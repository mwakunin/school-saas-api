import { createMiddleware } from "hono/factory";
import * as HttpStatusCodes from "stoker/http-status-codes";
import * as HttpStatusPhrases from "stoker/http-status-phrases";

import type { AppBindings, MembershipRole, TenantBindings, UserRole } from "@/lib/types";

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
 * Rejects anyone whose PLATFORM role isn't in `allowed` — in practice, the
 * superadmin plane and nothing else.
 *
 * For anything inside a school, use `requireMembershipRole`. This function
 * reads the global `user.role`, which cannot express "bursar at St Mary's":
 * guarding a tenant route with it would either lock out every legitimate user
 * or, if someone widened the allowlist to compensate, admit staff from other
 * schools.
 *
 * Assumes `requireAuth` ran first; a missing user is treated as
 * unauthenticated rather than forbidden so the status code stays honest.
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

/**
 * Rejects anyone who holds none of `allowed` at the school being addressed.
 *
 * This is the guard nearly every route wants. It reads the membership that
 * `withMembership` resolved for *this* school, so a bursar at one school gets
 * no bursar powers at another — the property a global role column cannot
 * express.
 *
 * Roles are a set, not a value: a teacher who is also a parent holds both, and
 * a route open to either must admit them once. Hence an intersection test
 * rather than an equality check.
 *
 * Requires `withTenant` and `withMembership` to have run. A missing membership
 * is a programming error — the middleware 404s before reaching here — so this
 * fails closed with 403 rather than pretending the route was public.
 */
export function requireMembershipRole(...allowed: MembershipRole[]) {
  return createMiddleware<TenantBindings>(async (c, next) => {
    const roles = c.var.membership?.roles ?? [];

    /*
     * No membership at all is 404, not 403.
     *
     * A signed-in stranger must not be able to tell a school that exists from
     * one that does not, or the subdomain space becomes a directory of our
     * customers. Someone who IS a member and merely holds the wrong role
     * already knows the school exists, so they get an honest 403 — the
     * distinction the two answers carry is worth keeping.
     */
    if (roles.length === 0) {
      return c.json(
        { message: "No school found for this address" },
        HttpStatusCodes.NOT_FOUND,
      );
    }

    if (!roles.some(role => allowed.includes(role))) {
      return c.json(
        { message: HttpStatusPhrases.FORBIDDEN },
        HttpStatusCodes.FORBIDDEN,
      );
    }

    await next();
  });
}
