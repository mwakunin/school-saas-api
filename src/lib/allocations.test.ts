import { and, eq, isNull, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import type { AppDb } from "@/db";

import db, { appDb } from "@/db";
import { allocations, invoices, payments } from "@/db/schema";
import {
  AllocationRefusal,
  recordAllocations,
  reverseAllocation,
} from "@/lib/allocations";
import {
  backendPid,
  makeAllocation,
  makeInvoice,
  makePayment,
  makeSchool,
  makeStudent,
  resetDb,
  waitForBlockedBackend,
} from "@/test/helpers";

/**
 * The two invariants no CHECK constraint can express.
 *
 * The schema stops an allocation pointing at the wrong child's money (the
 * foreign keys carry student_id); it cannot stop an allocation spending money
 * another allocation already spent, because that is a question about SIBLING
 * rows. That is `recordAllocations`' job, inside the caller's transaction,
 * under row locks — and these tests are mostly about whether that holds when
 * two bursars race, not just when one works alone.
 */
async function inTenant<T>(schoolId: string, fn: (tx: AppDb) => Promise<T>): Promise<T> {
  return appDb.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.school_id', ${schoolId}, true)`);
    return fn(tx);
  });
}

async function liveAllocatedCents(paymentId: string) {
  const rows = await db
    .select({ total: allocations.amountCents })
    .from(allocations)
    .where(and(eq(allocations.paymentId, paymentId), isNull(allocations.reversedAt)));

  return rows.reduce((sum, r) => sum + r.total, 0);
}

describe("recordAllocations", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("refuses to spend more than the payment holds", async () => {
    const school = await makeSchool({ subdomain: "alpha" });
    const student = await makeStudent(school, "2026/001");
    const invoice = await makeInvoice(school, student, { totalCents: 5_000_000 });
    const payment = await makePayment(school, student, { amountCents: 1_000_000 });

    const refusal = inTenant(school.id, tx =>
      recordAllocations(tx, {
        schoolId: school.id,
        paymentId: payment.id,
        allocatedBy: null,
        entries: [{ invoiceId: invoice.id, amountCents: 1_800_000 }],
      }));

    await expect(refusal).rejects.toMatchObject({
      name: "AllocationRefusal",
      field: "amountCents",
      conflict: false,
    });
    expect(await liveAllocatedCents(payment.id)).toBe(0);
  });

  it("refuses to settle an invoice beyond its total", async () => {
    const school = await makeSchool({ subdomain: "alpha" });
    const student = await makeStudent(school, "2026/001");
    const invoice = await makeInvoice(school, student, { totalCents: 1_800_000 });
    const first = await makePayment(school, student, { amountCents: 1_500_000 });
    const second = await makePayment(school, student, { amountCents: 1_500_000 });
    await makeAllocation(school, first, invoice, { amountCents: 1_500_000 });

    const refusal = inTenant(school.id, tx =>
      recordAllocations(tx, {
        schoolId: school.id,
        paymentId: second.id,
        allocatedBy: null,
        entries: [{ invoiceId: invoice.id, amountCents: 500_000 }],
      }));

    await expect(refusal).rejects.toMatchObject({
      name: "AllocationRefusal",
      field: "amountCents",
      conflict: false,
    });
  });

  it("refuses the whole request when one entry is impossible", async () => {
    const school = await makeSchool({ subdomain: "alpha" });
    const student = await makeStudent(school, "2026/001");
    const invoice = await makeInvoice(school, student, { totalCents: 5_000_000 });
    const other = await makeStudent(school, "2026/002");
    const otherInvoice = await makeInvoice(school, other, { totalCents: 5_000_000 });
    const payment = await makePayment(school, student, { amountCents: 3_000_000 });

    const refusal = inTenant(school.id, tx =>
      recordAllocations(tx, {
        schoolId: school.id,
        paymentId: payment.id,
        allocatedBy: null,
        entries: [
          { invoiceId: invoice.id, amountCents: 1_000_000 },
          { invoiceId: otherInvoice.id, amountCents: 1_000_000 },
        ],
      }));

    await expect(refusal).rejects.toThrow(AllocationRefusal);

    // All or nothing. Half-applied allocations would leave the receipt
    // part-spent by a request the bursar saw fail — and which they would
    // reasonably retry, spending twice.
    const rows = await db
      .select()
      .from(allocations)
      .where(eq(allocations.paymentId, payment.id));
    expect(rows).toEqual([]);
  });

  it("refuses a voided invoice, another child's invoice and an unknown one", async () => {
    const school = await makeSchool({ subdomain: "alpha" });
    const student = await makeStudent(school, "2026/001");
    const sibling = await makeStudent(school, "2026/002");
    const voided = await makeInvoice(school, student, { totalCents: 1_800_000 });
    await db
      .update(invoices)
      .set({ voidedAt: new Date(), voidReason: "test" })
      .where(eq(invoices.id, voided.id));
    const siblingInvoice = await makeInvoice(school, sibling, { totalCents: 1_800_000 });
    const payment = await makePayment(school, student, { amountCents: 3_000_000 });

    await expect(inTenant(school.id, tx =>
      recordAllocations(tx, {
        schoolId: school.id,
        paymentId: payment.id,
        allocatedBy: null,
        entries: [{ invoiceId: voided.id, amountCents: 500_000 }],
      }))).rejects.toMatchObject({ field: "invoiceId", conflict: false });

    await expect(inTenant(school.id, tx =>
      recordAllocations(tx, {
        schoolId: school.id,
        paymentId: payment.id,
        allocatedBy: null,
        entries: [{ invoiceId: siblingInvoice.id, amountCents: 500_000 }],
      }))).rejects.toMatchObject({ field: "invoiceId", conflict: false });

    await expect(inTenant(school.id, tx =>
      recordAllocations(tx, {
        schoolId: school.id,
        paymentId: payment.id,
        allocatedBy: null,
        entries: [{
          invoiceId: "00000000-0000-4000-8000-000000000000",
          amountCents: 500_000,
        }],
      }))).rejects.toMatchObject({ field: "invoiceId", conflict: false });
  });

  it("refuses a reversed or unknown payment", async () => {
    const school = await makeSchool({ subdomain: "alpha" });
    const student = await makeStudent(school, "2026/001");
    const invoice = await makeInvoice(school, student, { totalCents: 1_800_000 });
    const reversed = await makePayment(school, student, { amountCents: 1_800_000 });
    await db
      .update(payments)
      .set({ reversedAt: new Date(), reversalReason: "test" })
      .where(eq(payments.id, reversed.id));

    // A reversed payment's money has left the account: 409, not 422 —
    // resubmitting cannot fix it.
    await expect(inTenant(school.id, tx =>
      recordAllocations(tx, {
        schoolId: school.id,
        paymentId: reversed.id,
        allocatedBy: null,
        entries: [{ invoiceId: invoice.id, amountCents: 500_000 }],
      }))).rejects.toMatchObject({ conflict: true });

    await expect(inTenant(school.id, tx =>
      recordAllocations(tx, {
        schoolId: school.id,
        paymentId: "00000000-0000-4000-8000-000000000000",
        allocatedBy: null,
        entries: [{ invoiceId: invoice.id, amountCents: 500_000 }],
      }))).rejects.toMatchObject({ conflict: true });
  });

  it("refuses amounts that are not whole shillings", async () => {
    const school = await makeSchool({ subdomain: "alpha" });
    const student = await makeStudent(school, "2026/001");
    const invoice = await makeInvoice(school, student, { totalCents: 5_000_000 });
    // The payment itself must be whole — the payments CHECK sees to that — so
    // the split being refused is a non-whole piece of a whole receipt.
    const payment = await makePayment(school, student, { amountCents: 1_000_000 });

    await expect(inTenant(school.id, tx =>
      recordAllocations(tx, {
        schoolId: school.id,
        paymentId: payment.id,
        allocatedBy: null,
        entries: [{ invoiceId: invoice.id, amountCents: 500_050 }],
      }))).rejects.toMatchObject({ field: "amountCents" });
  });

  it("frees an invoice's capacity when the payment behind an allocation is reversed", async () => {
    const school = await makeSchool({ subdomain: "alpha" });
    const student = await makeStudent(school, "2026/001");
    const invoice = await makeInvoice(school, student, { totalCents: 1_800_000 });
    const bounced = await makePayment(school, student, { amountCents: 1_800_000 });
    await makeAllocation(school, bounced, invoice, { amountCents: 1_800_000 });

    // The cheque bounces; the allocation is untouched but its payment is dead.
    await db
      .update(payments)
      .set({ reversedAt: new Date(), reversalReason: "bounced" })
      .where(eq(payments.id, bounced.id));

    const fresh = await makePayment(school, student, { amountCents: 1_800_000 });

    // If the dead allocation still occupied capacity, this would refuse — and
    // the family could never settle the bill by a different route.
    const created = await inTenant(school.id, tx =>
      recordAllocations(tx, {
        schoolId: school.id,
        paymentId: fresh.id,
        allocatedBy: null,
        entries: [{ invoiceId: invoice.id, amountCents: 1_800_000 }],
      }));

    expect(created).toHaveLength(1);
  });

  describe("under concurrency", () => {
    it("makes the second writer of one payment see the first's work", async () => {
      const school = await makeSchool({ subdomain: "alpha" });
      const student = await makeStudent(school, "2026/001");
      const invoice = await makeInvoice(school, student, { totalCents: 5_000_000 });
      const payment = await makePayment(school, student, { amountCents: 2_000_000 });

      const entry = [{ invoiceId: invoice.id, amountCents: 2_000_000 }];

      /*
       * The first transaction allocates the full payment and STAYS OPEN, so
       * the row lock it took stays held. A fixed sleep before the second
       * writer would only guess the lock was held; waiting on pg_stat_activity
       * (below) observes it.
       */
      const holderPid = Promise.withResolvers<number>();
      const holderDone = Promise.withResolvers<void>();
      const gate = Promise.withResolvers<void>();

      const holder = appDb.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.school_id', ${school.id}, true)`);
        holderPid.resolve(await backendPid(tx as never));
        await recordAllocations(tx as never, {
          schoolId: school.id,
          paymentId: payment.id,
          allocatedBy: null,
          entries: entry,
        });
        holderDone.resolve();
        await gate.promise;
      });

      try {
        await holderDone.promise;

        const secondWriter = appDb.transaction(async (tx) => {
          await tx.execute(sql`SELECT set_config('app.school_id', ${school.id}, true)`);
          return recordAllocations(tx as never, {
            schoolId: school.id,
            paymentId: payment.id,
            allocatedBy: null,
            entries: entry,
          });
        });

        // Blocked on the payment's row lock — the lock IS the mechanism; if
        // it were missing the second writer would read an empty allocations
        // table and double-spend.
        expect(await waitForBlockedBackend(await holderPid.promise)).toBe(true);
        gate.resolve();
        await holder;

        await expect(secondWriter).rejects.toMatchObject({
          name: "AllocationRefusal",
          conflict: false,
        });

        // Exactly one payment's worth exists, not two.
        expect(await liveAllocatedCents(payment.id)).toBe(2_000_000);
      }
      finally {
        gate.resolve();
        await holder.catch(() => undefined);
      }
    });

    it("serializes two payments chasing the same invoice", async () => {
      const school = await makeSchool({ subdomain: "alpha" });
      const student = await makeStudent(school, "2026/001");
      const invoice = await makeInvoice(school, student, { totalCents: 2_000_000 });
      const first = await makePayment(school, student, { amountCents: 1_600_000 });
      const second = await makePayment(school, student, { amountCents: 1_600_000 });

      const holderPid = Promise.withResolvers<number>();
      const holderDone = Promise.withResolvers<void>();
      const gate = Promise.withResolvers<void>();

      const holder = appDb.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.school_id', ${school.id}, true)`);
        holderPid.resolve(await backendPid(tx as never));
        await recordAllocations(tx as never, {
          schoolId: school.id,
          paymentId: first.id,
          allocatedBy: null,
          entries: [{ invoiceId: invoice.id, amountCents: 1_600_000 }],
        });
        holderDone.resolve();
        await gate.promise;
      });

      try {
        await holderDone.promise;

        const secondWriter = appDb.transaction(async (tx) => {
          await tx.execute(sql`SELECT set_config('app.school_id', ${school.id}, true)`);
          return recordAllocations(tx as never, {
            schoolId: school.id,
            paymentId: second.id,
            allocatedBy: null,
            entries: [{ invoiceId: invoice.id, amountCents: 1_600_000 }],
          });
        });

        // Different payments, so the payment lock is not what could serialize
        // them — the invoice's row lock is. The invoice holds 2,000,000 and
        // 1,600,000 has just been applied; the second writer must see that
        // once unblocked, and refuse.
        expect(await waitForBlockedBackend(await holderPid.promise)).toBe(true);
        gate.resolve();
        await holder;

        await expect(secondWriter).rejects.toMatchObject({
          name: "AllocationRefusal",
          conflict: false,
        });

        const [onInvoice] = await db
          .select({ total: sql<string>`coalesce(sum(${allocations.amountCents}), 0)` })
          .from(allocations)
          .where(and(eq(allocations.invoiceId, invoice.id), isNull(allocations.reversedAt)));
        expect(Number(onInvoice.total)).toBe(1_600_000);
      }
      finally {
        gate.resolve();
        await holder.catch(() => undefined);
      }
    });
  });
});

describe("reverseAllocation", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("reverses, and the money returns to the payment's unallocated pool", async () => {
    const school = await makeSchool({ subdomain: "alpha" });
    const student = await makeStudent(school, "2026/001");
    const invoice = await makeInvoice(school, student, { totalCents: 2_000_000 });
    const payment = await makePayment(school, student, { amountCents: 2_000_000 });
    const allocation = await makeAllocation(school, payment, invoice, { amountCents: 2_000_000 });

    const reversed = await inTenant(school.id, tx =>
      reverseAllocation(tx, { allocationId: allocation.id, reason: "wrong term" }));

    expect(reversed).toMatchObject({
      id: allocation.id,
      reversalReason: "wrong term",
    });
    expect(reversed!.reversedAt).not.toBeNull();

    // The payment was untouched — only the allocation stands down.
    const [after] = await db.select().from(payments).where(eq(payments.id, payment.id));
    expect(after.reversedAt).toBeNull();
  });

  it("answers null for an allocation that does not exist", async () => {
    const school = await makeSchool({ subdomain: "alpha" });

    const missing = await inTenant(school.id, tx =>
      reverseAllocation(tx, {
        allocationId: "00000000-0000-4000-8000-000000000000",
        reason: "anything",
      }));

    expect(missing).toBeNull();
  });

  it("refuses a second reversal rather than rewriting the first reason", async () => {
    const school = await makeSchool({ subdomain: "alpha" });
    const student = await makeStudent(school, "2026/001");
    const invoice = await makeInvoice(school, student, { totalCents: 2_000_000 });
    const payment = await makePayment(school, student, { amountCents: 2_000_000 });
    const allocation = await makeAllocation(school, payment, invoice, { amountCents: 2_000_000 });

    await inTenant(school.id, tx =>
      reverseAllocation(tx, { allocationId: allocation.id, reason: "first" }));

    const again = inTenant(school.id, tx =>
      reverseAllocation(tx, { allocationId: allocation.id, reason: "second" }));

    // Whoever reversed it first said why; the second click must not overwrite
    // that with its own story.
    await expect(again).rejects.toMatchObject({ conflict: true });
    const [row] = await db
      .select()
      .from(allocations)
      .where(eq(allocations.id, allocation.id));
    expect(row.reversalReason).toBe("first");
  });
});
