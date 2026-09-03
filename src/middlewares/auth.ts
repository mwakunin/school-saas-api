import { createMiddleware } from "hono/factory";
import * as HttpStatusCodes from "stoker/http-status-codes";
import * as HttpStatusPhrases from "stoker/http-status-phrases";

import type { AppBindings, UserRole } from "@/lib/types";

import { auth } from "@/lib/auth";

/**
 * Resolves the Better Auth session (if any) onto the context. Always runs;
 * never rejects — routes decide for themselves whether a session is required,
 * so public endpoints can still personalize when someone happens to be signed
 * in.
 */
export const withSession = createMiddleware<AppBindings>(async (c, next) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });

  c.set("user", session?.user ?? null);
  c.set("session", session?.session ?? null);

  await next();
});

/** Rejects anyone without a valid session. */
export const requireAuth = createMiddleware<AppBindings>(async (c, next) => {
  if (!c.var.user) {
    return c.json(
      { message: HttpStatusPhrases.UNAUTHORIZED },
      HttpStatusCodes.UNAUTHORIZED,
    );
  }

  await next();
});

/**
 * Rejects anyone whose role isn't in `allowed`. Assumes `requireAuth` ran
 * first; a missing user is treated as unauthenticated rather than forbidden so
 * the status code stays honest.
 */
export function requireRole(...allowed: UserRole[]) {
  return createMiddleware<AppBindings>(async (c, next) => {
    const user = c.var.user;

    if (!user) {
      return c.json(
        { message: HttpStatusPhrases.UNAUTHORIZED },
        HttpStatusCodes.UNAUTHORIZED,
      );
    }

    if (!allowed.includes(user.role as UserRole)) {
      return c.json(
        { message: HttpStatusPhrases.FORBIDDEN },
        HttpStatusCodes.FORBIDDEN,
      );
    }

    await next();
  });
}
