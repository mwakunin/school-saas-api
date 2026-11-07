import type { ErrorHandler } from "hono";

import { HTTPException } from "hono/http-exception";
import * as HttpStatusCodes from "stoker/http-status-codes";
import * as HttpStatusPhrases from "stoker/http-status-phrases";

import type { AppBindings } from "./types";

import { summarizeError } from "./error-summary";

/**
 * The last word on an unhandled error, replacing stoker's `onError`.
 *
 * Stoker returns `err.message` to the caller in every environment, and the
 * stack outside production. A database error's message carries its SQL and
 * its parameters, so a failed insert would hand the caller the guardian's
 * phone number or the pupil's name it held. This returns a fixed message and
 * the request id, which ties the response to the server's log line; the log
 * gets a summary with no parameters in it.
 *
 * An `HTTPException` is a deliberate refusal with a message written for the
 * caller, so it keeps its own status and message.
 */
export const onError: ErrorHandler<AppBindings> = (err, c) => {
  if (err instanceof HTTPException)
    return err.getResponse();

  c.var.logger?.error({ err: summarizeError(err) }, "Unhandled error");

  return c.json(
    {
      message: HttpStatusPhrases.INTERNAL_SERVER_ERROR,
      requestId: c.get("requestId"),
    },
    HttpStatusCodes.INTERNAL_SERVER_ERROR,
  );
};
