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
  allocateSchema,
  configureMpesaSchema,
  listTransactionsQuerySchema,
  mpesaSettingsSchema,
  rejectSchema,
  runMatcherResultSchema,
  transactionDetailSchema,
  transactionSchema,
} from "./reconciliation.schemas";

const tags = ["Reconciliation"];

/** Money, so the same audience as fees: bursar and admin, never a teacher. */
const money = requireMembershipRole("admin", "bursar");
/** Handling a school's Safaricom credentials is an administrative act. */
const adminOnly = requireMembershipRole("admin");

const errorResponses = {
  [HttpStatusCodes.UNAUTHORIZED]: jsonContent(unauthorizedSchema, "Not signed in"),
  [HttpStatusCodes.NOT_FOUND]: jsonContent(
    notFoundSchema,
    "No school at this address, or no such record in it",
  ),
  [HttpStatusCodes.FORBIDDEN]: jsonContent(forbiddenSchema, "Wrong role, or school suspended"),
};

export const listTransactions = createRoute({
  tags,
  method: "get",
  path: "/mpesa/transactions",
  summary: "The reconciliation queue",
  description:
    "Unmatched payments first — parents type the reference wrong constantly, "
    + "and this is the screen where that gets resolved. Each row carries the "
    + "students whose admission number resembles what was typed, as "
    + "suggestions rather than decisions.",
  middleware: [money],
  request: { query: listTransactionsQuerySchema },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      z.object({
        transactions: z.array(transactionSchema),
        total: z.number().int(),
        /** How much money is sitting unallocated, across the whole school. */
        unmatchedCount: z.number().int(),
        unmatchedCents: z.number().int(),
      }),
      "The queue",
    ),
    ...errorResponses,
  },
});

export const getTransaction = createRoute({
  tags,
  method: "get",
  path: "/mpesa/transactions/{id}",
  summary: "One confirmation, including Safaricom's raw envelope",
  middleware: [money],
  request: { params: IdUUIDParamsSchema },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(transactionDetailSchema, "The confirmation"),
    ...errorResponses,
  },
});

export const allocate = createRoute({
  tags,
  method: "post",
  path: "/mpesa/transactions/{id}/allocate",
  summary: "Match a payment to a child",
  description:
    "Creates the ledger entry and marks the confirmation allocated, in one "
    + "transaction. The raw confirmation is not altered — reversing the "
    + "payment later returns it to the queue, which is what makes a wrong "
    + "allocation recoverable.",
  middleware: [money],
  request: {
    params: IdUUIDParamsSchema,
    body: jsonContentRequired(allocateSchema, "Which child"),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(transactionDetailSchema, "The allocated confirmation"),
    [HttpStatusCodes.CONFLICT]: jsonContent(
      notFoundSchema,
      "Already allocated, or rejected",
    ),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(
      createErrorSchema(allocateSchema),
      "Validation error, or the student belongs to another school",
    ),
    ...errorResponses,
  },
});

export const reject = createRoute({
  tags,
  method: "post",
  path: "/mpesa/transactions/{id}/reject",
  summary: "Set a confirmation aside",
  description:
    "For a payment that is not school fees, or a duplicate Safaricom sent "
    + "twice under different receipts. Nothing is deleted — the row stays, so "
    + "a payment set aside by mistake can be explained and re-queued.",
  middleware: [money],
  request: {
    params: IdUUIDParamsSchema,
    body: jsonContentRequired(rejectSchema, "Why"),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(transactionDetailSchema, "The rejected confirmation"),
    [HttpStatusCodes.CONFLICT]: jsonContent(notFoundSchema, "Already allocated"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(
      createErrorSchema(rejectSchema),
      "Validation error",
    ),
    ...errorResponses,
  },
});

export const requeue = createRoute({
  tags,
  method: "post",
  path: "/mpesa/transactions/{id}/requeue",
  summary: "Return a rejected confirmation to the queue",
  middleware: [money],
  request: { params: IdUUIDParamsSchema },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(transactionDetailSchema, "Back in the queue"),
    [HttpStatusCodes.CONFLICT]: jsonContent(
      notFoundSchema,
      "Only a rejected confirmation can be re-queued",
    ),
    ...errorResponses,
  },
});

export const runMatcher = createRoute({
  tags,
  method: "post",
  path: "/mpesa/transactions/match",
  summary: "Re-run automatic matching over the queue",
  description:
    "Worth running after the register changes: a child admitted late, or an "
    + "admission number corrected, turns yesterday's unmatched payments into "
    + "today's matches without anyone re-keying them. Only allocates what is "
    + "unambiguous.",
  middleware: [money],
  responses: {
    [HttpStatusCodes.OK]: jsonContent(runMatcherResultSchema, "What it matched"),
    ...errorResponses,
  },
});

// --- Settings ---

export const getMpesaSettings = createRoute({
  tags,
  method: "get",
  path: "/mpesa/settings",
  summary: "This school's M-Pesa configuration",
  description:
    "Returns the URLs to register with Safaricom. Credentials are never "
    + "returned — only whether they are set.",
  middleware: [adminOnly],
  responses: {
    [HttpStatusCodes.OK]: jsonContent(mpesaSettingsSchema, "The configuration"),
    ...errorResponses,
  },
});

export const configureMpesa = createRoute({
  tags,
  method: "put",
  path: "/mpesa/settings",
  summary: "Set this school's paybill and Daraja credentials",
  description:
    "The school's own shortcode — money never routes through ours. "
    + "Credentials are encrypted at rest and cannot be read back.",
  middleware: [adminOnly],
  request: {
    body: jsonContentRequired(configureMpesaSchema, "Paybill and credentials"),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(mpesaSettingsSchema, "The stored configuration"),
    [HttpStatusCodes.BAD_GATEWAY]: jsonContent(
      notFoundSchema,
      "Safaricom refused the URL registration; the credentials were still saved",
    ),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(
      createErrorSchema(configureMpesaSchema),
      "Validation error, or encryption is not configured",
    ),
    ...errorResponses,
  },
});

export type ListTransactionsRoute = typeof listTransactions;
export type GetTransactionRoute = typeof getTransaction;
export type AllocateRoute = typeof allocate;
export type RejectRoute = typeof reject;
export type RequeueRoute = typeof requeue;
export type RunMatcherRoute = typeof runMatcher;
export type GetMpesaSettingsRoute = typeof getMpesaSettings;
export type ConfigureMpesaRoute = typeof configureMpesa;
