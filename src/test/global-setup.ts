/* eslint-disable node/no-process-env */
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

/**
 * Runs once before the whole suite: brings the disposable test database
 * (tmpfs) up to the current migration head. The migrator records what it has
 * applied in the same table drizzle-kit uses, so this is idempotent across
 * runs while the container lives.
 *
 * The migrator is called directly rather than through the drizzle-kit
 * binary: `./node_modules/.bin/drizzle-kit` is a shell script, and execSync
 * runs commands through cmd.exe on Windows, where it cannot start, so the
 * suite only ran on Linux. Ported from healthcare-api.
 */
export default async function setup() {
  if (process.env.NODE_ENV !== "test")
    throw new Error("Test global-setup ran outside NODE_ENV=test");

  const { default: env } = await import("../env");
  const { sslConfigFor } = await import("../db/connection");

  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    ssl: sslConfigFor(env.DATABASE_URL),
    max: 1,
    connectionTimeoutMillis: 5_000,
  });

  try {
    await migrate(drizzle(pool), { migrationsFolder: "./src/db/migrations" });
  }
  finally {
    await pool.end();
  }
}
