import { eq } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import db from "@/db";
import { students } from "@/db/schema";
import { isCheckViolation, pgConstraintName } from "@/lib/db-errors";
import { makeSchool, makeStudent, resetDb } from "@/test/helpers";

/**
 * Every `.$type<"a" | "b">()` column has a CHECK saying the same thing.
 *
 * `.$type<>()` constrains this codebase and nothing else — the column is
 * `text`, and Postgres will take any string a seed, a backfill or a hand-run
 * correction hands it. The failure that follows is quiet: an unrecognised
 * value is not a crash, it is a row that stops matching filters. A pupil whose
 * status is neither `active` nor `withdrawn` is absent from the register and
 * absent from the leavers' list, and nothing reports it.
 *
 * Static, like `db-access.test.ts`, and for the same reason: the drift this
 * guards against arrives with a column added months from now, in a table no
 * test in this file knows about. Reading the schema catches it whether or not
 * anything exercises the column.
 */

const SCHEMA = path.resolve(import.meta.dirname, "schema.ts");

interface Column {
  table: string;
  property: string;
  /** The members of the TypeScript union, in source order. */
  union: string[];
}

/** A `text().$type<SomeAlias>()` this guard cannot read the members of. */
interface Unreadable {
  table: string;
  property: string;
}

interface Constraint {
  table: string;
  property: string;
  name: string;
  values: string[];
}

/**
 * The string literal members of `"a" | "b"`.
 *
 * `null` means "not a union of string literals" — a shape this guard has no
 * opinion about. `undefined` means "names a type this guard cannot read", which
 * is a different answer and a much more dangerous one: `$type<AuditAction>()`
 * on a text column is almost certainly an aliased union, and resolving it would
 * need a full type checker rather than one file's syntax tree. Reported rather
 * than skipped, because silently skipping is how a column with no CHECK gets
 * past a test written to find exactly that.
 */
function unionMembers(node: ts.TypeNode): string[] | null | undefined {
  if (ts.isTypeReferenceNode(node))
    return undefined;

  const parts = ts.isUnionTypeNode(node) ? node.types : [node];
  const members: string[] = [];

  for (const part of parts) {
    if (!ts.isLiteralTypeNode(part) || !ts.isStringLiteral(part.literal))
      return null;
    members.push(part.literal.text);
  }

  return members;
}

/** `text().$type<...>()` — and specifically not `jsonb()` or a `pgEnum`. */
function textTypeArgument(node: ts.Expression): ts.TypeNode | null {
  if (!ts.isCallExpression(node) || node.typeArguments?.length !== 1)
    return null;
  if (!ts.isPropertyAccessExpression(node.expression))
    return null;
  if (node.expression.name.text !== "$type")
    return null;

  const base = node.expression.expression;
  if (!ts.isCallExpression(base) || !ts.isIdentifier(base.expression))
    return null;
  if (base.expression.text !== "text")
    return null;

  return node.typeArguments[0];
}

/** Unwraps `.notNull().default(...)` back to the `$type` call underneath. */
function chainRoot(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    ts.isCallExpression(current)
    && ts.isPropertyAccessExpression(current.expression)
    && current.expression.name.text !== "$type"
  ) {
    current = current.expression.expression;
  }
  return current;
}

function parseSchema(source: string) {
  const file = ts.createSourceFile(SCHEMA, source, ts.ScriptTarget.Latest, true);
  const columns: Column[] = [];
  const unreadable: Unreadable[] = [];
  const constraints: Constraint[] = [];

  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === "pgTable"
      && node.arguments.length >= 2
      && ts.isStringLiteral(node.arguments[0])
    ) {
      const table = node.arguments[0].text;

      // Columns: the object literal.
      const shape = node.arguments[1];
      if (ts.isObjectLiteralExpression(shape)) {
        for (const member of shape.properties) {
          if (!ts.isPropertyAssignment(member) || !ts.isIdentifier(member.name))
            continue;

          const typeArg = textTypeArgument(chainRoot(member.initializer));
          if (!typeArg)
            continue;

          const union = unionMembers(typeArg);
          if (union === undefined)
            unreadable.push({ table, property: member.name.text });
          else if (union)
            columns.push({ table, property: member.name.text, union });
        }
      }

      // Constraints: `oneOf(...)` anywhere in the extras callback.
      const extras = node.arguments[2];
      if (extras) {
        const collect = (inner: ts.Node) => {
          if (
            ts.isCallExpression(inner)
            && ts.isIdentifier(inner.expression)
            && inner.expression.text === "oneOf"
            && inner.arguments.length === 3
            && ts.isStringLiteral(inner.arguments[0])
            && ts.isPropertyAccessExpression(inner.arguments[1])
            && ts.isArrayLiteralExpression(inner.arguments[2])
          ) {
            constraints.push({
              table,
              property: inner.arguments[1].name.text,
              name: inner.arguments[0].text,
              values: inner.arguments[2].elements.map(e =>
                ts.isStringLiteral(e) ? e.text : "<not a literal>",
              ),
            });
          }
          ts.forEachChild(inner, collect);
        };
        collect(extras);
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(file);
  return { columns, unreadable, constraints };
}

describe("union-typed columns", () => {
  it("finds the columns it is supposed to be checking", async () => {
    const { columns } = parseSchema(await readFile(SCHEMA, "utf8"));

    /*
     * A parser that quietly matched nothing would make every assertion below
     * vacuous while staying green — the way this test fails uselessly.
     *
     * `performance_level` is deliberately not among these: it is a real
     * `pgEnum`, so the database already knows its values.
     */
    expect(columns.length).toBeGreaterThanOrEqual(12);
    expect(columns).toContainEqual({
      table: "students",
      property: "status",
      union: ["active", "transferred_out", "graduated", "withdrawn", "deceased"],
    });
  });

  it("can read every union it is asked to check", async () => {
    const { unreadable } = parseSchema(await readFile(SCHEMA, "utf8"));

    /*
     * A named type on a text column escapes this guard entirely.
     *
     * Reading `$type<AuditAction>()` would need a type checker, not one file's
     * syntax tree — so the union goes inline in the column and the alias, where
     * one is wanted, is DERIVED from it (`typeof table.$inferInsert`). That way
     * the type and the CHECK cannot drift apart without this test noticing.
     */
    expect(
      unreadable.map(u => `${u.table}.${u.property}`),
      "write the union inline; derive any alias from the column, not the reverse",
    ).toEqual([]);
  });

  it("has a CHECK for each one, listing exactly the same values", async () => {
    const { columns, constraints } = parseSchema(await readFile(SCHEMA, "utf8"));

    for (const column of columns) {
      const found = constraints.find(
        con => con.table === column.table && con.property === column.property,
      );

      /*
       * Naming the column in the failure, because the fix is not obvious from
       * a bare `undefined`: add `oneOf("<table>_<column>_known", t.<column>,
       * [...])` to the table's extras, and generate a migration for it.
       */
      expect(
        found,
        `${column.table}.${column.property} has a TypeScript union and no CHECK`,
      ).toBeDefined();

      // Order included: a mismatch here is the two lists having drifted, and
      // sorting first would hide a value that moved rather than changed.
      expect(
        found!.values,
        `${found!.name} does not list the same values as the type`,
      ).toEqual(column.union);
    }
  });

  it("refuses a status no part of this codebase would recognise", async () => {
    await resetDb();
    const school = await makeSchool({ subdomain: "alpha" });
    const student = await makeStudent(school, "2026/001");

    /*
     * On the OWNER connection, which is exempt from RLS and holds every
     * privilege — the nearest thing available to the hand-run correction this
     * is here to survive. No route can do it: `students.status` is a Zod enum
     * at the edge.
     *
     * `withdrawn_2024` is the shape a real one takes. Nothing would have
     * thrown; the pupil would simply have stopped being active without
     * becoming a leaver, and the fee run would still have counted them.
     */
    const err = await db.update(students)
      // `exited_on` too, and deliberately: `students_exit_matches_status`
      // requires a non-active pupil to have left, and it fires first. Leaving
      // it out tested that older constraint instead of this one.
      .set({ status: "withdrawn_2024" as never, exitedOn: "2030-01-01" })
      .where(eq(students.id, student.id))
      .then(() => null, (e: unknown) => e);

    expect(isCheckViolation(err)).toBe(true);
    expect(pgConstraintName(err)).toBe("students_status_known");
  });

  it("has applied every one of them to the database", async () => {
    const { constraints } = parseSchema(await readFile(SCHEMA, "utf8"));

    const { rows } = await db.$client.query<{ conname: string; convalidated: boolean }>(
      `SELECT conname, convalidated FROM pg_constraint WHERE contype = 'c'`,
    );
    const applied = new Map(rows.map(r => [r.conname, r.convalidated]));

    for (const constraint of constraints) {
      // The schema file and the migrations are separate artefacts; declaring a
      // constraint and forgetting to generate one is a silent no-op otherwise.
      expect(
        applied.has(constraint.name),
        `${constraint.name} is declared in schema.ts but not in any migration`,
      ).toBe(true);

      // NOT VALID would accept the existing rows unchecked, which is exactly
      // the state this is meant to rule out.
      expect(applied.get(constraint.name), `${constraint.name} is NOT VALID`).toBe(true);
    }
  });
});
