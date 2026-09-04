import { createRoute, z } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers";

const tags = ["Webhooks"];

/**
 * Safaricom's endpoints. Unauthenticated by nature — Daraja signs nothing and
 * cannot present a credential — so the tenant comes from an unguessable token
 * in the path, and nothing in the body is believed.
 *
 * Deliberately outside the tenant middleware: there is no session and no
 * subdomain here. Deliberately outside the rate limiter too, because Safaricom
 * retries anything it does not see acknowledged and a throttled confirmation
 * is a payment the school never learns about.
 */

/** What Daraja expects back. Anything else it treats as a failure and retries. */
const darajaAckSchema = z.object({
  ResultCode: z.number().int(),
  ResultDesc: z.string(),
});

/**
 * The payload is entirely attacker-controllable, so this is documentation
 * rather than a gate — every field optional, and unknown ones passed through,
 * because the raw envelope is stored whole precisely so a field we did not
 * model is still recoverable later.
 */
const c2bConfirmationSchema = z.looseObject({
  TransID: z.string().optional(),
  TransTime: z.string().optional(),
  TransAmount: z.union([z.string(), z.number()]).optional(),
  BusinessShortCode: z.string().optional(),
  BillRefNumber: z.string().optional(),
  MSISDN: z.string().optional(),
  FirstName: z.string().optional(),
  MiddleName: z.string().optional(),
  LastName: z.string().optional(),
});

export const c2bConfirmation = createRoute({
  tags,
  method: "post",
  path: "/webhooks/mpesa/c2b/{token}/confirmation",
  summary: "Safaricom C2B payment confirmation",
  description:
    "Writes the raw confirmation and returns 200. It never decides which "
    + "child the money is for, never creates a ledger entry, and never fails "
    + "on a reference it does not recognise — Safaricom retries anything it "
    + "does not see acknowledged, and a webhook that can reject is a webhook "
    + "that loses money. Matching happens afterwards, against a row that is "
    + "already safe.",
  request: {
    params: z.object({ token: z.string() }),
    body: jsonContentRequired(c2bConfirmationSchema, "Daraja's confirmation"),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(darajaAckSchema, "Stored, or already known"),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(
      darajaAckSchema,
      "No school answers to this callback token",
    ),
  },
});

export const c2bValidation = createRoute({
  tags,
  method: "post",
  path: "/webhooks/mpesa/c2b/{token}/validation",
  summary: "Safaricom C2B validation",
  description:
    "Accepts every payment. Rejecting here would refuse a parent's fees at "
    + "the till because our records did not recognise the reference they "
    + "typed — which is the normal case, not an error. An unrecognised "
    + "reference belongs in the reconciliation queue, not in a declined "
    + "payment at a shop counter.",
  request: {
    params: z.object({ token: z.string() }),
    body: jsonContentRequired(c2bConfirmationSchema, "Daraja's validation request"),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(darajaAckSchema, "Accepted"),
  },
});

export type C2bConfirmationRoute = typeof c2bConfirmation;
export type C2bValidationRoute = typeof c2bValidation;
