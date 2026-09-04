import { and, asc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import * as HttpStatusCodes from "stoker/http-status-codes";
import * as HttpStatusPhrases from "stoker/http-status-phrases";

import type { AppDb } from "@/db";
import type { ReportCardSnapshot } from "@/lib/assessment";
import type { TenantRouteHandler } from "@/lib/types";

import {
  assessments,
  assessmentScores,
  competencies,
  enrollments,
  gradeLevels,
  learningAreas,
  reportCards,
  schools,
  streams,
  students,
  termResults,
  terms,
} from "@/db/schema";
import { computePositions, computeTermResults } from "@/lib/assessment";
import { isForeignKeyViolation, isUniqueViolation } from "@/lib/db-errors";

import type {
  ComputeResultsRoute,
  CreateAssessmentRoute,
  FinaliseReportCardRoute,
  GetAssessmentRoute,
  GetReportCardRoute,
  ListAssessmentsRoute,
  ListReportCardsRoute,
  ListTermResultsRoute,
  PublishAssessmentRoute,
  ReleaseReportCardRoute,
  SaveScoresRoute,
  UnpublishAssessmentRoute,
} from "./assessment.routes";

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

async function assessmentDetail(db: AppDb, id: string) {
  const [assessment] = await db
    .select()
    .from(assessments)
    .where(eq(assessments.id, id));

  if (!assessment)
    return null;

  const scores = await db
    .select()
    .from(assessmentScores)
    .where(eq(assessmentScores.assessmentId, id));

  return {
    ...assessment,
    scores,
    isPublished: assessment.publishedAt !== null,
  };
}

export const listAssessments: TenantRouteHandler<ListAssessmentsRoute> = async (c) => {
  const query = c.req.valid("query");

  const filters = [];
  if (query.termId)
    filters.push(eq(assessments.termId, query.termId));
  if (query.learningAreaId)
    filters.push(eq(assessments.learningAreaId, query.learningAreaId));
  if (query.streamId)
    filters.push(eq(assessments.streamId, query.streamId));
  if (query.publishedOnly)
    filters.push(isNotNull(assessments.publishedAt));

  const rows = await c.var.db
    .select()
    .from(assessments)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(asc(assessments.administeredOn), asc(assessments.title));

  return c.json(rows, HttpStatusCodes.OK);
};

export const createAssessment: TenantRouteHandler<CreateAssessmentRoute> = async (c) => {
  const body = c.req.valid("json");

  try {
    const [created] = await c.var.db
      .insert(assessments)
      .values({
        schoolId: c.var.school.id,
        termId: body.termId,
        learningAreaId: body.learningAreaId,
        streamId: body.streamId,
        title: body.title,
        kind: body.kind,
        maxScore: body.maxScore,
        weight: body.weight === undefined ? null : String(body.weight),
        administeredOn: body.administeredOn,
        createdBy: c.var.user!.id,
      })
      .returning();

    return c.json((await assessmentDetail(c.var.db, created.id))!, HttpStatusCodes.CREATED);
  }
  catch (err) {
    if (isForeignKeyViolation(err)) {
      return c.json(
        fieldError(["termId"], "No such term, learning area or class at this school"),
        HttpStatusCodes.UNPROCESSABLE_ENTITY,
      );
    }
    throw err;
  }
};

export const getAssessment: TenantRouteHandler<GetAssessmentRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const detail = await assessmentDetail(c.var.db, id);

  if (!detail) {
    return c.json(
      { message: HttpStatusPhrases.NOT_FOUND },
      HttpStatusCodes.NOT_FOUND,
    );
  }

  return c.json(detail, HttpStatusCodes.OK);
};

export const saveScores: TenantRouteHandler<SaveScoresRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const { scores } = c.req.valid("json");
  const db = c.var.db;

  const [assessment] = await db
    .select({ publishedAt: assessments.publishedAt, maxScore: assessments.maxScore })
    .from(assessments)
    .where(eq(assessments.id, id));

  if (!assessment) {
    return c.json(
      { message: HttpStatusPhrases.NOT_FOUND },
      HttpStatusCodes.NOT_FOUND,
    );
  }

  /*
   * A published assessment is closed to edits.
   *
   * Parents are looking at it, and a mark that changed underneath them is the
   * complaint this whole flow exists to avoid. Withdrawing it first is one
   * extra click and makes the change deliberate — and visible, because the
   * assessment stops being published while it happens.
   */
  if (assessment.publishedAt) {
    return c.json(
      { message: "This assessment is published. Withdraw it before changing marks." },
      HttpStatusCodes.CONFLICT,
    );
  }

  // A mark above the paper's total is a typo every time — usually a digit
  // doubled. Caught here rather than quietly skewing a mean.
  if (assessment.maxScore !== null) {
    const over = scores.find(
      s => s.rawScore !== undefined && s.rawScore > assessment.maxScore!,
    );

    if (over) {
      return c.json(
        fieldError(
          ["scores"],
          `A mark of ${over.rawScore} is above this assessment's total of ${assessment.maxScore}`,
        ),
        HttpStatusCodes.UNPROCESSABLE_ENTITY,
      );
    }
  }

  let updated = 0;

  try {
    /*
     * The whole grid in one transaction.
     *
     * A partly saved grid is worse than a failed one: a teacher cannot tell
     * which rows landed, and re-entering the lot risks doubling the ones that
     * did. All or nothing, and re-submitting is safe.
     */
    await db.transaction(async (tx) => {
      for (const entry of scores) {
        const result = await tx
          .insert(assessmentScores)
          .values({
            schoolId: c.var.school.id,
            assessmentId: id,
            enrollmentId: entry.enrollmentId,
            competencyId: entry.competencyId,
            rawScore: entry.rawScore === undefined ? null : String(entry.rawScore),
            level: entry.level,
            isAbsent: entry.isAbsent,
            comment: entry.comment,
            enteredBy: c.var.user!.id,
          })
          .onConflictDoUpdate({
            // Matches the NULLS NOT DISTINCT unique, so re-submitting the grid
            // corrects rather than duplicates — including on the percentage
            // path, where the competency is null.
            target: [
              assessmentScores.assessmentId,
              assessmentScores.enrollmentId,
              assessmentScores.competencyId,
            ],
            set: {
              rawScore: entry.rawScore === undefined ? null : String(entry.rawScore),
              level: entry.level ?? null,
              isAbsent: entry.isAbsent,
              comment: entry.comment ?? null,
              enteredBy: c.var.user!.id,
              enteredAt: new Date(),
            },
          })
          .returning({ enteredAt: assessmentScores.enteredAt });

        if (result.length > 0)
          updated += 1;
      }
    });
  }
  catch (err) {
    if (isForeignKeyViolation(err)) {
      return c.json(
        fieldError(
          ["scores"],
          "An enrolment or competency in this grid is not this school's",
        ),
        HttpStatusCodes.UNPROCESSABLE_ENTITY,
      );
    }
    if (isUniqueViolation(err)) {
      return c.json(
        fieldError(["scores"], "The same pupil and competency appears twice in this grid"),
        HttpStatusCodes.UNPROCESSABLE_ENTITY,
      );
    }
    throw err;
  }

  return c.json({ saved: scores.length, updated }, HttpStatusCodes.OK);
};

export const publishAssessment: TenantRouteHandler<PublishAssessmentRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const db = c.var.db;

  const [updated] = await db
    .update(assessments)
    .set({ publishedAt: new Date() })
    .where(and(eq(assessments.id, id), isNull(assessments.publishedAt)))
    .returning({ id: assessments.id });

  if (!updated) {
    const exists = await db
      .select({ id: assessments.id })
      .from(assessments)
      .where(eq(assessments.id, id));

    return exists.length === 0
      ? c.json({ message: HttpStatusPhrases.NOT_FOUND }, HttpStatusCodes.NOT_FOUND)
      : c.json({ message: "Already published" }, HttpStatusCodes.CONFLICT);
  }

  return c.json((await assessmentDetail(db, id))!, HttpStatusCodes.OK);
};

export const unpublishAssessment: TenantRouteHandler<UnpublishAssessmentRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const db = c.var.db;

  const [updated] = await db
    .update(assessments)
    .set({ publishedAt: null })
    .where(and(eq(assessments.id, id), isNotNull(assessments.publishedAt)))
    .returning({ id: assessments.id });

  if (!updated) {
    const exists = await db
      .select({ id: assessments.id })
      .from(assessments)
      .where(eq(assessments.id, id));

    return exists.length === 0
      ? c.json({ message: HttpStatusPhrases.NOT_FOUND }, HttpStatusCodes.NOT_FOUND)
      : c.json({ message: "Not published" }, HttpStatusCodes.CONFLICT);
  }

  return c.json((await assessmentDetail(db, id))!, HttpStatusCodes.OK);
};

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export const computeResults: TenantRouteHandler<ComputeResultsRoute> = async (c) => {
  const { termId, levelReduction } = c.req.valid("json");
  const db = c.var.db;

  // Invisible under RLS if it is another school's, so this doubles as the
  // tenant check.
  const [term] = await db
    .select({ id: terms.id })
    .from(terms)
    .where(eq(terms.id, termId));

  if (!term) {
    return c.json(
      fieldError(["termId"], "No such term at this school"),
      HttpStatusCodes.UNPROCESSABLE_ENTITY,
    );
  }

  const { enrolments, results } = await computeTermResults(
    db,
    c.var.school.id,
    termId,
    levelReduction,
  );

  const positionsRanked = await computePositions(db, termId);

  return c.json({ enrolments, results, positionsRanked }, HttpStatusCodes.OK);
};

export const listTermResults: TenantRouteHandler<ListTermResultsRoute> = async (c) => {
  const query = c.req.valid("query");
  const db = c.var.db;

  const filters = [eq(termResults.termId, query.termId)];

  if (query.enrollmentId)
    filters.push(eq(termResults.enrollmentId, query.enrollmentId));

  if (query.streamId) {
    const inStream = db
      .select({ id: enrollments.id })
      .from(enrollments)
      .where(eq(enrollments.streamId, query.streamId));

    filters.push(inArray(termResults.enrollmentId, inStream));
  }

  const rows = await db
    .select()
    .from(termResults)
    .where(and(...filters));

  return c.json(rows, HttpStatusCodes.OK);
};

// ---------------------------------------------------------------------------
// Report cards
// ---------------------------------------------------------------------------

export const finaliseReportCard: TenantRouteHandler<FinaliseReportCardRoute> = async (c) => {
  const body = c.req.valid("json");
  const db = c.var.db;

  const [context] = await db
    .select({
      enrollmentId: enrollments.id,
      studentId: students.id,
      admissionNumber: students.admissionNumber,
      givenName: students.givenName,
      familyName: students.familyName,
      streamId: streams.id,
      streamName: streams.name,
      gradeLevelName: gradeLevels.name,
    })
    .from(enrollments)
    .innerJoin(students, eq(enrollments.studentId, students.id))
    .innerJoin(streams, eq(enrollments.streamId, streams.id))
    .innerJoin(gradeLevels, eq(streams.gradeLevelId, gradeLevels.id))
    .where(eq(enrollments.id, body.enrollmentId));

  if (!context) {
    return c.json(
      fieldError(["enrollmentId"], "No such enrolment at this school"),
      HttpStatusCodes.UNPROCESSABLE_ENTITY,
    );
  }

  const [term] = await db
    .select()
    .from(terms)
    .where(eq(terms.id, body.termId));

  if (!term) {
    return c.json(
      fieldError(["termId"], "No such term at this school"),
      HttpStatusCodes.UNPROCESSABLE_ENTITY,
    );
  }

  const results = await db
    .select({
      learningAreaId: termResults.learningAreaId,
      learningAreaName: learningAreas.name,
      sequence: learningAreas.sequence,
      meanScore: termResults.meanScore,
      overallLevel: termResults.overallLevel,
      streamPosition: termResults.streamPosition,
      gradePosition: termResults.gradePosition,
      outOf: termResults.outOf,
    })
    .from(termResults)
    .innerJoin(learningAreas, eq(termResults.learningAreaId, learningAreas.id))
    .where(and(
      eq(termResults.enrollmentId, body.enrollmentId),
      eq(termResults.termId, body.termId),
    ))
    .orderBy(asc(learningAreas.sequence));

  if (results.length === 0) {
    return c.json(
      fieldError(
        ["enrollmentId"],
        "Nothing has been computed for this child in this term yet",
      ),
      HttpStatusCodes.UNPROCESSABLE_ENTITY,
    );
  }

  const [school] = await db
    .select({ showsPositions: schools.showsPositions })
    .from(schools)
    .limit(1);

  // The per-sub-strand breakdown, which is the BODY of a CBE report card —
  // the mean and the position are the summary strip above it.
  const breakdown = await db
    .select({
      learningAreaId: assessments.learningAreaId,
      competencyId: assessmentScores.competencyId,
      title: competencies.title,
      code: competencies.code,
      level: assessmentScores.level,
    })
    .from(assessmentScores)
    .innerJoin(assessments, eq(assessmentScores.assessmentId, assessments.id))
    .innerJoin(competencies, eq(assessmentScores.competencyId, competencies.id))
    .where(and(
      eq(assessmentScores.enrollmentId, body.enrollmentId),
      eq(assessments.termId, body.termId),
      isNotNull(assessments.publishedAt),
      isNotNull(assessmentScores.level),
    ))
    .orderBy(asc(competencies.sequence));

  const byArea = new Map<string, typeof breakdown>();
  for (const row of breakdown) {
    const list = byArea.get(row.learningAreaId) ?? [];
    list.push(row);
    byArea.set(row.learningAreaId, list);
  }

  const snapshot: ReportCardSnapshot = {
    student: {
      id: context.studentId,
      admissionNumber: context.admissionNumber,
      name: `${context.givenName} ${context.familyName}`,
    },
    class: {
      streamId: context.streamId,
      streamName: context.streamName,
      gradeLevelName: context.gradeLevelName,
    },
    term: {
      id: term.id,
      number: term.number,
      startsOn: term.startsOn,
      endsOn: term.endsOn,
    },
    showsPositions: school?.showsPositions ?? true,
    levelReduction: "mode_ties_low",
    learningAreas: results.map(r => ({
      name: r.learningAreaName,
      sequence: r.sequence,
      meanScore: r.meanScore === null ? null : Number(r.meanScore),
      overallLevel: r.overallLevel,
      /*
       * Positions are omitted entirely when the school does not publish them.
       *
       * Nulling them at render time would leave the number in the frozen
       * document, one query away from a screen that decided to show it. Some
       * schools have moved away from ranking children under CBE, and honouring
       * that means the snapshot does not carry the rank at all.
       */
      streamPosition: school?.showsPositions ? r.streamPosition : null,
      gradePosition: school?.showsPositions ? r.gradePosition : null,
      outOf: school?.showsPositions ? r.outOf : null,
      competencies: (byArea.get(r.learningAreaId) ?? []).map(cmp => ({
        title: cmp.title,
        code: cmp.code,
        level: cmp.level!,
      })),
    })),
    finalisedAt: new Date().toISOString(),
  };

  try {
    const [created] = await db
      .insert(reportCards)
      .values({
        schoolId: c.var.school.id,
        enrollmentId: body.enrollmentId,
        termId: body.termId,
        snapshot,
        classTeacherComment: body.classTeacherComment,
        headComment: body.headComment,
        attendancePresent: body.attendancePresent,
        attendanceTotal: body.attendanceTotal,
        finalisedBy: c.var.user!.id,
        finalisedAt: new Date(),
      })
      .returning();

    return c.json(created, HttpStatusCodes.CREATED);
  }
  catch (err) {
    if (isUniqueViolation(err)) {
      return c.json(
        { message: "This child's report card for this term is already finalised" },
        HttpStatusCodes.CONFLICT,
      );
    }
    throw err;
  }
};

export const releaseReportCard: TenantRouteHandler<ReleaseReportCardRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const db = c.var.db;

  // Finalised and not yet released, checked in the predicate so two heads
  // clicking at once produce one release and one conflict.
  const [updated] = await db
    .update(reportCards)
    .set({ releasedAt: new Date() })
    .where(and(
      eq(reportCards.id, id),
      isNotNull(reportCards.finalisedAt),
      isNull(reportCards.releasedAt),
    ))
    .returning();

  if (!updated) {
    const [existing] = await db
      .select({ finalisedAt: reportCards.finalisedAt, releasedAt: reportCards.releasedAt })
      .from(reportCards)
      .where(eq(reportCards.id, id));

    if (!existing)
      return c.json({ message: HttpStatusPhrases.NOT_FOUND }, HttpStatusCodes.NOT_FOUND);

    return c.json(
      {
        message: existing.releasedAt
          ? "Already released"
          : "Finalise it before releasing — a guardian must not see a document that could still change",
      },
      HttpStatusCodes.CONFLICT,
    );
  }

  return c.json(updated, HttpStatusCodes.OK);
};

export const getReportCard: TenantRouteHandler<GetReportCardRoute> = async (c) => {
  const { id } = c.req.valid("param");

  const [row] = await c.var.db
    .select()
    .from(reportCards)
    .where(eq(reportCards.id, id));

  if (!row) {
    return c.json(
      { message: HttpStatusPhrases.NOT_FOUND },
      HttpStatusCodes.NOT_FOUND,
    );
  }

  return c.json(row, HttpStatusCodes.OK);
};

export const listReportCards: TenantRouteHandler<ListReportCardsRoute> = async (c) => {
  const query = c.req.valid("query");

  const filters = [eq(reportCards.termId, query.termId)];
  if (query.releasedOnly)
    filters.push(isNotNull(reportCards.releasedAt));

  const rows = await c.var.db
    .select()
    .from(reportCards)
    .where(and(...filters));

  return c.json(rows, HttpStatusCodes.OK);
};
