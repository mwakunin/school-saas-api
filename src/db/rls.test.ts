import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import db, { appDb, appPool, pool } from "@/db";
import { TENANT_TABLES } from "@/db/schema";
import { pgErrorCode } from "@/lib/db-errors";
import { makeSchool, resetDb } from "@/test/helpers";

/**
 * Postgres reports an RLS refusal as insufficient_privilege.
 *
 * Asserted by SQLSTATE rather than by message: drizzle wraps driver errors and
 * puts its own "Failed query: ..." text on top, so matching the message would
 * pass only by accident and break on any drizzle change. The code is the
 * stable contract — which is what lib/db-errors.ts exists to reach.
 */
const INSUFFICIENT_PRIVILEGE = "42501";

async function errorFrom(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  }
  catch (err) {
    return err;
  }
  throw new Error("Expected the write to be refused, but it succeeded");
}

/**
 * Row-level security, asserted against the database rather than the app.
 *
 * Everything else in the suite reaches Postgres through handlers that set the
 * tenant correctly. These tests do the opposite: they connect as the runtime
 * role, deliberately fail to set `app.school_id`, or try to write across a
 * boundary, and require Postgres itself to refuse.
 *
 * That distinction is the whole reason RLS is here. A test that only exercises
 * the middleware proves the middleware works today; these prove that code
 * which forgets the middleware entirely still cannot read another school's
 * rows — which is the failure this design exists to survive.
 */
describe("row-level security", () => {
  beforeEach(async () => {
    await resetDb();
  });

  describe("the configuration that makes it real", () => {
    it("connects as a role that is neither superuser nor BYPASSRLS", async () => {
      const { rows } = await appPool.query<{
        usename: string;
        usesuper: boolean;
        usebypassrls: boolean;
      }>(`SELECT usename, usesuper, usebypassrls FROM pg_user
          WHERE usename = current_user`);

      // A superuser ignores policies outright, and FORCE does not change that.
      // If this ever passes as `school`, every other test in this file becomes
      // vacuous while still going green.
      expect(rows[0].usesuper).toBe(false);
      expect(rows[0].usebypassrls).toBe(false);
    });

    it("is not the same role that owns the tables", async () => {
      const owner = await pool.query<{ current_user: string }>(
        "SELECT current_user",
      );
      const app = await appPool.query<{ current_user: string }>(
        "SELECT current_user",
      );

      expect(app.rows[0].current_user).not.toBe(owner.rows[0].current_user);
    });

    it("has RLS enabled AND forced on every tenant table", async () => {
      const { rows } = await pool.query<{
        relname: string;
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
      }>(`SELECT relname, relrowsecurity, relforcerowsecurity
          FROM pg_class
          WHERE relname = ANY($1) AND relkind = 'r'`, [
        ["schools", ...TENANT_TABLES],
      ]);

      expect(rows).toHaveLength(TENANT_TABLES.length + 1);

      for (const row of rows) {
        expect(row.relrowsecurity, `${row.relname} has RLS enabled`).toBe(true);
        // Without FORCE, the owner is exempt — so a migration that runs as the
        // owner, or any future code that reuses that connection, sees
        // everything.
        expect(row.relforcerowsecurity, `${row.relname} FORCEs RLS`).toBe(true);
      }
    });

    it("leaves no table carrying school_id unprotected", async () => {
      // Catches the realistic omission: someone adds a table in a later step,
      // gives it the school_id the conventions require, and forgets the
      // policy. Nothing else in the suite would notice.
      const { rows } = await pool.query<{ table_name: string }>(`
        SELECT c.relname AS table_name
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_attribute a ON a.attrelid = c.oid
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
          AND a.attname = 'school_id'
          AND NOT a.attisdropped
          AND NOT EXISTS (
            SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid
          )
      `);

      expect(rows.map(r => r.table_name)).toEqual([]);
    });

    it("denies DELETE to the runtime role, so nothing can hard-delete", async () => {
      // CLAUDE.md §3 rule 5. Enforced as a privilege rather than a convention:
      // withdrawn students, voided invoices and reversed payments must stay
      // queryable, and a stray DELETE in a handler should fail in test.
      const { rows } = await appPool.query<{ has: boolean }>(
        `SELECT has_table_privilege(current_user, 'schools', 'DELETE') AS has`,
      );

      expect(rows[0].has).toBe(false);
    });
  });

  describe("reads", () => {
    it("returns nothing at all when no tenant is set", async () => {
      await makeSchool({ subdomain: "alpha" });
      await makeSchool({ subdomain: "beta" });

      // The proof that the database is doing the work: this connection has
      // every privilege it needs and issues a query with no WHERE clause, and
      // still sees zero rows. Under a scoped-client-only design this same
      // query would return both schools.
      const seen = await appDb.execute(sql`SELECT id FROM schools`);

      expect(seen.rows).toEqual([]);
    });

    it("shows one school only its own row", async () => {
      const alpha = await makeSchool({ subdomain: "alpha" });
      await makeSchool({ subdomain: "beta" });

      const rows = await appDb.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.school_id', ${alpha.id}, true)`);
        const r = await tx.execute<{ subdomain: string }>(
          sql`SELECT subdomain FROM schools`,
        );
        return r.rows;
      });

      expect(rows).toEqual([{ subdomain: "alpha" }]);
    });

    it("hides another school's academic spine", async () => {
      const alpha = await makeSchool({ subdomain: "alpha" });
      const beta = await makeSchool({ subdomain: "beta" });

      const counts = await appDb.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.school_id', ${alpha.id}, true)`);

        // Asking for beta's rows *by primary key*, which is the strongest
        // form of the question: not "does a scan leak them" but "can they be
        // fetched at all by someone who already knows the id".
        const year = await tx.execute(
          sql`SELECT id FROM academic_years WHERE id = ${beta.academicYear.id}`,
        );
        const term = await tx.execute(
          sql`SELECT id FROM terms WHERE id = ${beta.terms[0].id}`,
        );
        const grade = await tx.execute(
          sql`SELECT id FROM grade_levels WHERE id = ${beta.gradeLevels[0].id}`,
        );

        return {
          years: year.rows.length,
          terms: term.rows.length,
          grades: grade.rows.length,
        };
      });

      expect(counts).toEqual({ years: 0, terms: 0, grades: 0 });
    });

    it("treats an empty tenant setting as no tenant, not as an error", async () => {
      await makeSchool({ subdomain: "alpha" });

      // `''::uuid` raises; the policy's NULLIF is what turns this into "no
      // rows" instead of a 500 that a caller could use to probe.
      const rows = await appDb.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.school_id', '', true)`);
        const r = await tx.execute(sql`SELECT id FROM schools`);
        return r.rows;
      });

      expect(rows).toEqual([]);
    });
  });

  describe("writes", () => {
    it("refuses an insert attributed to another school", async () => {
      const alpha = await makeSchool({ subdomain: "alpha" });
      const beta = await makeSchool({ subdomain: "beta" });

      // The more damaging direction, and the one a USING-only policy would
      // allow: writing INTO another tenant rather than reading from it.
      const err = await errorFrom(() => appDb.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.school_id', ${alpha.id}, true)`);
        await tx.execute(sql`
          INSERT INTO academic_years (school_id, year) VALUES (${beta.id}, 2030)
        `);
      }));

      expect(pgErrorCode(err)).toBe(INSUFFICIENT_PRIVILEGE);

      // And nothing was written, which is the claim that actually matters.
      const { rows } = await pool.query(
        "SELECT 1 FROM academic_years WHERE year = 2030",
      );
      expect(rows).toEqual([]);
    });

    it("refuses an insert when no tenant is set", async () => {
      const alpha = await makeSchool({ subdomain: "alpha" });

      const err = await errorFrom(() => appDb.execute(sql`
        INSERT INTO academic_years (school_id, year) VALUES (${alpha.id}, 2031)
      `));

      expect(pgErrorCode(err)).toBe(INSUFFICIENT_PRIVILEGE);

      const { rows } = await pool.query(
        "SELECT 1 FROM academic_years WHERE year = 2031",
      );
      expect(rows).toEqual([]);
    });

    it("cannot update another school's row into itself", async () => {
      const alpha = await makeSchool({ subdomain: "alpha" });
      const beta = await makeSchool({ subdomain: "beta" });

      const updated = await appDb.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.school_id', ${alpha.id}, true)`);
        const r = await tx.execute(sql`
          UPDATE academic_years SET year = 1999 WHERE school_id = ${beta.id}
        `);
        return r.rowCount;
      });

      // Not an error — the row is simply invisible, so the UPDATE matches
      // nothing. Confirm beta's data is untouched rather than trusting that.
      expect(updated).toBe(0);

      const [betaYear] = await db.execute<{ year: number }>(
        sql`SELECT year FROM academic_years WHERE school_id = ${beta.id}`,
      ).then(r => r.rows);

      expect(betaYear.year).toBe(2026);
    });
  });

  describe("references across tenants", () => {
    /*
     * The gap policies alone do not close.
     *
     * Postgres validates a foreign key internally, as the table owner, and RLS
     * does not apply to that check. So a row whose own `school_id` is correct —
     * and which therefore satisfies every WITH CHECK — can still point at
     * another tenant's parent row. An earlier version of this schema allowed
     * exactly that: a stream at one school referencing another school's grade
     * level, accepted by every policy in place.
     *
     * The composite `(school_id, id)` foreign keys are what make it fail. These
     * tests exist because the failure is invisible from the application side:
     * the insert simply succeeds, and the corruption surfaces later as a class
     * list containing a grade nobody at the school recognises.
     */
    it("refuses a stream pointing at another school's grade level", async () => {
      const alpha = await makeSchool({ subdomain: "alpha" });
      const beta = await makeSchool({ subdomain: "beta" });

      const err = await errorFrom(() => appDb.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.school_id', ${alpha.id}, true)`);
        await tx.execute(sql`
          INSERT INTO streams (school_id, grade_level_id, academic_year_id, name)
          VALUES (${alpha.id}, ${beta.gradeLevels[0].id}, ${alpha.academicYear.id}, 'Blue')
        `);
      }));

      // A foreign key violation, not a policy one — which is the point: the
      // constraint catches it before any policy is consulted.
      expect(pgErrorCode(err)).toBe("23503");
    });

    it("refuses a stream pointing at another school's academic year", async () => {
      const alpha = await makeSchool({ subdomain: "alpha" });
      const beta = await makeSchool({ subdomain: "beta" });

      const err = await errorFrom(() => appDb.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.school_id', ${alpha.id}, true)`);
        await tx.execute(sql`
          INSERT INTO streams (school_id, grade_level_id, academic_year_id, name)
          VALUES (${alpha.id}, ${alpha.gradeLevels[0].id}, ${beta.academicYear.id}, 'Blue')
        `);
      }));

      expect(pgErrorCode(err)).toBe("23503");
    });

    it("still allows a stream built entirely from its own school", async () => {
      const alpha = await makeSchool({ subdomain: "alpha" });

      // The constraints must not be so tight that the legitimate case fails.
      const created = await appDb.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.school_id', ${alpha.id}, true)`);
        const r = await tx.execute(sql`
          INSERT INTO streams (school_id, grade_level_id, academic_year_id, name)
          VALUES (${alpha.id}, ${alpha.gradeLevels[3].id}, ${alpha.academicYear.id}, 'Blue')
          RETURNING name
        `);
        return r.rows;
      });

      expect(created).toEqual([{ name: "Blue" }]);
    });

    it("refuses a term belonging to another school's academic year", async () => {
      const alpha = await makeSchool({ subdomain: "alpha" });
      const beta = await makeSchool({ subdomain: "beta" });

      // An empty year at beta. Reusing beta's seeded year would trip the
      // unique on (academic_year_id, number) first, and the test would pass on
      // the wrong constraint — proving nothing about cross-tenant references.
      const [betaSpare] = await db.execute<{ id: string }>(sql`
        INSERT INTO academic_years (school_id, year) VALUES (${beta.id}, 2029)
        RETURNING id
      `).then(r => r.rows);

      const err = await errorFrom(() => appDb.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.school_id', ${alpha.id}, true)`);
        await tx.execute(sql`
          INSERT INTO terms (school_id, academic_year_id, number, starts_on, ends_on)
          VALUES (${alpha.id}, ${betaSpare.id}, 1, '2029-01-06', '2029-04-10')
        `);
      }));

      expect(pgErrorCode(err)).toBe("23503");
    });

    it("leaves no tenant table referencing a parent without carrying school_id", async () => {
      /*
       * The guard against the next occurrence.
       *
       * Any foreign key FROM a tenant table INTO another tenant table must
       * include school_id, or it reopens the hole above. This finds the ones
       * that do not, so adding a table in a later step cannot quietly
       * reintroduce it.
       */
      const { rows } = await pool.query<{ child: string; constraint_name: string }>(`
        SELECT c.conrelid::regclass::text AS child,
               c.conname AS constraint_name
        FROM pg_constraint c
        WHERE c.contype = 'f'
          AND c.conrelid::regclass::text = ANY($1)
          AND c.confrelid::regclass::text = ANY($1)
          AND NOT EXISTS (
            SELECT 1
            FROM unnest(c.conkey) AS k(attnum)
            JOIN pg_attribute a
              ON a.attrelid = c.conrelid AND a.attnum = k.attnum
            WHERE a.attname = 'school_id'
          )
      `, [[...TENANT_TABLES]]);

      expect(rows.map(r => `${r.child}.${r.constraint_name}`)).toEqual([]);
    });
  });

  describe("the transaction boundary", () => {
    it("does not leak the tenant onto the next user of a pooled connection", async () => {
      const alpha = await makeSchool({ subdomain: "alpha" });

      await appDb.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.school_id', ${alpha.id}, true)`);
        const r = await tx.execute(sql`SELECT id FROM schools`);
        expect(r.rows).toHaveLength(1);
      });

      /*
       * The reason `set_config`'s third argument is `true`.
       *
       * With `false` the setting is session-scoped, and because connections
       * are pooled it would survive the response and hand the next borrower of
       * that connection the previous request's tenant. That is a cross-tenant
       * leak created by the very code that sets up the isolation, and it would
       * be invisible under low load — the pool would usually hand back a
       * different connection.
       */
      const after = await appDb.execute(sql`SELECT id FROM schools`);
      expect(after.rows).toEqual([]);
    });
  });
});
