import { createRoute, z } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContent } from "stoker/openapi/helpers";
import { createMessageObjectSchema, IdUUIDParamsSchema } from "stoker/openapi/schemas";

import { forbiddenSchema, notFoundSchema, unauthorizedSchema } from "@/lib/constants";
import { requireMembershipRole } from "@/middlewares/auth";

import {
  childFeesSchema,
  childReportCardSchema,
  childResultsSchema,
  claimResultSchema,
  myChildrenSchema,
} from "./portal.schemas";

/**
 * The parent portal.
 *
 * CLAUDE.md §8 calls the parent view the thing that convinces a head that fee
 * follow-up gets easier, and until now it did not exist: a guardian who signed
 * in could reach the school, its terms, its grades and its streams, and
 * nothing whatever about their own child.
 *
 * Guarded by the `guardian` role, which a person may hold alongside another —
 * a teacher who is also a parent has two memberships and one login, which is
 * the entire reason role lives on the membership (§5.1).
 *
 * Every route is confined to the caller's own children. That is a different
 * axis from tenant isolation and gets its own tests: RLS keeps St Mary's out
 * of Alliance's data and does nothing at all to keep one family out of
 * another's.
 */
const tags = ["Parent portal"];
const guardianOnly = requireMembershipRole("guardian");

const errorResponses = {
  [HttpStatusCodes.UNAUTHORIZED]: jsonContent(unauthorizedSchema, "Not signed in"),
  [HttpStatusCodes.FORBIDDEN]: jsonContent(forbiddenSchema, "Not a guardian here"),
  [HttpStatusCodes.NOT_FOUND]: jsonContent(
    notFoundSchema,
    "No school at this address, or not your child",
  ),
};

export const claim = createRoute({
  tags,
  method: "post",
  path: "/portal/claim",
  summary: "Link this account to your guardian record",
  description:
    "Matches a VERIFIED phone number or email on your account against what the "
    + "school recorded for you. Verified, because an unverified identifier "
    + "would let anyone who knows a parent's number read their child's marks. "
    + "A parent whose details differ from the school's records is linked by "
    + "the office instead — see `POST /guardians/{id}/link`.",
  middleware: [guardianOnly],
  responses: {
    [HttpStatusCodes.OK]: jsonContent(claimResultSchema, "What was linked"),
    ...errorResponses,
  },
});

export const myChildren = createRoute({
  tags,
  method: "get",
  path: "/portal/children",
  summary: "My children at this school",
  middleware: [guardianOnly],
  responses: {
    [HttpStatusCodes.OK]: jsonContent(myChildrenSchema, "Children and balances"),
    [HttpStatusCodes.CONFLICT]: jsonContent(
      createMessageObjectSchema("This account is not linked to a guardian record"),
      "Claim the account first",
    ),
    ...errorResponses,
  },
});

export const childResults = createRoute({
  tags,
  method: "get",
  path: "/portal/children/{id}/results",
  summary: "A child's results, term by term",
  description:
    "Built only from PUBLISHED assessments, which is what `publishedAt` is "
    + "for: teachers enter marks over days and correct them, and a parent must "
    + "not see a half-entered exam.",
  middleware: [guardianOnly],
  request: { params: IdUUIDParamsSchema },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(z.array(childResultsSchema), "Results"),
    ...errorResponses,
  },
});

export const childReportCards = createRoute({
  tags,
  method: "get",
  path: "/portal/children/{id}/report-cards",
  summary: "A child's released report cards",
  description:
    "RELEASED only. A finalised card the head has not released yet is not a "
    + "document the family is meant to have, and the frozen snapshot is what "
    + "is returned — the same page that was printed.",
  middleware: [guardianOnly],
  request: { params: IdUUIDParamsSchema },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(z.array(childReportCardSchema), "Report cards"),
    ...errorResponses,
  },
});

export const childFees = createRoute({
  tags,
  method: "get",
  path: "/portal/children/{id}/fees",
  summary: "A child's fees",
  description:
    "The whole account, not one term. Carries the admission number as the "
    + "M-Pesa account reference, so a parent pays from the screen showing the "
    + "balance rather than typing a number from memory — which is most of what "
    + "lands in the reconciliation queue.",
  middleware: [guardianOnly],
  request: { params: IdUUIDParamsSchema },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(childFeesSchema, "Fees and payments"),
    ...errorResponses,
  },
});

export type ClaimRoute = typeof claim;
export type MyChildrenRoute = typeof myChildren;
export type ChildResultsRoute = typeof childResults;
export type ChildReportCardsRoute = typeof childReportCards;
export type ChildFeesRoute = typeof childFees;
