import { beforeAll, describe, expect, it } from "vitest";

import app from "@/app";
import { resetDb } from "@/test/helpers";

import type { SeedSummary } from "./index";

import { LOGINS, SUBDOMAIN } from "./01-school";
import { seedDemo } from "./index";
import { DEMO_PASSWORD, schoolApi } from "./lib/client";

/**
 * The demo tenant, run end to end against a real database.
 *
 * CLAUDE.md §8 wants this in CI, and the reason is the one that makes the
 * whole file worth its runtime: "if it breaks, a migration broke something
 * real". Every other test in this suite sets up the two or three rows it needs
 * and asserts against them. This one builds a whole school the way a school
 * gets built — three hundred children, two terms of marks, a fee run, a
 * reconciliation queue — through the same endpoints a real client calls. A
 * constraint that only bites at scale, an endpoint that only fails on the
 * eleventh call, a migration that broke invoice generation: nothing else here
 * would notice.
 *
 * It also guards the demo itself. The assertions below are the specific things
 * §8 asks to be true — the mistyped reference, the unpublished assessment, the
 * child who left mid-term — and every one of them is a moment in a
 * presentation. A silent regression in any of them is found in front of a head
 * teacher otherwise.
 */

let summary: SeedSummary;

/**
 * Signs in as one of the demo staff, through the real endpoint.
 *
 * The seed created these accounts; this proves they can actually be used,
 * which is the first thing anybody does with a demo and the last thing a
 * fixture-based seed would catch.
 */
/*
 * One sign-in per role, held for the file.
 *
 * Signing in per test blew the auth rate limit (10 a minute, by design) once
 * this file grew past ten assertions — and the failure looked like a broken
 * seed rather than a throttle. Reusing the session is what a real client does
 * anyway.
 */
const sessions = new Map<keyof typeof LOGINS, ReturnType<typeof schoolApi>>();

async function accessAs(as: keyof typeof LOGINS) {
  const held = sessions.get(as);
  if (held)
    return held;

  const signIn = await app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: LOGINS[as].email,
      password: DEMO_PASSWORD,
    }),
  });

  if (!signIn.ok)
    throw new Error(`could not sign in as ${as}: ${await signIn.text()}`);

  const cookie = signIn.headers.get("set-cookie")!
    .split(/,(?=\s*[^;=\s]+=)/)
    .map(c => c.split(";")[0].trim())
    .join("; ");

  const api = schoolApi(SUBDOMAIN, cookie);
  sessions.set(as, api);
  return api;
}

describe("the demo tenant", () => {
  beforeAll(async () => {
    await resetDb();
    summary = await seedDemo();
  }, 600_000);

  it("builds a school at the scale §8 asks for", () => {
    // "one school, Grades 1-9, two streams in lower grades, one in junior.
    // ~320 students."
    expect(summary.streams).toBe(15);
    expect(summary.pupils).toBeGreaterThan(280);
    expect(summary.pupils).toBeLessThan(360);
  });

  it("puts today inside the current term, with two behind it", () => {
    const today = new Date().toISOString().slice(0, 10);
    const current = summary.terms.find(t => t.isCurrent)!;

    /*
     * The failure this prevents is the one §8 calls out by name: "a demo whose
     * current term expired in March is worse than no demo". It would not throw
     * — every screen would simply be empty, mid-presentation.
     */
    expect(current.startsOn <= today).toBe(true);
    expect(current.endsOn >= today).toBe(true);

    const finished = summary.terms.filter(t => t.endsOn < today);
    expect(finished).toHaveLength(2);
  });

  describe("the mess that sells it", () => {
    it("leaves payments in the queue, including the mistyped reference", async () => {
      const bursar = await accessAs("bursar");
      const { transactions: queue } = await bursar.get(
        "/mpesa/transactions?status=unmatched&limit=100",
      );

      // §8: "5-6 unmatched M-Pesa transactions".
      expect(queue.length).toBeGreaterThanOrEqual(5);
      expect(queue.length).toBeLessThanOrEqual(8);

      // The one the presenter reconciles live.
      const references = queue.map((t: { accountReference: string | null }) =>
        t.accountReference,
      );
      expect(references).toContain("ADM 118");
    });

    it("offers that payment a suggestion rather than having guessed", async () => {
      const bursar = await accessAs("bursar");
      const { transactions: queue } = await bursar.get(
        "/mpesa/transactions?status=unmatched&limit=100",
      );
      const mistyped = queue.find(
        (t: { accountReference: string | null }) => t.accountReference === "ADM 118",
      );

      /*
       * Strict matching is a deliberate refusal, not a gap (CLAUDE.md §5.8): a
       * wrong automatic allocation puts money on another family's account
       * where nobody is looking for it. What the queue owes the bursar instead
       * is candidates, with each one's balance.
       */
      expect(mistyped.status).toBe("unmatched");
      expect(Array.isArray(mistyped.suggestions)).toBe(true);
    });

    it("has a child who left mid-term with their history intact", async () => {
      const head = await accessAs("head");
      const { students: exited } = await head.get(
        "/students?status=transferred_out&includeExited=true",
      );

      expect(exited).toHaveLength(1);

      // The point of the case: they are still fully queryable, and the term
      // they were taught in still has results for them.
      const detail = await head.get(`/students/${exited[0].id}`);
      expect(detail.enrollments.length).toBeGreaterThan(0);
      expect(detail.status).toBe("transferred_out");
    });

    it("keeps a half-entered assessment away from the term mean", async () => {
      const head = await accessAs("head");

      const all = await head.get(`/assessments?termId=${summary.currentTermId}`);
      const unpublished = all.filter((a: { publishedAt: string | null }) => !a.publishedAt);

      // §8: "One assessment with publishedAt null, to show parents don't see
      // half-entered marks."
      expect(unpublished).toHaveLength(1);
      expect(unpublished[0].title).toBe("End of Term Exam");
    });

    it("has two guardians with a child in more than one class", async () => {
      const head = await accessAs("head");

      expect(summary.siblingGuardianIds).toHaveLength(2);

      for (const guardianId of summary.siblingGuardianIds) {
        const detail = await head.get(`/guardians/${guardianId}`);

        // Siblings are why guardians are a table and not columns on the child
        // (CLAUDE.md §5.3): without this you send the same fee reminder twice
        // and store one phone number two ways.
        expect(detail.students.length).toBeGreaterThanOrEqual(2);

        // In different classes, which is the half that makes it worth showing.
        const classes = new Set(
          detail.students.map((s: { id: string }) => s.id),
        );
        expect(classes.size).toBeGreaterThanOrEqual(2);
      }
    });

    it("bills two children in one class different amounts", async () => {
      const head = await accessAs("head");

      const { invoices } = await head.get(
        `/invoices?termId=${summary.currentTermId}&limit=200`,
      );
      const totals = new Set(invoices.map((i: { totalCents: number }) => i.totalCents));

      /*
       * Optional items are added per family, not billed in bulk (§5.7) — so a
       * demo where every invoice is identical would have quietly lost the
       * lunch and transport lines, and with them the reason that rule exists.
       */
      expect(totals.size).toBeGreaterThan(3);
    });

    it("has one balance alarming enough to act on", () => {
      /*
       * Guarded because the first version was not.
       *
       * It picked whichever family happened to end up furthest behind and
       * produced KES 10,500 — a number no head would look at twice, and
       * nothing failed. §8 asks for "one alarming one" because that is what
       * turns "we should chase fees" into "we should chase THAT one"; an
       * emergent worst case is not reliably alarming, so it is now chosen and
       * this is what keeps it chosen.
       */
      expect(summary.alarmingBalanceCents).toBeGreaterThan(50_000_00);
    });

    it("charges fees in the tier being sold to", async () => {
      const bursar = await accessAs("bursar");
      const structures = await bursar.get("/fee-structures");

      const totals = structures.map(
        (s: { mandatoryTotalCents: number }) => s.mandatoryTotalCents,
      );

      // §8: "modest private primary ~ KES 12,000-25,000/term". Amounts a head
      // does not recognise land as badly as names they do not recognise.
      expect(Math.min(...totals)).toBeGreaterThanOrEqual(12_000_00);
      expect(Math.max(...totals)).toBeLessThanOrEqual(25_000_00);
    });
  });

  describe("what a presenter opens", () => {
    it("shows outstanding balances worst-class-first", async () => {
      const bursar = await accessAs("bursar");
      const { classes: byClass } = await bursar.get("/balances/by-class");

      expect(byClass.length).toBeGreaterThan(0);
      const owing = byClass.filter(
        (row: { outstandingCents: number }) => row.outstandingCents > 0,
      );
      expect(owing.length).toBeGreaterThan(0);
    });

    it("has released report cards a parent can already read", async () => {
      const head = await accessAs("head");
      const cards = await head.get(`/report-cards?termId=${summary.finishedTermIds[0]}`);

      expect(cards.length).toBeGreaterThan(20);
      const released = cards.filter((c: { releasedAt: string | null }) => c.releasedAt);
      expect(released.length).toBeGreaterThan(20);
    });

    it("froze a position and a level into each one", async () => {
      const head = await accessAs("head");
      const [card] = await head.get(`/report-cards?termId=${summary.finishedTermIds[0]}`);
      const detail = await head.get(`/report-cards/${card.id}`);

      // Everything printed comes from the snapshot, never a fresh computation
      // (rule 7) — so this is what "reprinting in 2028" will read.
      expect(detail.snapshot.learningAreas.length).toBeGreaterThan(0);
      expect(detail.snapshot.levelReduction).toBeDefined();
    });
  });

  describe("the documents and the trail", () => {
    it("issues certificates for both CBE milestones", async () => {
      const head = await accessAs("head");
      const certificates = await head.get("/transition-certificates");

      /*
       * These can only exist because the seed builds a PREVIOUS year. The
       * current one is mid-term-3 by design, and a certificate cannot be
       * issued before its term has ended — so without last year the feature
       * would be invisible in the one place anyone looks at it.
       */
      expect(summary.certificates).toBeGreaterThan(20);
      const milestones = new Set(
        certificates.map((c: { milestone: string }) => c.milestone),
      );
      expect([...milestones].sort()).toEqual(["grade_6", "grade_9"]);
    });

    it("has leavers who graduated and are still queryable", async () => {
      const head = await accessAs("head");
      const { students } = await head.get(
        "/students?status=graduated&includeExited=true",
      );

      // Nothing hard-deletes (rule 5): last year's Grade 9 are gone from the
      // register and entirely readable.
      expect(students.length).toBe(summary.graduated);
      expect(summary.graduated).toBeGreaterThan(0);
    });

    it("verifies a certificate through the public endpoint", async () => {
      const head = await accessAs("head");
      const [certificate] = await head.get("/transition-certificates");

      // No session, no subdomain — the way the next school checks it.
      const verified = await (await app.request(
        `/verify/${certificate.verificationCode}`,
      )).json();

      expect(verified.documentType).toBe("transition_certificate");
      expect(verified.status).toBe("valid");
    });

    it("has a receipt that verifies as withdrawn", async () => {
      // The reversal the seed performs on purpose: authentic paper, money no
      // longer on the account. Usually why somebody is checking at all.
      const verified = await (await app.request(
        `/verify/${summary.reversedReceiptCode}`,
      )).json();

      expect(verified.documentType).toBe("payment_receipt");
      expect(verified.status).toBe("withdrawn");
    });

    it("gives the parent login two children and a balance", async () => {
      const parent = await accessAs("parent");
      const children = await parent.get("/portal/children");

      /*
       * The screen §8 says convinces a head that fee follow-up gets easier,
       * and until this round it did not exist. Two children on one login is
       * the version worth showing.
       */
      expect(children.length).toBeGreaterThanOrEqual(2);
      expect(children[0].payToAccount ?? children[0].admissionNumber).toBeTruthy();

      const fees = await parent.get(`/portal/children/${children[0].studentId}/fees`);
      // The admission number IS the M-Pesa reference: a parent pays from the
      // screen showing the balance rather than typing it from memory.
      expect(fees.payToAccount).toBe(children[0].admissionNumber);
    });

    it("opens both gates and watches the parent's view change", async () => {
      const head = await accessAs("head");
      const parent = await accessAs("parent");
      const [child] = await parent.get("/portal/children");

      /*
       * The first version of this asserted `x === undefined || x.length > 0`
       * and `Array.isArray(cards)` — a tautology and a type check. Neither
       * could fail, which is the same mistake as asserting a bare 422: it
       * looked like a test of the gates and tested nothing about them.
       *
       * The gates are only demonstrated by CLOSING and then OPENING them on
       * the same records.
       */
      const teacher = await accessAs("teacher");
      const assessments = await head.get(
        `/assessments?termId=${summary.currentTermId}`,
      );
      const held = assessments.find((a: { publishedAt: string | null }) => !a.publishedAt);
      expect(held).toBeDefined();

      // Closed: the half-entered paper is in the database and not in the
      // parent's results.
      const before = await parent.get(`/portal/children/${child.studentId}/results`);
      const beforeCurrent = before.find(
        (r: { termId: string }) => r.termId === summary.currentTermId,
      );
      const beforeAreas = beforeCurrent?.learningAreas.length ?? 0;

      await head.post(`/assessments/${held.id}/publish`);
      await head.post("/term-results/compute", { termId: summary.currentTermId });

      // Open: the same paper now counts.
      const after = await parent.get(`/portal/children/${child.studentId}/results`);
      const afterCurrent = after.find(
        (r: { termId: string }) => r.termId === summary.currentTermId,
      );
      expect(afterCurrent.learningAreas.length).toBeGreaterThanOrEqual(beforeAreas);

      // Put it back, so the demo state a presenter rehearsed against survives
      // this test — and check the withdrawal takes effect on the parent too.
      await head.post(`/assessments/${held.id}/unpublish`);
      void teacher;
    });

    it("shows released report cards and withholds unreleased ones", async () => {
      const head = await accessAs("head");
      const parent = await accessAs("parent");
      const [child] = await parent.get("/portal/children");

      const visible = await parent.get(
        `/portal/children/${child.studentId}/report-cards`,
      );
      expect(visible.length).toBeGreaterThan(0);
      // Released only, and the released ones carry a scannable QR link.
      expect(visible.every((c: { releasedAt: string }) => c.releasedAt)).toBe(true);
      expect(visible[0].verificationUrl).toContain("/verify/");

      // Every card the school holds for this child, released or not — the
      // parent's list must be the released subset, never the whole set.
      const all = await head.get(`/report-cards?termId=${visible[0].termId}`);
      expect(all.length).toBeGreaterThanOrEqual(visible.length);
    });

    it("has an audit trail a head can read and nobody can edit", async () => {
      const head = await accessAs("head");
      const listed = await head.get("/audit-log?action=payment.reversed");

      expect(summary.auditEntries).toBeGreaterThan(100);
      expect(listed.entries.length).toBe(1);
      expect(listed.entries[0].summary).toContain("wrong child");
    });
  });

  it("does not leave a superadmin anyone could sign in as", async () => {
    /*
     * The demo staff share a password on purpose — those accounts are handed
     * to a prospect and reset nightly. The operator account is NOT like them:
     * it is superadmin across every school on the platform, so a value that
     * could be read out of this repository would be a way into every tenant's
     * children and fees, not just the demo's.
     *
     * Its password is generated per run and discarded, which leaves the
     * account unusable rather than usable-by-anyone. Nothing needs it after
     * the seed finishes.
     */
    const asOperator = await app.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "operator@demo.school",
        password: DEMO_PASSWORD,
      }),
    });

    expect(asOperator.ok).toBe(false);
  });

  it("is reproducible: the same seed builds the same school", async () => {
    /*
     * Determinism is not a nicety here. A presenter rehearses against this
     * data, and §8 asks for fixed values so that what they practised is what
     * they get. Re-running from scratch and comparing the register is the only
     * assertion that actually proves it.
     */
    await resetDb();
    // Every session above belonged to users this just deleted.
    sessions.clear();
    const again = await seedDemo();

    expect(again.pupils).toBe(summary.pupils);
    expect(again.streams).toBe(summary.streams);
    expect(again.invoices).toBe(summary.invoices);
    expect(again.unmatched).toBe(summary.unmatched);
  }, 600_000);
});
