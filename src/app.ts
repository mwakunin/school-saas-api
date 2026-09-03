import type { AppOpenAPI } from "@/lib/types";

import configureOpenAPI from "@/lib/configure-open-api";
import createApp from "@/lib/create-app";
import academic from "@/routes/academic/academic.index";
import health from "@/routes/health.route";
import index from "@/routes/index.route";
import superadmin from "@/routes/superadmin/superadmin.index";

const app = createApp();

configureOpenAPI(app);

/**
 * Two planes, deliberately separate.
 *
 * `superadmin` runs outside any tenant on the owner connection; `academic` and
 * everything after it runs inside one, on a transaction scoped by
 * `app.school_id`. The distinct router types in lib/types.ts are what stop a
 * handler in one plane from reaching for the other's database handle.
 */
const unscopedRoutes = [
  index,
  health,
  superadmin,
] as const;

/**
 * Routers whose handlers see `school`, `membership` and `db` on the context.
 *
 * The cast is a limitation of Hono's types, not a hole in the guarantee.
 * `app.route()` requires the sub-app's Env to be assignable to the parent's,
 * and a tenant router's Env has strictly *more* variables — which is the whole
 * point of it, and which Hono cannot express for a subtree. At runtime the
 * sub-router carries its own middleware, so the variables really are set
 * before any handler in it runs.
 *
 * Confining the cast to this one list is what keeps it honest: inside
 * academic.index.ts the strong typing still holds, so a handler that forgets
 * the tenant chain is a type error where it is actually written.
 */
const tenantRoutes = [
  academic,
] as unknown as readonly AppOpenAPI[];

[...unscopedRoutes, ...tenantRoutes].forEach((route) => {
  app.route("/", route);
});

export type AppType = typeof unscopedRoutes[number];

export default app;
