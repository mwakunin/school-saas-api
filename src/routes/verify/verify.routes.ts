import { createRoute } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContent } from "stoker/openapi/helpers";

import { tooManyRequestsSchema } from "@/lib/constants";
import { rateLimits } from "@/middlewares/rate-limit";

import {
  codeParamsSchema,
  verificationNotFoundSchema,
  verifiedDocumentSchema,
} from "./verify.schemas";

/**
 * Public document verification.
 *
 * No session, no subdomain, no tenant. The code in the path is the whole
 * credential, exactly like the M-Pesa callback token — and for the same
 * reason: the person checking a report card handed to them at admission has no
 * account here and should not need one.
 *
 * Rate limited because the only attack on a 160-bit code is volume. It is the
 * first route in this codebase to actually use `rateLimits`, which have been
 * defined and unapplied since the scaffold.
 */
const tags = ["Verification"];

export const verifyDocument = createRoute({
  tags,
  method: "get",
  path: "/verify/{code}",
  summary: "Check a printed document is genuine",
  description:
    "Confirms a report card, fee receipt or transition certificate against the "
    + "frozen snapshot taken when it was issued. Shows no more than the paper "
    + "does. A reversed payment or a withdrawn document answers `withdrawn` "
    + "rather than simply failing, because a receipt that was real and is no "
    + "longer good is the case worth being told about.",
  middleware: [rateLimits.read()],
  request: { params: codeParamsSchema },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(verifiedDocumentSchema, "The document as issued"),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(
      verificationNotFoundSchema,
      "No document with that code",
    ),
    [HttpStatusCodes.TOO_MANY_REQUESTS]: jsonContent(
      tooManyRequestsSchema,
      "Too many verification attempts",
    ),
  },
});

export type VerifyDocumentRoute = typeof verifyDocument;
