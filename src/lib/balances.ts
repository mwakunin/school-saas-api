import { and, inArray, isNull, sql } from "drizzle-orm";

import type { AppDb } from "@/db";

import { invoices, payments } from "@/db/schema";

/**
 * What a family owes. The single definition of it.
 *
 * CLAUDE.md §3 rule 4: balances are derived, never stored. The formula it
 * gives — `sum(invoices) - sum(payments)` — is not quite complete, and the two
 * omissions are the ones that matter:
 *
 *   - a VOIDED invoice is not owed
 *   - a REVERSED payment was not paid
 *
 * Miss either and a parent gets dunned for a bill that was cancelled, or a
 * mis-keyed receipt keeps a debt hidden. Both are the kind of error a school
 * discovers in front of the parent.
 *
 * This module exists so that formula is written once. The bursar dashboard,
 * the parent portal, the invoice PDF and the fee-reminder SMS all ask here.
 * Three near-copies that drift is exactly how a school ends up with two
 * different answers to "how much is outstanding", and no way to tell which is
 * right.
 *
 * Everything below runs on the tenant-scoped connection, so the figures are
 * one school's by construction — no query here filters on school_id.
 */

export interface Balance {
  studentId: string;
  /** Sum of invoices that still stand, in cents. */
  billedCents: number;
  /** Sum of payments that were not reversed, in cents. */
  paidCents: number;
  /** Positive = owed to the school. Negative = the family is in credit. */
  balanceCents: number;
}

/**
 * Credit is a real state, not an error.
 *
 * A family that overpays, or pays before an invoice is generated, has a
 * negative balance. Clamping it to zero would lose money the school owes them
 * and make the next term's invoice look unpaid.
 */
export function isInCredit(balance: Balance): boolean {
  return balance.balanceCents < 0;
}

/** Balances for the given students. Students with no activity are omitted. */
export async function balancesFor(
  db: AppDb,
  studentIds: string[],
): Promise<Map<string, Balance>> {
  if (studentIds.length === 0)
    return new Map();

  /*
   * Two separate aggregates, not a join.
   *
   * Joining invoices to payments multiplies rows: a student with 3 invoices
   * and 2 payments produces 6, and both sums come out wrong — inflated by a
   * factor nobody notices until the totals are checked by hand. Aggregating
   * each side independently and combining in code is the boring version that
   * is right.
   */
  const billed = await db
    .select({
      studentId: invoices.studentId,
      total: sql<string>`coalesce(sum(${invoices.totalCents}), 0)`,
    })
    .from(invoices)
    .where(and(
      inArray(invoices.studentId, studentIds),
      isNull(invoices.voidedAt),
    ))
    .groupBy(invoices.studentId);

  const paid = await db
    .select({
      studentId: payments.studentId,
      total: sql<string>`coalesce(sum(${payments.amountCents}), 0)`,
    })
    .from(payments)
    .where(and(
      inArray(payments.studentId, studentIds),
      isNull(payments.reversedAt),
    ))
    .groupBy(payments.studentId);

  const result = new Map<string, Balance>();

  const ensure = (studentId: string) => {
    let row = result.get(studentId);
    if (!row) {
      row = { studentId, billedCents: 0, paidCents: 0, balanceCents: 0 };
      result.set(studentId, row);
    }
    return row;
  };

  // `sum()` comes back as a string from pg: bigint has no lossless JS
  // representation, so the driver refuses to guess. Parsed explicitly rather
  // than coerced, because a silent NaN here would read as "owes nothing".
  for (const row of billed)
    ensure(row.studentId).billedCents = Number(row.total);

  for (const row of paid)
    ensure(row.studentId).paidCents = Number(row.total);

  for (const row of result.values())
    row.balanceCents = row.billedCents - row.paidCents;

  return result;
}

/** The balance for one student, zeroed if they have neither invoices nor payments. */
export async function balanceFor(
  db: AppDb,
  studentId: string,
): Promise<Balance> {
  const balances = await balancesFor(db, [studentId]);

  return balances.get(studentId) ?? {
    studentId,
    billedCents: 0,
    paidCents: 0,
    balanceCents: 0,
  };
}

export interface InvoiceBalance {
  invoiceId: string;
  totalCents: number;
  /** Only payments allocated to this invoice; a credit on account is excluded. */
  paidCents: number;
  outstandingCents: number;
}

/**
 * Per-invoice settlement, which is a different question from what a family owes.
 *
 * A payment with a null `invoiceId` is a credit on account: real money, but not
 * yet attributed to a term. It counts towards the student's balance and NOT
 * towards any individual invoice — so these two figures can legitimately
 * disagree, and a screen showing both should say which is which.
 */
export async function invoiceBalancesFor(
  db: AppDb,
  invoiceIds: string[],
): Promise<Map<string, InvoiceBalance>> {
  if (invoiceIds.length === 0)
    return new Map();

  const rows = await db
    .select({
      id: invoices.id,
      totalCents: invoices.totalCents,
      voidedAt: invoices.voidedAt,
    })
    .from(invoices)
    .where(inArray(invoices.id, invoiceIds));

  const allocated = await db
    .select({
      invoiceId: payments.invoiceId,
      total: sql<string>`coalesce(sum(${payments.amountCents}), 0)`,
    })
    .from(payments)
    .where(and(
      inArray(payments.invoiceId, invoiceIds),
      isNull(payments.reversedAt),
    ))
    .groupBy(payments.invoiceId);

  const paidByInvoice = new Map(
    allocated.map(r => [r.invoiceId!, Number(r.total)]),
  );

  return new Map(rows.map((row) => {
    const paidCents = paidByInvoice.get(row.id) ?? 0;
    // A voided invoice is owed nothing, whatever its total says.
    const totalCents = row.voidedAt ? 0 : row.totalCents;

    return [row.id, {
      invoiceId: row.id,
      totalCents,
      paidCents,
      outstandingCents: totalCents - paidCents,
    }];
  }));
}

/**
 * Recomputes an invoice's stored total from its lines.
 *
 * `invoices.total_cents` is a frozen figure on a printed document, so it is
 * stored rather than derived — but it must never disagree with the lines under
 * it. Every path that adds, changes or removes a line calls this inside the
 * same transaction, which is what keeps "stored" from meaning "stale".
 */
export async function recomputeInvoiceTotal(
  db: AppDb,
  invoiceId: string,
): Promise<number> {
  const [row] = await db.execute<{ total: string }>(sql`
    UPDATE invoices
    SET total_cents = coalesce(
      (SELECT sum(amount_cents) FROM invoice_lines WHERE invoice_id = ${invoiceId}),
      0
    )
    WHERE id = ${invoiceId}
    RETURNING total_cents AS total
  `).then(r => r.rows);

  return Number(row.total);
}
