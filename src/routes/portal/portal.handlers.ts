import { and, asc, desc, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import * as HttpStatusCodes from "stoker/http-status-codes";
import * as HttpStatusPhrases from "stoker/http-status-phrases";

import type { AppDb } from "@/db";
import type { TenantRouteHandler } from "@/lib/types";

import {
  academicYears,
  enrollments,
  gradeLevels,
  guardians,
  invoices,
  learningAreas,
  payments,
  reportCards,
  streams,
  studentGuardians,
  students,
  termResults,
  terms,
  user,
} from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { balancesFor } from "@/lib/balances";
import { normalizeKenyanPhone } from "@/lib/phone";
import { verificationUrlFor } from "@/lib/verification";

import type {
  ChildFeesRoute,
  ChildReportCardsRoute,
  ChildResultsRoute,
  ClaimRoute,
  MyChildrenRoute,
} from "./portal.routes";

/**
 * The children this caller may see, and the only source of that answer.
 *
 * Every route funnels through here. Tenant isolation is already handled by RLS
 * and does nothing for this: every guardian at a school passes the same policy,
 * so without this second scoping a parent could read the whole register by
 * changing an id in a URL.
 *
 * Returns an empty set for an unlinked account rather than throwing, so the
 * caller can tell "no children" from "not a guardian" and say something useful.
 */
async function childrenOf(db: AppDb, userId: string) {
  return db
    .select({
      studentId: students.id,
      admissionNumber: students.admissionNumber,
      givenName: students.givenName,
      familyName: students.familyName,
      relationship: studentGuardians.relationship,
    })
    .from(guardians)
    .innerJoin(studentGuardians, eq(studentGuardians.guardianId, guardians.id))
    .innerJoin(students, eq(studentGuardians.studentId, students.id))
    .where(eq(guardians.userId, userId))
    .orderBy(asc(students.familyName), asc(students.givenName));
}

/** 404 rather than 403 for another family's child — see the comment inline. */
async function requireOwnChild(db: AppDb, userId: string, studentId: string) {
  const mine = await childrenOf(db, userId);
  return mine.find(c => c.studentId === studentId) ?? null;
}

export const claim: TenantRouteHandler<ClaimRoute> = async (c) => {
  const db = c.var.db;
  const userId = c.var.user!.id;

  /*
   * Read from the row, not from the session.
   *
   * What matters here is whether an identifier is VERIFIED, and that is a
   * property of the account rather than of this request. An unverified email
   * would let anyone who knows a parent's address sign up with it and read a
   * child's marks — so an unverified one matches nothing at all.
   */
  const [account] = await db
    .select({
      email: user.email,
      emailVerified: user.emailVerified,
      phoneNumber: user.phoneNumber,
      phoneNumberVerified: user.phoneNumberVerified,
    })
    .from(user)
    .where(eq(user.id, userId));

  const matchers = [];
  const matchedOn: Array<"phone" | "email"> = [];

  if (account?.phoneNumber && account.phoneNumberVerified) {
    // Normalised, because the school may hold `0712…` where the account holds
    // `+254712…` and they are the same number (rule 10).
    const normalized = normalizeKenyanPhone(account.phoneNumber) ?? account.phoneNumber;
    matchers.push(eq(guardians.phone, normalized), eq(guardians.altPhone, normalized));
    matchedOn.push("phone");
  }

  if (account?.email && account.emailVerified) {
    matchers.push(eq(guardians.email, account.email));
    matchedOn.push("email");
  }

  if (matchers.length === 0) {
    return c.json(
      { linked: 0, alreadyLinked: 0, children: 0, matchedOn: [] },
      HttpStatusCodes.OK,
    );
  }

  const candidates = await db
    .select({ id: guardians.id, userId: guardians.userId })
    .from(guardians)
    .where(or(...matchers));

  const alreadyLinked = candidates.filter(g => g.userId === userId).length;
  /*
   * Never take a record that belongs to somebody else's account.
   *
   * Two parents can legitimately share a phone number, and the first to claim
   * it holds it. Reassigning would silently move one family's view of their
   * children onto another person's login.
   */
  const claimable = candidates.filter(g => g.userId === null);

  if (claimable.length > 0) {
    await db
      .update(guardians)
      .set({ userId })
      .where(inArray(guardians.id, claimable.map(g => g.id)));

    await recordAudit(db, {
      schoolId: c.var.school.id,
      actorId: userId,
      action: "guardian.linked",
      entityType: "guardian",
      entityId: claimable[0].id,
      summary: `A guardian linked their own account by verified ${matchedOn.join(" and ")}`,
      detail: { guardianIds: claimable.map(g => g.id), matchedOn },
    });
  }

  const children = await childrenOf(db, userId);

  return c.json({
    linked: claimable.length,
    alreadyLinked,
    children: children.length,
    matchedOn,
  }, HttpStatusCodes.OK);
};

export const myChildren: TenantRouteHandler<MyChildrenRoute> = async (c) => {
  const db = c.var.db;
  const children = await childrenOf(db, c.var.user!.id);

  if (children.length === 0) {
    return c.json(
      {
        message:
          "This account is not linked to a guardian record at this school. "
          + "Claim it, or ask the office to link it for you.",
      },
      HttpStatusCodes.CONFLICT,
    );
  }

  const balances = await balancesFor(db, children.map(ch => ch.studentId));

  // The open enrolment is what answers "which class" (§5.3) — there is
  // deliberately no column for it.
  const placements = await db
    .select({
      studentId: enrollments.studentId,
      streamName: streams.name,
      gradeLevelName: gradeLevels.name,
    })
    .from(enrollments)
    .innerJoin(streams, eq(enrollments.streamId, streams.id))
    .innerJoin(gradeLevels, eq(streams.gradeLevelId, gradeLevels.id))
    .where(and(
      inArray(enrollments.studentId, children.map(ch => ch.studentId)),
      // The OPEN one. `endedOn = endedOn` would have been NULL for exactly
      // these rows and quietly excluded every current placement.
      isNull(enrollments.endedOn),
    ));

  const classOf = new Map(
    placements.map(p => [p.studentId, `${p.gradeLevelName} ${p.streamName}`]),
  );

  return c.json(
    children.map(ch => ({
      studentId: ch.studentId,
      admissionNumber: ch.admissionNumber,
      name: `${ch.givenName} ${ch.familyName}`,
      className: classOf.get(ch.studentId) ?? null,
      relationship: ch.relationship,
      balanceCents: balances.get(ch.studentId)?.balanceCents ?? 0,
    })),
    HttpStatusCodes.OK,
  );
};

export const childResults: TenantRouteHandler<ChildResultsRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const db = c.var.db;

  /*
   * 404 for another family's child, not 403.
   *
   * A 403 would confirm the id names a real pupil at this school, which turns
   * the URL into a way to enumerate the register — the same reasoning that
   * makes `withMembership` answer 404 rather than 403 for a non-member.
   */
  if (!await requireOwnChild(db, c.var.user!.id, id)) {
    return c.json({ message: HttpStatusPhrases.NOT_FOUND }, HttpStatusCodes.NOT_FOUND);
  }

  const rows = await db
    .select({
      termId: terms.id,
      termNumber: terms.number,
      year: academicYears.year,
      name: learningAreas.name,
      meanScore: termResults.meanScore,
      overallLevel: termResults.overallLevel,
      streamPosition: termResults.streamPosition,
      outOf: termResults.outOf,
      sequence: learningAreas.sequence,
    })
    .from(termResults)
    .innerJoin(enrollments, eq(termResults.enrollmentId, enrollments.id))
    .innerJoin(terms, eq(termResults.termId, terms.id))
    .innerJoin(academicYears, eq(terms.academicYearId, academicYears.id))
    .innerJoin(learningAreas, eq(termResults.learningAreaId, learningAreas.id))
    .where(eq(enrollments.studentId, id))
    .orderBy(desc(academicYears.year), desc(terms.number), asc(learningAreas.sequence));

  const byTerm = new Map<string, {
    termId: string;
    termNumber: number;
    year: number;
    learningAreas: Array<{
      name: string;
      meanScore: number | null;
      overallLevel: string | null;
      streamPosition: number | null;
      outOf: number | null;
    }>;
  }>();

  for (const row of rows) {
    const held = byTerm.get(row.termId) ?? {
      termId: row.termId,
      termNumber: row.termNumber,
      year: row.year,
      learningAreas: [],
    };
    held.learningAreas.push({
      name: row.name,
      meanScore: row.meanScore === null ? null : Number(row.meanScore),
      overallLevel: row.overallLevel,
      streamPosition: row.streamPosition,
      outOf: row.outOf,
    });
    byTerm.set(row.termId, held);
  }

  return c.json([...byTerm.values()], HttpStatusCodes.OK);
};

export const childReportCards: TenantRouteHandler<ChildReportCardsRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const db = c.var.db;

  if (!await requireOwnChild(db, c.var.user!.id, id)) {
    return c.json({ message: HttpStatusPhrases.NOT_FOUND }, HttpStatusCodes.NOT_FOUND);
  }

  const rows = await db
    .select({
      id: reportCards.id,
      termId: reportCards.termId,
      releasedAt: reportCards.releasedAt,
      snapshot: reportCards.snapshot,
      classTeacherComment: reportCards.classTeacherComment,
      headComment: reportCards.headComment,
      verificationCode: reportCards.verificationCode,
    })
    .from(reportCards)
    .innerJoin(enrollments, eq(reportCards.enrollmentId, enrollments.id))
    .where(and(
      eq(enrollments.studentId, id),
      // Released only. A finalised card the head has not released is not a
      // document this family is meant to have yet.
      isNotNull(reportCards.releasedAt),
    ))
    .orderBy(desc(reportCards.releasedAt));

  return c.json(
    rows.map(row => ({
      id: row.id,
      termId: row.termId,
      releasedAt: row.releasedAt!.toISOString(),
      snapshot: row.snapshot as Record<string, unknown>,
      classTeacherComment: row.classTeacherComment,
      headComment: row.headComment,
      verificationUrl: row.verificationCode
        ? verificationUrlFor(row.verificationCode)
        : null,
    })),
    HttpStatusCodes.OK,
  );
};

export const childFees: TenantRouteHandler<ChildFeesRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const db = c.var.db;

  const child = await requireOwnChild(db, c.var.user!.id, id);
  if (!child) {
    return c.json({ message: HttpStatusPhrases.NOT_FOUND }, HttpStatusCodes.NOT_FOUND);
  }

  // The one place the formula lives (rule 4).
  const balances = await balancesFor(db, [id]);
  const balance = balances.get(id);

  const billed = await db
    .select()
    .from(invoices)
    .where(eq(invoices.studentId, id))
    .orderBy(desc(invoices.issuedOn));

  const received = await db
    .select()
    .from(payments)
    .where(eq(payments.studentId, id))
    .orderBy(desc(payments.receivedAt));

  return c.json({
    balanceCents: balance?.balanceCents ?? 0,
    billedCents: balance?.billedCents ?? 0,
    paidCents: balance?.paidCents ?? 0,
    // The admission number IS the M-Pesa account reference (§5.3). Showing it
    // beside the balance is the cheapest thing we can do about the unmatched
    // queue: most of what lands there is a reference typed from memory.
    payToAccount: child.admissionNumber,
    invoices: billed.map(i => ({
      id: i.id,
      termId: i.termId,
      totalCents: i.totalCents,
      issuedOn: i.issuedOn,
      dueOn: i.dueOn,
      voidedAt: i.voidedAt?.toISOString() ?? null,
    })),
    payments: received.map(p => ({
      id: p.id,
      amountCents: p.amountCents,
      method: p.method,
      receivedAt: p.receivedAt.toISOString(),
      reference: p.reference,
      reversedAt: p.reversedAt?.toISOString() ?? null,
    })),
  }, HttpStatusCodes.OK);
};
