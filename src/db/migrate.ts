/* eslint-disable no-console */
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

import env from "@/env";

import { sslConfigFor } from "./connection";

/**
 * Applies migrations at deploy time.
 *
 * Uses drizzle-orm's migrator rather than `drizzle-kit migrate`, because
 * drizzle-kit is a devDependency: a production image installed with
 * `--prod` doesn't have it, and shipping the whole toolchain just to run
 * migrations is a poor trade. drizzle-orm is already a runtime dependency.
 *
 * Reads the same journal as drizzle-kit, so a database migrated either way
 * stays consistent.
 */
async function main() {
  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    ssl: sslConfigFor(env.DATABASE_URL),
    // A migration run is one connection doing one thing.
    max: 1,
  });

  try {
    console.log(`Applying migrations (NODE_ENV=${env.NODE_ENV})...`);
    await migrate(drizzle(pool), { migrationsFolder: "./src/db/migrations" });
    console.log("Migrations applied.");
  }
  finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
