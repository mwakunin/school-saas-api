import { and, asc, count, eq, ilike, or, sql } from "drizzle-orm";
import * as HttpStatusCodes from "stoker/http-status-codes";
import * as HttpStatusPhrases from "stoker/http-status-phrases";

import type { AppDb } from "@/db";
import type { TenantRouteHandler } from "@/lib/types";

import { mpesaTransactions, schools, students } from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { balancesFor } from "@/lib/balances";
import { encryptSecret, generateCallbackToken } from "@/lib/crypto";
import { isForeignKeyViolation, isUniqueViolation } from "@/lib/db-errors";
import { MpesaError } from "@/lib/mpesa";
import {
  confirmationUrlFor,
  credentialsFor,
  registerC2bUrls,
  serialiseCredentials,
  validationUrlFor,
} from "@/lib/mpesa-c2b";
import {
  allocateTransaction,
  decodeCursor,
  encodeCursor,
  matchUnallocated,
  normalisedAdmissionNumber,
  normaliseReference,
} from "@/lib/mpesa-matching";

import type {
  AllocateRoute,
  ConfigureMpesaRoute,
  GetMpesaSettingsRoute,
  GetTransactionRoute,
  ListTransactionsRoute,
  RejectRoute,
  RequeueRoute,
  RunMatcherRoute,
} from "./reconciliation.routes";

/** Field-level 422, shaped like the one `defaultHook` produces for Zod. */
function fieldError(path: string[], message: string) {
  return {
    success: false as const,
    error: {
      issues: [{ code: "custom" as const, path, message }],
      name: "ZodError",
    },
  };
}

/**
 * Students whose admission number resembles a reference.
 *
 * Suggestions for a person, not candidates for automatic allocation — the
 * matcher stays strict for the reason set out in lib/mpesa-matching.ts, and
 * this is the other half of that decision: refuse to guess, then make guessing
 * unnecessary by putting the likely answers in front of the bursar.
 *
 * Matched on a suffix of the digits, which is what actually goes wrong.
 * `2026/118` gets typed as `118`, `ADM 118`, or last year's `2025/118`; all
 * three share the tail.
 */
async function candidatesFor(db: AppDb, reference: string | null) {
  if (!reference)
    return [];

  const digits = reference.replace(/\D/g, "");
  if (digits.length < 2)
    return [];

  // The last three digits are the serial part of a Kenyan admission number.
  const tail = digits.slice(-3);

  const candidates = await db
    .select({
      id: students.id,
      admissionNumber: students.admissionNumber,
      givenName: students.givenName,
      familyName: students.familyName,
    })
    .from(students)
    .where(and(
      eq(students.status, "active"),
      or(
        ilike(students.admissionNumber, `%${tail}`),
        sql`${normalisedAdmissionNumber(students.admissionNumber)} = ${normaliseReference(reference)}`,
      ),
    ))
    .orderBy(asc(students.admissionNumber))
    .limit(5);

  return candidates;
}

export const listTransactions: TenantRouteHandler<ListTransactionsRoute> = async (c) => {
  const query = c.req.valid("query");
  const db = c.var.db;

  const filters = [];
  if (query.status)
    filters.push(eq(mpesaTransactions.status, query.status));

  if (query.q) {
    const term = `%${query.q}%`;
    filters.push(or(
      ilike(mpesaTransactions.accountReference, term),
      ilike(mpesaTransactions.payerName, term),
      ilike(mpesaTransactions.transactionId, term),
      ilike(mpesaTransactions.msisdn, term),
    )!);
  }

  const where = filters.length > 0 ? and(...filters) : undefined;

  const [{ total }] = await db
    .select({ total: count() })
    .from(mpesaTransactions)
    .where(where);

  /*
   * The unmatched figures ignore the filters and the page on purpose.
   *
   * "How much money is sitting unallocated" is a question about the school,
   * not about whatever the bursar is currently looking at. Computing it from
   * the visible rows would make it shrink as they searched.
   */
  const [unmatched] = await db
    .select({
      rows: count(),
      cents: sql<string>`coalesce(sum(${mpesaTransactions.amountCents}), 0)`,
    })
    .from(mpesaTransactions)
    .where(eq(mpesaTransactions.status, "unmatched"));

  const rows = await db
    .select()
    .from(mpesaTransactions)
    .where(where)
    // Oldest first: a parent waiting on a receipt has been waiting longest.
    .orderBy(asc(mpesaTransactions.transactedAt))
    .limit(query.limit)
    .offset(query.offset);

  /*
   * Candidates first, then ONE balance lookup for the whole page.
   *
   * Fetching a balance per row meant a page of fifty unmatched payments cost
   * fifty pairs of aggregate queries to render — on the screen a bursar leaves
   * open all morning. `balancesFor` already takes a set, so the shape was
   * there; it was just being called one student at a time.
   */
  const candidatesByRow = new Map<string, Awaited<ReturnType<typeof candidatesFor>>>();

  for (const row of rows) {
    // Only worth computing for rows a bursar might act on.
    if (row.status === "unmatched")
      candidatesByRow.set(row.id, await candidatesFor(db, row.accountReference));
  }

  const everyCandidate = [...new Set(
    [...candidatesByRow.values()].flatMap(list => list.map(s => s.id)),
  )];

  // The balance is what makes the right row obvious: the child who owes
  // exactly this much is almost always the one the parent was paying for.
  const balances = await balancesFor(db, everyCandidate);

  const transactions = rows.map((row) => {
    const { rawPayload: _envelope, ...rest } = row;

    return {
      ...rest,
      suggestions: (candidatesByRow.get(row.id) ?? []).map(s => ({
        studentId: s.id,
        admissionNumber: s.admissionNumber,
        name: `${s.givenName} ${s.familyName}`,
        balanceCents: balances.get(s.id)?.balanceCents ?? 0,
      })),
    };
  });

  return c.json({
    transactions,
    total,
    unmatchedCount: unmatched.rows,
    unmatchedCents: Number(unmatched.cents),
  }, HttpStatusCodes.OK);
};

export const getTransaction: TenantRouteHandler<GetTransactionRoute> = async (c) => {
  const { id } = c.req.valid("param");

  const [row] = await c.var.db
    .select()
    .from(mpesaTransactions)
    .where(eq(mpesaTransactions.id, id));

  if (!row) {
    return c.json(
      { message: HttpStatusPhrases.NOT_FOUND },
      HttpStatusCodes.NOT_FOUND,
    );
  }

  return c.json(row, HttpStatusCodes.OK);
};

export const allocate: TenantRouteHandler<AllocateRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  const db = c.var.db;

  const [transaction] = await db
    .select()
    .from(mpesaTransactions)
    .where(eq(mpesaTransactions.id, id));

  if (!transaction) {
    return c.json(
      { message: HttpStatusPhrases.NOT_FOUND },
      HttpStatusCodes.NOT_FOUND,
    );
  }

  if (transaction.status !== "unmatched") {
    return c.json(
      {
        message: transaction.status === "allocated"
          ? "This payment is already allocated. Reverse the payment to move it."
          : "This payment was set aside. Re-queue it before allocating.",
      },
      HttpStatusCodes.CONFLICT,
    );
  }

  try {
    await allocateTransaction(db, {
      schoolId: c.var.school.id,
      transaction,
      studentId: body.studentId,
      recordedBy: c.var.user!.id,
    });
  }
  catch (err) {
    // Another bursar allocated it between the read above and this write. The
    // partial unique index is what catches it; without it the double-click
    // would credit one receipt to two families.
    if (isUniqueViolation(err)) {
      return c.json(
        { message: "This payment was allocated by someone else a moment ago" },
        HttpStatusCodes.CONFLICT,
      );
    }
    if (isForeignKeyViolation(err)) {
      return c.json(
        fieldError(["studentId"], "No such student at this school"),
        HttpStatusCodes.UNPROCESSABLE_ENTITY,
      );
    }
    throw err;
  }

  /*
   * A hand allocation is the entry worth having most.
   *
   * The matcher's own allocations are reproducible from the reference; this
   * one is a person deciding whose money it was, on a reference that did not
   * match anything. If it turns out to be the wrong family, "who decided
   * that" is the first question, and the raw confirmation cannot answer it.
   */
  await recordAudit(db, {
    schoolId: c.var.school.id,
    actorId: c.var.user!.id,
    action: "mpesa.allocated",
    entityType: "mpesa_transaction",
    entityId: id,
    summary:
      `Allocated ${transaction.amountCents} cents from `
      + `${transaction.accountReference ?? "a blank reference"} by hand`,
    detail: {
      studentId: body.studentId,
      accountReference: transaction.accountReference,
      transactionId: transaction.transactionId,
    },
  });

  const [updated] = await db
    .select()
    .from(mpesaTransactions)
    .where(eq(mpesaTransactions.id, id));

  return c.json(updated, HttpStatusCodes.OK);
};

export const reject: TenantRouteHandler<RejectRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const { reason } = c.req.valid("json");
  const db = c.var.db;

  const [transaction] = await db
    .select({ status: mpesaTransactions.status })
    .from(mpesaTransactions)
    .where(eq(mpesaTransactions.id, id));

  if (!transaction) {
    return c.json(
      { message: HttpStatusPhrases.NOT_FOUND },
      HttpStatusCodes.NOT_FOUND,
    );
  }

  if (transaction.status === "allocated") {
    return c.json(
      { message: "Reverse the payment before setting this aside" },
      HttpStatusCodes.CONFLICT,
    );
  }

  const [updated] = await db
    .update(mpesaTransactions)
    .set({ status: "rejected", statusReason: reason })
    .where(eq(mpesaTransactions.id, id))
    .returning();

  await recordAudit(db, {
    schoolId: c.var.school.id,
    actorId: c.var.user!.id,
    action: "mpesa.rejected",
    entityType: "mpesa_transaction",
    entityId: id,
    summary: `Set a payment aside: ${reason}`,
    detail: { reason, transactionId: updated.transactionId },
  });

  return c.json(updated, HttpStatusCodes.OK);
};

export const requeue: TenantRouteHandler<RequeueRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const db = c.var.db;

  const [transaction] = await db
    .select({ status: mpesaTransactions.status })
    .from(mpesaTransactions)
    .where(eq(mpesaTransactions.id, id));

  if (!transaction) {
    return c.json(
      { message: HttpStatusPhrases.NOT_FOUND },
      HttpStatusCodes.NOT_FOUND,
    );
  }

  if (transaction.status !== "rejected") {
    return c.json(
      { message: "Only a confirmation that was set aside can be re-queued" },
      HttpStatusCodes.CONFLICT,
    );
  }

  const [updated] = await db
    .update(mpesaTransactions)
    .set({ status: "unmatched", statusReason: null })
    .where(eq(mpesaTransactions.id, id))
    .returning();

  return c.json(updated, HttpStatusCodes.OK);
};

export const runMatcher: TenantRouteHandler<RunMatcherRoute> = async (c) => {
  const db = c.var.db;
  const { after } = c.req.valid("json");

  const cursor = after ? decodeCursor(after) : null;

  if (after && !cursor) {
    // Rejected rather than silently restarted: a caller looping on a cursor it
    // cannot read would sweep the first batch for ever and believe it was
    // making progress.
    return c.json(
      fieldError(["after"], "Unreadable cursor"),
      HttpStatusCodes.UNPROCESSABLE_ENTITY,
    );
  }

  const { results, remaining, nextCursor } = await matchUnallocated(
    db,
    c.var.school.id,
    { after: cursor },
  );

  const allocated = results.filter(r => r.outcome.kind === "matched").length;

  return c.json({
    examined: results.length,
    allocated,
    stillUnmatched: results.length - allocated,
    remaining,
    nextCursor: nextCursor ? encodeCursor(nextCursor) : null,
  }, HttpStatusCodes.OK);
};

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function settingsFor(school: {
  mpesaShortcode: string | null;
  mpesaCredentials: string | null;
  mpesaCallbackToken: string | null;
}) {
  return {
    shortcode: school.mpesaShortcode,
    // Whether, never what. The credentials cannot be read back through the API
    // at all — a support session with a screen share must not be able to leak
    // a school's ability to transact.
    credentialsConfigured: Boolean(school.mpesaCredentials),
    confirmationUrl: school.mpesaCallbackToken
      ? confirmationUrlFor(school.mpesaCallbackToken)
      : null,
    validationUrl: school.mpesaCallbackToken
      ? validationUrlFor(school.mpesaCallbackToken)
      : null,
  };
}

export const getMpesaSettings: TenantRouteHandler<GetMpesaSettingsRoute> = async (c) => {
  const [school] = await c.var.db
    .select({
      mpesaShortcode: schools.mpesaShortcode,
      mpesaCredentials: schools.mpesaCredentials,
      mpesaCallbackToken: schools.mpesaCallbackToken,
    })
    .from(schools)
    .limit(1);

  if (!school) {
    return c.json(
      { message: HttpStatusPhrases.NOT_FOUND },
      HttpStatusCodes.NOT_FOUND,
    );
  }

  return c.json(settingsFor(school), HttpStatusCodes.OK);
};

export const configureMpesa: TenantRouteHandler<ConfigureMpesaRoute> = async (c) => {
  const body = c.req.valid("json");
  const db = c.var.db;

  const [existing] = await db
    .select({
      mpesaCallbackToken: schools.mpesaCallbackToken,
    })
    .from(schools)
    .limit(1);

  if (!existing) {
    return c.json(
      { message: HttpStatusPhrases.NOT_FOUND },
      HttpStatusCodes.NOT_FOUND,
    );
  }

  /*
   * The token is minted once and kept.
   *
   * Rotating it on every credential change would silently break the URLs
   * already registered with Safaricom — confirmations would arrive at a path
   * nobody answers to, and the school would notice only when a parent asked
   * why a payment never showed. Rotation deserves its own deliberate action.
   */
  const callbackToken = existing.mpesaCallbackToken ?? generateCallbackToken();

  let encrypted: string;
  try {
    encrypted = encryptSecret(serialiseCredentials({
      consumerKey: body.consumerKey,
      consumerSecret: body.consumerSecret,
    }));
  }
  catch (err) {
    // No encryption key configured. Storing the credentials in the clear
    // instead is not a fallback anyone would want.
    return c.json(
      fieldError(
        ["consumerSecret"],
        err instanceof Error ? err.message : "Could not encrypt the credentials",
      ),
      HttpStatusCodes.UNPROCESSABLE_ENTITY,
    );
  }

  const [updated] = await db
    .update(schools)
    .set({
      mpesaShortcode: body.shortcode,
      mpesaCredentials: encrypted,
      mpesaCallbackToken: callbackToken,
    })
    .returning({
      mpesaShortcode: schools.mpesaShortcode,
      mpesaCredentials: schools.mpesaCredentials,
      mpesaCallbackToken: schools.mpesaCallbackToken,
    });

  const settings = settingsFor(updated);

  if (!body.registerUrls)
    return c.json(settings, HttpStatusCodes.OK);

  /*
   * Registration is attempted AFTER the credentials are saved, and its failure
   * does not roll them back.
   *
   * Safaricom's sandbox rejects a re-registration for a shortcode that already
   * has URLs, and production has its own reasons to refuse. Losing a correctly
   * entered credential because a separate remote call failed would make the
   * screen impossible to use — the operator would re-enter the same values and
   * see the same error.
   */
  try {
    await registerC2bUrls({
      shortcode: body.shortcode,
      credentials: credentialsFor({ name: "this school", mpesaCredentials: encrypted }),
      confirmationUrl: settings.confirmationUrl!,
      validationUrl: settings.validationUrl!,
    });
  }
  catch (err) {
    c.var.logger.error({ err }, "Daraja refused C2B URL registration");

    return c.json(
      {
        message: err instanceof MpesaError
          ? `Credentials saved, but Safaricom refused the URL registration: ${err.message}`
          : "Credentials saved, but the URL registration failed",
      },
      HttpStatusCodes.BAD_GATEWAY,
    );
  }

  return c.json(settings, HttpStatusCodes.OK);
};
