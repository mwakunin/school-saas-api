import { createRoute, z } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers";
import { createErrorSchema, IdUUIDParamsSchema } from "stoker/openapi/schemas";

import {
  forbiddenSchema,
  notFoundSchema,
  unauthorizedSchema,
} from "@/lib/constants";
import { requireMembershipRole } from "@/middlewares/auth";

import {
  assessmentDetailSchema,
  assessmentSchema,
  computeResultsResultSchema,
  computeResultsSchema,
  createAssessmentSchema,
  finaliseReportCardSchema,
  listAssessmentsQuerySchema,
  reportCardSchema,
  saveScoresResultSchema,
  saveScoresSchema,
  termResultSchema,
} from "./assessment.schemas";

const tags = ["Assessment"];

/** Marks are a teacher's job — this is the one area where they write. */
const teaching = requireMembershipRole("admin", "teacher");
const anyStaff = requireMembershipRole("admin", "bursar", "teacher");
/** Finalising and releasing a report card is the head's act, not a teacher's. */
const adminOnly = requireMembershipRole("admin");

const errorResponses = {
  [HttpStatusCodes.UNAUTHORIZED]: jsonContent(unauthorizedSchema, "Not signed in"),
  [HttpStatusCodes.NOT_FOUND]: jsonContent(
    notFoundSchema,
    "No school at this address, or no such record in it",
  ),
  [HttpStatusCodes.FORBIDDEN]: jsonContent(forbiddenSchema, "Wrong role, or school suspended"),
};

export const listAssessments = createRoute({
  tags,
  method: "get",
  path: "/assessments",
  summary: "Assessments in a term",
  middleware: [anyStaff],
  request: { query: listAssessmentsQuerySchema },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(z.array(assessmentSchema), "Assessments"),
    ...errorResponses,
  },
});

export const createAssessment = createRoute({
  tags,
  method: "post",
  path: "/assessments",
  summary: "Set an exam, project or observation",
  middleware: [teaching],
  request: { body: jsonContentRequired(createAssessmentSchema, "The assessment") },
  responses: {
    [HttpStatusCodes.CREATED]: jsonContent(assessmentDetailSchema, "The new assessment"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(
      createErrorSchema(createAssessmentSchema),
      "Validation error, or the term, area or stream belongs to another school",
    ),
    ...errorResponses,
  },
});

export const getAssessment = createRoute({
  tags,
  method: "get",
  path: "/assessments/{id}",
  summary: "One assessment with its marks",
  middleware: [anyStaff],
  request: { params: IdUUIDParamsSchema },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(assessmentDetailSchema, "The assessment"),
    ...errorResponses,
  },
});

export const saveScores = createRoute({
  tags,
  method: "put",
  path: "/assessments/{id}/scores",
  summary: "Save the marks grid",
  description:
    "The whole grid in one request, in one transaction. Thirty pupils through "
    + "thirty requests is what makes a marks screen miserable, and a "
    + "half-saved grid is worse than a failed one.\n\n"
    + "Re-submitting replaces what was there, because correcting a mistyped "
    + "mark is the normal case. An absent pupil carries no mark and no level — "
    + "an absence is not a zero, and storing it as one drags a mean down for a "
    + "paper the child never sat.",
  middleware: [teaching],
  request: {
    params: IdUUIDParamsSchema,
    body: jsonContentRequired(saveScoresSchema, "The grid"),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(saveScoresResultSchema, "What was saved"),
    [HttpStatusCodes.CONFLICT]: jsonContent(
      notFoundSchema,
      "The assessment is published; unpublish it before changing marks",
    ),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(
      createErrorSchema(saveScoresSchema),
      "Validation error, or an enrolment or competency that is not this school's",
    ),
    ...errorResponses,
  },
});

export const publishAssessment = createRoute({
  tags,
  method: "post",
  path: "/assessments/{id}/publish",
  summary: "Let parents see it",
  description:
    "Until this, marks are invisible outside the staffroom. Teachers enter "
    + "over days and correct as they go; a parent watching a half-entered exam "
    + "would ring about a mark that is about to change.",
  middleware: [teaching],
  request: { params: IdUUIDParamsSchema },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(assessmentDetailSchema, "Published"),
    [HttpStatusCodes.CONFLICT]: jsonContent(notFoundSchema, "Already published"),
    ...errorResponses,
  },
});

export const unpublishAssessment = createRoute({
  tags,
  method: "post",
  path: "/assessments/{id}/unpublish",
  summary: "Withdraw it from parents to correct a mark",
  middleware: [teaching],
  request: { params: IdUUIDParamsSchema },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(assessmentDetailSchema, "Withdrawn"),
    [HttpStatusCodes.CONFLICT]: jsonContent(notFoundSchema, "Not published"),
    ...errorResponses,
  },
});

// --- Results ---

export const computeResults = createRoute({
  tags,
  method: "post",
  path: "/term-results/compute",
  summary: "Work out the term's results and positions",
  description:
    "Recomputed from the marks each time rather than accumulated, so "
    + "correcting a mark moves the report that follows from it. Only published "
    + "assessments count.\n\n"
    + "Positions are ranked here, from the whole cohort at once, and then "
    + "frozen into the report card at finalisation — class rank is the most "
    + "contested number on a Kenyan report card, and one that silently moved "
    + "would be indefensible.",
  middleware: [adminOnly],
  request: { body: jsonContentRequired(computeResultsSchema, "Which term") },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(computeResultsResultSchema, "What was computed"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(
      createErrorSchema(computeResultsSchema),
      "Validation error, or the term belongs to another school",
    ),
    ...errorResponses,
  },
});

export const listTermResults = createRoute({
  tags,
  method: "get",
  path: "/term-results",
  summary: "Computed results for a term",
  middleware: [anyStaff],
  request: {
    query: z.object({
      termId: z.uuid(),
      enrollmentId: z.uuid().optional(),
      streamId: z.uuid().optional(),
    }),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(z.array(termResultSchema), "Results"),
    ...errorResponses,
  },
});

// --- Report cards ---

export const finaliseReportCard = createRoute({
  tags,
  method: "post",
  path: "/report-cards/finalise",
  summary: "Freeze a report card",
  description:
    "Snapshots the computed content as it stands, so reprinting in two years "
    + "produces the same document — after a mark was corrected, after the "
    + "class was renamed, after the fee structure changed (CLAUDE.md §3 rule "
    + "7). A finalised snapshot cannot be rewritten; the database refuses it.\n\n"
    + "Positions are included only if the school publishes them.",
  middleware: [adminOnly],
  request: { body: jsonContentRequired(finaliseReportCardSchema, "Which child, which term") },
  responses: {
    [HttpStatusCodes.CREATED]: jsonContent(reportCardSchema, "The frozen report card"),
    [HttpStatusCodes.CONFLICT]: jsonContent(notFoundSchema, "Already finalised"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(
      createErrorSchema(finaliseReportCardSchema),
      "Validation error, or nothing has been computed for this child yet",
    ),
    ...errorResponses,
  },
});

export const releaseReportCard = createRoute({
  tags,
  method: "post",
  path: "/report-cards/{id}/release",
  summary: "Let guardians see it",
  middleware: [adminOnly],
  request: { params: IdUUIDParamsSchema },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(reportCardSchema, "Released"),
    [HttpStatusCodes.CONFLICT]: jsonContent(
      notFoundSchema,
      "Not finalised, or already released",
    ),
    ...errorResponses,
  },
});

export const getReportCard = createRoute({
  tags,
  method: "get",
  path: "/report-cards/{id}",
  summary: "One report card, as it was frozen",
  middleware: [anyStaff],
  request: { params: IdUUIDParamsSchema },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(reportCardSchema, "The report card"),
    ...errorResponses,
  },
});

export const listReportCards = createRoute({
  tags,
  method: "get",
  path: "/report-cards",
  summary: "Report cards for a term",
  middleware: [anyStaff],
  request: {
    query: z.object({
      termId: z.uuid(),
      releasedOnly: z.stringbool().default(false),
    }),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(z.array(reportCardSchema), "Report cards"),
    ...errorResponses,
  },
});

export type ListAssessmentsRoute = typeof listAssessments;
export type CreateAssessmentRoute = typeof createAssessment;
export type GetAssessmentRoute = typeof getAssessment;
export type SaveScoresRoute = typeof saveScores;
export type PublishAssessmentRoute = typeof publishAssessment;
export type UnpublishAssessmentRoute = typeof unpublishAssessment;
export type ComputeResultsRoute = typeof computeResults;
export type ListTermResultsRoute = typeof listTermResults;
export type FinaliseReportCardRoute = typeof finaliseReportCard;
export type ReleaseReportCardRoute = typeof releaseReportCard;
export type GetReportCardRoute = typeof getReportCard;
export type ListReportCardsRoute = typeof listReportCards;
