import type { Context } from "hono";

import { pinoLogger as logger } from "hono-pino";
import pino from "pino";
import pretty from "pino-pretty";

import env from "@/env";

/**
 * The message on a request's log line.
 *
 * Fixed, never the error's own text. hono-pino's default is `c.error.message`
 * on a failed request, and a database error's message is Drizzle's
 * `Failed query: <sql> params: <values>`, so a crash on a write would put a
 * guardian's phone number or a pupil's name in the log. What went wrong is
 * logged once, without its parameters, by the error handler (lib/on-error.ts).
 */
export function requestLogMessage(c: Pick<Context, "error">): string {
  return c.error ? "Request failed" : "Request completed";
}

export function pinoLogger() {
  return logger({
    pino: pino({
      level: env.LOG_LEVEL || "info",
    }, env.NODE_ENV === "production" ? undefined : pretty()),
    http: { onResMessage: requestLogMessage },
  });
}
