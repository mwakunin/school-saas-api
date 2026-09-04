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
    const voided = row.voidedAt !== null;
    // A voided invoice is owed nothing, whatever its total says.
    const totalCents = voided ? 0 : row.totalCents;

    return [row.id, {
      invoiceId: row.id,
      totalCents,
      paidCents,
      /*
       * Zero when voided, rather than `0 - paidCents`.
       *
       * An invoice that was paid and then voided would otherwise report a
       * NEGATIVE amount outstanding, which reads on a statement as the school
       * owing the family — on this invoice alone, which is not a claim it can
       * make. Whether a refund is due is a question about the student's
       * balance, where the payment still counts; see `balancesFor`.
       */
      outstandingCents: voided ? 0 : totalCents - paidCents,
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
  /*
   * Lock the invoice before summing its lines.
   *
   * Without this, two concurrent line additions can leave the total short. In
   * READ COMMITTED, when a blocked UPDATE is released it re-checks its WHERE
   * against the new row version, but a subquery in the SET list was already
   * evaluated against the statement's original snapshot — so the second writer
   * can store a sum computed before the first writer's line existed. The
   * invoice then disagrees with its own lines, permanently and silently.
   *
   * Taking the row lock in a separate statement first means the second
   * transaction blocks here, and its aggregate below runs as a NEW statement
   * once the first has committed — so it sees every line.
   */
  await db.execute(sql`SELECT id FROM invoices WHERE id = ${invoiceId} FOR UPDATE`);

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

export interface ClassBalance {
  streamId: string;
  streamName: string;
  gradeLevelId: string;
  gradeLevelName: string;
  gradeLevelSequence: number;
  /** Actively enrolled students in this class. */
  studentCount: number;
  billedCents: number;
  paidCents: number;
  /** Billed minus paid across the class. Families in credit pull this down. */
  netCents: number;
  /** Debts only — what the class actually owes the school. */
  outstandingCents: number;
  /** How many families are behind, which is the number a bursar chases. */
  owingCount: number;
}

/**
 * Outstanding per class — the bursar dashboard's headline figure.
 *
 * Aggregated in SQL rather than by fetching every student and summing in
 * JavaScript. That matters less for correctness than for what it forces: the
 * rules about what counts have to be written a second time, and a second copy
 * that drifts is how one screen says a class owes 40,000 and another says
 * 55,000 with nothing to explain the difference.
 *
 * So the two omissions from `sum(invoices) - sum(payments)` are repeated here
 * deliberately and identically — a VOIDED invoice is not owed, a REVERSED
 * payment was not paid — and `balances.test.ts` pins this against
 * `balancesFor` so the pair cannot come apart unnoticed.
 *
 * Only actively enrolled students count. A class list that included last
 * term's withdrawn pupils would inflate every figure on the dashboard, and the
 * open enrollment row is what "which class is this child in" means
 * (CLAUDE.md §5.3).
 */
export async function outstandingByClass(
  db: AppDb,
  filters: { academicYearId?: string; gradeLevelId?: string } = {},
): Promise<ClassBalance[]> {
  /*
   * Each side aggregated separately before being joined to the student.
   *
   * Joining invoices to payments directly multiplies rows — three invoices and
   * two payments become six — and both sums come out inflated by a factor
   * nobody notices until the totals are checked by hand. The same reason
   * `balancesFor` runs two queries rather than one join.
   */
  const rows = await db.execute<{
    stream_id: string;
    stream_name: string;
    grade_level_id: string;
    grade_level_name: string;
    grade_level_sequence: number;
    student_count: string;
    billed_cents: string;
    paid_cents: string;
    outstanding_cents: string;
    owing_count: string;
  }>(sql`
    WITH per_student AS (
      SELECT
        e.stream_id,
        coalesce(i.billed, 0)                        AS billed,
        coalesce(p.paid, 0)                          AS paid,
        coalesce(i.billed, 0) - coalesce(p.paid, 0)  AS balance
      FROM students st
      JOIN enrollments e
        ON e.student_id = st.id
       AND e.ended_on IS NULL
      LEFT JOIN (
        SELECT student_id, sum(total_cents) AS billed
        FROM invoices
        WHERE voided_at IS NULL
        GROUP BY student_id
      ) i ON i.student_id = st.id
      LEFT JOIN (
        SELECT student_id, sum(amount_cents) AS paid
        FROM payments
        WHERE reversed_at IS NULL
        GROUP BY student_id
      ) p ON p.student_id = st.id
      WHERE st.status = 'active'
    )
    SELECT
      s.id                                   AS stream_id,
      s.name                                 AS stream_name,
      gl.id                                  AS grade_level_id,
      gl.name                                AS grade_level_name,
      gl.sequence                            AS grade_level_sequence,
      count(ps.*)                            AS student_count,
      coalesce(sum(ps.billed), 0)            AS billed_cents,
      coalesce(sum(ps.paid), 0)              AS paid_cents,
      -- Debts only. A family in credit must not net off against one that owes,
      -- or the figure a head reads is smaller than the money actually missing.
      coalesce(sum(ps.balance) FILTER (WHERE ps.balance > 0), 0) AS outstanding_cents,
      count(*) FILTER (WHERE ps.balance > 0)  AS owing_count
    FROM streams s
    JOIN grade_levels gl ON gl.id = s.grade_level_id
    -- LEFT, so a class with nobody enrolled still appears rather than
    -- vanishing from a dashboard that is meant to cover the whole school.
    LEFT JOIN per_student ps ON ps.stream_id = s.id
    WHERE ${filters.academicYearId
      ? sql`s.academic_year_id = ${filters.academicYearId}::uuid`
      : sql`true`}
      AND ${filters.gradeLevelId
        ? sql`s.grade_level_id = ${filters.gradeLevelId}::uuid`
        : sql`true`}
    GROUP BY s.id, s.name, gl.id, gl.name, gl.sequence
    /*
     * Grade order first, then worst debt within it.
     *
     * The dashboard reads like a school — Grade 1 through Grade 9 — but inside
     * a grade the class a bursar needs to act on should be at the top. The
     * stream name is the tie-break so the order is stable between refreshes;
     * without it two classes owing the same amount could swap places and make
     * the screen look like it had changed when nothing had.
     */
    ORDER BY gl.sequence,
             coalesce(sum(ps.balance) FILTER (WHERE ps.balance > 0), 0) DESC,
             s.name
  `).then(r => r.rows);

  return rows.map(row => ({
    streamId: row.stream_id,
    streamName: row.stream_name,
    gradeLevelId: row.grade_level_id,
    gradeLevelName: row.grade_level_name,
    gradeLevelSequence: Number(row.grade_level_sequence),
    studentCount: Number(row.student_count),
    billedCents: Number(row.billed_cents),
    paidCents: Number(row.paid_cents),
    netCents: Number(row.billed_cents) - Number(row.paid_cents),
    outstandingCents: Number(row.outstanding_cents),
    owingCount: Number(row.owing_count),
  }));
}
