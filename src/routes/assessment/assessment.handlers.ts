import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
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
  transitionCertificates,
} from "@/db/schema";
import { computePositions, computeTermResults } from "@/lib/assessment";
import { recordAudit } from "@/lib/audit";
import { isForeignKeyViolation, isUniqueViolation } from "@/lib/db-errors";
import { mintVerificationCode, qrSvgFor, verificationUrlFor } from "@/lib/verification";

import type {
  ComputeResultsRoute,
  CreateAssessmentRoute,
  FinaliseReportCardRoute,
  GetAssessmentRoute,
  GetCertificateRoute,
  GetReportCardRoute,
  IssueCertificateRoute,
  ListAssessmentsRoute,
  ListCertificatesRoute,
  ListReportCardsRoute,
  ListTermResultsRoute,
  MeritListRoute,
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

  /*
   * Locked, because the published check below is only worth anything if the
   * answer cannot change under us.
   *
   * `c.var.db` is the request's transaction, but READ COMMITTED gives each
   * statement its own snapshot: a publish committing between this read and the
   * upsert would leave us writing marks into an assessment parents had already
   * been shown — the exact thing the check exists to prevent, and invisible
   * afterwards because both requests succeeded. `FOR UPDATE` makes the publish
   * wait for this request to finish instead, and the lock is held to the end of
   * the request rather than the end of the block below.
   */
  const [assessment] = await db
    .select({ publishedAt: assessments.publishedAt, maxScore: assessments.maxScore })
    .from(assessments)
    .where(eq(assessments.id, id))
    .for("update");

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

  /*
   * One row per pupil-and-competency, last entry winning.
   *
   * A multi-row upsert cannot touch the same conflict target twice — Postgres
   * refuses with "cannot affect row a second time" — so a grid that repeated a
   * pupil would fail the whole submission. Collapsing first keeps the previous
   * behaviour (the last value entered is the one saved) and makes the
   * duplicate a non-event rather than a 500.
   */
  const deduped = new Map<string, typeof scores[number]>();
  for (const entry of scores)
    deduped.set(`${entry.enrollmentId}:${entry.competencyId ?? ""}`, entry);

  const rows = [...deduped.values()].map(entry => ({
    schoolId: c.var.school.id,
    assessmentId: id,
    enrollmentId: entry.enrollmentId,
    competencyId: entry.competencyId,
    rawScore: entry.rawScore === undefined ? null : String(entry.rawScore),
    level: entry.level,
    isAbsent: entry.isAbsent,
    comment: entry.comment,
    enteredBy: c.var.user!.id,
  }));

  let updated = 0;

  try {
    /*
     * The whole grid in one statement, inside one transaction.
     *
     * A partly saved grid is worse than a failed one: a teacher cannot tell
     * which rows landed, and re-entering the lot risks doubling the ones that
     * did. All or nothing, and re-submitting is safe.
     */
    await db.transaction(async (tx) => {
      const written = await tx
        .insert(assessmentScores)
        .values(rows)
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
            rawScore: sql`excluded.raw_score`,
            level: sql`excluded.level`,
            isAbsent: sql`excluded.is_absent`,
            comment: sql`excluded.comment`,
            enteredBy: sql`excluded.entered_by`,
            enteredAt: new Date(),
          },
        })
        .returning({
          /*
           * The genuine insert-versus-update signal.
           *
           * An upsert returns a row either way, so counting returned rows made
           * `updated` always equal `saved` — the field claimed to say how many
           * marks were CORRECTED and in fact said how many were submitted. A
           * non-zero `xmax` means this tuple replaced an existing version,
           * which is the only thing that actually distinguishes them.
           */
          wasUpdate: sql<boolean>`(xmax <> 0)`,
        });

      updated = written.filter(r => r.wasUpdate).length;
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

  await recordAudit(db, {
    schoolId: c.var.school.id,
    actorId: c.var.user!.id,
    action: "marks.saved",
    entityType: "assessment",
    entityId: id,
    summary: `Entered ${rows.length} marks, ${updated} of them corrections`,
    detail: { submitted: scores.length, deduped: rows.length, updated },
  });

  return c.json({ saved: scores.length, updated }, HttpStatusCodes.OK);
};

export const publishAssessment: TenantRouteHandler<PublishAssessmentRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const db = c.var.db;

  const [updated] = await db
    .update(assessments)
    .set({ publishedAt: new Date() })
    .where(and(eq(assessments.id, id), isNull(assessments.publishedAt)))
    .returning({ id: assessments.id, title: assessments.title });

  if (!updated) {
    const exists = await db
      .select({ id: assessments.id })
      .from(assessments)
      .where(eq(assessments.id, id));

    return exists.length === 0
      ? c.json({ message: HttpStatusPhrases.NOT_FOUND }, HttpStatusCodes.NOT_FOUND)
      : c.json({ message: "Already published" }, HttpStatusCodes.CONFLICT);
  }

  await recordAudit(db, {
    schoolId: c.var.school.id,
    actorId: c.var.user!.id,
    action: "assessment.published",
    entityType: "assessment",
    entityId: id,
    summary: `Published "${updated.title}" — marks are now visible to guardians`,
  });

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

  /*
   * Withdrawing is the one worth logging most.
   *
   * Marks that parents have already seen are about to become editable again,
   * and the reason `saveScores` refuses a published assessment is precisely
   * that a mark changing underneath a parent is the complaint to avoid. This
   * is the record that the change was deliberate and whose it was.
   */
  await recordAudit(db, {
    schoolId: c.var.school.id,
    actorId: c.var.user!.id,
    action: "assessment.unpublished",
    entityType: "assessment",
    entityId: id,
    summary: "Withdrew a published assessment, reopening it for edits",
  });

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

  const { enrolments, results, cleared } = await computeTermResults(
    db,
    c.var.school.id,
    termId,
    levelReduction,
  );

  const positionsRanked = await computePositions(db, termId);

  return c.json({ enrolments, results, positionsRanked, cleared }, HttpStatusCodes.OK);
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
      levelReduction: termResults.levelReduction,
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
    /*
     * The rule that actually produced these levels, read from the results
     * rather than assumed.
     *
     * Hardcoding the default meant a school computing with `lowest` got a
     * frozen document claiming `mode_ties_low` — the snapshot would have
     * misdescribed its own contents, which is worse than not recording the
     * rule at all.
     */
    levelReduction: results[0].levelReduction,
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
        // Minted here, with the snapshot it stands behind. Before finalisation
        // there is nothing frozen for a code to verify.
        verificationCode: mintVerificationCode(),
      })
      .returning();

    await recordAudit(db, {
      schoolId: c.var.school.id,
      actorId: c.var.user!.id,
      action: "report_card.finalised",
      entityType: "report_card",
      entityId: created.id,
      summary: `Finalised a report card for term ${term.number}`,
      detail: { enrollmentId: body.enrollmentId, termId: body.termId },
    });

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

  await recordAudit(db, {
    schoolId: c.var.school.id,
    actorId: c.var.user!.id,
    action: "report_card.released",
    entityType: "report_card",
    entityId: updated.id,
    summary: "Released a report card to guardians",
  });

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

  /*
   * The QR goes out with the document, not as a separate call.
   *
   * Whatever renders the page — a PDF pipeline, the Next app — needs the SVG
   * in hand at render time; making it fetch a second endpoint is how a report
   * card ends up printed without one. Built from the stored code rather than
   * minted here, so reprinting the same card always carries the same QR.
   */
  return c.json({
    ...row,
    verificationUrl: row.verificationCode
      ? verificationUrlFor(row.verificationCode)
      : null,
    verificationQrSvg: row.verificationCode
      ? await qrSvgFor(row.verificationCode)
      : null,
  }, HttpStatusCodes.OK);
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

// ---------------------------------------------------------------------------
// Merit lists and transition certificates
// ---------------------------------------------------------------------------

export const meritList: TenantRouteHandler<MeritListRoute> = async (c) => {
  const query = c.req.valid("query");
  const db = c.var.db;

  /*
   * Refused outright when the school does not rank children.
   *
   * CLAUDE.md §5.6 keeps positions out of a report card snapshot entirely at
   * such a school rather than nulling them at render time, and the same
   * reasoning applies harder here: a merit list IS the ranking. Returning it
   * unranked would be a different document nobody asked for; returning it
   * ranked would hand a head the thing they decided not to publish.
   */
  const [school] = await db
    .select({ showsPositions: schools.showsPositions })
    .from(schools)
    .limit(1);

  if (!(school?.showsPositions ?? true)) {
    return c.json(
      { message: "This school does not publish positions" },
      HttpStatusCodes.CONFLICT,
    );
  }

  const filters = [eq(termResults.termId, query.termId)];
  if (query.streamId)
    filters.push(eq(streams.id, query.streamId));
  if (query.gradeLevelId)
    filters.push(eq(gradeLevels.id, query.gradeLevelId));

  /*
   * The mean of the learning-area means, not a mean of raw marks.
   *
   * Each area is already weighted internally by its assessments; averaging the
   * area means again gives every subject equal say, which is what a Kenyan
   * merit list has always meant. Averaging raw marks instead would silently
   * weight whichever subject set the most papers.
   *
   * Areas with no mean are skipped rather than counted as zero — the same rule
   * as an absence, and `learningAreas` is returned so a reader can see when
   * two children were ranked over different numbers of subjects.
   */
  const rows = await db
    .select({
      enrollmentId: termResults.enrollmentId,
      studentId: students.id,
      admissionNumber: students.admissionNumber,
      givenName: students.givenName,
      familyName: students.familyName,
      streamName: streams.name,
      gradeLevelName: gradeLevels.name,
      overallMean: sql<string>`avg(${termResults.meanScore})`,
      learningAreas: sql<number>`count(${termResults.meanScore})::int`,
    })
    .from(termResults)
    .innerJoin(enrollments, eq(termResults.enrollmentId, enrollments.id))
    .innerJoin(students, eq(enrollments.studentId, students.id))
    .innerJoin(streams, eq(enrollments.streamId, streams.id))
    .innerJoin(gradeLevels, eq(streams.gradeLevelId, gradeLevels.id))
    .where(and(...filters))
    .groupBy(
      termResults.enrollmentId,
      students.id,
      students.admissionNumber,
      students.givenName,
      students.familyName,
      streams.name,
      gradeLevels.name,
    )
    .having(sql`count(${termResults.meanScore}) > 0`)
    .orderBy(sql`avg(${termResults.meanScore}) DESC`, asc(students.familyName));

  /*
   * Ties share a position, the way `rank()` does everywhere else.
   *
   * `index + 1` numbered two children on identical means 3rd and 4th, decided
   * by surname — and position is the most contested number on a Kenyan report
   * card, so a rank that depends on the alphabet is one a parent is right to
   * dispute. `computePositions` already uses SQL `rank()` for the per-subject
   * positions; this makes the merit list agree with the report cards built
   * from the same data.
   *
   * Ranked on the DISPLAYED figure. Two means that print as 71.43 must share a
   * place even if they differ in the seventh decimal, or the sheet shows
   * identical marks with different positions beside them.
   */
  let position = 0;
  let previousMean: number | null = null;

  return c.json(
    rows.map((row, index) => {
      const overallMean = Math.round(Number(row.overallMean) * 100) / 100;
      if (overallMean !== previousMean) {
        position = index + 1;
        previousMean = overallMean;
      }

      return {
        position,
        enrollmentId: row.enrollmentId,
        studentId: row.studentId,
        admissionNumber: row.admissionNumber,
        name: `${row.givenName} ${row.familyName}`,
        streamName: row.streamName,
        gradeLevelName: row.gradeLevelName,
        overallMean,
        learningAreas: row.learningAreas,
      };
    }),
    HttpStatusCodes.OK,
  );
};

/** The milestone a grade sequence marks, or null if it marks none. */
function milestoneFor(sequence: number): "grade_6" | "grade_9" | null {
  // Derived, never stored (CLAUDE.md §5.2). Grade 6 and Grade 9 are the
  // candidate years, and the two points a family needs paperwork for.
  if (sequence === 6)
    return "grade_6";
  if (sequence === 9)
    return "grade_9";
  return null;
}

export const issueCertificate: TenantRouteHandler<IssueCertificateRoute> = async (c) => {
  const body = c.req.valid("json");
  const db = c.var.db;

  const [context] = await db
    .select({
      studentId: students.id,
      admissionNumber: students.admissionNumber,
      givenName: students.givenName,
      middleNames: students.middleNames,
      familyName: students.familyName,
      dateOfBirth: students.dateOfBirth,
      upiNumber: students.upiNumber,
      streamName: streams.name,
      gradeLevelName: gradeLevels.name,
      sequence: gradeLevels.sequence,
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

  const milestone = milestoneFor(context.sequence);
  if (!milestone) {
    return c.json(
      fieldError(
        ["enrollmentId"],
        `${context.gradeLevelName} is not a transition year — certificates are `
        + "issued at Grade 6 and Grade 9",
      ),
      HttpStatusCodes.UNPROCESSABLE_ENTITY,
    );
  }

  const [term] = await db
    .select({ id: terms.id, number: terms.number })
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
      learningAreaName: learningAreas.name,
      sequence: learningAreas.sequence,
      meanScore: termResults.meanScore,
      overallLevel: termResults.overallLevel,
      levelReduction: termResults.levelReduction,
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
        ["termId"],
        "Nothing has been computed for this child in this term, so there is "
        + "nothing to certify",
      ),
      HttpStatusCodes.UNPROCESSABLE_ENTITY,
    );
  }

  /*
   * Frozen at issue, like a report card and for the same reason (rule 7).
   *
   * A transition certificate is the document a family carries to the next
   * school. Reprinting it in three years — for an admission, a bursary
   * application, a lost original — has to produce the same page, whatever has
   * happened to the marks behind it since.
   */
  const snapshot = {
    milestone,
    student: {
      name: [context.givenName, context.middleNames, context.familyName]
        .filter(Boolean)
        .join(" "),
      admissionNumber: context.admissionNumber,
      upiNumber: context.upiNumber,
      dateOfBirth: context.dateOfBirth,
    },
    completed: {
      gradeLevelName: context.gradeLevelName,
      streamName: context.streamName,
      termNumber: term.number,
    },
    levelReduction: results[0].levelReduction,
    learningAreas: results.map(r => ({
      name: r.learningAreaName,
      sequence: r.sequence,
      meanScore: r.meanScore === null ? null : Number(r.meanScore),
      overallLevel: r.overallLevel,
    })),
    headComment: body.headComment ?? null,
    issuedAt: new Date().toISOString(),
  };

  const code = mintVerificationCode();

  let created;
  try {
    [created] = await db
      .insert(transitionCertificates)
      .values({
        schoolId: c.var.school.id,
        enrollmentId: body.enrollmentId,
        termId: body.termId,
        milestone,
        snapshot,
        verificationCode: code,
        issuedBy: c.var.user!.id,
      })
      .returning();
  }
  catch (err) {
    if (isUniqueViolation(err)) {
      return c.json(
        {
          message:
            "This child already has a certificate for this milestone. Reprint "
            + "the one that was issued rather than making a second.",
        },
        HttpStatusCodes.CONFLICT,
      );
    }
    throw err;
  }

  await recordAudit(db, {
    schoolId: c.var.school.id,
    actorId: c.var.user!.id,
    action: "certificate.issued",
    entityType: "transition_certificate",
    entityId: created.id,
    summary: `Issued a ${milestone.replace("_", " ")} transition certificate`,
    detail: { enrollmentId: body.enrollmentId, admissionNumber: context.admissionNumber },
  });

  return c.json({
    id: created.id,
    enrollmentId: created.enrollmentId,
    termId: created.termId,
    milestone,
    snapshot,
    issuedAt: created.issuedAt.toISOString(),
    verificationCode: code,
    verificationUrl: verificationUrlFor(code),
    verificationQrSvg: await qrSvgFor(code),
  }, HttpStatusCodes.CREATED);
};

export const listCertificates: TenantRouteHandler<ListCertificatesRoute> = async (c) => {
  const query = c.req.valid("query");
  const db = c.var.db;

  const filters = [];
  if (query.termId)
    filters.push(eq(transitionCertificates.termId, query.termId));
  if (query.milestone)
    filters.push(eq(transitionCertificates.milestone, query.milestone));

  const rows = await db
    .select()
    .from(transitionCertificates)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(transitionCertificates.issuedAt));

  return c.json(
    rows.map(row => ({
      id: row.id,
      enrollmentId: row.enrollmentId,
      termId: row.termId,
      milestone: row.milestone,
      snapshot: row.snapshot as Record<string, unknown>,
      issuedAt: row.issuedAt.toISOString(),
      verificationCode: row.verificationCode,
      verificationUrl: verificationUrlFor(row.verificationCode),
    })),
    HttpStatusCodes.OK,
  );
};

export const getCertificate: TenantRouteHandler<GetCertificateRoute> = async (c) => {
  const { id } = c.req.valid("param");

  const [row] = await c.var.db
    .select()
    .from(transitionCertificates)
    .where(eq(transitionCertificates.id, id));

  if (!row) {
    return c.json(
      { message: HttpStatusPhrases.NOT_FOUND },
      HttpStatusCodes.NOT_FOUND,
    );
  }

  return c.json({
    id: row.id,
    enrollmentId: row.enrollmentId,
    termId: row.termId,
    milestone: row.milestone,
    // Straight from the snapshot, never recomputed.
    snapshot: row.snapshot as Record<string, unknown>,
    issuedAt: row.issuedAt.toISOString(),
    verificationCode: row.verificationCode,
    verificationUrl: verificationUrlFor(row.verificationCode),
    verificationQrSvg: await qrSvgFor(row.verificationCode),
  }, HttpStatusCodes.OK);
};
