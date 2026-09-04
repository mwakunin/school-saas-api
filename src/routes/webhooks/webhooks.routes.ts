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
 * Any JSON at all, deliberately.
 *
 * An earlier version declared the known fields as optional strings. That
 * validated the body BEFORE the handler ran, so a confirmation carrying
 * `BusinessShortCode` as a JSON number — which Daraja does, and which
 * `parseC2bConfirmation` explicitly copes with — was answered 422 and never
 * stored. Safaricom would then retry a payment we could never accept.
 *
 * Validating a payload we do not control, on an endpoint whose contract is
 * "always acknowledge", is a contradiction: the schema can only ever turn a
 * storable payment into a rejected one. `parseC2bConfirmation` is the single
 * authority on whether there is enough here to store, and it answers by
 * returning null rather than by failing a request.
 *
 * The fields Daraja sends are described in the route below instead, where they
 * inform a reader without gating a request.
 */
const c2bConfirmationSchema = z.unknown();

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
    + "already safe.\n\n"
    + "Daraja sends TransID, TransTime (YYYYMMDDHHmmss in EAT), TransAmount, "
    + "BusinessShortCode, BillRefNumber, MSISDN and the payer's name parts — "
    + "any of which may arrive as a JSON string or number. The body is not "
    + "validated against that shape on purpose: rejecting a payload we do not "
    + "control could only ever turn a real payment into a retry loop.",
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
