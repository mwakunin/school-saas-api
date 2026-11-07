import { pgConstraintName, pgErrorCode } from "./db-errors";

/**
 * What may be said about an error outside the database: in a log line, and
 * never in a response body.
 *
 * Drizzle's messages read `Failed query: <sql>\nparams: <values>`, and a pg
 * error's `detail` repeats the offending values (`Key (phone)=(...) already
 * exists`). Those values are children's names and guardians' phone numbers,
 * so they stay in the database. This keeps the error's class, its SQLSTATE
 * and constraint, and the first line of its message with any parameters cut
 * off: enough to diagnose, nothing about a person.
 *
 * Ported from healthcare-api, where the same leak was found first.
 */
export interface ErrorSummary {
  name: string;
  message: string;
  code?: string;
  constraint?: string;
}

const MESSAGE_LIMIT = 300;

export function summarizeError(err: unknown): ErrorSummary {
  const name = err instanceof Error ? err.name : typeof err;
  const raw = err instanceof Error ? err.message : String(err);
  const message = raw.split(/\n\s*params:/)[0].split("\n")[0].slice(0, MESSAGE_LIMIT);

  const summary: ErrorSummary = { name, message };
  const code = pgErrorCode(err);
  const constraint = pgConstraintName(err);
  if (code)
    summary.code = code;
  if (constraint)
    summary.constraint = constraint;
  return summary;
}
