import { createRoute, z } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers";
import { createErrorSchema, IdUUIDParamsSchema } from "stoker/openapi/schemas";

import {
  forbiddenSchema,
  notFoundSchema,
  unauthorizedSchema,
} from "@/lib/constants";
import { requireAuth, requireRole } from "@/middlewares/auth";

import {
  createSchoolSchema,
  grantedMembershipSchema,
  grantMembershipSchema,
  onboardedSchoolSchema,
  selectSchoolSchema,
  updateSchoolStatusSchema,
} from "./superadmin.schemas";

/**
 * The superadmin plane.
 *
 * A separate route namespace, not a role inside a tenant (CLAUDE.md §4). It
 * never runs `withTenant`, so it holds no `app.school_id` and uses the owner
 * connection — which is exactly what lets it work across schools, and exactly
 * why nothing else may.
 *
 * Guarded by the platform role. Build it early and ugly; the alternative is
 * onboarding schools by hand with SQL.
 */
const tags = ["Superadmin"];
const guard = [requireAuth, requireRole("superadmin")];

export const list = createRoute({
  tags,
  method: "get",
  path: "/superadmin/schools",
  summary: "List every school",
  middleware: guard,
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      z.array(selectSchoolSchema),
      "Every school on the platform",
    ),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(unauthorizedSchema, "Not signed in"),
    [HttpStatusCodes.FORBIDDEN]: jsonContent(forbiddenSchema, "Not a superadmin"),
  },
});

export const create = createRoute({
  tags,
  method: "post",
  path: "/superadmin/schools",
  summary: "Onboard a school",
  description:
    "Creates the school and seeds its academic spine — Grade 1-9, the current "
    + "academic year, and its three terms — so the tenant is usable "
    + "immediately rather than opening onto empty forms.",
  middleware: guard,
  request: {
    body: jsonContentRequired(createSchoolSchema, "The school to onboard"),
  },
  responses: {
    [HttpStatusCodes.CREATED]: jsonContent(
      onboardedSchoolSchema,
      "The school and what was seeded for it",
    ),
    [HttpStatusCodes.CONFLICT]: jsonContent(
      notFoundSchema,
      "That subdomain is already taken",
    ),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(
      createErrorSchema(createSchoolSchema),
      "Validation error",
    ),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(unauthorizedSchema, "Not signed in"),
    [HttpStatusCodes.FORBIDDEN]: jsonContent(forbiddenSchema, "Not a superadmin"),
  },
});

export const setStatus = createRoute({
  tags,
  method: "patch",
  path: "/superadmin/schools/{id}/status",
  summary: "Activate or suspend a school",
  description:
    "Suspending is how a non-payer is cut off. Staff at a suspended school are "
    + "told why rather than being 404'd, so they can act on it — the data "
    + "itself is untouched and returns intact on reactivation.",
  middleware: guard,
  request: {
    params: IdUUIDParamsSchema,
    body: jsonContentRequired(updateSchoolStatusSchema, "The new status"),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(selectSchoolSchema, "The updated school"),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(notFoundSchema, "No such school"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(
      createErrorSchema(updateSchoolStatusSchema),
      "Validation error",
    ),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(unauthorizedSchema, "Not signed in"),
    [HttpStatusCodes.FORBIDDEN]: jsonContent(forbiddenSchema, "Not a superadmin"),
  },
});

export const grantMembership = createRoute({
  tags,
  method: "post",
  path: "/superadmin/schools/{id}/memberships",
  summary: "Give someone a role at a school",
  description:
    "Onboarding a school leaves nobody able to sign into it, so this is what "
    + "makes it usable: the first admin has to be granted from outside the "
    + "tenant, because the tenant-side equivalent would be guarded by a role "
    + "that does not exist yet. The account must already exist — this grants "
    + "access rather than creating people. Idempotent: granting a role someone "
    + "already holds returns it rather than failing.",
  middleware: guard,
  request: {
    params: IdUUIDParamsSchema,
    body: jsonContentRequired(grantMembershipSchema, "Who, and as what"),
  },
  responses: {
    [HttpStatusCodes.CREATED]: jsonContent(grantedMembershipSchema, "The membership"),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(notFoundSchema, "No such school"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(
      createErrorSchema(grantMembershipSchema),
      "Validation error, or nobody signed up with that address",
    ),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(unauthorizedSchema, "Not signed in"),
    [HttpStatusCodes.FORBIDDEN]: jsonContent(forbiddenSchema, "Not a superadmin"),
  },
});

export type ListRoute = typeof list;
export type CreateRoute = typeof create;
export type SetStatusRoute = typeof setStatus;
export type GrantMembershipRoute = typeof grantMembership;
