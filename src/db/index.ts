import type { PoolClient } from "pg";

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import type { ErrorSummary } from "@/lib/error-summary";

import env from "@/env";
import { summarizeError } from "@/lib/error-summary";

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

/** How long one connection's probe may take, every step included. */
export const PROBE_DEADLINE_MS = 3000;

/**
 * Probes one connection: null if it can run a query, else why not.
 *
 * Bounded on every step by a deadline here, not only by Postgres: a stalled
 * server would otherwise leave `BEGIN`, or the wait for a connection, without
 * any bound, and the readiness probe hanging with a client held. A client
 * that failed or overran is released with its error, so pg discards it rather
 * than pooling a connection left mid-transaction. Postgres still caps the
 * query itself (`statement_timeout`).
 */
export async function probeConnection(target: Pool, deadlineMs = PROBE_DEADLINE_MS): Promise<ErrorSummary | null> {
  let client: PoolClient | undefined;
  let released = false;
  let timedOut = false;
  const discard = (err: Error) => {
    if (client && !released) {
      released = true;
      client.release(err);
    }
  };

  const work = (async () => {
    client = await target.connect();
    if (timedOut) {
      discard(new Error("Probe abandoned after its deadline"));
      return;
    }
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = 2000");
    await client.query("SELECT 1");
    await client.query("COMMIT");
    if (!released) {
      released = true;
      client.release();
    }
  })();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new Error(`No answer within ${deadlineMs} ms`));
    }, deadlineMs);
  });

  try {
    await Promise.race([work, deadline]);
    return null;
  }
  catch (err) {
    discard(err instanceof Error ? err : new Error(String(err)));
    // It settles later, if at all; its client is already discarded.
    work.catch(() => {});
    return summarizeError(err);
  }
  finally {
    clearTimeout(timer);
  }
}

export interface ConnectionCheck {
  owner: boolean;
  app: boolean;
  auth: boolean;
  /** Why each failed connection failed: enough to tell bad credentials from a network fault, nothing about a person. */
  errors: Partial<Record<"owner" | "app" | "auth", ErrorSummary>>;
}

/**
 * Whether every connection can run a query: the readiness probe.
 *
 * All three, because each logs in as its own role: the owner can still be up
 * while `school_app` or `school_auth` cannot sign in, and then no school's
 * requests, or no sign-in, would work. Ported from healthcare-api.
 */
export async function checkConnections(): Promise<ConnectionCheck> {
  const [owner, app, auth] = await Promise.all([pool, appPool, authPool].map(target => probeConnection(target)));
  const errors: ConnectionCheck["errors"] = {};
  if (owner)
    errors.owner = owner;
  if (app)
    errors.app = app;
  if (auth)
    errors.auth = auth;
  return { owner: !owner, app: !app, auth: !auth, errors };
}

export default db;
