import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import app from "@/app";
import db from "@/db";
import { mpesaTransactions, payments, schools } from "@/db/schema";
import { generateCallbackToken } from "@/lib/crypto";
import { makeSchool, resetDb } from "@/test/helpers";

/**
 * The Safaricom callback.
 *
 * Its whole job is to write a row and return 200 (CLAUDE.md §5.8). Most of
 * what follows is about the ways it must NOT fail: Safaricom retries anything
 * it does not see acknowledged, so an endpoint that rejects is an endpoint
 * that loses payments.
 */
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

async function withPaybill(subdomain: string, shortcode = "600638") {
  const school = await makeSchool({ subdomain });
  const token = generateCallbackToken();

  await db
    .update(schools)
    .set({ mpesaShortcode: shortcode, mpesaCallbackToken: token })
    .where(eq(schools.id, school.id));

  return { school, token };
}

function post(path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("m-Pesa C2B webhook", () => {
  beforeEach(async () => {
    await resetDb();
  });

  describe("storing a confirmation", () => {
    it("records what Safaricom sent and acknowledges it", async () => {
      const { school, token } = await withPaybill("alpha");

      const res = await post(`/webhooks/mpesa/c2b/${token}/confirmation`, CONFIRMATION);

      expect(res.status).toBe(200);
      // Daraja treats anything but ResultCode 0 as a failure and retries.
      expect(await res.json()).toEqual({ ResultCode: 0, ResultDesc: "Accepted" });

      const [row] = await db.select().from(mpesaTransactions);
      expect(row).toMatchObject({
        schoolId: school.id,
        transactionId: "RKTQDM7W6S",
        accountReference: "2026/118",
        amountCents: 1_800_000,
        msisdn: "254712345678",
        payerName: "GRACE NJOROGE",
        status: "unmatched",
      });
    });

    it("keeps the whole envelope, including fields we do not model", async () => {
      const { token } = await withPaybill("alpha");

      await post(`/webhooks/mpesa/c2b/${token}/confirmation`, {
        ...CONFIRMATION,
        OrgAccountBalance: "49197.00",
        SomethingNew: "from a future Daraja",
      });

      const [row] = await db.select().from(mpesaTransactions);
      // The raw payload is the only independent record of what was said.
      expect(row.rawPayload).toMatchObject({
        OrgAccountBalance: "49197.00",
        SomethingNew: "from a future Daraja",
      });
    });

    it("creates no payment — matching is a separate step", async () => {
      const { token } = await withPaybill("alpha");
      await post(`/webhooks/mpesa/c2b/${token}/confirmation`, CONFIRMATION);

      expect(await db.select().from(payments)).toHaveLength(0);
    });
  });

  describe("retries and duplicates", () => {
    it("acknowledges a repeated confirmation without storing it twice", async () => {
      const { token } = await withPaybill("alpha");

      const first = await post(`/webhooks/mpesa/c2b/${token}/confirmation`, CONFIRMATION);
      const second = await post(`/webhooks/mpesa/c2b/${token}/confirmation`, CONFIRMATION);

      // Safaricom retries anything it does not see acknowledged. A retry that
      // became a second row would become a second payment.
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(await db.select().from(mpesaTransactions)).toHaveLength(1);
    });
  });

  describe("refusing to guess", () => {
    it("stores a reference that matches no child, and still returns 200", async () => {
      const { token } = await withPaybill("alpha");

      const res = await post(`/webhooks/mpesa/c2b/${token}/confirmation`, {
        ...CONFIRMATION,
        BillRefNumber: "WHO KNOWS",
      });

      // "It never fails on an unrecognised reference" — that is the normal
      // case, and the reconciliation queue is where it gets resolved.
      expect(res.status).toBe(200);
      const [row] = await db.select().from(mpesaTransactions);
      expect(row.accountReference).toBe("WHO KNOWS");
      expect(row.status).toBe("unmatched");
    });

    it("stores a confirmation with no reference at all", async () => {
      const { token } = await withPaybill("alpha");

      const res = await post(`/webhooks/mpesa/c2b/${token}/confirmation`, {
        ...CONFIRMATION,
        BillRefNumber: "",
      });

      expect(res.status).toBe(200);
      expect((await db.select().from(mpesaTransactions))[0].accountReference).toBeNull();
    });

    it("acknowledges an unparseable payload rather than inviting retries", async () => {
      const { token } = await withPaybill("alpha");

      const res = await post(`/webhooks/mpesa/c2b/${token}/confirmation`, {
        TransID: "X",
      });

      // Retrying will not make a malformed payload parse.
      expect(res.status).toBe(200);
      expect(await db.select().from(mpesaTransactions)).toHaveLength(0);
    });
  });

  describe("the tenant comes from the path, not the payload", () => {
    it("404s a token no school answers to", async () => {
      await withPaybill("alpha");

      const res = await post(
        `/webhooks/mpesa/c2b/${generateCallbackToken()}/confirmation`,
        CONFIRMATION,
      );

      // Our own misconfiguration, not a transient fault — a 200 would swallow
      // it while real payments went nowhere.
      expect(res.status).toBe(404);
      expect(await db.select().from(mpesaTransactions)).toHaveLength(0);
    });

    it("attributes the payment to the school owning the token", async () => {
      const alpha = await withPaybill("alpha", "600638");
      const beta = await withPaybill("beta", "700100");

      await post(`/webhooks/mpesa/c2b/${beta.token}/confirmation`, {
        ...CONFIRMATION,
        BusinessShortCode: "700100",
      });

      const [row] = await db.select().from(mpesaTransactions);
      expect(row.schoolId).toBe(beta.school.id);
      expect(row.schoolId).not.toBe(alpha.school.id);
    });

    it("rejects a payload claiming another school's shortcode", async () => {
      const { school, token } = await withPaybill("alpha", "600638");

      /*
       * The attack CLAUDE.md §5.8 would have allowed.
       *
       * Resolving the tenant from the payload's shortcode means anyone can
       * file fabricated payments against any school. The token already decided
       * the tenant here, so a disagreeing shortcode is stored as evidence and
       * never treated as money owed.
       */
      const res = await post(`/webhooks/mpesa/c2b/${token}/confirmation`, {
        ...CONFIRMATION,
        BusinessShortCode: "999999",
      });

      expect(res.status).toBe(200);

      const [row] = await db.select().from(mpesaTransactions);
      expect(row.schoolId).toBe(school.id);
      expect(row.status).toBe("rejected");
      expect(row.statusReason).toMatch(/999999/);
    });

    it("does not let a guessed token reach a school", async () => {
      await withPaybill("alpha");

      for (const guess of ["", "short", "a".repeat(43)]) {
        const res = await post(
          `/webhooks/mpesa/c2b/${guess}/confirmation`,
          CONFIRMATION,
        );
        expect([404, 405, 400]).toContain(res.status);
      }

      expect(await db.select().from(mpesaTransactions)).toHaveLength(0);
    });
  });

  describe("validation endpoint", () => {
    it("accepts a payment whose reference we do not recognise", async () => {
      const { token } = await withPaybill("alpha");

      const res = await post(`/webhooks/mpesa/c2b/${token}/validation`, {
        ...CONFIRMATION,
        BillRefNumber: "NONSENSE",
      });

      // Validation runs BEFORE the money moves. Refusing here declines a
      // parent's fees at the till because our records did not recognise what
      // they typed — which is the normal case, not an error.
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ResultCode: 0 });
    });

    it("accepts even for an unknown token", async () => {
      const res = await post(
        `/webhooks/mpesa/c2b/${generateCallbackToken()}/validation`,
        CONFIRMATION,
      );

      // Our misconfiguration must not become their declined payment.
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ResultCode: 0 });
    });
  });

  describe("the raw row is append-only", () => {
    it("refuses to alter what Safaricom said", async () => {
      const { token } = await withPaybill("alpha");
      await post(`/webhooks/mpesa/c2b/${token}/confirmation`, CONFIRMATION);
      const [row] = await db.select().from(mpesaTransactions);

      /*
       * The database enforces this, not a convention.
       *
       * §5.8 rests a claim on it: "because the raw row is never mutated,
       * mis-allocation is always reversible". A handler that helpfully
       * corrected an amount would destroy the only independent record of what
       * actually happened — and the corruption would be undetectable
       * afterwards, because the evidence is the thing that changed.
       */
      await expect(
        db.update(mpesaTransactions)
          .set({ amountCents: 100 })
          .where(eq(mpesaTransactions.id, row.id)),
      ).rejects.toThrow();

      await expect(
        db.update(mpesaTransactions)
          .set({ accountReference: "2026/999" })
          .where(eq(mpesaTransactions.id, row.id)),
      ).rejects.toThrow();
    });

    it("allows the status to change, which is a decision about the row", async () => {
      const { token } = await withPaybill("alpha");
      await post(`/webhooks/mpesa/c2b/${token}/confirmation`, CONFIRMATION);
      const [row] = await db.select().from(mpesaTransactions);

      await db
        .update(mpesaTransactions)
        .set({ status: "rejected", statusReason: "not school fees" })
        .where(eq(mpesaTransactions.id, row.id));

      const [updated] = await db.select().from(mpesaTransactions);
      expect(updated.status).toBe("rejected");
      expect(updated.amountCents).toBe(row.amountCents);
    });
  });
});
