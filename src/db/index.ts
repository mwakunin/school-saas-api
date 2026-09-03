import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import env from "@/env";

import { sslConfigFor } from "./connection";
// schema.ts re-exports the Better-Auth-owned tables, so this is the whole model.
import * as schema from "./schema";

/**
 * Two connections, deliberately.
 *
 * `db` connects as the OWNER of the tables. Postgres exempts a table's owner
 * from row-level security, and exempts a superuser from it outright, so this
 * connection sees every school's rows. That is correct for exactly three
 * callers — migrations, the test harness's TRUNCATE, and the superadmin plane,
 * which exists precisely to work across tenants — and catastrophic for any
 * other.
 *
 * `appDb` connects as `school_app` (db/roles.sql): not the owner, not a
 * superuser, and therefore subject to the policies. Every request that acts
 * on behalf of a school goes through it, inside a transaction that has set
 * `app.school_id`. See middlewares/tenant.ts.
 *
 * The split is the whole reason RLS is worth having here. With one connection
 * as the owner, the policies would still exist, still be reported by
 * `pg_policies`, and still do nothing at all.
 */

// One driver serves both local Docker Postgres and Neon — Neon speaks the
// standard wire protocol over TCP, so there's no environment branching here.
export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  // Neon (and most managed Postgres) require TLS; local Docker doesn't offer it.
  ssl: sslConfigFor(env.DATABASE_URL),
});

const db = drizzle({
  client: pool,
  casing: "snake_case",
  schema,
});

export const appPool = new Pool({
  connectionString: env.APP_DATABASE_URL,
  ssl: sslConfigFor(env.APP_DATABASE_URL),
});

export const appDb = drizzle({
  client: appPool,
  casing: "snake_case",
  schema,
});

/** A tenant-scoped handle: the transaction `withTenant` opened, never the pool. */
export type AppDb = Parameters<Parameters<typeof appDb.transaction>[0]>[0];

export default db;
