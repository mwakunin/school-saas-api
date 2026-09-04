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

/**
 * How long to wait for a free connection before giving up.
 *
 * `pg` waits forever by default. A database that has gone away therefore turns
 * every request into one that hangs rather than one that fails — including
 * `/health`, which is the endpoint whose whole job is to notice. Failing takes
 * a few seconds; hanging takes until something else times out.
 */
const CONNECTION_TIMEOUT_MS = 5_000;

/**
 * Keeps an idle-client failure from killing the process.
 *
 * `pg` Pool emits `error` for a client that dies while idle — a database
 * restart, a dropped network link, an idle-timeout on the server side. An
 * `error` event with no listener is an unhandled exception in Node, so without
 * this a routine Postgres restart takes the whole API down instead of costing
 * one pooled connection.
 */
function surviveIdleFailures(pool: Pool, name: string) {
  pool.on("error", (err) => {
    console.error(`[db:${name}] idle client error:`, err);
  });
  return pool;
}

// One driver serves both local Docker Postgres and Neon — Neon speaks the
// standard wire protocol over TCP, so there's no environment branching here.
export const pool = surviveIdleFailures(new Pool({
  connectionString: env.DATABASE_URL,
  // Neon (and most managed Postgres) require TLS; local Docker doesn't offer it.
  ssl: sslConfigFor(env.DATABASE_URL),
  connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
}), "owner");

const db = drizzle({
  client: pool,
  casing: "snake_case",
  schema,
});

export const appPool = surviveIdleFailures(new Pool({
  connectionString: env.APP_DATABASE_URL,
  ssl: sslConfigFor(env.APP_DATABASE_URL),
  connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
}), "app");

export const appDb = drizzle({
  client: appPool,
  casing: "snake_case",
  schema,
});

/** A tenant-scoped handle: the transaction `withTenant` opened, never the pool. */
export type AppDb = Parameters<Parameters<typeof appDb.transaction>[0]>[0];

export default db;
