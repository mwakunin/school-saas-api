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
  createCompetencySchema,
  createLearningAreaSchema,
  learningAreaDetailSchema,
  learningAreaSchema,
  seedCurriculumSchema,
  seedResultSchema,
  updateLearningAreaSchema,
} from "./curriculum.schemas";

const tags = ["Curriculum"];

/** Teachers read the curriculum constantly; only admins reshape it. */
const anyStaff = requireMembershipRole("admin", "bursar", "teacher");
const adminOnly = requireMembershipRole("admin");

const errorResponses = {
  [HttpStatusCodes.UNAUTHORIZED]: jsonContent(unauthorizedSchema, "Not signed in"),
  [HttpStatusCodes.NOT_FOUND]: jsonContent(
    notFoundSchema,
    "No school at this address, or no such record in it",
  ),
  [HttpStatusCodes.FORBIDDEN]: jsonContent(forbiddenSchema, "Wrong role, or school suspended"),
};

export const seed = createRoute({
  tags,
  method: "post",
  path: "/curriculum/seed",
  summary: "Copy the starting curriculum into this school",
  description:
    "Learning areas and a strand tree, so a school opens onto its own "
    + "subjects rather than empty forms. Safe to re-run: an area the school "
    + "already has is left alone, including any edits made to it.\n\n"
    + "The learning areas follow the CBE curriculum as taught. The strands "
    + "beneath them are marked `(placeholder)` — plausible shapes rather than "
    + "KICD's published designs, so a teacher can see how the tree works "
    + "without mistaking it for the curriculum itself.",
  middleware: [adminOnly],
  request: { body: jsonContentRequired(seedCurriculumSchema, "Which phase") },
  responses: {
    [HttpStatusCodes.CREATED]: jsonContent(seedResultSchema, "What was copied"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(
      createErrorSchema(seedCurriculumSchema),
      "Validation error",
    ),
    ...errorResponses,
  },
});

export const listAreas = createRoute({
  tags,
  method: "get",
  path: "/learning-areas",
  summary: "Learning areas, in report-card order",
  middleware: [anyStaff],
  request: {
    query: z.object({
      gradeLevelId: z.uuid().optional(),
      includeNonCore: z.stringbool().default(true),
    }),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(z.array(learningAreaSchema), "Learning areas"),
    ...errorResponses,
  },
});

export const getArea = createRoute({
  tags,
  method: "get",
  path: "/learning-areas/{id}",
  summary: "One learning area with its strand tree",
  middleware: [anyStaff],
  request: { params: IdUUIDParamsSchema },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(learningAreaDetailSchema, "The area and its strands"),
    ...errorResponses,
  },
});

export const createArea = createRoute({
  tags,
  method: "post",
  path: "/learning-areas",
  summary: "Add a learning area",
  middleware: [adminOnly],
  request: { body: jsonContentRequired(createLearningAreaSchema, "The area") },
  responses: {
    [HttpStatusCodes.CREATED]: jsonContent(learningAreaSchema, "The new area"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(
      createErrorSchema(createLearningAreaSchema),
      "Validation error, or the grade level belongs to another school",
    ),
    ...errorResponses,
  },
});

export const updateArea = createRoute({
  tags,
  method: "patch",
  path: "/learning-areas/{id}",
  summary: "Correct a learning area",
  middleware: [adminOnly],
  request: {
    params: IdUUIDParamsSchema,
    body: jsonContentRequired(updateLearningAreaSchema, "The changes"),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(learningAreaSchema, "The updated area"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(
      createErrorSchema(updateLearningAreaSchema),
      "Validation error",
    ),
    ...errorResponses,
  },
});

export const removeArea = createRoute({
  tags,
  method: "delete",
  path: "/learning-areas/{id}",
  summary: "Remove a learning area the school does not teach",
  description:
    "Refused once anything has been assessed against it — the foreign key "
    + "holds, because removing it would take a child's marks with it.",
  middleware: [adminOnly],
  request: { params: IdUUIDParamsSchema },
  responses: {
    [HttpStatusCodes.NO_CONTENT]: { description: "Removed" },
    [HttpStatusCodes.CONFLICT]: jsonContent(
      notFoundSchema,
      "Something has already been assessed against this area",
    ),
    ...errorResponses,
  },
});

export const addCompetency = createRoute({
  tags,
  method: "post",
  path: "/learning-areas/{id}/competencies",
  summary: "Add a strand or sub-strand",
  middleware: [adminOnly],
  request: {
    params: IdUUIDParamsSchema,
    body: jsonContentRequired(createCompetencySchema, "The strand"),
  },
  responses: {
    [HttpStatusCodes.CREATED]: jsonContent(learningAreaDetailSchema, "The area"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(
      createErrorSchema(createCompetencySchema),
      "Validation error, or the parent belongs to another area",
    ),
    ...errorResponses,
  },
});

export const removeCompetency = createRoute({
  tags,
  method: "delete",
  path: "/competencies/{id}",
  summary: "Remove a strand",
  description:
    "Refused once it has been assessed, and refused while it still has "
    + "sub-strands — a tree that loses a branch mid-way leaves children "
    + "pointing at nothing.",
  middleware: [adminOnly],
  request: { params: IdUUIDParamsSchema },
  responses: {
    [HttpStatusCodes.NO_CONTENT]: { description: "Removed" },
    [HttpStatusCodes.CONFLICT]: jsonContent(
      notFoundSchema,
      "It has been assessed, or still has sub-strands",
    ),
    ...errorResponses,
  },
});

export type SeedRoute = typeof seed;
export type ListAreasRoute = typeof listAreas;
export type GetAreaRoute = typeof getArea;
export type CreateAreaRoute = typeof createArea;
export type UpdateAreaRoute = typeof updateArea;
export type RemoveAreaRoute = typeof removeArea;
export type AddCompetencyRoute = typeof addCompetency;
export type RemoveCompetencyRoute = typeof removeCompetency;
