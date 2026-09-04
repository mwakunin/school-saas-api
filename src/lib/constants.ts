import { z } from "@hono/zod-openapi";
import * as HttpStatusPhrases from "stoker/http-status-phrases";
import { createMessageObjectSchema } from "stoker/openapi/schemas";

export const ZOD_ERROR_MESSAGES = {
  REQUIRED: "Required",
  EXPECTED_NUMBER: "Invalid input: expected number, received NaN",
  NO_UPDATES: "No updates provided",
  EXPECTED_STRING: "Invalid input: expected string, received undefined",
};

export const ZOD_ERROR_CODES = {
  INVALID_UPDATES: "invalid_updates",
};

export const notFoundSchema = createMessageObjectSchema(HttpStatusPhrases.NOT_FOUND);
export const unauthorizedSchema = createMessageObjectSchema(HttpStatusPhrases.UNAUTHORIZED);
export const forbiddenSchema = createMessageObjectSchema(HttpStatusPhrases.FORBIDDEN);

/** Returned when a caller exceeds a rate limit. */
/**
 * Mirrors what `rateLimit()` returns, including the retry hint — a documented
 * response that omits half the body is worse than none, since clients generate
 * against it.
 */
export const tooManyRequestsSchema = z.object({
  message: z.string(),
  retryAfterSeconds: z.number().int().positive(),
});
