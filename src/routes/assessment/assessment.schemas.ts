import { z } from "@hono/zod-openapi";
import { createSelectSchema } from "drizzle-zod";

import { assessments, assessmentScores, reportCards, termResults } from "@/db/schema";
import { toZodV4SchemaTyped } from "@/lib/zod-utils";

const rawAssessment = createSelectSchema(assessments);
const rawScore = createSelectSchema(assessmentScores);
const rawTermResult = createSelectSchema(termResults);
const rawReportCard = createSelectSchema(reportCards);

const performanceLevel = z.enum([
  "below_expectation",
  "approaching",
  "meeting",
  "exceeding",
]);

export const assessmentSchema = toZodV4SchemaTyped(rawAssessment);

export const assessmentDetailSchema = toZodV4SchemaTyped(
  rawAssessment.extend({
    scores: z.array(rawScore),
    /** Whether parents can see it yet. */
    isPublished: z.boolean(),
  }),
);

export const createAssessmentSchema = toZodV4SchemaTyped(
  z.object({
    termId: z.uuid(),
    learningAreaId: z.uuid(),
    /** Omit when the whole grade sits it rather than one class. */
    streamId: z.uuid().optional(),
    title: z.string().min(1).max(200),
    kind: z.enum(["exam", "cat", "project", "practical", "observation", "national"]),
    /** Null for pure observation, which produces a level and no mark. */
    maxScore: z.number().int().positive().max(1000).optional(),
    weight: z.number().positive().max(100).optional(),
    administeredOn: z.iso.date().optional(),
  }),
);

/**
 * One row of the marks grid.
 *
 * `competencyId` decides which grading system this row is on: omit it for the
 * percentage path (one overall mark), supply it for the competency path (one
 * judgement per sub-strand). Both can exist for the same assessment.
 */
export const scoreEntrySchema = z.object({
  enrollmentId: z.uuid(),
  competencyId: z.uuid().optional(),
  rawScore: z.number().min(0).max(10_000).optional(),
  level: performanceLevel.optional(),
  isAbsent: z.boolean().default(false),
  comment: z.string().max(1000).optional(),
}).refine(
  v => !v.isAbsent || (v.rawScore === undefined && v.level === undefined),
  { message: "An absent pupil has no mark and no level — an absence is not a zero" },
);

/**
 * Marks entry, in bulk.
 *
 * Thirty pupils through thirty requests is what makes a marks screen miserable
 * (CLAUDE.md §9), and a half-saved grid is worse than a failed one — so the
 * whole submission lands in one transaction or not at all.
 */
export const saveScoresSchema = toZodV4SchemaTyped(
  z.object({
    scores: z.array(scoreEntrySchema).min(1).max(500),
  }),
);

export const saveScoresResultSchema = toZodV4SchemaTyped(
  z.object({
    saved: z.number().int(),
    /** Rows that replaced an existing entry rather than adding one. */
    updated: z.number().int(),
  }),
);

export const listAssessmentsQuerySchema = z.object({
  termId: z.uuid().optional(),
  learningAreaId: z.uuid().optional(),
  streamId: z.uuid().optional(),
  publishedOnly: z.stringbool().default(false),
});

export const termResultSchema = toZodV4SchemaTyped(rawTermResult);

export const computeResultsSchema = toZodV4SchemaTyped(
  z.object({
    termId: z.uuid(),
    /**
     * How several sub-strand judgements reduce to the one on the report card.
     *
     * Explicit rather than assumed, because it is a policy decision a head
     * should be able to state. Never an average — see lib/assessment.ts.
     */
    levelReduction: z.enum(["mode_ties_low", "mode_ties_high", "lowest"])
      .default("mode_ties_low"),
  }),
);

export const computeResultsResultSchema = toZodV4SchemaTyped(
  z.object({
    enrolments: z.number().int(),
    results: z.number().int(),
    positionsRanked: z.number().int(),
    /** Results removed because nothing published stands behind them any more. */
    cleared: z.number().int(),
  }),
);

export const reportCardSchema = toZodV4SchemaTyped(rawReportCard);

/**
 * A report card ready to print, QR and all.
 *
 * Nullable because a card frozen before verification existed has no code —
 * older documents stay readable rather than breaking, and a screen can tell
 * the difference instead of printing a QR that leads nowhere.
 */
export const printableReportCardSchema = toZodV4SchemaTyped(
  rawReportCard.extend({
    verificationUrl: z.string().nullable(),
    verificationQrSvg: z.string().nullable(),
  }),
);

export const finaliseReportCardSchema = toZodV4SchemaTyped(
  z.object({
    enrollmentId: z.uuid(),
    termId: z.uuid(),
    classTeacherComment: z.string().max(2000).optional(),
    headComment: z.string().max(2000).optional(),
    attendancePresent: z.number().int().min(0).max(400).optional(),
    attendanceTotal: z.number().int().min(0).max(400).optional(),
  })
    /*
     * Attendance is a pair or it is nothing.
     *
     * "Present: 42" with no total says nothing a parent can read, and the
     * database CHECK refuses it — which without this would surface as a 500
     * from a constraint violation rather than a message naming the field.
     */
    .refine(
      v => (v.attendancePresent === undefined) === (v.attendanceTotal === undefined),
      {
        message: "Give both attendance figures or neither — a count with no total says nothing",
        path: ["attendanceTotal"],
      },
    )
    .refine(
      v => v.attendancePresent === undefined
        || v.attendanceTotal === undefined
        || v.attendancePresent <= v.attendanceTotal,
      {
        message: "A child cannot attend more days than the term had",
        path: ["attendancePresent"],
      },
    ),
);

/**
 * A merit list: the whole cohort ranked on one number.
 *
 * The most-read and most-argued sheet a Kenyan school produces, and the reason
 * `showsPositions` exists — a school that has moved away from ranking children
 * under CBE gets a refusal here rather than a list it did not want, because
 * hiding it one query away from a screen is not the same as not producing it.
 */
export const meritListEntrySchema = toZodV4SchemaTyped(
  z.object({
    position: z.number().int(),
    enrollmentId: z.uuid(),
    studentId: z.uuid(),
    admissionNumber: z.string(),
    name: z.string(),
    streamName: z.string(),
    gradeLevelName: z.string(),
    /** Mean of the learning-area means, to two places. */
    overallMean: z.number(),
    /** How many areas that mean is over — two children may differ. */
    learningAreas: z.number().int(),
  }),
);

export const meritListQuerySchema = z.object({
  termId: z.uuid(),
  /** Rank within one class, or across the whole grade. One or the other. */
  streamId: z.uuid().optional(),
  gradeLevelId: z.uuid().optional(),
}).refine(
  v => Boolean(v.streamId) !== Boolean(v.gradeLevelId),
  {
    /*
     * Exactly one, and neither is a default.
     *
     * With neither, the query ranked the whole school — a list putting a Grade
     * 1 above a Grade 9 on marks out of different papers, which is not a
     * meaningless answer so much as a misleading one. With both, the second
     * silently did nothing. A merit list is always OF something.
     */
    message: "Rank one class or one grade — give exactly one of streamId or gradeLevelId",
    path: ["streamId"],
  },
);

export const issueCertificateSchema = toZodV4SchemaTyped(
  z.object({
    enrollmentId: z.uuid(),
    /** The final term of the child's last year at this level. */
    termId: z.uuid(),
    headComment: z.string().max(2000).optional(),
  }),
);

export const transitionCertificateSchema = toZodV4SchemaTyped(
  z.object({
    id: z.uuid(),
    enrollmentId: z.uuid(),
    termId: z.uuid(),
    milestone: z.enum(["grade_6", "grade_9"]),
    snapshot: z.record(z.string(), z.unknown()),
    issuedAt: z.string(),
    /** The code printed on the certificate, and where to check it. */
    verificationCode: z.string(),
    verificationUrl: z.string(),
  }),
);

export const transitionCertificateDetailSchema = toZodV4SchemaTyped(
  z.object({
    id: z.uuid(),
    enrollmentId: z.uuid(),
    termId: z.uuid(),
    milestone: z.enum(["grade_6", "grade_9"]),
    snapshot: z.record(z.string(), z.unknown()),
    issuedAt: z.string(),
    verificationCode: z.string(),
    verificationUrl: z.string(),
    /** Inline SVG, ready to drop into the printed page. */
    verificationQrSvg: z.string(),
  }),
);

export const listCertificatesQuerySchema = z.object({
  termId: z.uuid().optional(),
  milestone: z.enum(["grade_6", "grade_9"]).optional(),
});
