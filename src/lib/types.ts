import type { OpenAPIHono, RouteConfig, RouteHandler } from "@hono/zod-openapi";
import type { Schema } from "hono";
import type { PinoLogger } from "hono-pino";

import type { AppDb } from "@/db";

import type { Session } from "./auth";

/**
 * The *platform* role, on the global Better Auth user row.
 *
 * Deliberately not the tenant roles. `admin` / `bursar` / `teacher` /
 * `guardian` live on `memberships`, per school, because one person may work at
 * two schools, or be both a teacher and a parent at one (CLAUDE.md §5.1) —
 * a single column on a global user row cannot express that.
 *
 * This column answers one narrower question: may this login reach the
 * superadmin plane, which onboards schools and suspends non-payers? That plane
 * is a separate route namespace outside any tenant (§4), so it needs an
 * authority that is not itself tenant-scoped.
 *
 * Nearly every route wants `requireMembershipRole` instead.
 */
export type UserRole = "user" | "superadmin";

/** What a person may do at one particular school. */
export type MembershipRole = "admin" | "bursar" | "teacher" | "guardian";

/** The Better Auth user, narrowed with the `role` additional field. */
export type AuthUser = Session["user"] & { role: string };

export interface TenantSchool {
  id: string;
  name: string;
  status: "trial" | "active" | "suspended" | "demo";
}

export interface Membership {
  schoolId: string;
  /** Every active role this user holds here — a teacher may also be a parent. */
  roles: MembershipRole[];
}

export interface AppBindings {
  Variables: {
    logger: PinoLogger;
    user: AuthUser | null;
    session: Session["session"] | null;
  };
};

/**
 * What a route gets once `withTenant` and `withMembership` have run.
 *
 * Separate from `AppBindings` so the type system knows where these exist.
 * Declaring `db` on the base bindings would make it appear available on
 * unscoped routes — including the superadmin plane, where a tenant-scoped
 * connection is exactly the wrong thing — and the mistake would typecheck.
 */
export interface TenantBindings {
  Variables: AppBindings["Variables"] & {
    school: TenantSchool;
    membership: Membership;
    /**
     * The tenant-scoped transaction. This is the only database handle a tenant
     * route may use; `db-access.test.ts` fails the build if a route imports
     * the module-level connection instead (CLAUDE.md §3 rule 2).
     */
    db: AppDb;
  };
};

// eslint-disable-next-line ts/no-empty-object-type
export type AppOpenAPI<S extends Schema = {}> = OpenAPIHono<AppBindings, S>;

// eslint-disable-next-line ts/no-empty-object-type
export type TenantOpenAPI<S extends Schema = {}> = OpenAPIHono<TenantBindings, S>;

export type AppRouteHandler<R extends RouteConfig> = RouteHandler<R, AppBindings>;

export type TenantRouteHandler<R extends RouteConfig> = RouteHandler<R, TenantBindings>;
