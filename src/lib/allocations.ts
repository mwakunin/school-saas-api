import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";

import type { AppDb } from "@/db";

import { allocations, invoices, payments } from "@/db/schema";

/**
 * Applying money to bills — the act the payments table deliberately doesn't do.
 *
 * A payment lands as a credit on a student's account; it is the allocation
 * that decides which invoices it settles, in whole or across several at once.
 * Keeping the two acts apart is what lets the M-Pesa matcher bank money it
 * cannot yet attribute instead of guessing a term.
 *
 * This module is where the two invariants live that no CHECK constraint can
 * express (CLAUDE.md §3 rule 4 keeps balances out of storage; these keep
 * allocations from exceeding either side):
 *
 *   - the live allocations on a payment may not exceed the payment's amount
 *   - the live allocations on an invoice may not exceed the invoice's total
 *
 * Both span rows, so both are checked here, inside the caller's transaction.
 * The locks below are what make the checks hold under concurrency, not just
 * on a quiet afternoon: the payment row and then every invoice row (in id
 * order, so two writers arriving at the same pair of invoices cannot
 * deadlock) are taken FOR UPDATE before either sum is read. A second writer
 * blocks on the lock and re-runs its sums on a fresh snapshot once the first
 * has committed — so it sees what the first did, and refuses if the money is
 * no longer there. `allocations.test.ts` runs exactly that race.
 *
 * "Live" means the allocation is not reversed AND its payment is not
 * reversed. Every sum below therefore reads `allocations.reversed_at IS NULL`
 * and — where the payment is not already known live — joins the payment and
 * reads its `reversed_at` too. Nothing copies liveness onto the rows
 * themselves; there is one rule and it is derived.
 *
 * Every function takes the request's transaction (`c.var.db`) and does no
 * filtering on school_id: the connection is tenant-scoped, so the figures are
 * one school's by construction.
 */

/**
 * A request that cannot be satisfied — wrong amounts, the wrong child's bill,
 * a voided invoice — or that lost a race against a concurrent allocation.
 *
 * `conflict` separates the two shapes the route has to return: a request that
 * names money that was never there is a 422 field error; a payment that was
 * reversed (or vanished) between reading and writing is a 409, because
 * resubmitting the same body cannot fix it — the caller must re-fetch.
 */
export class AllocationRefusal extends Error {
  constructor(
    message: string,
    readonly field: string,
    readonly conflict = false,
  ) {
    super(message);
    this.name = "AllocationRefusal";
  }
}

export interface AllocationEntry {
  invoiceId: string;
  amountCents: number;
}

export interface RecordAllocationsInput {
  schoolId: string;
  paymentId: string;
  allocatedBy: string | null;
  entries: AllocationEntry[];
}

/**
 * Allocates part or all of a payment to one or more invoices, atomically.
 *
 * All or nothing: the caller's transaction is the boundary, so any refusal
 * below throws and nothing is written. A parent's receipt is never left
 * half-applied while a bursar reads an error.
 */
export async function recordAllocations(
  db: AppDb,
  input: RecordAllocationsInput,
): Promise<(typeof allocations.$inferSelect)[]> {
  if (input.entries.length === 0)
    return [];

  for (const entry of input.entries) {
    if (entry.amountCents <= 0 || entry.amountCents % 100 !== 0) {
      throw new AllocationRefusal(
        "Allocation amounts must be whole shillings above zero",
        "amountCents",
      );
    }
  }

  /*
   * The payment is locked first and everything else is decided under its
   * lock — a concurrent allocation of the same payment cannot even start
   * summing until this one has committed. The 404/already-reversed cases are
   * usually caught by the route before it calls here; the checks below are
   * what holds when two requests race, not what a quiet client sees.
   */
  const [payment] = await db
    .select()
    .from(payments)
    .where(eq(payments.id, input.paymentId))
    .for("update");

  if (!payment) {
    throw new AllocationRefusal("No such payment at this school", "id", true);
  }

  if (payment.reversedAt) {
    throw new AllocationRefusal(
      "This payment has been reversed and its money is no longer allocatable",
      "id",
      true,
    );
  }

  // Requests name invoices once each, but a caller may legitimately split two
  // lines against the same invoice in one body — so capacity is checked
  // against the combined amount, not per line.
  const requestedByInvoice = new Map<string, number>();
  for (const entry of input.entries) {
    requestedByInvoice.set(
      entry.invoiceId,
      (requestedByInvoice.get(entry.invoiceId) ?? 0) + entry.amountCents,
    );
  }

  const invoiceIds = [...requestedByInvoice.keys()];

  const [appliedToPayment] = await db
    .select({
      total: sql<string>`coalesce(sum(${allocations.amountCents}), 0)`,
    })
    .from(allocations)
    .where(and(
      eq(allocations.paymentId, input.paymentId),
      isNull(allocations.reversedAt),
    ));

  const unallocatedCents
    = payment.amountCents - Number(appliedToPayment.total);
  const requestedTotalCents = [...requestedByInvoice.values()].reduce(
    (sum, amount) => sum + amount,
    0,
  );

  if (requestedTotalCents > unallocatedCents) {
    throw new AllocationRefusal(
      `Allocating ${requestedTotalCents} cents would exceed this payment's `
      + `unallocated ${unallocatedCents} cents`,
      "amountCents",
    );
  }

  const existingAllocations = await db
    .select({ invoiceId: allocations.invoiceId })
    .from(allocations)
    .where(and(
      eq(allocations.paymentId, input.paymentId),
      inArray(allocations.invoiceId, invoiceIds),
      isNull(allocations.reversedAt),
    ));

  if (existingAllocations.length > 0) {
    throw new AllocationRefusal(
      "An allocation for one of these invoices already exists on this payment. Reverse it to record the combined amount.",
      "invoiceId",
    );
  }

  /*
   * Id order is lock order. Two bursars allocating different payments to the
   * same two invoices would otherwise lock them in opposite orders and each
   * wait for ever on the other. Sorting the locking SELECT is cheaper than
   * explaining a deadlock to a bursar.
   */
  const lockedInvoices = await db
    .select()
    .from(invoices)
    .where(inArray(invoices.id, invoiceIds))
    .orderBy(asc(invoices.id))
    .for("update");

  const lockedById = new Map(lockedInvoices.map(i => [i.id, i]));

  // Live allocations already sitting on these invoices, from OTHER payments.
  // This payment's own contributions are not in the table yet, so nothing is
  // double-counted; the payment-side sum above already covered them.
  const appliedByInvoice = await db
    .select({
      invoiceId: allocations.invoiceId,
      total: sql<string>`coalesce(sum(${allocations.amountCents}), 0)`,
    })
    .from(allocations)
    .innerJoin(payments, and(
      eq(allocations.paymentId, payments.id),
      eq(allocations.schoolId, payments.schoolId),
    ))
    .where(and(
      inArray(allocations.invoiceId, invoiceIds),
      isNull(allocations.reversedAt),
      // An allocation whose payment was reversed frees its share of the
      // invoice — the money is no longer there, so it cannot be occupying
      // capacity. Reading liveness here is the invoice-side half of the rule.
      isNull(payments.reversedAt),
    ))
    .groupBy(allocations.invoiceId);

  const appliedCentsByInvoice = new Map(
    appliedByInvoice.map(r => [r.invoiceId, Number(r.total)]),
  );

  for (const [invoiceId, requestedCents] of requestedByInvoice) {
    const invoice = lockedById.get(invoiceId);

    if (!invoice) {
      throw new AllocationRefusal(
        "No such invoice at this school",
        "invoiceId",
      );
    }

    if (invoice.voidedAt) {
      throw new AllocationRefusal(
        "This invoice has been voided and cannot take an allocation",
        "invoiceId",
      );
    }

    if (invoice.studentId !== payment.studentId) {
      // Unrepresentable at the foreign keys — both references carry the
      // student — so this only fires with a clear message instead of a 23503
      // from deep inside the insert.
      throw new AllocationRefusal(
        "This invoice belongs to a different student than the payment",
        "invoiceId",
      );
    }

    const appliedCents = appliedCentsByInvoice.get(invoiceId) ?? 0;

    if (appliedCents + requestedCents > invoice.totalCents) {
      throw new AllocationRefusal(
        `Allocating ${requestedCents} cents would exceed this invoice's `
        + `unsettled ${invoice.totalCents - appliedCents} cents`,
        "amountCents",
      );
    }
  }

  return db
    .insert(allocations)
    .values(Array.from(requestedByInvoice.entries()).map(([invoiceId, amountCents]) => ({
      schoolId: input.schoolId,
      studentId: payment.studentId,
      paymentId: input.paymentId,
      invoiceId,
      amountCents,
      allocatedBy: input.allocatedBy,
    })))
    .returning();
}

/**
 * Un-applies one allocation, returning the updated row.
 *
 * Returns `null` when the allocation does not exist — the caller turns that
 * into a 404 — and refuses with `conflict` when it was reversed a moment ago
 * by someone else, the same race the payment reversal handles with a
 * predicate rather than a pre-check.
 *
 * No cascade: the money simply returns to the payment's unallocated pool,
 * where `recordAllocations` can spend it again. The payment itself is not
 * touched.
 */
export async function reverseAllocation(
  db: AppDb,
  input: { allocationId: string; reason: string },
): Promise<(typeof allocations.$inferSelect) | null> {
  const [row] = await db
    .update(allocations)
    .set({ reversedAt: new Date(), reversalReason: input.reason })
    .where(and(
      eq(allocations.id, input.allocationId),
      isNull(allocations.reversedAt),
    ))
    .returning();

  if (row)
    return row;

  // Nothing matched. Either it never existed or it was reversed between the
  // caller's read and this write — distinguish them so the answer is not a
  // guess.
  const [existing] = await db
    .select({ reversedAt: allocations.reversedAt })
    .from(allocations)
    .where(eq(allocations.id, input.allocationId));

  if (!existing)
    return null;

  throw new AllocationRefusal(
    "This allocation was reversed by someone else a moment ago",
    "id",
    true,
  );
}
