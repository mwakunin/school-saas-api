import type { AnyColumn } from "drizzle-orm";

import { and, count, eq, isNull, sql } from "drizzle-orm";

import type { AppDb } from "@/db";

import { mpesaTransactions, payments, students } from "@/db/schema";

/**
 * Turning "what the parent typed" into "which child this is for".
 *
 * A meaningful share of payments arrive with a reference that is not an
 * admission number — CLAUDE.md §5.8 calls this the core bursar workflow, not
 * an edge case. Parents type a child's name, last year's number, a sibling's
 * number, or the number with the wrong separator.
 *
 * The rule this module follows: match only what is unambiguous, and leave
 * everything else for a person. A wrong automatic allocation is worse than no
 * allocation — the money lands on another family's account, both balances are
 * wrong, and nobody is looking for it because the queue is empty.
 */

/**
 * Reduces a reference to its comparable form.
 *
 * Uppercased, with separators and spaces removed, so `2026/118`, `2026-118`
 * and `2026 118` all reduce alike. Deliberately narrow: it normalises how a
 * number was *written*, never what it means.
 */
export function normaliseReference(value: string): string {
  return value.toUpperCase().replace(/[\s/\-_.]/g, "");
}

/**
 * The same normalisation, expressed for Postgres.
 *
 * Written once and shared, because the SQL half and the JavaScript half above
 * have to agree on what "the same number, written differently" means. Two
 * copies that drifted would put a payment in the queue that the suggestion
 * list then failed to suggest a candidate for — the one situation where a
 * bursar has nothing at all to go on.
 */
export function normalisedAdmissionNumber(column: AnyColumn) {
  return sql`upper(regexp_replace(${column}, '[\\s/\\-_.]', '', 'g'))`;
}

export type MatchOutcome
  = | { kind: "matched"; studentId: string; confidence: "exact" | "normalised" }
    | { kind: "unmatched"; reason: "no_reference" | "no_candidate" | "ambiguous" };

/**
 * Finds the student a reference names, if exactly one is named.
 *
 * Two passes, both conservative:
 *
 *   exact       the reference IS an admission number
 *   normalised  it is one once separators and case are ignored
 *
 * There is deliberately no third pass. Fuzzy matching — stripping an `ADM`
 * prefix, trying a name, taking the closest number — is precisely where an
 * automatic allocation credits the wrong child, and the bursar's queue is
 * where those belong. §8's demo data leans on this: `ADM 118` typed instead of
 * `2026/118` is meant to *stay* unmatched and be resolved on screen.
 *
 * Ambiguity is a miss, not a coin flip. Two children matching one reference
 * means a person has to decide.
 */
export async function matchReference(
  db: AppDb,
  reference: string | null,
): Promise<MatchOutcome> {
  if (!reference || reference.trim() === "")
    return { kind: "unmatched", reason: "no_reference" };

  const trimmed = reference.trim();

  const exact = await db
    .select({ id: students.id })
    .from(students)
    .where(eq(students.admissionNumber, trimmed));

  if (exact.length === 1)
    return { kind: "matched", studentId: exact[0].id, confidence: "exact" };

  if (exact.length > 1)
    return { kind: "unmatched", reason: "ambiguous" };

  const normalised = normaliseReference(trimmed);

  if (normalised === "")
    return { kind: "unmatched", reason: "no_candidate" };

  /*
   * Normalising both sides in SQL rather than loading the register.
   *
   * A school has hundreds of students and this runs per payment; pulling every
   * admission number into memory to compare would work and would be the kind
   * of thing that is fine until a school with 2,000 pupils arrives.
   */
  const loose = await db
    .select({ id: students.id })
    .from(students)
    .where(sql`${normalisedAdmissionNumber(students.admissionNumber)} = ${normalised}`);

  if (loose.length === 1)
    return { kind: "matched", studentId: loose[0].id, confidence: "normalised" };

  if (loose.length > 1)
    return { kind: "unmatched", reason: "ambiguous" };

  return { kind: "unmatched", reason: "no_candidate" };
}

export interface AllocationResult {
  transactionId: string;
  outcome: MatchOutcome;
}

/**
 * Allocates one already-stored confirmation to a student.
 *
 * Creates the ledger entry and marks the transaction, in one transaction so
 * the two can never disagree — a payment whose source says `unmatched`, or a
 * transaction marked `allocated` with no money behind it, are both states
 * nobody could untangle later.
 *
 * The payment carries no `invoiceId`: it lands as a credit on the student's
 * account. Which term a payment settles is a bursar's decision, and guessing
 * "the oldest unpaid invoice" produces a plausible allocation that is wrong
 * whenever a parent is paying next term in advance.
 */
export async function allocateTransaction(
  db: AppDb,
  input: {
    schoolId: string;
    transaction: { id: string; amountCents: number; transactedAt: Date; transactionId: string };
    studentId: string;
    recordedBy?: string | null;
  },
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.insert(payments).values({
      schoolId: input.schoolId,
      studentId: input.studentId,
      method: "mpesa",
      mpesaTransactionId: input.transaction.id,
      amountCents: input.transaction.amountCents,
      // The Safaricom receipt, so a bursar holding the parent's SMS can find
      // this row by the number the parent reads out.
      reference: input.transaction.transactionId,
      recordedBy: input.recordedBy ?? null,
      receivedAt: input.transaction.transactedAt,
    });

    await tx
      .update(mpesaTransactions)
      .set({ status: "allocated", statusReason: null })
      .where(eq(mpesaTransactions.id, input.transaction.id));
  });
}

/**
 * Tries to match everything still sitting unmatched.
 *
 * Safe to run repeatedly and safe to run concurrently with itself: it only
 * ever moves a row from `unmatched` to `allocated`, and the partial unique
 * index on `payments.mpesa_transaction_id` means a second runner that raced
 * the first fails its insert rather than paying twice.
 *
 * Worth re-running after the register changes — a child admitted late, or an
 * admission number corrected, turns yesterday's unmatched payments into
 * today's matches without anyone re-keying them.
 */
/**
 * How many confirmations one pass will look at.
 *
 * Each one costs a query or two, so an unbounded sweep over a school that let
 * a term's payments pile up would hold a request open for as long as the
 * backlog is deep. Bounded and resumable instead: the caller is told whether
 * more remain and can press again.
 */
export const MATCH_BATCH_SIZE = 200;

export async function matchUnallocated(
  db: AppDb,
  schoolId: string,
  batchSize: number = MATCH_BATCH_SIZE,
): Promise<{ results: AllocationResult[]; remaining: number }> {
  const pending = await db
    .select()
    .from(mpesaTransactions)
    .where(eq(mpesaTransactions.status, "unmatched"))
    // Oldest first: a parent waiting on a receipt has been waiting longest,
    // and the ordering has to be stable for "press again" to make progress.
    .orderBy(mpesaTransactions.transactedAt)
    .limit(batchSize);

  const results: AllocationResult[] = [];

  for (const transaction of pending) {
    const outcome = await matchReference(db, transaction.accountReference);

    if (outcome.kind === "matched") {
      await allocateTransaction(db, {
        schoolId,
        transaction,
        studentId: outcome.studentId,
      });
    }

    results.push({ transactionId: transaction.id, outcome });
  }

  /*
   * What is left AFTER this pass.
   *
   * Counted rather than inferred from the batch being full: rows this pass
   * could not match are still unmatched, so a full batch does not mean there
   * is more to do, and an empty one does not mean there is not.
   */
  const [{ left }] = await db
    .select({ left: count() })
    .from(mpesaTransactions)
    .where(eq(mpesaTransactions.status, "unmatched"));

  return { results, remaining: left };
}

/**
 * Frees a transaction for re-allocation after its payment is reversed.
 *
 * The pair that makes a mis-allocation recoverable: the payment stays on the
 * record as reversed, and the confirmation returns to the queue so the money
 * can be put where it belongs. Without this the transaction reads `allocated`
 * for ever while no live payment exists — money that arrived, was
 * acknowledged, and now belongs to nobody.
 */
export async function releaseReversedTransaction(
  db: AppDb,
  mpesaTransactionId: string,
): Promise<void> {
  const live = await db
    .select({ id: payments.id })
    .from(payments)
    .where(and(
      eq(payments.mpesaTransactionId, mpesaTransactionId),
      isNull(payments.reversedAt),
    ));

  // Only when nothing live still claims it. A partial reversal among several
  // payments should not put a transaction back in the queue.
  if (live.length > 0)
    return;

  await db
    .update(mpesaTransactions)
    .set({
      status: "unmatched",
      statusReason: "Returned to the queue when its payment was reversed",
    })
    .where(eq(mpesaTransactions.id, mpesaTransactionId));
}
