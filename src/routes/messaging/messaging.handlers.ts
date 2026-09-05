import { and, asc, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import * as HttpStatusCodes from "stoker/http-status-codes";

import type { AppDb } from "@/db";
import type { TenantRouteHandler } from "@/lib/types";

import {
  enrollments,
  gradeLevels,
  guardians,
  reportCards,
  smsMessages,
  streams,
  studentGuardians,
  students,
} from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { balancesFor } from "@/lib/balances";
import { segmentsFor, sendSms } from "@/lib/sms";

import type {
  FeeRemindersRoute,
  ListSmsRoute,
  ResultsNoticeRoute,
} from "./messaging.routes";

/**
 * One message per family, and a dry run by default.
 *
 * Everything here is shaped by one fact: a delivered SMS cannot be recalled and
 * costs real money. So the filters are the easy part, the preview is the
 * default, and every family NOT messaged is reported with a reason — a
 * guardian with no phone number is otherwise invisible, and "we texted
 * everyone" quietly means "everyone we happened to have a number for".
 */

interface Recipient {
  studentId: string;
  admissionNumber: string;
  childName: string;
  guardianId: string;
  phone: string;
}

type SkipReason = "no_guardian" | "no_report_card" | "no_balance";

/**
 * The guardian who gets the message, one per child.
 *
 * The primary contact, falling back to whoever else is linked. One per child
 * and not all of them, because a family with two guardians linked does not
 * want the same fee reminder twice — that is the exact complaint the
 * `guardians` table exists to prevent (CLAUDE.md §5.3), and it would double
 * the bill for the privilege.
 */
async function primaryGuardians(
  db: AppDb,
  studentIds: string[],
): Promise<Map<string, { guardianId: string; phone: string }>> {
  if (studentIds.length === 0)
    return new Map();

  const rows = await db
    .select({
      studentId: studentGuardians.studentId,
      guardianId: guardians.id,
      phone: guardians.phone,
      isPrimary: studentGuardians.isPrimary,
    })
    .from(studentGuardians)
    .innerJoin(guardians, eq(studentGuardians.guardianId, guardians.id))
    // `inArray`, not a hand-built array literal. The ids come from our own
    // uuid columns so nothing was reachable, but concatenating values into SQL
    // is a habit worth not having — and the helper is shorter besides.
    .where(inArray(studentGuardians.studentId, studentIds));

  const chosen = new Map<string, { guardianId: string; phone: string; isPrimary: boolean }>();
  for (const row of rows) {
    const held = chosen.get(row.studentId);
    if (!held || (row.isPrimary && !held.isPrimary))
      chosen.set(row.studentId, row);
  }

  return new Map(
    [...chosen].map(([studentId, v]) => [studentId, { guardianId: v.guardianId, phone: v.phone }]),
  );
}

/** The children a broadcast is aimed at: enrolled now, in the chosen scope. */
async function cohort(
  db: AppDb,
  scope: { gradeLevelId?: string; streamId?: string },
) {
  const filters = [isNull(enrollments.endedOn), eq(students.status, "active")];
  if (scope.streamId)
    filters.push(eq(streams.id, scope.streamId));
  if (scope.gradeLevelId)
    filters.push(eq(gradeLevels.id, scope.gradeLevelId));

  return db
    .select({
      studentId: students.id,
      admissionNumber: students.admissionNumber,
      givenName: students.givenName,
      familyName: students.familyName,
      enrollmentId: enrollments.id,
    })
    .from(enrollments)
    .innerJoin(students, eq(enrollments.studentId, students.id))
    .innerJoin(streams, eq(enrollments.streamId, streams.id))
    .innerJoin(gradeLevels, eq(streams.gradeLevelId, gradeLevels.id))
    .where(and(...filters))
    /*
     * Class-list order, and ordered at all.
     *
     * Unordered, the preview's sample changed between two identical calls, so
     * a bursar checking the wording saw a different family each time and could
     * not tell whether anything had changed. It also decides the order a batch
     * goes out in, which is what makes "who had we reached before it failed" a
     * question with an answer.
     */
    .orderBy(asc(students.familyName), asc(students.givenName), asc(students.admissionNumber));
}

/**
 * `{name}` and `{school}` always; `{amount}` only where there is one.
 *
 * Anything else is left alone rather than blanked — and `{amount}` used to
 * contradict that, substituting an empty string on a results notice where no
 * amount exists. A head whose custom wording mentioned an amount would have
 * sent parents a sentence with a hole in it, and nothing would have said so.
 * Leaving the placeholder visible is ugly on purpose: it is a mistake somebody
 * can see in the dry run.
 */
function fill(template: string, values: { name: string; school: string; amount?: string }) {
  const filled = template
    .replaceAll("{name}", values.name)
    .replaceAll("{school}", values.school);

  return values.amount === undefined
    ? filled
    : filled.replaceAll("{amount}", values.amount);
}

/**
 * Queues and sends a batch, writing a row per message either way.
 *
 * The row is written BEFORE the provider is called and updated after, so a
 * message that vanishes into a timeout still exists as evidence something was
 * attempted. A school reconciling a bill against messages it can see needs the
 * failures as much as the successes.
 */
async function deliver(
  db: AppDb,
  input: {
    schoolId: string;
    actorId: string;
    kind: "results" | "fees";
    batchId: string;
    messages: Array<{ recipient: Recipient; body: string }>;
  },
) {
  let sent = 0;
  let failed = 0;
  let costCents = 0;

  for (const message of input.messages) {
    const [row] = await db
      .insert(smsMessages)
      .values({
        schoolId: input.schoolId,
        guardianId: message.recipient.guardianId,
        studentId: message.recipient.studentId,
        toPhone: message.recipient.phone,
        body: message.body,
        batchId: input.batchId,
        kind: input.kind,
        segments: segmentsFor(message.body),
        requestedBy: input.actorId,
      })
      .returning({ id: smsMessages.id });

    try {
      const result = await sendSms({ to: message.recipient.phone, body: message.body });

      await db
        .update(smsMessages)
        .set({
          status: result.accepted ? "sent" : "rejected",
          statusReason: result.reason,
          providerMessageId: result.providerMessageId,
          // The provider's figure, not our estimate. `segments` is what we
          // warned the bursar; this is what they will actually be billed.
          costCents: result.costCents,
          sentAt: result.accepted ? new Date() : null,
        })
        .where(eq(smsMessages.id, row.id));

      if (result.accepted) {
        sent += 1;
        costCents += result.costCents ?? 0;
      }
      else {
        failed += 1;
      }
    }
    catch (err) {
      /*
       * A provider outage fails this message, not the batch.
       *
       * Letting it throw would abandon the remaining families with no record
       * of who was reached — and the bursar would have no way to tell which
       * half to retry.
       */
      await db
        .update(smsMessages)
        .set({
          status: "failed",
          statusReason: err instanceof Error ? err.message : "Send failed",
        })
        .where(eq(smsMessages.id, row.id));
      failed += 1;
    }
  }

  return { sent, failed, costCents };
}

export const resultsNotice: TenantRouteHandler<ResultsNoticeRoute> = async (c) => {
  const body = c.req.valid("json");
  const db = c.var.db;

  const children = await cohort(db, body);
  const guardiansByStudent = await primaryGuardians(db, children.map(s => s.studentId));

  /*
   * Only families whose report card has actually been released.
   *
   * Telling a parent their results are ready and having them find nothing is
   * worse than not texting — and `releasedAt` is the gate that decides parent
   * visibility everywhere else, so honouring it here keeps the message and the
   * portal telling the same story.
   */
  const released = body.releasedOnly
    ? new Set(
      (await db
        .select({ enrollmentId: reportCards.enrollmentId })
        .from(reportCards)
        .where(and(
          eq(reportCards.termId, body.termId),
          sql`${reportCards.releasedAt} IS NOT NULL`,
        )))
        .map(r => r.enrollmentId),
    )
    : null;

  const template = body.message
    ?? "Dear parent, {name}'s results for this term are now available on the "
    + "{school} parent portal.";

  const messages: Array<{ recipient: Recipient; body: string }> = [];
  const skipped: Array<{ admissionNumber: string; reason: SkipReason }> = [];

  for (const child of children) {
    if (released && !released.has(child.enrollmentId)) {
      skipped.push({ admissionNumber: child.admissionNumber, reason: "no_report_card" });
      continue;
    }

    const guardian = guardiansByStudent.get(child.studentId);
    if (!guardian) {
      skipped.push({ admissionNumber: child.admissionNumber, reason: "no_guardian" });
      continue;
    }

    messages.push({
      recipient: {
        studentId: child.studentId,
        admissionNumber: child.admissionNumber,
        childName: child.givenName,
        guardianId: guardian.guardianId,
        phone: guardian.phone,
      },
      body: fill(template, { name: child.givenName, school: c.var.school.name }),
    });
  }

  return c.json(
    await respond(c, db, { kind: "results", messages, skipped, dryRun: body.dryRun }),
    HttpStatusCodes.OK,
  );
};

export const feeReminders: TenantRouteHandler<FeeRemindersRoute> = async (c) => {
  const body = c.req.valid("json");
  const db = c.var.db;

  const children = await cohort(db, body);
  const guardiansByStudent = await primaryGuardians(db, children.map(s => s.studentId));

  // The one place the balance formula lives (rule 4). A reminder quoting a
  // figure computed some other way is how a parent gets chased for a bill
  // they already paid.
  // Already keyed by student, and students with no activity are simply absent
  // — which is why the lookup below defaults to zero rather than assuming a
  // missing row means something went wrong.
  const owed = await balancesFor(db, children.map(s => s.studentId));

  const template = body.message
    ?? "Dear parent, the fee balance for {name} is KES {amount}. Pay via M-Pesa "
    + "using account number {ref}. Thank you — {school}.";

  const messages: Array<{ recipient: Recipient; body: string }> = [];
  const skipped: Array<{ admissionNumber: string; reason: SkipReason }> = [];

  for (const child of children) {
    const balance = owed.get(child.studentId)?.balanceCents ?? 0;
    if (balance < body.minBalanceCents) {
      skipped.push({ admissionNumber: child.admissionNumber, reason: "no_balance" });
      continue;
    }

    const guardian = guardiansByStudent.get(child.studentId);
    if (!guardian) {
      skipped.push({ admissionNumber: child.admissionNumber, reason: "no_guardian" });
      continue;
    }

    messages.push({
      recipient: {
        studentId: child.studentId,
        admissionNumber: child.admissionNumber,
        childName: child.givenName,
        guardianId: guardian.guardianId,
        phone: guardian.phone,
      },
      /*
       * The admission number goes in the message because it IS the M-Pesa
       * account reference (§5.3).
       *
       * A parent copying it straight out of the text is the single cheapest
       * thing we can do about the unmatched queue — most of what lands there
       * is a reference typed from memory.
       */
      body: fill(template, {
        name: child.givenName,
        school: c.var.school.name,
        amount: (balance / 100).toLocaleString("en-KE"),
      }).replaceAll("{ref}", child.admissionNumber),
    });
  }

  return c.json(
    await respond(c, db, { kind: "fees", messages, skipped, dryRun: body.dryRun }),
    HttpStatusCodes.OK,
  );
};

/** Shared tail: preview, or send and log. */
async function respond(
  c: { var: { school: { id: string; name: string }; user?: { id: string } | null } },
  db: AppDb,
  input: {
    kind: "results" | "fees";
    messages: Array<{ recipient: Recipient; body: string }>;
    skipped: Array<{ admissionNumber: string; reason: SkipReason }>;
    dryRun: boolean;
  },
) {
  const estimatedSegments = input.messages.reduce(
    (total, m) => total + segmentsFor(m.body),
    0,
  );
  // A working figure for the preview only: Africa's Talking bills per unit and
  // the real price comes back per message. 80 cents is the common Kenyan rate.
  const estimatedCostCents = estimatedSegments * 80;

  if (input.dryRun) {
    return {
      dryRun: true,
      batchId: null,
      recipients: input.messages.length,
      estimatedSegments,
      estimatedCostCents,
      sent: 0,
      failed: 0,
      sample: input.messages.slice(0, 3).map(m => ({ to: m.recipient.phone, body: m.body })),
      skipped: input.skipped,
    };
  }

  const batchId = crypto.randomUUID();
  const outcome = await deliver(db, {
    schoolId: c.var.school.id,
    actorId: c.var.user!.id,
    kind: input.kind,
    batchId,
    messages: input.messages,
  });

  await recordAudit(db, {
    schoolId: c.var.school.id,
    actorId: c.var.user!.id,
    action: "sms.queued",
    entityType: "sms_batch",
    entityId: batchId,
    summary:
      `Sent ${outcome.sent} ${input.kind} messages `
      + `(${outcome.failed} failed) costing ${outcome.costCents} cents`,
    detail: { kind: input.kind, skipped: input.skipped.length },
  });

  return {
    dryRun: false,
    batchId,
    recipients: input.messages.length,
    estimatedSegments,
    // After sending, the provider's total — not the estimate.
    estimatedCostCents: outcome.costCents,
    sent: outcome.sent,
    failed: outcome.failed,
    sample: input.messages.slice(0, 3).map(m => ({ to: m.recipient.phone, body: m.body })),
    skipped: input.skipped,
  };
}

export const listSms: TenantRouteHandler<ListSmsRoute> = async (c) => {
  const query = c.req.valid("query");
  const db = c.var.db;

  const filters = [];
  if (query.batchId)
    filters.push(eq(smsMessages.batchId, query.batchId));
  if (query.status)
    filters.push(eq(smsMessages.status, query.status));
  if (query.kind)
    filters.push(eq(smsMessages.kind, query.kind));
  if (query.studentId)
    filters.push(eq(smsMessages.studentId, query.studentId));

  const where = filters.length > 0 ? and(...filters) : undefined;

  const [totals] = await db
    .select({
      total: count(),
      // Coalesced, so an unbilled selection reports 0 rather than null — "we
      // have spent nothing" and "we cannot tell" must not look the same.
      totalCostCents: sql<number>`coalesce(sum(${smsMessages.costCents}), 0)::int`,
    })
    .from(smsMessages)
    .where(where);

  const rows = await db
    .select()
    .from(smsMessages)
    .where(where)
    .orderBy(desc(smsMessages.queuedAt))
    .limit(query.limit)
    .offset(query.offset);

  return c.json(
    { messages: rows, total: totals.total, totalCostCents: totals.totalCostCents },
    HttpStatusCodes.OK,
  );
};
