import type { OpenAPIHono, RouteConfig, RouteHandler } from "@hono/zod-openapi";
import type { Schema } from "hono";
import type { PinoLogger } from "hono-pino";

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
 * `requireRole` below still reads this. From step 2 there is a second guard,
 * `requireMembershipRole`, which reads the membership instead — and that is
 * the one nearly every route wants.
 */
export type UserRole = "user" | "superadmin";

/** The Better Auth user, narrowed with the `role` additional field. */
export type AuthUser = Session["user"] & { role: string };

export interface AppBindings {
  Variables: {
    logger: PinoLogger;
    user: AuthUser | null;
    session: Session["session"] | null;
  };
};

// eslint-disable-next-line ts/no-empty-object-type
export type AppOpenAPI<S extends Schema = {}> = OpenAPIHono<AppBindings, S>;

export type AppRouteHandler<R extends RouteConfig> = RouteHandler<R, AppBindings>;
