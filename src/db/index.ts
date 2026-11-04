import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import env from "@/env";

import * as authSchema from "./auth-schema";
import { sslConfigFor } from "./connection";
// schema.ts re-exports the Better-Auth-owned tables, so this is the whole model.
import * as schema from "./schema";

/**
 * Three connections, deliberately.
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
 * `app.school_id`. See middlewares/tenant.ts. Of identity it sees only who a
 * person is (name, email, phone), never a session or a password.
 *
 * `authDb` connects as `school_auth`, for Better Auth alone: the only role
 * that can read sessions, password hashes and verification tokens, and one
 * that holds nothing on the tenant tables. Identity is global, so those
 * tables carry no tenant policies; privileges are what keep them apart.
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

export const authPool = surviveIdleFailures(new Pool({
  connectionString: env.AUTH_DATABASE_URL,
  ssl: sslConfigFor(env.AUTH_DATABASE_URL),
  connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
}), "auth");

/** Better Auth's adapter, and only it (lib/auth.ts). */
export const authDb = drizzle({
  client: authPool,
  casing: "snake_case",
  schema: authSchema,
});

/** A tenant-scoped handle: the transaction `withTenant` opened, never the pool. */
export type AppDb = Parameters<Parameters<typeof appDb.transaction>[0]>[0];

/**
 * Whether every connection can run a query: the readiness probe.
 *
 * All three, because each logs in as its own role: the owner can still be up
 * while `school_app` or `school_auth` cannot sign in, and then no school's
 * requests, or no sign-in, would work. Each probe is bounded by Postgres
 * itself (`statement_timeout`) as well as by the pool's connection timeout,
 * so a probe cannot hang. Ported from healthcare-api.
 */
export async function checkConnections(): Promise<{ owner: boolean; app: boolean; auth: boolean }> {
  async function probe(target: Pool) {
    const client = await target.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL statement_timeout = 2000");
      await client.query("SELECT 1");
      await client.query("COMMIT");
      return true;
    }
    catch {
      await client.query("ROLLBACK").catch(() => {});
      return false;
    }
    finally {
      client.release();
    }
  }

  const [owner, app, auth] = await Promise.all(
    [pool, appPool, authPool].map(target => probe(target).catch(() => false)),
  );
  return { owner, app, auth };
}

export default db;
