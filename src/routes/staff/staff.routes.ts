import { createRoute, z } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers";
import { createErrorSchema, createMessageObjectSchema, IdUUIDParamsSchema } from "stoker/openapi/schemas";

import { forbiddenSchema, notFoundSchema, unauthorizedSchema } from "@/lib/constants";
import { requireMembershipRole } from "@/middlewares/auth";

import {
  grantStaffSchema,
  listStaffQuerySchema,
  staffMemberSchema,
  updateStaffSchema,
} from "./staff.schemas";

/**
 * A school running its own access.
 *
 * The superadmin plane grants the FIRST membership, because a school that has
 * just been created has no admin to do it. Everything after that belongs here:
 * needing the platform operator to add a bursar is the kind of dependency that
 * turns a product into a service.
 */
const tags = ["Staff"];
const adminOnly = requireMembershipRole("admin");

const errorResponses = {
  [HttpStatusCodes.UNAUTHORIZED]: jsonContent(unauthorizedSchema, "Not signed in"),
  [HttpStatusCodes.FORBIDDEN]: jsonContent(forbiddenSchema, "Not an admin here"),
  [HttpStatusCodes.NOT_FOUND]: jsonContent(notFoundSchema, "No school at this address"),
};

export const listStaff = createRoute({
  tags,
  method: "get",
  path: "/memberships",
  summary: "Who may act at this school",
  middleware: [adminOnly],
  request: { query: listStaffQuerySchema },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(z.array(staffMemberSchema), "Memberships"),
    ...errorResponses,
  },
});

export const grantStaff = createRoute({
  tags,
  method: "post",
  path: "/memberships",
  summary: "Give someone a role here",
  description:
    "The account must already exist. Idempotent, and a person may hold several "
    + "roles at one school — a teacher who is also a parent is one login with "
    + "two memberships, which is why role lives here and not on the user.",
  middleware: [adminOnly],
  request: { body: jsonContentRequired(grantStaffSchema, "Who, and as what") },
  responses: {
    [HttpStatusCodes.CREATED]: jsonContent(staffMemberSchema, "The membership"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(
      createErrorSchema(grantStaffSchema),
      "Validation error, or nobody has signed up with that address",
    ),
    ...errorResponses,
  },
});

export const updateStaff = createRoute({
  tags,
  method: "patch",
  path: "/memberships/{id}",
  summary: "Revoke or restore access",
  description:
    "Deactivating takes effect on the next request. The last active admin "
    + "cannot be deactivated — a school that locked itself out would need the "
    + "platform operator to get back in, which is the dependency this whole "
    + "route group exists to remove.",
  middleware: [adminOnly],
  request: {
    params: IdUUIDParamsSchema,
    body: jsonContentRequired(updateStaffSchema, "The change"),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(staffMemberSchema, "The membership"),
    [HttpStatusCodes.CONFLICT]: jsonContent(
      createMessageObjectSchema("This is the school's last admin"),
      "Removing it would lock the school out",
    ),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(
      createErrorSchema(updateStaffSchema),
      "Validation error",
    ),
    ...errorResponses,
  },
});

export type ListStaffRoute = typeof listStaff;
export type GrantStaffRoute = typeof grantStaff;
export type UpdateStaffRoute = typeof updateStaff;
