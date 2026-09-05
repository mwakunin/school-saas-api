import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import type { TestUser } from "@/test/helpers";

import app from "@/app";
import db from "@/db";
import { guardians, smsMessages, studentGuardians } from "@/db/schema";
import { sentSms } from "@/lib/sms";
import {
  makeInvoice,
  makeSchool,
  makeStream,
  makeStudent,
  resetDb,
  signInAt,
  tenantHeaders,
} from "@/test/helpers";

/**
 * SMS to guardians, and the record of what it cost.
 *
 * Every test here is really about one property: a send spends a school's money
 * and cannot be recalled. So the preview has to be the default, the families
 * left out have to be visible, and a parent with two guardians linked must not
 * be billed for twice.
 */
function jsonHeaders(subdomain: string, user: TestUser) {
  return { "content-type": "application/json", ...tenantHeaders(subdomain, user) };
}

function post(path: string, body: unknown, headers: Record<string, string>) {
  return app.request(path, { method: "POST", headers, body: JSON.stringify(body) });
}

async function seed(subdomain: string) {
  const school = await makeSchool({ subdomain });
  const blue = await makeStream(school, 4, "Blue");
  const admin = await signInAt(school.id, "admin");
  const bursar = await signInAt(school.id, "bursar");
  const term = school.terms[0];

  const pupils: Array<{
    student: Awaited<ReturnType<typeof makeStudent>>;
    guardian: { id: string; phone: string };
  }> = [];
  for (const [n, name] of [["2026/001", "Wanjiku"], ["2026/002", "Otieno"]] as const) {
    const student = await makeStudent(school, n, { givenName: name, streamId: blue.id });
    const [guardian] = await db
      .insert(guardians)
      .values({
        schoolId: school.id,
        name: `Parent of ${name}`,
        phone: `+2547200000${String(pupils.length + 1).padStart(2, "0")}`,
      })
      .returning();
    await db.insert(studentGuardians).values({
      schoolId: school.id,
      studentId: student.id,
      guardianId: guardian.id,
      isPrimary: true,
    });
    pupils.push({ student, guardian });
  }

  return { school, blue, admin, bursar, term, pupils, subdomain };
}

describe("messaging", () => {
  beforeEach(async () => {
    await resetDb();
    sentSms.length = 0;
  });

  describe("the preview", () => {
    it("sends nothing unless asked, and shows the cost first", async () => {
      const ctx = await seed("alpha");

      const preview = await (await post("/sms/fee-reminders", {
        termId: ctx.term.id,
        minBalanceCents: 0,
      }, jsonHeaders("alpha", ctx.bursar))).json();

      /*
       * The default that matters.
       *
       * Every other write in this codebase does the thing you asked for. This
       * one cannot be undone and costs money per recipient, so a bursar who
       * mistypes a filter has to see the count before the bill.
       */
      expect(preview.dryRun).toBe(true);
      expect(preview.batchId).toBeNull();
      expect(preview.sent).toBe(0);
      expect(sentSms).toHaveLength(0);

      expect(preview.recipients).toBe(2);
      expect(preview.estimatedCostCents).toBeGreaterThan(0);
      expect(preview.sample[0].body).toContain("Wanjiku");
    });

    it("names the families it would skip rather than passing over them", async () => {
      const ctx = await seed("alpha");
      // A child with nobody linked — the case that is invisible otherwise, and
      // that turns "we texted everyone" into "everyone we had a number for".
      await makeStudent(ctx.school, "2026/003", {
        givenName: "Achieng",
        streamId: ctx.blue.id,
      });

      const preview = await (await post("/sms/fee-reminders", {
        termId: ctx.term.id,
        minBalanceCents: 0,
      }, jsonHeaders("alpha", ctx.bursar))).json();

      expect(preview.skipped).toContainEqual({
        admissionNumber: "2026/003",
        reason: "no_guardian",
      });
    });
  });

  describe("sending", () => {
    it("writes a row per message with the provider's own cost", async () => {
      const ctx = await seed("alpha");

      const result = await (await post("/sms/fee-reminders", {
        termId: ctx.term.id,
        minBalanceCents: 0,
        dryRun: false,
      }, jsonHeaders("alpha", ctx.bursar))).json();

      expect(result.sent).toBe(2);
      expect(sentSms).toHaveLength(2);

      const rows = await db.select().from(smsMessages);
      expect(rows).toHaveLength(2);
      // The provider's figure, not our estimate: this is what a school will be
      // billed, and the estimate is only for the warning beforehand.
      expect(rows[0].costCents).toBe(80);
      expect(rows[0].status).toBe("sent");
      expect(rows[0].providerMessageId).toBeTruthy();
      expect(rows[0].batchId).toBe(result.batchId);
    });

    it("puts the admission number in a fee reminder", async () => {
      const ctx = await seed("alpha");
      await makeInvoice(ctx.school, ctx.pupils[0].student, { totalCents: 1_500_000 });

      await post("/sms/fee-reminders", {
        termId: ctx.term.id,
        dryRun: false,
      }, jsonHeaders("alpha", ctx.bursar));

      /*
       * The cheapest thing we can do about the unmatched queue.
       *
       * The admission number IS the M-Pesa account reference (§5.3), and most
       * of what lands in reconciliation is a reference typed from memory. A
       * parent copying it out of the text gets it right.
       */
      expect(sentSms[0].body).toContain("2026/001");
      expect(sentSms[0].body).toContain("15,000");
    });

    it("texts one guardian per child, not every guardian linked", async () => {
      const ctx = await seed("alpha");
      const [second] = await db
        .insert(guardians)
        .values({
          schoolId: ctx.school.id,
          name: "Second parent",
          phone: "+254720999999",
        })
        .returning();
      await db.insert(studentGuardians).values({
        schoolId: ctx.school.id,
        studentId: ctx.pupils[0].student.id,
        guardianId: second.id,
        isPrimary: false,
      });

      await post("/sms/fee-reminders", {
        termId: ctx.term.id,
        minBalanceCents: 0,
        dryRun: false,
      }, jsonHeaders("alpha", ctx.bursar));

      // Two children, two messages — not three. Sending the same reminder to
      // both parents of one child is the complaint the guardians table exists
      // to prevent, and it would double the bill for the privilege.
      expect(sentSms).toHaveLength(2);
      expect(sentSms.map(m => m.to)).not.toContain("+254720999999");
    });

    it("skips families below the threshold", async () => {
      const ctx = await seed("alpha");
      await makeInvoice(ctx.school, ctx.pupils[0].student, { totalCents: 1_500_000 });

      const result = await (await post("/sms/fee-reminders", {
        termId: ctx.term.id,
        dryRun: false,
      }, jsonHeaders("alpha", ctx.bursar))).json();

      // Chasing a family who owes nothing costs money and trust. Only the one
      // with an invoice gets a text.
      expect(result.sent).toBe(1);
      expect(result.skipped).toContainEqual({
        admissionNumber: "2026/002",
        reason: "no_balance",
      });
    });
  });

  describe("results notices", () => {
    it("will not tell a parent to look at a report card that is not released", async () => {
      const ctx = await seed("alpha");

      const preview = await (await post("/sms/results-notice", {
        termId: ctx.term.id,
      }, jsonHeaders("alpha", ctx.admin))).json();

      /*
       * `releasedAt` gates parent visibility everywhere else, so honouring it
       * here keeps the text and the portal telling the same story. Sending
       * families to look at nothing is worse than not texting.
       */
      expect(preview.recipients).toBe(0);
      expect(preview.skipped.every((s: { reason: string }) => s.reason === "no_report_card"))
        .toBe(true);
    });

    it("is the head's send, not the bursar's", async () => {
      const ctx = await seed("alpha");

      const res = await post("/sms/results-notice", {
        termId: ctx.term.id,
      }, jsonHeaders("alpha", ctx.bursar));

      expect(res.status).toBe(403);
    });
  });

  describe("what it cost", () => {
    it("totals the spend for a selection", async () => {
      const ctx = await seed("alpha");
      await post("/sms/fee-reminders", {
        termId: ctx.term.id,
        minBalanceCents: 0,
        dryRun: false,
      }, jsonHeaders("alpha", ctx.bursar));

      const listed = await (await app.request("/sms", {
        headers: tenantHeaders("alpha", ctx.bursar),
      })).json();

      // "What are we spending on SMS" is the question §6 says this table
      // exists to answer, so the total travels with the list.
      expect(listed.total).toBe(2);
      expect(listed.totalCostCents).toBe(160);
    });

    it("reports nothing spent as zero rather than as unknown", async () => {
      const ctx = await seed("alpha");

      const listed = await (await app.request("/sms", {
        headers: tenantHeaders("alpha", ctx.bursar),
      })).json();

      // A null here would make "we have spent nothing" and "we cannot tell"
      // look the same on a screen.
      expect(listed.totalCostCents).toBe(0);
    });
  });

  describe("isolation", () => {
    it("shows one school none of another's messages", async () => {
      const alpha = await seed("alpha");
      const beta = await seed("beta");

      await post("/sms/fee-reminders", {
        termId: beta.term.id,
        minBalanceCents: 0,
        dryRun: false,
      }, jsonHeaders("beta", beta.bursar));

      const listed = await (await app.request("/sms", {
        headers: tenantHeaders("alpha", alpha.bursar),
      })).json();

      expect(listed.messages).toHaveLength(0);
      expect(await db.select().from(smsMessages).where(eq(smsMessages.schoolId, beta.school.id)))
        .toHaveLength(2);
    });
  });
});
