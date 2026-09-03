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

/**
 * Import specifiers pulled from `@/db` or a relative path to it.
 *
 * The module specifier accepts an optional `/index`, and the clause is matched
 * for a bare default, a `{ default as x }` rename, and the named connections.
 * All three of the latter used to slip past: `@/db/index` did not match the
 * specifier at all, and `{ default as ownerDb }` matched neither the
 * bare-default pattern (it starts with `{`) nor the named list. Any of them
 * would have handed a route the RLS-exempt connection with the guard green.
 */
function dbImportsIn(source: string): string[] {
  const names: string[] = [];
  /*
   * `import` may be followed by no whitespace at all — `import{pool}from"@/db"`
   * is valid JavaScript, and requiring a space missed it. The lookahead is what
   * keeps that from also matching the word `imported`: only whitespace, a
   * brace, a star or a quote can follow the keyword in a real import.
   *
   * The clause is `[^;"']+?` with no `\s*` in front. Both would match
   * whitespace, and a quantifier that can consume the same characters two ways
   * backtracks polynomially on a hostile input. `+?` rather than `*?` because
   * the lookahead already guarantees a character follows the keyword.
   *
   * `\bfrom` keeps an identifier like `fromCache` from ending the clause early;
   * no closing `\b` is needed, since the `["']` that must follow provides it.
   */
  const pattern
    = /\bimport(?=[\s{*"'])([^;"']+?)\bfrom\s*["'](?:@\/db|\.\.?\/(?:\.\.\/)*db)(?:\/index)?["']/g;

  for (const match of source.matchAll(pattern)) {
    const clause = match[1];

    // `import db from "@/db"` — the default export is the owner connection.
    if (/^\s*\w+\s*(?:,|$)/.test(clause))
      names.push("default");

    // `import { default as ownerDb } from "@/db"` — the same thing, renamed.
    if (/\bdefault\s+as\s+\w+/.test(clause))
      names.push("default");

    /*
     * `import * as dbMod from "@/db"` reaches everything the module exports —
     * `dbMod.default` and `dbMod.pool` included — so a namespace import is
     * treated as taking all of them. Reported under every name rather than a
     * new one, so both allowlists judge it the way they judge a direct import.
     */
    if (/^\s*\*\s*as\s+\w+/.test(clause))
      names.push("default", "pool", "appDb", "appPool");

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

  it.each([
    // Both of these reach the same module and used to match nothing.
    ["explicit /index", `import db from "@/db/index";`],
    ["named default rename", `import { default as ownerDb } from "@/db";`],
    ["named default rename via /index", `import { default as x } from "@/db/index";`],
    ["relative /index", `import db from "../db/index";`],
  ])("sees through %s", (_case, source) => {
    expect(dbImportsIn(source)).toContain("default");
  });

  it("sees a named connection reached through /index", () => {
    expect(dbImportsIn(`import { pool } from "@/db/index";`)).toContain("pool");
    expect(dbImportsIn(`import { appDb } from "@/db/index";`)).toContain("appDb");
  });

  it("still ignores sibling modules that merely start with db", () => {
    // `@/db/schema` and `@/db-errors` are not the connection module.
    expect(dbImportsIn(`import { schools } from "@/db/schema";`)).toEqual([]);
    expect(dbImportsIn(`import { pgErrorCode } from "@/lib/db-errors";`)).toEqual([]);
  });

  it("matches an import written without whitespace", () => {
    // Valid JavaScript, and what a minifier or a deliberate bypass produces.
    expect(dbImportsIn(`import{pool}from"@/db";`)).toContain("pool");
    expect(dbImportsIn(`import{appDb}from'@/db/index';`)).toContain("appDb");
    expect(dbImportsIn(`import{default as x}from"@/db";`)).toContain("default");
  });

  it("treats a namespace import as taking everything", () => {
    // `dbMod.default` and `dbMod.pool` are both reachable through it.
    const names = dbImportsIn(`import * as dbMod from "@/db";`);
    expect(names).toContain("default");
    expect(names).toContain("pool");
    expect(names).toContain("appDb");
  });

  it("does not mistake an identifier ending in `import` for one", () => {
    // The lookahead exists for this: allowing zero whitespace after the
    // keyword must not start matching the middle of a longer word.
    expect(dbImportsIn(`const imported = collectFrom("@/db");`)).toEqual([]);
    expect(dbImportsIn(`reimported from "@/db"`)).toEqual([]);
  });

  it("is not confused by an identifier containing `from` in the clause", () => {
    expect(dbImportsIn(`import { fromCache, pool } from "@/db";`)).toContain("pool");
  });
});
