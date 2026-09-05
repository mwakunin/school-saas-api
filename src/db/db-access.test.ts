import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
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
  [
    "routes/verify/verify.handlers.ts",
    "a document verifier carries no session and no subdomain; the code in the "
    + "path is the whole lookup, and it can only ever return the one document "
    + "the caller already holds",
  ],
  [
    "routes/webhooks/webhooks.handlers.ts",
    "Safaricom callbacks carry no session and no subdomain; the token in the "
    + "path is what establishes the tenant, and reading it is the bootstrap",
  ],
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
 * The connection module, however it is spelled.
 *
 * Anchored, unlike the pattern this replaced: `@/db/schema` and `@/lib/db-errors`
 * are different modules and must not match.
 */
const DB_MODULE = /^(?:@\/db|\.\.?\/(?:\.\.\/)*db)(?:\/index)?$/;

/**
 * Every export a namespace-style import reaches.
 *
 * `import * as m` and `await import(...)` both hand back the whole module, so
 * `m.default` and `m.pool` are equally available. Reported under all four
 * names rather than a new one, so both allowlists judge them exactly as they
 * judge a direct import — and a file doing it has to justify itself on both.
 */
const ALL_CONNECTIONS = ["default", "pool", "appDb", "appPool"] as const;

/** The named exports that ARE a connection. `AppDb` is a type and reaches none. */
const CONNECTION_EXPORTS = new Set(["pool", "appDb", "appPool"]);

/**
 * Connections a file reaches through `@/db`, classified from the syntax tree.
 *
 * This was a regular expression for four rounds, and was wrong in a new way
 * each time — `@/db/index`, `{ default as ownerDb }`, `import{pool}from`, then
 * dynamic imports. Each fix was correct and each time another form existed,
 * because "which module does this file import, and what does it take from it"
 * is a question about syntax, and a character stream does not have the answer.
 * The parser does.
 *
 * What the change buys beyond the forms already found:
 *
 *   - a comment or a string that merely mentions an import is not an import,
 *     so the guard stops reporting files that import nothing
 *   - `import type { AppDb }` is erased at compile time and reaches no
 *     connection, which the regex only got right by accident
 *   - a template-literal specifier resolves like any other literal
 *   - a specifier that is not literal at all cannot be resolved, so it FAILS
 *     CLOSED — reported as reaching everything rather than waved through
 *
 * TypeScript is already a devDependency, so this costs nothing to run.
 */
function dbImportsIn(source: string, fileName = "probe.ts"): string[] {
  const names: string[] = [];
  const tree = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    // Parent pointers are not needed, and setting them costs memory per file.
    false,
  );

  /** A specifier we can read, or null when it is computed at runtime. */
  function literalSpecifier(node: ts.Expression): string | null {
    // Covers both quote styles and a backtick with no substitutions —
    // `import(\`@/db\`)` is as knowable as `import("@/db")`.
    return ts.isStringLiteralLike(node) ? node.text : null;
  }

  function visit(node: ts.Node): void {
    // `import ... from "@/db"`
    if (ts.isImportDeclaration(node)) {
      const specifier = literalSpecifier(node.moduleSpecifier);

      if (specifier && DB_MODULE.test(specifier))
        names.push(...staticImportNames(node.importClause));
    }

    /*
     * `export { pool } from "@/db"` — a re-export.
     *
     * The file does not use the connection, but it hands it to anything that
     * imports the file, which launders exactly the access the allowlist
     * exists to account for.
     */
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && !node.isTypeOnly) {
      const specifier = literalSpecifier(node.moduleSpecifier);

      if (specifier && DB_MODULE.test(specifier)) {
        if (!node.exportClause || ts.isNamespaceExport(node.exportClause)) {
          // `export * from` / `export * as m from` — everything.
          names.push(...ALL_CONNECTIONS);
        }
        else {
          for (const element of node.exportClause.elements) {
            if (element.isTypeOnly)
              continue;
            const imported = (element.propertyName ?? element.name).text;
            if (imported === "default")
              names.push("default");
            else if (CONNECTION_EXPORTS.has(imported))
              names.push(imported);
          }
        }
      }
    }

    // `await import("@/db")`
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [argument] = node.arguments;

      if (argument) {
        const specifier = literalSpecifier(argument);

        if (specifier === null) {
          /*
           * A specifier assembled at runtime — `import(path)`, or a template
           * with a substitution. What it resolves to cannot be known here, so
           * it is treated as reaching everything.
           *
           * Failing closed is the whole point of a guard: a false positive
           * costs an allowlist entry and an explanation, while a false
           * negative hands a route the RLS-exempt connection silently.
           */
          names.push(...ALL_CONNECTIONS);
        }
        else if (DB_MODULE.test(specifier)) {
          // A dynamic import yields the whole module namespace, so it takes
          // everything regardless of what the caller destructures off it.
          names.push(...ALL_CONNECTIONS);
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(tree);

  return names;
}

/** What an import clause actually binds at runtime. */
function staticImportNames(clause: ts.ImportClause | undefined): string[] {
  /*
   * `import "@/db"` with no clause binds nothing. It still runs the module —
   * which builds the pools — but gives the importing file no way to reach a
   * connection, so it is not what this guard is about.
   */
  if (!clause)
    return [];

  /*
   * `import type { AppDb } from "@/db"` is erased before anything runs.
   *
   * This matters in practice rather than in principle: several handlers take
   * the `AppDb` type from this module and are deliberately NOT allowlisted.
   * Treating a type import as access would flag every one of them, and the
   * fix people would reach for is adding them to the allowlist — which is how
   * an allowlist stops meaning anything.
   */
  if (clause.isTypeOnly)
    return [];

  const names: string[] = [];

  // `import db from "@/db"` — the default export is the owner connection.
  if (clause.name)
    names.push("default");

  if (clause.namedBindings) {
    if (ts.isNamespaceImport(clause.namedBindings)) {
      // `import * as dbMod` reaches every export through the object.
      names.push(...ALL_CONNECTIONS);
    }
    else {
      for (const element of clause.namedBindings.elements) {
        if (element.isTypeOnly)
          continue;

        // `{ default as ownerDb }` — propertyName is what was imported,
        // name is what it was called locally.
        const imported = (element.propertyName ?? element.name).text;

        if (imported === "default")
          names.push("default");
        else if (CONNECTION_EXPORTS.has(imported))
          names.push(imported);
      }
    }
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

  it("detects a violation when one is introduced", () => {
    // Guards the guard. A classifier that silently stopped matching would make
    // every assertion above pass while enforcing nothing.
    expect(dbImportsIn(`import db from "@/db";`)).toContain("default");
    expect(dbImportsIn(`import db, { pool } from "@/db";`)).toContain("pool");
    expect(dbImportsIn(`import { appDb } from "@/db";`)).toContain("appDb");
    expect(dbImportsIn(`import { appPool } from "../db";`)).toContain("appPool");
    expect(dbImportsIn(`import { schools } from "@/db/schema";`)).toEqual([]);
  });

  it.each([
    ["explicit /index", `import db from "@/db/index";`],
    ["named default rename", `import { default as ownerDb } from "@/db";`],
    ["named default rename via /index", `import { default as x } from "@/db/index";`],
    ["relative /index", `import db from "../db/index";`],
    ["no whitespace", `import{default as d}from"@/db";`],
  ])("sees through %s", (_case, source) => {
    expect(dbImportsIn(source)).toContain("default");
  });

  it("treats a namespace import as taking everything", () => {
    const names = dbImportsIn(`import * as dbMod from "@/db";`);
    expect(names).toContain("default");
    expect(names).toContain("pool");
    expect(names).toContain("appDb");
  });

  it.each([
    ["awaited default", `const { default: db } = await import("@/db");`],
    ["awaited named", `const { pool } = await import("@/db");`],
    ["via /index", `const m = await import("@/db/index");`],
    ["relative", `const m = await import("../db");`],
    ["no await", `const p = import("@/db");`],
    ["single quotes", `await import('@/db')`],
  ])("sees a dynamic import: %s", (_case, source) => {
    const names = dbImportsIn(source);
    expect(names).toContain("default");
    expect(names).toContain("pool");
  });

  it("resolves a template-literal specifier", () => {
    // A backtick with no substitution is as knowable as a quote. The regex
    // only looked for quotes, so this was a way through.
    expect(dbImportsIn("const m = await import(`@/db`);")).toContain("default");
    expect(dbImportsIn("import db from `@/db`;")).not.toEqual([]);
  });

  it.each([
    ["an identifier", `const p = "@/db"; await import(p);`],
    // Written as an escaped template so the `${` is data, not a substitution
    // in this file.
    ["a template with a substitution", `await import(\`@/\${name}\`);`],
    ["a ternary", `await import(cond ? "@/db" : "@/db/schema");`],
    ["a concatenation", `await import("@/" + "db");`],
  ])("fails closed on a specifier computed at runtime: %s", (_case, source) => {
    /*
     * What it resolves to cannot be known from the syntax, so it is treated as
     * reaching everything. A false positive costs an allowlist entry and an
     * explanation; a false negative hands a route the RLS-exempt connection
     * silently.
     */
    const names = dbImportsIn(source);
    expect(names).toContain("default");
    expect(names).toContain("pool");
  });

  it("does not treat a comment or a string as an import", () => {
    /*
     * The regex reported these, so a file whose only mention of the connection
     * was a comment explaining why it must NOT be used got flagged — and the
     * obvious way to quieten it is an allowlist entry, which is how an
     * allowlist stops meaning anything.
     */
    expect(dbImportsIn(`// import db from "@/db"\nconst x = 1;`)).toEqual([]);
    expect(dbImportsIn(`/* import { pool } from "@/db" */`)).toEqual([]);
    expect(dbImportsIn(`const doc = 'import db from "@/db"';`)).toEqual([]);
  });

  it("ignores a type-only import, which reaches nothing at runtime", () => {
    // Several handlers take the AppDb TYPE from this module and are
    // deliberately not allowlisted; treating that as access would flag every
    // one of them.
    expect(dbImportsIn(`import type { AppDb } from "@/db";`)).toEqual([]);
    expect(dbImportsIn(`import { type AppDb } from "@/db";`)).toEqual([]);
    expect(dbImportsIn(`import { type AppDb, pool } from "@/db";`)).toEqual(["pool"]);
  });

  it("catches a re-export, which launders the connection onward", () => {
    expect(dbImportsIn(`export { pool } from "@/db";`)).toContain("pool");
    expect(dbImportsIn(`export { default } from "@/db";`)).toContain("default");
    expect(dbImportsIn(`export * from "@/db";`)).toContain("default");
    expect(dbImportsIn(`export type { AppDb } from "@/db";`)).toEqual([]);
  });

  it("ignores a bare side-effect import, which binds nothing", () => {
    // It runs the module, but gives the importing file no way to reach a
    // connection — which is not what this guard is about.
    expect(dbImportsIn(`import "@/db";`)).toEqual([]);
  });

  it("still ignores sibling modules that merely start with db", () => {
    expect(dbImportsIn(`import { schools } from "@/db/schema";`)).toEqual([]);
    expect(dbImportsIn(`import { pgErrorCode } from "@/lib/db-errors";`)).toEqual([]);
    expect(dbImportsIn(`await import("@/db/schema");`)).toEqual([]);
    expect(dbImportsIn(`import { x } from "@/database";`)).toEqual([]);
  });

  it.each([
    ["awaited default", `const { default: db } = await import("@/db");`],
    ["awaited named", `const { pool } = await import("@/db");`],
    ["via /index", `const m = await import("@/db/index");`],
    ["relative", `const m = await import("../db");`],
    ["relative /index", `const m = await import("../../db/index");`],
    ["no await", `const p = import("@/db");`],
    ["single quotes and spacing", `await import( '@/db' )`],
  ])("sees a dynamic import: %s", (_case, source) => {
    // A dynamic import hands back the whole module, so it counts as taking
    // every connection — whatever the caller destructures off it.
    const names = dbImportsIn(source);
    expect(names).toContain("default");
    expect(names).toContain("pool");
    expect(names).toContain("appDb");
  });

  it("ignores a dynamic import of a different module", () => {
    expect(dbImportsIn(`await import("@/db/schema");`)).toEqual([]);
    expect(dbImportsIn(`await import("@/lib/db-errors");`)).toEqual([]);
    expect(dbImportsIn(`await import("node:fs/promises");`)).toEqual([]);
  });

  it("does not mistake a call on an identifier ending in `import`", () => {
    expect(dbImportsIn(`reimport("@/db");`)).toEqual([]);
    expect(dbImportsIn(`const imported = ["@/db"];`)).toEqual([]);
  });
});
