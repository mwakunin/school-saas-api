import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * CLAUDE.md §3 rule 2: never query the raw `db` export from a route handler.
 *
 * RLS means a slip here is no longer catastrophic — the owner connection is
 * the one that bypasses policies, and this test is what keeps its use down to
 * the handful of places that genuinely work across tenants. Without it, "use
 * the scoped client" is a convention, and the failure mode of a convention is
 * one tired afternoon.
 *
 * Static, deliberately. A runtime assertion would only fire on the code path
 * that happened to run; reading the source catches the import whether or not
 * any test exercises it.
 */

const SRC = path.resolve(import.meta.dirname, "..");

/**
 * Files permitted to import the OWNER connection (`db`, `pool`).
 *
 * Every entry needs a reason, and the reason must be that the file's job is
 * inherently cross-tenant. "It was easier" is not one — that is what
 * `c.var.db` is for.
 */
const OWNER_ALLOWLIST = new Map([
  ["db/index.ts", "defines it"],
  ["db/migrate.ts", "runs migrations, before any tenant exists"],
  ["lib/auth.ts", "identity is global; Better Auth owns those tables"],
  ["middlewares/tenant.ts", "resolves subdomain -> school, the one bootstrap read"],
  ["routes/health.route.ts", "liveness probe; reaches no tenant data"],
  ["routes/superadmin/superadmin.handlers.ts", "the cross-tenant plane by design"],
]);

/**
 * Files permitted to import `appDb` / `appPool` directly rather than taking
 * the transaction from the request context.
 *
 * Narrower than the owner list: `appDb` outside a transaction has no
 * `app.school_id`, so it sees nothing — which is safe, but silently returns
 * empty results, and a handler built on it would look broken rather than
 * insecure.
 */
const APP_DB_ALLOWLIST = new Map([
  ["db/index.ts", "defines it"],
  ["lib/auth.ts", "Better Auth's adapter; auth tables carry no policies"],
  ["middlewares/tenant.ts", "opens the tenant transaction"],
]);

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const found: string[] = [];

  for (const entry of entries) {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      found.push(...await sourceFiles(full));
      continue;
    }

    if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts"))
      continue;

    // Test helpers set up multiple schools on purpose.
    if (path.relative(SRC, full).startsWith("test/"))
      continue;

    found.push(full);
  }

  return found;
}

/** Import specifiers pulled from `@/db` or a relative path to it. */
function dbImportsIn(source: string): string[] {
  const names: string[] = [];
  // Written to avoid ambiguity between the adjacent quantifiers: the import
  // clause cannot contain a quote, so there is exactly one way to match.
  const pattern = /import\s([^;"']*)from\s*["'](?:@\/db|\.\.?\/(?:\.\.\/)*db)["']/g;

  for (const match of source.matchAll(pattern)) {
    const clause = match[1];

    // `import db from "@/db"` — the default export is the owner connection.
    const defaultImport = clause.match(/^\s*(\w+)\s*(?:,|$)/);
    if (defaultImport)
      names.push("default");

    for (const named of clause.matchAll(/\b(pool|appDb|appPool)\b/g))
      names.push(named[1]);
  }

  return names;
}

describe("database access", () => {
  it("keeps the owner connection out of everything but its allowlist", async () => {
    const files = await sourceFiles(SRC);
    const offenders: string[] = [];

    for (const file of files) {
      const rel = path.relative(SRC, file);
      const imports = dbImportsIn(await readFile(file, "utf8"));

      const usesOwner = imports.includes("default") || imports.includes("pool");
      if (usesOwner && !OWNER_ALLOWLIST.has(rel))
        offenders.push(rel);
    }

    expect(
      offenders,
      "These import the RLS-exempt owner connection. Use `c.var.db` — the "
      + "tenant-scoped transaction — or add an entry to OWNER_ALLOWLIST with "
      + "a reason this file is inherently cross-tenant.",
    ).toEqual([]);
  });

  it("keeps the pooled app connection out of everything but its allowlist", async () => {
    const files = await sourceFiles(SRC);
    const offenders: string[] = [];

    for (const file of files) {
      const rel = path.relative(SRC, file);
      const imports = dbImportsIn(await readFile(file, "utf8"));

      const usesAppDb = imports.includes("appDb") || imports.includes("appPool");
      if (usesAppDb && !APP_DB_ALLOWLIST.has(rel))
        offenders.push(rel);
    }

    expect(
      offenders,
      "These import `appDb` directly. Outside the request transaction it "
      + "carries no app.school_id and sees nothing at all; take the handle "
      + "from `c.var.db` instead.",
    ).toEqual([]);
  });

  it("has no stale allowlist entries", async () => {
    // An allowlist that outlives its reason is how the next exception gets
    // waved through: the file is already listed, so nobody re-asks why.
    const files = await sourceFiles(SRC);
    const present = new Set(files.map(f => path.relative(SRC, f)));

    for (const entry of [...OWNER_ALLOWLIST.keys(), ...APP_DB_ALLOWLIST.keys()])
      expect(present, `${entry} is allowlisted but does not exist`).toContain(entry);
  });

  it("detects a violation when one is introduced", async () => {
    // Guards the guard. A regex that silently stopped matching would make
    // every assertion above pass while enforcing nothing.
    expect(dbImportsIn(`import db from "@/db";`)).toContain("default");
    expect(dbImportsIn(`import db, { pool } from "@/db";`)).toContain("pool");
    expect(dbImportsIn(`import { appDb } from "@/db";`)).toContain("appDb");
    expect(dbImportsIn(`import { appPool } from "../db";`)).toContain("appPool");
    expect(dbImportsIn(`import { schools } from "@/db/schema";`)).toEqual([]);
  });
});
