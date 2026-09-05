import { createRoute } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers";
import { createErrorSchema } from "stoker/openapi/schemas";

import { forbiddenSchema, notFoundSchema, unauthorizedSchema } from "@/lib/constants";
import { requireMembershipRole } from "@/middlewares/auth";

import {
  broadcastResultSchema,
  feeReminderSchema,
  listSmsQuerySchema,
  resultsNoticeSchema,
  smsListSchema,
} from "./messaging.schemas";

/**
 * SMS to guardians, and the record of what it cost.
 *
 * CLAUDE.md §9: guardians are on phones, on patchy data, and SMS has to carry
 * the important things. This is the outreach half of that — targeted sends a
 * school controls, rather than a notification firehose.
 */
const tags = ["Messaging"];

/** Results go out on the head's say-so; fee reminders on the bursar's. */
const adminOnly = requireMembershipRole("admin");
const money = requireMembershipRole("admin", "bursar");
const anyStaff = requireMembershipRole("admin", "bursar", "teacher");

const errorResponses = {
  [HttpStatusCodes.UNAUTHORIZED]: jsonContent(unauthorizedSchema, "Not signed in"),
  [HttpStatusCodes.FORBIDDEN]: jsonContent(forbiddenSchema, "Wrong role at this school"),
  [HttpStatusCodes.NOT_FOUND]: jsonContent(notFoundSchema, "No school at this address"),
};

export const resultsNotice = createRoute({
  tags,
  method: "post",
  path: "/sms/results-notice",
  summary: "Tell guardians results are out",
  description:
    "Targeted by grade and stream, with wording the school chooses per send. "
    + "**Defaults to a dry run**: it answers with the recipients, the wording "
    + "and the cost, and sends nothing until `dryRun` is false. Four hundred "
    + "delivered messages cannot be recalled, so the safe call is the default.",
  middleware: [adminOnly],
  request: { body: jsonContentRequired(resultsNoticeSchema, "Who, and what to say") },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(broadcastResultSchema, "What was, or would be, sent"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(
      createErrorSchema(resultsNoticeSchema),
      "Validation error",
    ),
    ...errorResponses,
  },
});

export const feeReminders = createRoute({
  tags,
  method: "post",
  path: "/sms/fee-reminders",
  summary: "Chase outstanding balances",
  description:
    "One message per family with a balance over the threshold, carrying the "
    + "amount and the child's admission number — which is also the M-Pesa "
    + "account reference, so a parent can pay straight from the text. Dry run "
    + "by default.",
  middleware: [money],
  request: { body: jsonContentRequired(feeReminderSchema, "Who, and what to say") },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(broadcastResultSchema, "What was, or would be, sent"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(
      createErrorSchema(feeReminderSchema),
      "Validation error",
    ),
    ...errorResponses,
  },
});

export const listSms = createRoute({
  tags,
  method: "get",
  path: "/sms",
  summary: "Messages sent, and what they cost",
  description:
    "The answer to 'what are we spending on SMS' and 'did that parent "
    + "actually get it' — the two questions §6 says this table exists for.",
  middleware: [anyStaff],
  request: { query: listSmsQuerySchema },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(smsListSchema, "Messages, newest first"),
    ...errorResponses,
  },
});

export type ResultsNoticeRoute = typeof resultsNotice;
export type FeeRemindersRoute = typeof feeReminders;
export type ListSmsRoute = typeof listSms;
