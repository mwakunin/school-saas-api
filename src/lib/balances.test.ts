import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import db, { appDb } from "@/db";
import { invoices, payments } from "@/db/schema";
import { balanceFor, invoiceBalancesFor, isInCredit } from "@/lib/balances";
import {
  makeInvoice,
  makePayment,
  makeSchool,
  makeStudent,
  resetDb,
} from "@/test/helpers";

/**
 * The one definition of what a family owes.
 *
 * CLAUDE.md §3 rule 4 states the formula as `sum(invoices) - sum(payments)`.
 * These tests are mostly about the two things that phrasing leaves out — a
 * voided invoice is not owed, and a reversed payment was not paid — because
 * getting either wrong duns a parent for a bill that was cancelled, or hides a
 * debt behind a receipt that bounced.
 */
/** Voided through the owner connection: test setup, not behaviour under test. */
async function voidInvoice(invoiceId: string) {
  await db
    .update(invoices)
    .set({ voidedAt: new Date(), voidReason: "test" })
    .where(eq(invoices.id, invoiceId));
}

async function reversePayment(paymentId: string) {
  await db
    .update(payments)
    .set({ reversedAt: new Date(), reversalReason: "test" })
    .where(eq(payments.id, paymentId));
}

async function inTenant<T>(schoolId: string, fn: (db: never) => Promise<T>): Promise<T> {
  return appDb.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.school_id', ${schoolId}, true)`);
    return fn(tx as never);
  });
}

describe("balances", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("is billed minus paid", async () => {
    const school = await makeSchool({ subdomain: "alpha" });
    const student = await makeStudent(school, "2026/001");
    await makeInvoice(school, student, { totalCents: 2_500_000 });
    await makePayment(school, student, { amountCents: 1_000_000 });

    const balance = await inTenant(school.id, db => balanceFor(db, student.id));

    expect(balance).toMatchObject({
      billedCents: 2_500_000,
      paidCents: 1_000_000,
      balanceCents: 1_500_000,
    });
  });

  it("excludes a voided invoice from what is owed", async () => {
    const school = await makeSchool({ subdomain: "alpha" });
    const student = await makeStudent(school, "2026/001");
    const invoice = await makeInvoice(school, student, { totalCents: 2_500_000 });
    await makeInvoice(school, student, { totalCents: 1_200_000, termIndex: 1 });

    const before = await inTenant(school.id, db => balanceFor(db, student.id));
    expect(before.balanceCents).toBe(3_700_000);

    await voidInvoice(invoice.id);

    // A cancelled bill is not a debt. Missing this is how a parent gets a
    // reminder for fees the school already agreed to drop.
    const after = await inTenant(school.id, db => balanceFor(db, student.id));
    expect(after.billedCents).toBe(1_200_000);
    expect(after.balanceCents).toBe(1_200_000);
  });

  it("excludes a reversed payment from what was paid", async () => {
    const school = await makeSchool({ subdomain: "alpha" });
    const student = await makeStudent(school, "2026/001");
    await makeInvoice(school, student, { totalCents: 2_500_000 });
    const payment = await makePayment(school, student, { amountCents: 2_500_000 });

    const before = await inTenant(school.id, db => balanceFor(db, student.id));
    expect(before.balanceCents).toBe(0);

    await reversePayment(payment.id);

    // A bounced cheque or a receipt entered against the wrong child. The debt
    // has to come back, or the school never chases money it is still owed.
    const after = await inTenant(school.id, db => balanceFor(db, student.id));
    expect(after.paidCents).toBe(0);
    expect(after.balanceCents).toBe(2_500_000);
  });

  it("reports a credit rather than clamping to zero", async () => {
    const school = await makeSchool({ subdomain: "alpha" });
    const student = await makeStudent(school, "2026/001");
    await makeInvoice(school, student, { totalCents: 1_000_000 });
    await makePayment(school, student, { amountCents: 1_500_000 });

    const balance = await inTenant(school.id, db => balanceFor(db, student.id));

    // Overpayment is real money the school holds. Clamping would lose it and
    // make next term's invoice look unpaid.
    expect(balance.balanceCents).toBe(-500_000);
    expect(isInCredit(balance)).toBe(true);
  });

  it("returns zeros for a student with no activity", async () => {
    const school = await makeSchool({ subdomain: "alpha" });
    const student = await makeStudent(school, "2026/001");

    const balance = await inTenant(school.id, db => balanceFor(db, student.id));

    expect(balance).toEqual({
      studentId: student.id,
      billedCents: 0,
      paidCents: 0,
      balanceCents: 0,
    });
  });

  it("does not multiply sums when a student has several of each", async () => {
    const school = await makeSchool({ subdomain: "alpha" });
    const student = await makeStudent(school, "2026/001");

    // Three invoices and two payments. Joining the two tables would produce
    // six rows and inflate both sums — the classic fan-out, and the reason
    // balancesFor aggregates each side separately.
    await makeInvoice(school, student, { totalCents: 1_000_000, termIndex: 0 });
    await makeInvoice(school, student, { totalCents: 1_000_000, termIndex: 1 });
    await makeInvoice(school, student, { totalCents: 1_000_000, termIndex: 2 });
    await makePayment(school, student, { amountCents: 500_000 });
    await makePayment(school, student, { amountCents: 700_000 });

    const balance = await inTenant(school.id, db => balanceFor(db, student.id));

    expect(balance.billedCents).toBe(3_000_000);
    expect(balance.paidCents).toBe(1_200_000);
    expect(balance.balanceCents).toBe(1_800_000);
  });

  it("keeps one school's money out of another's", async () => {
    const alpha = await makeSchool({ subdomain: "alpha" });
    const beta = await makeSchool({ subdomain: "beta" });
    const alphaStudent = await makeStudent(alpha, "2026/001");
    const betaStudent = await makeStudent(beta, "2026/001");

    await makeInvoice(alpha, alphaStudent, { totalCents: 1_000_000 });
    await makeInvoice(beta, betaStudent, { totalCents: 9_900_000 });

    const balance = await inTenant(alpha.id, db => balanceFor(db, alphaStudent.id));
    expect(balance.billedCents).toBe(1_000_000);

    // Asking for another school's student by id returns zeros, not their
    // figures — the rows are simply not visible on this connection.
    const other = await inTenant(alpha.id, db => balanceFor(db, betaStudent.id));
    expect(other.billedCents).toBe(0);
  });

  describe("per invoice", () => {
    it("counts only payments allocated to that invoice", async () => {
      const school = await makeSchool({ subdomain: "alpha" });
      const student = await makeStudent(school, "2026/001");
      const invoice = await makeInvoice(school, student, { totalCents: 2_500_000 });

      await makePayment(school, student, {
        amountCents: 1_000_000,
        invoiceId: invoice.id,
      });
      // A credit on account: real money, not attributed to a term.
      await makePayment(school, student, { amountCents: 400_000 });

      const perInvoice = await inTenant(school.id, db =>
        invoiceBalancesFor(db, [invoice.id]));
      const studentBalance = await inTenant(school.id, db =>
        balanceFor(db, student.id));

      expect(perInvoice.get(invoice.id)).toMatchObject({
        totalCents: 2_500_000,
        paidCents: 1_000_000,
        outstandingCents: 1_500_000,
      });

      // The two figures legitimately disagree, which is why a screen showing
      // both has to say which is which.
      expect(studentBalance.paidCents).toBe(1_400_000);
      expect(studentBalance.balanceCents).toBe(1_100_000);
    });

    it("owes nothing on a voided invoice that was already paid", async () => {
      const school = await makeSchool({ subdomain: "alpha" });
      const student = await makeStudent(school, "2026/001");
      const invoice = await makeInvoice(school, student, { totalCents: 2_500_000 });
      await makePayment(school, student, {
        amountCents: 1_000_000,
        invoiceId: invoice.id,
      });

      await voidInvoice(invoice.id);

      const perInvoice = await inTenant(school.id, db =>
        invoiceBalancesFor(db, [invoice.id]));

      // Not `0 - paidCents`. A negative amount outstanding reads on a
      // statement as the school owing the family on this invoice, which is
      // not a claim one invoice can make. Whether a refund is due is a
      // question about the student's balance, below.
      expect(perInvoice.get(invoice.id)).toMatchObject({
        totalCents: 0,
        paidCents: 1_000_000,
        outstandingCents: 0,
      });

      // The payment still counts towards what the family is owed overall.
      const balance = await inTenant(school.id, db => balanceFor(db, student.id));
      expect(balance.balanceCents).toBe(-1_000_000);
    });

    it("owes nothing on a voided invoice, whatever its total says", async () => {
      const school = await makeSchool({ subdomain: "alpha" });
      const student = await makeStudent(school, "2026/001");
      const invoice = await makeInvoice(school, student, { totalCents: 2_500_000 });

      await voidInvoice(invoice.id);

      const perInvoice = await inTenant(school.id, db =>
        invoiceBalancesFor(db, [invoice.id]));

      expect(perInvoice.get(invoice.id)).toMatchObject({
        totalCents: 0,
        outstandingCents: 0,
      });
    });
  });
});
