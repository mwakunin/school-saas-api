import type { AnyColumn } from "drizzle-orm";

import { and, asc, count, eq, isNull, sql } from "drizzle-orm";
import { Buffer } from "node:buffer";

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
 * backlog is deep.
 */
export const MATCH_BATCH_SIZE = 200;

/**
 * Where a sweep got to: the last confirmation it examined.
 *
 * `transactedAt` alone is not unique — two payments can share a second — so
 * the id breaks the tie and makes the ordering total. Without that a cursor
 * could skip a row or repeat one, which on a matcher means a payment that is
 * never looked at again.
 */
export interface MatchCursor {
  transactedAt: Date;
  id: string;
}

/** Opaque to callers, so the pair can change without breaking a client. */
export function encodeCursor(cursor: MatchCursor): string {
  return Buffer
    .from(`${cursor.transactedAt.toISOString()}|${cursor.id}`, "utf8")
    .toString("base64url");
}

export function decodeCursor(value: string): MatchCursor | null {
  try {
    const [timestamp, id] = Buffer.from(value, "base64url").toString("utf8").split("|");
    const transactedAt = new Date(timestamp);

    if (!id || Number.isNaN(transactedAt.getTime()))
      return null;

    return { transactedAt, id };
  }
  catch {
    return null;
  }
}

/**
 * Sweeps unmatched confirmations, resuming where the last pass stopped.
 *
 * The cursor is the whole point. A bounded sweep that always started from the
 * oldest row could not make progress: the rows at the front of the queue are
 * there precisely BECAUSE nothing could match them, so every pass re-examined
 * the same stuck batch, matched nothing, and reported that more remained. A
 * backlog deeper than one batch was unreachable, and the "run again" the
 * response invited did nothing at all. That is how the first bounded version
 * of this function behaved.
 *
 * Ordered by `(transactedAt, id)` — oldest first, since a parent waiting on a
 * receipt has been waiting longest — and paged by that same pair, so each call
 * examines rows the last one did not.
 *
 * Safe to run repeatedly and concurrently with itself: it only ever moves a
 * row from `unmatched` to `allocated`, and the partial unique index on
 * `payments.mpesa_transaction_id` means a second runner that raced the first
 * fails its insert rather than paying twice.
 */
export async function matchUnallocated(
  db: AppDb,
  schoolId: string,
  options: { batchSize?: number; after?: MatchCursor | null } = {},
): Promise<{
  results: AllocationResult[];
  remaining: number;
  nextCursor: MatchCursor | null;
}> {
  const batchSize = options.batchSize ?? MATCH_BATCH_SIZE;
  const after = options.after ?? null;

  /*
   * Row-value comparison, not `transactedAt > x OR (= x AND id > y)`.
   *
   * Postgres compares the tuple left to right in one expression, which is both
   * easier to read and index-friendly against `(transacted_at, id)`.
   */
  const beyondCursor = after
    ? sql`(${mpesaTransactions.transactedAt}, ${mpesaTransactions.id}) > (${after.transactedAt.toISOString()}::timestamptz, ${after.id}::uuid)`
    : undefined;

  const pending = await db
    .select()
    .from(mpesaTransactions)
    .where(and(eq(mpesaTransactions.status, "unmatched"), beyondCursor))
    .orderBy(asc(mpesaTransactions.transactedAt), asc(mpesaTransactions.id))
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

  const last = pending.at(-1);

  // A short batch means the queue is already exhausted; only a full one leaves
  // any question about what follows.
  const reached = last && pending.length === batchSize
    ? { transactedAt: last.transactedAt, id: last.id }
    : null;

  /*
   * What a FURTHER pass would examine — not the size of the queue.
   *
   * Counting every unmatched row was the misleading part of the first bounded
   * version: rows this pass just tried and could not match are still
   * unmatched, so the figure never fell and "run again" never helped. Counted
   * beyond where this pass reached instead, so zero genuinely means there is
   * nothing left to look at.
   */
  const remaining = reached
    ? await db
        .select({ left: count() })
        .from(mpesaTransactions)
        .where(and(
          eq(mpesaTransactions.status, "unmatched"),
          sql`(${mpesaTransactions.transactedAt}, ${mpesaTransactions.id}) > (${reached.transactedAt.toISOString()}::timestamptz, ${reached.id}::uuid)`,
        ))
        .then(([row]) => row.left)
    : 0;

  /*
   * The cursor is offered only when it would lead somewhere.
   *
   * Deriving it from `remaining` rather than from the batch being full ties
   * the two together: a null cursor and a zero count now mean the same thing,
   * and a caller looping `while (nextCursor)` cannot be handed one final pass
   * that examines nothing. It also saves that empty round trip whenever the
   * queue happens to be an exact multiple of the batch.
   *
   * Cleared at the end of a sweep rather than parked there, so the next run
   * starts from the oldest row again — which is what picks up confirmations
   * that arrived in the meantime.
   */
  const nextCursor = remaining > 0 ? reached : null;

  return { results, remaining, nextCursor };
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
