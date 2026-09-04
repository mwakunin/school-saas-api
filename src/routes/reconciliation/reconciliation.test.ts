import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import type { TestUser } from "@/test/helpers";

import app from "@/app";
import db from "@/db";
import { mpesaTransactions, payments, schools } from "@/db/schema";
import { generateCallbackToken } from "@/lib/crypto";
import {
  makeSchool,
  makeStream,
  makeStudent,
  resetDb,
  signInAt,
  tenantHeaders,
} from "@/test/helpers";

/**
 * The reconciliation queue — what CLAUDE.md §5.8 calls the core bursar
 * workflow, not an edge case.
 *
 * A meaningful share of payments arrive with a reference that is not an
 * admission number, because parents type them wrong. The tests below are
 * mostly about the line between what the system may decide by itself and what
 * it must hand to a person: a wrong automatic allocation is worse than none,
 * since the money lands on another family's account and nobody is looking for
 * it.
 */
function jsonHeaders(subdomain: string, user: TestUser) {
  return { "content-type": "application/json", ...tenantHeaders(subdomain, user) };
}

function post(path: string, body: unknown, headers: Record<string, string>) {
  return app.request(path, { method: "POST", headers, body: JSON.stringify(body) });
}

const CONFIRMATION = {
  TransactionType: "Pay Bill",
  TransID: "RKTQDM7W6S",
  TransTime: "20260115143045",
  TransAmount: "18000.00",
  BusinessShortCode: "600638",
  BillRefNumber: "2026/118",
  MSISDN: "254712345678",
  FirstName: "GRACE",
  LastName: "NJOROGE",
};

/** A school with a paybill, a class, and two children on the register. */
async function seed(subdomain: string) {
  const school = await makeSchool({ subdomain });
  const blue = await makeStream(school, 4, "Blue");
  const bursar = await signInAt(school.id, "bursar");
  const token = generateCallbackToken();

  await db
    .update(schools)
    .set({ mpesaShortcode: "600638", mpesaCallbackToken: token })
    .where(eq(schools.id, school.id));

  const wanjiku = await makeStudent(school, "2026/118", {
    givenName: "Wanjiku",
    streamId: blue.id,
  });
  const otieno = await makeStudent(school, "2026/205", {
    givenName: "Otieno",
    streamId: blue.id,
  });

  /** Delivers a confirmation exactly as Safaricom would. */
  async function confirm(overrides: Record<string, unknown> = {}) {
    await app.request(`/webhooks/mpesa/c2b/${token}/confirmation`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...CONFIRMATION, ...overrides }),
    });
  }

  return { school, bursar, token, wanjiku, otieno, confirm };
}

describe("reconciliation", () => {
  beforeEach(async () => {
    await resetDb();
  });

  describe("automatic matching", () => {
    it("allocates a reference that is exactly an admission number", async () => {
      const { bursar, wanjiku, confirm } = await seed("alpha");
      await confirm({ BillRefNumber: "2026/118" });

      const res = await post("/mpesa/transactions/match", {}, jsonHeaders("alpha", bursar));

      expect(await res.json()).toMatchObject({ examined: 1, allocated: 1 });

      const [payment] = await db.select().from(payments);
      expect(payment).toMatchObject({
        studentId: wanjiku.id,
        method: "mpesa",
        amountCents: 1_800_000,
        // The Safaricom receipt, so a bursar holding the parent's SMS can find
        // this row by the number the parent reads out.
        reference: "RKTQDM7W6S",
      });
    });

    it("allocates through a different separator", async () => {
      const { bursar, wanjiku, confirm } = await seed("alpha");
      // Same number, written how a phone keypad encourages.
      await confirm({ BillRefNumber: "2026-118" });

      await post("/mpesa/transactions/match", {}, jsonHeaders("alpha", bursar));

      const [payment] = await db.select().from(payments);
      expect(payment.studentId).toBe(wanjiku.id);
    });

    it("leaves a reference it cannot resolve for a person", async () => {
      const { bursar, confirm } = await seed("alpha");
      // §8's demo case: `ADM 118` typed instead of `2026/118`. It is meant to
      // STAY unmatched — guessing here is how money lands on the wrong child.
      await confirm({ BillRefNumber: "ADM 118" });

      const res = await post("/mpesa/transactions/match", {}, jsonHeaders("alpha", bursar));

      expect(await res.json()).toMatchObject({ allocated: 0, stillUnmatched: 1 });
      expect(await db.select().from(payments)).toHaveLength(0);
    });

    it("leaves a confirmation with no reference alone", async () => {
      const { bursar, confirm } = await seed("alpha");
      await confirm({ BillRefNumber: "" });

      const res = await post("/mpesa/transactions/match", {}, jsonHeaders("alpha", bursar));
      expect(await res.json()).toMatchObject({ allocated: 0 });
    });

    it("is safe to run twice", async () => {
      const { bursar, confirm } = await seed("alpha");
      await confirm();

      await post("/mpesa/transactions/match", {}, jsonHeaders("alpha", bursar));
      const second = await post("/mpesa/transactions/match", {}, jsonHeaders("alpha", bursar));

      // The second pass sees nothing unmatched, so it allocates nothing —
      // and certainly does not pay twice.
      expect(await second.json()).toMatchObject({ examined: 0, allocated: 0 });
      expect(await db.select().from(payments)).toHaveLength(1);
    });

    it("picks up payments that arrived before the child was admitted", async () => {
      const { school, bursar, confirm } = await seed("alpha");
      await confirm({ BillRefNumber: "2026/999", TransID: "LATE001" });

      // Nobody to match yet.
      await post("/mpesa/transactions/match", {}, jsonHeaders("alpha", bursar));
      expect(await db.select().from(payments)).toHaveLength(0);

      // The child is admitted a week later — a real sequence, since parents
      // pay the deposit before the paperwork.
      const late = await makeStudent(school, "2026/999", { givenName: "Latecomer" });

      const res = await post("/mpesa/transactions/match", {}, jsonHeaders("alpha", bursar));
      expect(await res.json()).toMatchObject({ allocated: 1 });

      const [payment] = await db.select().from(payments);
      expect(payment.studentId).toBe(late.id);
    });

    it("never matches across schools", async () => {
      const alpha = await seed("alpha");
      const beta = await seed("beta");

      // Beta receives a payment quoting a reference that exists at both.
      await beta.confirm({ TransID: "BETA001" });
      await post("/mpesa/transactions/match", {}, jsonHeaders("beta", beta.bursar));

      const [payment] = await db.select().from(payments);
      expect(payment.schoolId).toBe(beta.school.id);
      expect(payment.studentId).not.toBe(alpha.wanjiku.id);
    });
  });

  describe("working through a backlog", () => {
    /** Confirmations at chosen times, so the sweep order is deterministic. */
    async function backlog(school: { id: string }, rows: Array<[string, string, string]>) {
      for (const [id, reference, at] of rows) {
        await db.insert(mpesaTransactions).values({
          schoolId: school.id,
          transactionId: id,
          shortcode: "600638",
          accountReference: reference,
          msisdn: "254712345678",
          amountCents: 100_000,
          transactedAt: new Date(at),
          rawPayload: {},
          status: "unmatched",
        });
      }
    }

    it("reaches a matchable payment sitting behind unmatchable ones", async () => {
      const { school, bursar } = await seed("alpha");
      await makeStudent(school, "2026/500", { givenName: "Reachable" });

      /*
       * The failure this exists to prevent.
       *
       * The rows at the front of a queue are there BECAUSE nothing could match
       * them. A bounded sweep that always restarted from the oldest re-examined
       * the same stuck batch every time, matched nothing, and still reported
       * that more remained — so "run again" did nothing, for ever, and a
       * payment behind them was never looked at.
       */
      await backlog(school, [
        ["T1", "GIBBERISH-A", "2026-01-01T08:00:00Z"],
        ["T2", "GIBBERISH-B", "2026-01-02T08:00:00Z"],
        ["T3", "GIBBERISH-C", "2026-01-03T08:00:00Z"],
        ["T4", "2026/500", "2026-01-04T08:00:00Z"],
      ]);

      // Walk the queue the way a client would, carrying the cursor.
      let after: string | undefined;
      let passes = 0;

      do {
        const body = await (await post(
          "/mpesa/transactions/match",
          after ? { after } : {},
          jsonHeaders("alpha", bursar),
        )).json();

        after = body.nextCursor ?? undefined;
        passes += 1;
      } while (after && passes < 10);

      // The matchable row was reached, and the sweep terminated.
      const paid = await db.select().from(payments);
      expect(paid).toHaveLength(1);
      expect(paid[0].reference).toBe("T4");
      expect(passes).toBeLessThan(10);
    });

    it("returns a cursor that moves, rather than repeating a batch", async () => {
      const { school, bursar } = await seed("alpha");
      await backlog(school, [
        ["U1", "NOPE-1", "2026-01-01T08:00:00Z"],
        ["U2", "NOPE-2", "2026-01-02T08:00:00Z"],
        ["U3", "NOPE-3", "2026-01-03T08:00:00Z"],
      ]);

      const first = await (await post(
        "/mpesa/transactions/match",
        {},
        jsonHeaders("alpha", bursar),
      )).json();

      // A batch of 200 swallows all three, so the sweep is done in one pass.
      expect(first.examined).toBe(3);
      expect(first.allocated).toBe(0);
      // `remaining` counts what a FURTHER pass would examine, not the size of
      // the queue — otherwise it never falls and always invites a useless
      // re-run.
      expect(first.remaining).toBe(0);
      expect(first.nextCursor).toBeNull();
    });

    it("starts from the oldest again once the sweep is finished", async () => {
      const { school, bursar } = await seed("alpha");
      await backlog(school, [["V1", "NOPE", "2026-01-01T08:00:00Z"]]);

      await post("/mpesa/transactions/match", {}, jsonHeaders("alpha", bursar));

      // A confirmation that arrives later must be picked up by the next run,
      // which is why a finished sweep clears the cursor rather than parking at
      // the end of the queue.
      await makeStudent(school, "2026/777", { givenName: "New" });
      await backlog(school, [["V2", "2026/777", "2026-01-05T08:00:00Z"]]);

      const body = await (await post(
        "/mpesa/transactions/match",
        {},
        jsonHeaders("alpha", bursar),
      )).json();

      expect(body.allocated).toBe(1);
    });

    it("422s a cursor it cannot read", async () => {
      const { bursar } = await seed("alpha");

      const res = await post(
        "/mpesa/transactions/match",
        { after: "not-a-cursor" },
        jsonHeaders("alpha", bursar),
      );

      // A client looping on a cursor it cannot read would sweep the first
      // batch for ever and believe it was progressing.
      expect(res.status).toBe(422);
    });
  });

  describe("the queue", () => {
    it("shows unmatched payments with the money still sitting there", async () => {
      const { bursar, confirm } = await seed("alpha");
      await confirm({ BillRefNumber: "ADM 118", TransID: "A1" });
      await confirm({ BillRefNumber: "???", TransID: "A2", TransAmount: "5000" });

      const res = await app.request("/mpesa/transactions?status=unmatched", {
        headers: tenantHeaders("alpha", bursar),
      });

      const body = await res.json();
      expect(body.transactions).toHaveLength(2);
      expect(body.unmatchedCount).toBe(2);
      expect(body.unmatchedCents).toBe(1_800_000 + 500_000);
    });

    it("suggests the children a mistyped reference might mean", async () => {
      const { bursar, wanjiku, confirm } = await seed("alpha");
      await confirm({ BillRefNumber: "ADM 118" });

      const body = await (await app.request("/mpesa/transactions?status=unmatched", {
        headers: tenantHeaders("alpha", bursar),
      })).json();

      // Refuse to guess, then make guessing unnecessary: the near misses go in
      // front of the bursar rather than being applied silently.
      const suggested = body.transactions[0].suggestions;
      expect(suggested.map((s: { studentId: string }) => s.studentId)).toContain(wanjiku.id);
    });

    it("withholds Safaricom's raw envelope from the list", async () => {
      const { bursar, confirm } = await seed("alpha");
      await confirm();

      const body = await (await app.request("/mpesa/transactions", {
        headers: tenantHeaders("alpha", bursar),
      })).json();

      expect(body.transactions[0]).not.toHaveProperty("rawPayload");
    });

    it("shows the envelope on the single-transaction view", async () => {
      const { bursar, confirm } = await seed("alpha");
      await confirm();
      const [row] = await db.select().from(mpesaTransactions);

      const body = await (await app.request(`/mpesa/transactions/${row.id}`, {
        headers: tenantHeaders("alpha", bursar),
      })).json();

      expect(body.rawPayload).toMatchObject({ TransID: "RKTQDM7W6S" });
    });

    it("403s a teacher", async () => {
      const { school, confirm } = await seed("alpha");
      await confirm();
      const teacher = await signInAt(school.id, "teacher");

      const res = await app.request("/mpesa/transactions", {
        headers: tenantHeaders("alpha", teacher),
      });

      expect(res.status).toBe(403);
    });

    it("shows one school none of another's payments", async () => {
      const alpha = await seed("alpha");
      await alpha.confirm();
      const beta = await seed("beta");

      const body = await (await app.request("/mpesa/transactions", {
        headers: tenantHeaders("beta", beta.bursar),
      })).json();

      expect(body.transactions).toEqual([]);
    });
  });

  describe("allocating by hand", () => {
    it("credits the payment to the child a bursar chose", async () => {
      const { bursar, otieno, confirm } = await seed("alpha");
      await confirm({ BillRefNumber: "ADM 205" });
      const [row] = await db.select().from(mpesaTransactions);

      const res = await post(
        `/mpesa/transactions/${row.id}/allocate`,
        { studentId: otieno.id },
        jsonHeaders("alpha", bursar),
      );

      expect(res.status).toBe(200);
      expect((await res.json()).status).toBe("allocated");

      const [payment] = await db.select().from(payments);
      expect(payment).toMatchObject({
        studentId: otieno.id,
        method: "mpesa",
        mpesaTransactionId: row.id,
      });
    });

    it("lands as a credit rather than guessing a term", async () => {
      const { bursar, otieno, confirm } = await seed("alpha");
      await confirm();
      const [row] = await db.select().from(mpesaTransactions);

      await post(
        `/mpesa/transactions/${row.id}/allocate`,
        { studentId: otieno.id },
        jsonHeaders("alpha", bursar),
      );

      // Which term a payment settles is a bursar's decision. Guessing "the
      // oldest unpaid invoice" is wrong every time a parent pays in advance.
      const [payment] = await db.select().from(payments);
      expect(payment.invoiceId).toBeNull();
    });

    it("409s a second allocation of the same money", async () => {
      const { bursar, wanjiku, otieno, confirm } = await seed("alpha");
      await confirm();
      const [row] = await db.select().from(mpesaTransactions);

      const body = { studentId: wanjiku.id };
      await post(`/mpesa/transactions/${row.id}/allocate`, body, jsonHeaders("alpha", bursar));
      const again = await post(
        `/mpesa/transactions/${row.id}/allocate`,
        { studentId: otieno.id },
        jsonHeaders("alpha", bursar),
      );

      // The double-click that would otherwise credit one M-Pesa receipt to two
      // families.
      expect(again.status).toBe(409);
      expect(await db.select().from(payments)).toHaveLength(1);
    });

    it("422s a student from another school", async () => {
      const alpha = await seed("alpha");
      const beta = await seed("beta");
      await alpha.confirm();
      const [row] = await db.select().from(mpesaTransactions);

      const res = await post(
        `/mpesa/transactions/${row.id}/allocate`,
        { studentId: beta.wanjiku.id },
        jsonHeaders("alpha", alpha.bursar),
      );

      expect(res.status).toBe(422);
    });
  });

  describe("undoing a mis-allocation", () => {
    it("returns the money to the queue when its payment is reversed", async () => {
      const { bursar, wanjiku, otieno, confirm } = await seed("alpha");
      await confirm();
      const [row] = await db.select().from(mpesaTransactions);

      // Allocated to the wrong sibling.
      await post(
        `/mpesa/transactions/${row.id}/allocate`,
        { studentId: wanjiku.id },
        jsonHeaders("alpha", bursar),
      );
      const [payment] = await db.select().from(payments);

      await post(
        `/payments/${payment.id}/reverse`,
        { reason: "Allocated to the wrong sibling" },
        jsonHeaders("alpha", bursar),
      );

      /*
       * The property §5.8 promises: "because the raw row is never mutated,
       * mis-allocation is always reversible". Without returning the
       * transaction to the queue it would read `allocated` for ever while no
       * live payment existed — money that arrived, was acknowledged, and now
       * belongs to nobody.
       */
      const [after] = await db.select().from(mpesaTransactions);
      expect(after.status).toBe("unmatched");

      // And it can now be put where it belongs.
      const res = await post(
        `/mpesa/transactions/${row.id}/allocate`,
        { studentId: otieno.id },
        jsonHeaders("alpha", bursar),
      );
      expect(res.status).toBe(200);

      const live = (await db.select().from(payments)).filter(p => p.reversedAt === null);
      expect(live).toHaveLength(1);
      expect(live[0].studentId).toBe(otieno.id);
    });

    it("keeps the reversed payment on the record", async () => {
      const { bursar, wanjiku, confirm } = await seed("alpha");
      await confirm();
      const [row] = await db.select().from(mpesaTransactions);

      await post(
        `/mpesa/transactions/${row.id}/allocate`,
        { studentId: wanjiku.id },
        jsonHeaders("alpha", bursar),
      );
      const [payment] = await db.select().from(payments);
      await post(
        `/payments/${payment.id}/reverse`,
        { reason: "wrong child" },
        jsonHeaders("alpha", bursar),
      );

      // "Where did this KES 18,000 go" stays answerable.
      const all = await db.select().from(payments);
      expect(all).toHaveLength(1);
      expect(all[0].reversalReason).toBe("wrong child");
    });
  });

  describe("setting a payment aside", () => {
    it("rejects and re-queues without losing the row", async () => {
      const { bursar, confirm } = await seed("alpha");
      await confirm({ BillRefNumber: "RENT" });
      const [row] = await db.select().from(mpesaTransactions);

      const rejected = await post(
        `/mpesa/transactions/${row.id}/reject`,
        { reason: "Not school fees — landlord used the wrong paybill" },
        jsonHeaders("alpha", bursar),
      );
      expect((await rejected.json()).status).toBe("rejected");

      const requeued = await post(
        `/mpesa/transactions/${row.id}/requeue`,
        {},
        jsonHeaders("alpha", bursar),
      );
      expect((await requeued.json()).status).toBe("unmatched");

      expect(await db.select().from(mpesaTransactions)).toHaveLength(1);
    });

    it("refuses to set aside money that is already allocated", async () => {
      const { bursar, wanjiku, confirm } = await seed("alpha");
      await confirm();
      const [row] = await db.select().from(mpesaTransactions);
      await post(
        `/mpesa/transactions/${row.id}/allocate`,
        { studentId: wanjiku.id },
        jsonHeaders("alpha", bursar),
      );

      const res = await post(
        `/mpesa/transactions/${row.id}/reject`,
        { reason: "changed my mind" },
        jsonHeaders("alpha", bursar),
      );

      // Otherwise the ledger would hold a payment whose source says it was
      // never accepted.
      expect(res.status).toBe(409);
    });

    it("does not auto-match a rejected confirmation", async () => {
      const { bursar, confirm } = await seed("alpha");
      await confirm();
      const [row] = await db.select().from(mpesaTransactions);
      await post(
        `/mpesa/transactions/${row.id}/reject`,
        { reason: "duplicate" },
        jsonHeaders("alpha", bursar),
      );

      const res = await post("/mpesa/transactions/match", {}, jsonHeaders("alpha", bursar));

      expect(await res.json()).toMatchObject({ examined: 0, allocated: 0 });
    });
  });

  describe("m-Pesa settings", () => {
    it("403s a bursar — handling Daraja credentials is an admin act", async () => {
      const { school, bursar } = await seed("alpha");
      void school;

      const res = await app.request("/mpesa/settings", {
        headers: tenantHeaders("alpha", bursar),
      });

      expect(res.status).toBe(403);
    });

    it("stores credentials encrypted and never returns them", async () => {
      const { school } = await seed("alpha");
      const admin = await signInAt(school.id, "admin");

      const res = await app.request("/mpesa/settings", {
        method: "PUT",
        headers: jsonHeaders("alpha", admin),
        body: JSON.stringify({
          shortcode: "600638",
          consumerKey: "the-consumer-key",
          consumerSecret: "the-consumer-secret",
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.text();

      // A support session with a screen share must not be able to leak a
      // school's ability to transact.
      expect(body).not.toContain("the-consumer-secret");
      expect(body).not.toContain("the-consumer-key");
      expect(JSON.parse(body)).toMatchObject({
        shortcode: "600638",
        credentialsConfigured: true,
      });

      // And what landed in the column is ciphertext, not the secret.
      const [row] = await db
        .select({ credentials: schools.mpesaCredentials })
        .from(schools)
        .where(eq(schools.id, school.id));

      expect(row.credentials).not.toContain("the-consumer-secret");
      expect(row.credentials!.startsWith("v1.")).toBe(true);
    });

    it("keeps the callback token across a credential change", async () => {
      const { school } = await seed("alpha");
      const admin = await signInAt(school.id, "admin");

      const put = (secret: string) => app.request("/mpesa/settings", {
        method: "PUT",
        headers: jsonHeaders("alpha", admin),
        body: JSON.stringify({
          shortcode: "600638",
          consumerKey: "k",
          consumerSecret: secret,
        }),
      });

      const first = await (await put("first-secret")).json();
      const second = await (await put("rotated-secret")).json();

      /*
       * Rotating the token on every credential change would silently break the
       * URLs already registered with Safaricom — confirmations would arrive at
       * a path nobody answers to, and the school would find out when a parent
       * asked why a payment never showed.
       */
      expect(second.confirmationUrl).toBe(first.confirmationUrl);
      expect(second.confirmationUrl).toMatch(/\/webhooks\/mpesa\/c2b\/.+\/confirmation$/);
    });

    it("reports an unconfigured school honestly", async () => {
      const school = await makeSchool({ subdomain: "gamma" });
      const admin = await signInAt(school.id, "admin");

      const body = await (await app.request("/mpesa/settings", {
        headers: tenantHeaders("gamma", admin),
      })).json();

      expect(body).toMatchObject({
        shortcode: null,
        credentialsConfigured: false,
        confirmationUrl: null,
      });
    });

    it("422s a shortcode that is not digits", async () => {
      const { school } = await seed("alpha");
      const admin = await signInAt(school.id, "admin");

      const res = await app.request("/mpesa/settings", {
        method: "PUT",
        headers: jsonHeaders("alpha", admin),
        body: JSON.stringify({
          shortcode: "not-a-paybill",
          consumerKey: "k",
          consumerSecret: "s",
        }),
      });

      expect(res.status).toBe(422);
    });
  });

  describe("balances", () => {
    it("moves the child's balance once the payment is allocated", async () => {
      const { bursar, wanjiku, confirm } = await seed("alpha");
      await confirm();

      await post("/mpesa/transactions/match", {}, jsonHeaders("alpha", bursar));

      const body = await (await app.request("/balances", {
        headers: tenantHeaders("alpha", bursar),
      })).json();

      const row = body.balances.find(
        (b: { studentId: string }) => b.studentId === wanjiku.id,
      );
      // Nothing billed yet, so the family is in credit by what they paid.
      expect(row.paidCents).toBe(1_800_000);
      expect(row.balanceCents).toBe(-1_800_000);
    });
  });
});
