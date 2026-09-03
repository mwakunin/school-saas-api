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
  createAcademicYearSchema,
  createStreamSchema,
  selectAcademicYearSchema,
  selectGradeLevelSchema,
  selectSchoolSchema,
  selectStreamSchema,
  selectTermSchema,
  updateTermSchema,
} from "./academic.schemas";

/**
 * The academic spine, from inside one school.
 *
 * Every route here is mounted behind `tenantChain`, so `c.var.db` is a
 * transaction carrying `app.school_id` and the RLS policies do the scoping.
 * That is why no handler in this group writes a `where school_id = ...`
 * clause: not because it was forgotten, but because the database applies it
 * whether the handler remembers or not.
 */
const tags = ["Academic"];

/** Anyone with a role at the school may read its structure. */
const anyMember = requireMembershipRole("admin", "bursar", "teacher", "guardian");
/** Changing the shape of the school year is an administrative act. */
const adminOnly = requireMembershipRole("admin");

const errorResponses = {
  [HttpStatusCodes.UNAUTHORIZED]: jsonContent(unauthorizedSchema, "Not signed in"),
  // One 404 covers both "no school at this address" and "no such record here".
  // Deliberately indistinguishable: a member of one school probing another's
  // ids must not be able to tell a record that exists elsewhere from one that
  // does not exist at all.
  [HttpStatusCodes.NOT_FOUND]: jsonContent(
    notFoundSchema,
    "No school at this address, or no such record in it",
  ),
  [HttpStatusCodes.FORBIDDEN]: jsonContent(forbiddenSchema, "Wrong role, or school suspended"),
};

export const getSchool = createRoute({
  tags,
  method: "get",
  path: "/school",
  summary: "The school this subdomain belongs to",
  middleware: [anyMember],
  responses: {
    [HttpStatusCodes.OK]: jsonContent(selectSchoolSchema, "The current school"),
    ...errorResponses,
  },
});

export const listAcademicYears = createRoute({
  tags,
  method: "get",
  path: "/academic-years",
  summary: "Academic years",
  middleware: [anyMember],
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      z.array(selectAcademicYearSchema),
      "Academic years, newest first",
    ),
    ...errorResponses,
  },
});

export const createAcademicYear = createRoute({
  tags,
  method: "post",
  path: "/academic-years",
  summary: "Open a new academic year",
  middleware: [adminOnly],
  request: {
    body: jsonContentRequired(createAcademicYearSchema, "The year to open"),
  },
  responses: {
    [HttpStatusCodes.CREATED]: jsonContent(selectAcademicYearSchema, "The new year"),
    [HttpStatusCodes.CONFLICT]: jsonContent(notFoundSchema, "That year already exists"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(
      createErrorSchema(createAcademicYearSchema),
      "Validation error",
    ),
    ...errorResponses,
  },
});

export const listTerms = createRoute({
  tags,
  method: "get",
  path: "/terms",
  summary: "Terms",
  middleware: [anyMember],
  responses: {
    [HttpStatusCodes.OK]: jsonContent(z.array(selectTermSchema), "Terms in order"),
    ...errorResponses,
  },
});

export const updateTerm = createRoute({
  tags,
  method: "patch",
  path: "/terms/{id}",
  summary: "Correct a term's dates, or mark it current",
  description:
    "The seeded boundaries are approximate — the Ministry publishes exact "
    + "dates each year and schools adjust them locally. Marking a term current "
    + "clears the flag on the others, so exactly one can hold it.",
  middleware: [adminOnly],
  request: {
    params: IdUUIDParamsSchema,
    body: jsonContentRequired(updateTermSchema, "The changes"),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(selectTermSchema, "The updated term"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(
      createErrorSchema(updateTermSchema),
      "Validation error, or dates out of order",
    ),
    ...errorResponses,
  },
});

export const listGradeLevels = createRoute({
  tags,
  method: "get",
  path: "/grade-levels",
  summary: "Grade 1-9",
  middleware: [anyMember],
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      z.array(selectGradeLevelSchema),
      "Grade levels in teaching order",
    ),
    ...errorResponses,
  },
});

export const listStreams = createRoute({
  tags,
  method: "get",
  path: "/streams",
  summary: "Classes",
  middleware: [anyMember],
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      z.array(selectStreamSchema),
      "Streams with their grade level",
    ),
    ...errorResponses,
  },
});

export const createStream = createRoute({
  tags,
  method: "post",
  path: "/streams",
  summary: "Create a class",
  middleware: [adminOnly],
  request: {
    body: jsonContentRequired(createStreamSchema, "The stream to create"),
  },
  responses: {
    [HttpStatusCodes.CREATED]: jsonContent(selectStreamSchema, "The new stream"),
    [HttpStatusCodes.CONFLICT]: jsonContent(
      notFoundSchema,
      "That grade already has a stream by this name for the year",
    ),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(
      createErrorSchema(createStreamSchema),
      "Validation error, or the grade level / year belongs to another school",
    ),
    ...errorResponses,
  },
});

export type GetSchoolRoute = typeof getSchool;
export type ListAcademicYearsRoute = typeof listAcademicYears;
export type CreateAcademicYearRoute = typeof createAcademicYear;
export type ListTermsRoute = typeof listTerms;
export type UpdateTermRoute = typeof updateTerm;
export type ListGradeLevelsRoute = typeof listGradeLevels;
export type ListStreamsRoute = typeof listStreams;
export type CreateStreamRoute = typeof createStream;
