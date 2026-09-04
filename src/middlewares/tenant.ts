import { and, eq, sql } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import * as HttpStatusCodes from "stoker/http-status-codes";

import type { AppBindings, TenantBindings } from "@/lib/types";

import db, { appDb } from "@/db";
import { memberships, schools } from "@/db/schema";
import env from "@/env";
import { subdomainFrom } from "@/lib/subdomain";

/**
 * Tenant resolution, in three steps that must happen in this order:
 *
 *   withTenant      Host header -> school. Opens the transaction that carries
 *                   `app.school_id`, which is what every RLS policy reads.
 *   withMembership  this user's role AT this school.
 *   requireMembershipRole(...)  authorization, in lib/../middlewares/auth.ts
 *
 * Handlers then use `c.var.db` and never import the module-level connection.
 */

/**
 * Resolves a subdomain to a school, on the OWNER connection.
 *
 * This is the one read in the whole request path that deliberately bypasses
 * row-level security, and it has to: the policy on `schools` is
 * `id = app_current_school()`, and the id is precisely what is not known yet.
 * A tenant-scoped connection cannot perform its own bootstrap.
 *
 * It is safe because of what it is, not because of where it sits: it selects
 * three non-secret columns for the single school the request is already
 * addressed to by name, and returns nothing else. It cannot be steered to
 * another tenant's rows, and it never touches `mpesa_credentials`.
 *
 * Keep it the only such read. `db-access.test.ts` asserts that the owner
 * connection is imported by an allowlist of files, and this is on it.
 */
async function resolveSchool(subdomain: string) {
  const [row] = await db
    .select({
      id: schools.id,
      name: schools.name,
      status: schools.status,
    })
    .from(schools)
    .where(eq(schools.subdomain, subdomain))
    .limit(1);

  return row;
}

/**
 * Resolves the school from the subdomain and opens the tenant transaction.
 *
 * The transaction is the mechanism, not an implementation detail. `set_config`
 * with `is_local = true` scopes the setting to the transaction, so it is
 * discarded on COMMIT or ROLLBACK and cannot outlive the request. A plain
 * `SET` on a pooled connection would persist after the response and hand the
 * next request that borrowed the connection the previous tenant's identity —
 * the exact cross-tenant leak the policies exist to prevent, reintroduced by
 * the code that sets them up.
 *
 * Holding a transaction open across `await next()` also makes each request
 * atomic: a handler that throws halfway through leaves nothing behind.
 */
export const withTenant = createMiddleware<TenantBindings>(async (c, next) => {
  const subdomain = subdomainFrom(c.req.header("host"), env.ROOT_DOMAIN);

  if (!subdomain) {
    return c.json(
      { message: "No school found for this address" },
      HttpStatusCodes.NOT_FOUND,
    );
  }

  const school = await resolveSchool(subdomain);

  // Unknown subdomain and suspended school are answered differently on
  // purpose: a suspended school's staff need to know why they are locked out,
  // whereas an unknown one must not confirm whether it exists.
  if (!school) {
    return c.json(
      { message: "No school found for this address" },
      HttpStatusCodes.NOT_FOUND,
    );
  }

  if (school.status === "suspended") {
    return c.json(
      { message: "This school's account is suspended. Please contact support." },
      HttpStatusCodes.FORBIDDEN,
    );
  }

  return appDb.transaction(async (tx) => {
    // Parameterised, not interpolated. `set_config` takes the value as an
    // argument, so a subdomain cannot escape into the statement — and the
    // value here is a uuid from our own table regardless.
    await tx.execute(
      sql`SELECT set_config('app.school_id', ${school.id}, true)`,
    );

    c.set("school", school);
    c.set("db", tx);

    await next();

    /*
     * A handler that returns 4xx/5xx without throwing would otherwise commit
     * whatever it wrote first. Rolling back on an error status keeps "the
     * request failed" and "nothing was persisted" the same statement, which
     * is what makes a half-finished fee allocation impossible.
     *
     * Thrown errors already roll back — this is only for the returned kind.
     */
    if (c.res.status >= 400)
      throw new RollbackOnErrorStatus(c.res.status);
  }).catch((err) => {
    // The rollback did its job; the response the handler built still stands.
    if (err instanceof RollbackOnErrorStatus)
      return;
    throw err;
  });
});

/** Internal signal: unwind the transaction but keep the handler's response. */
class RollbackOnErrorStatus extends Error {
  constructor(readonly status: number) {
    super(`Rolled back on ${status}`);
    this.name = "RollbackOnErrorStatus";
  }
}

/**
 * Loads the signed-in user's membership at the resolved school.
 *
 * Runs on the tenant connection, so the membership row is itself subject to
 * RLS — a user's membership at some *other* school is invisible here and
 * cannot be mistaken for authorization at this one.
 *
 * Requires `withTenant` and `withSession` to have run.
 */
export const withMembership = createMiddleware<TenantBindings>(async (c, next) => {
  const user = c.var.user;

  if (!user) {
    return c.json(
      { message: "Not signed in" },
      HttpStatusCodes.UNAUTHORIZED,
    );
  }

  const rows = await c.var.db
    .select({
      id: memberships.id,
      role: memberships.role,
      schoolId: memberships.schoolId,
    })
    .from(memberships)
    .where(and(
      eq(memberships.userId, user.id),
      eq(memberships.isActive, true),
    ));

  if (rows.length === 0) {
    // 404, not 403. A signed-in user with no membership here must not be able
    // to tell a school that exists from one that does not — otherwise the
    // subdomain space becomes a directory of our customers.
    return c.json(
      { message: "No school found for this address" },
      HttpStatusCodes.NOT_FOUND,
    );
  }

  // One person may hold several roles at one school — CLAUDE.md §5.1 keeps a
  // teacher who is also a parent on a single login — so this is a set, and
  // authorization asks whether it intersects what a route allows.
  c.set("membership", {
    schoolId: rows[0].schoolId,
    roles: rows.map(r => r.role),
  });

  await next();
});

/** Convenience for mounting: session, then tenant, then membership. */
export const tenantChain = [withTenant, withMembership] as const;

export type { AppBindings };
