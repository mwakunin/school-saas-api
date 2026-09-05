import { and, eq, ne } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import type { TestUser } from "@/test/helpers";

import app from "@/app";
import db from "@/db";
import { academicYears, terms } from "@/db/schema";
import { termForDay, termsForYear } from "@/lib/academic-spine";
import { isUniqueViolation, pgConstraintName } from "@/lib/db-errors";
import {
  makeSchool,
  resetDb,
  signInAt,
  tenantHeaders,
} from "@/test/helpers";

/**
 * The academic spine from inside a school.
 *
 * Isolation is covered in tenant.test.ts and rls.test.ts; this is about the
 * rules the spine itself has to hold — one current term, coherent boundaries,
 * and a class structure a school can actually shape to its own naming.
 */
function jsonHeaders(subdomain: string, user: TestUser) {
  return { "content-type": "application/json", ...tenantHeaders(subdomain, user) };
}

describe("academic spine", () => {
  beforeEach(async () => {
    await resetDb();
  });

  describe("grade levels", () => {
    it("returns Grade 1-9 in teaching order with the CBE phase boundary", async () => {
      const alpha = await makeSchool({ subdomain: "alpha" });
      const teacher = await signInAt(alpha.id, "teacher");

      const res = await app.request("/grade-levels", {
        headers: tenantHeaders("alpha", teacher),
      });

      const body = await res.json();
      expect(body.map((g: { name: string }) => g.name)).toEqual([
        "Grade 1",
        "Grade 2",
        "Grade 3",
        "Grade 4",
        "Grade 5",
        "Grade 6",
        "Grade 7",
        "Grade 8",
        "Grade 9",
      ]);

      // Anything differing between primary and junior filters on `phase`, not
      // on a grade number — the boundary is a curriculum decision.
      const phases = Object.fromEntries(
        body.map((g: { sequence: number; phase: string }) => [g.sequence, g.phase]),
      );
      expect(phases[6]).toBe("primary");
      expect(phases[7]).toBe("junior");
    });
  });

  describe("terms", () => {
    it("seeds three terms whose boundaries do not overlap", async () => {
      const alpha = await makeSchool({ subdomain: "alpha", year: 2026 });
      const teacher = await signInAt(alpha.id, "teacher");

      const res = await app.request("/terms", {
        headers: tenantHeaders("alpha", teacher),
      });

      const body = await res.json() as Array<{
        number: number;
        startsOn: string;
        endsOn: string;
      }>;

      expect(body.map(t => t.number)).toEqual([1, 2, 3]);

      for (let i = 1; i < body.length; i += 1)
        expect(body[i].startsOn > body[i - 1].endsOn).toBe(true);
    });

    it("lets an admin correct the dates the Ministry actually published", async () => {
      const alpha = await makeSchool({ subdomain: "alpha", year: 2026 });
      const admin = await signInAt(alpha.id, "admin");
      const [term1] = alpha.terms;

      const res = await app.request(`/terms/${term1.id}`, {
        method: "PATCH",
        headers: jsonHeaders("alpha", admin),
        body: JSON.stringify({ startsOn: "2026-01-05", endsOn: "2026-04-03" }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        startsOn: "2026-01-05",
        endsOn: "2026-04-03",
      });
    });

    it("refuses dates that would end a term before it starts", async () => {
      const alpha = await makeSchool({ subdomain: "alpha", year: 2026 });
      const admin = await signInAt(alpha.id, "admin");
      const [term1] = alpha.terms;

      const res = await app.request(`/terms/${term1.id}`, {
        method: "PATCH",
        headers: jsonHeaders("alpha", admin),
        body: JSON.stringify({ endsOn: "2025-01-01" }),
      });

      // Patching one half of the pair is the common way in, which is why the
      // CHECK is on the table rather than only in the request schema.
      expect(res.status).toBe(422);
    });

    it("keeps exactly one term current", async () => {
      const alpha = await makeSchool({ subdomain: "alpha", year: 2026 });
      const admin = await signInAt(alpha.id, "admin");
      const [term1, term2] = alpha.terms;

      await app.request(`/terms/${term1.id}`, {
        method: "PATCH",
        headers: jsonHeaders("alpha", admin),
        body: JSON.stringify({ isCurrent: true }),
      });
      await app.request(`/terms/${term2.id}`, {
        method: "PATCH",
        headers: jsonHeaders("alpha", admin),
        body: JSON.stringify({ isCurrent: true }),
      });

      const rows = await db
        .select()
        .from(terms)
        .where(eq(terms.schoolId, alpha.id));

      // "Which term is it" decides where marks and invoices are filed, so two
      // current terms is not a cosmetic problem.
      expect(rows.filter(t => t.isCurrent).map(t => t.number)).toEqual([2]);
    });

    it("403s a teacher trying to move a term", async () => {
      const alpha = await makeSchool({ subdomain: "alpha" });
      const teacher = await signInAt(alpha.id, "teacher");

      const res = await app.request(`/terms/${alpha.terms[0].id}`, {
        method: "PATCH",
        headers: jsonHeaders("alpha", teacher),
        body: JSON.stringify({ isCurrent: true }),
      });

      expect(res.status).toBe(403);
    });

    it("422s an empty patch rather than silently doing nothing", async () => {
      const alpha = await makeSchool({ subdomain: "alpha" });
      const admin = await signInAt(alpha.id, "admin");

      const res = await app.request(`/terms/${alpha.terms[0].id}`, {
        method: "PATCH",
        headers: jsonHeaders("alpha", admin),
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(422);
    });
  });

  describe("streams", () => {
    it("creates a class and returns it with its grade", async () => {
      const alpha = await makeSchool({ subdomain: "alpha" });
      const admin = await signInAt(alpha.id, "admin");
      const grade4 = alpha.gradeLevels.find(g => g.sequence === 4)!;

      const res = await app.request("/streams", {
        method: "POST",
        headers: jsonHeaders("alpha", admin),
        body: JSON.stringify({
          gradeLevelId: grade4.id,
          academicYearId: alpha.academicYear.id,
          name: "Blue",
        }),
      });

      expect(res.status).toBe(201);
      // "Blue" alone is meaningless on a class list; the grade is what makes
      // it readable.
      expect(await res.json()).toMatchObject({
        name: "Blue",
        gradeLevel: { name: "Grade 4", sequence: 4, phase: "primary" },
      });
    });

    it("409s a duplicate class name in the same grade and year", async () => {
      const alpha = await makeSchool({ subdomain: "alpha" });
      const admin = await signInAt(alpha.id, "admin");
      const grade4 = alpha.gradeLevels.find(g => g.sequence === 4)!;

      const body = JSON.stringify({
        gradeLevelId: grade4.id,
        academicYearId: alpha.academicYear.id,
        name: "Blue",
      });

      await app.request("/streams", {
        method: "POST",
        headers: jsonHeaders("alpha", admin),
        body,
      });
      const second = await app.request("/streams", {
        method: "POST",
        headers: jsonHeaders("alpha", admin),
        body,
      });

      expect(second.status).toBe(409);
    });

    it("allows the same class name in a different grade", async () => {
      const alpha = await makeSchool({ subdomain: "alpha" });
      const admin = await signInAt(alpha.id, "admin");

      for (const sequence of [4, 5]) {
        const grade = alpha.gradeLevels.find(g => g.sequence === sequence)!;
        const res = await app.request("/streams", {
          method: "POST",
          headers: jsonHeaders("alpha", admin),
          body: JSON.stringify({
            gradeLevelId: grade.id,
            academicYearId: alpha.academicYear.id,
            name: "Blue",
          }),
        });
        expect(res.status).toBe(201);
      }

      // Most schools reuse a small set of names across grades — "Blue" exists
      // in every year group.
      const list = await app.request("/streams", {
        headers: tenantHeaders("alpha", admin),
      });
      expect(await list.json()).toHaveLength(2);
    });

    it("lists streams in grade order", async () => {
      const alpha = await makeSchool({ subdomain: "alpha" });
      const admin = await signInAt(alpha.id, "admin");

      for (const sequence of [7, 1, 4]) {
        const grade = alpha.gradeLevels.find(g => g.sequence === sequence)!;
        await app.request("/streams", {
          method: "POST",
          headers: jsonHeaders("alpha", admin),
          body: JSON.stringify({
            gradeLevelId: grade.id,
            academicYearId: alpha.academicYear.id,
            name: "East",
          }),
        });
      }

      const res = await app.request("/streams", {
        headers: tenantHeaders("alpha", admin),
      });
      const body = await res.json() as Array<{ gradeLevel: { sequence: number } }>;

      expect(body.map(s => s.gradeLevel.sequence)).toEqual([1, 4, 7]);
    });

    it("seeds no streams at onboarding, since naming is local", async () => {
      const alpha = await makeSchool({ subdomain: "alpha" });
      const admin = await signInAt(alpha.id, "admin");

      const res = await app.request("/streams", {
        headers: tenantHeaders("alpha", admin),
      });

      // Guessing "A"/"B" creates rows an admin then has to hunt down and
      // delete — and the runtime role has no DELETE privilege.
      expect(await res.json()).toEqual([]);
    });
  });

  describe("academic years", () => {
    it("opens a new year and moves `current` onto it", async () => {
      const alpha = await makeSchool({ subdomain: "alpha", year: 2026 });
      const admin = await signInAt(alpha.id, "admin");

      const res = await app.request("/academic-years", {
        method: "POST",
        headers: jsonHeaders("alpha", admin),
        body: JSON.stringify({ year: 2027, isCurrent: true }),
      });

      expect(res.status).toBe(201);

      const list = await (await app.request("/academic-years", {
        headers: tenantHeaders("alpha", admin),
      })).json() as Array<{ year: number; isCurrent: boolean }>;

      expect(list.filter(y => y.isCurrent).map(y => y.year)).toEqual([2027]);
    });
  });

  describe("the seeded calendar", () => {
    it("produces three non-overlapping terms for any year", () => {
      for (const year of [2026, 2027, 2030]) {
        const t = termsForYear(year);
        expect(t).toHaveLength(3);
        for (const term of t) {
          expect(term.endsOn > term.startsOn).toBe(true);
          expect(term.startsOn.startsWith(String(year))).toBe(true);
        }
        expect(t[1].startsOn > t[0].endsOn).toBe(true);
        expect(t[2].startsOn > t[1].endsOn).toBe(true);
      }
    });

    it("reports no term during the holidays rather than guessing one", () => {
      expect(termForDay(2026, "2026-02-01")).toBe(1);
      expect(termForDay(2026, "2026-06-01")).toBe(2);
      expect(termForDay(2026, "2026-09-15")).toBe(3);

      // December is between years, and April sits in the first-term break.
      // Callers deciding "the current term" must handle this rather than
      // defaulting to term 1.
      expect(termForDay(2026, "2026-12-25")).toBeNull();
      expect(termForDay(2026, "2026-04-20")).toBeNull();
    });
  });

  /**
   * One current term per school, and one current year — held by the database.
   *
   * The handlers clear the flag and then set it, which is correct on its own
   * and races against itself: under READ COMMITTED neither request can see the
   * row the other has not committed, so both clear nothing of each other's and
   * both write two current rows with no error at all. Everything that then
   * reads "the current term" picks whichever sorts first, silently, for ever.
   *
   * Asserted against the constraint rather than by racing two requests. The
   * first version of this did fire both through `Promise.all` and check that
   * only one survived — and it passed with the indexes DROPPED, because the
   * window never opened. A concurrency test that cannot lose is not a test of
   * anything; the guarantee is what has to be proved, and it holds whether or
   * not any particular interleaving happens.
   */
  describe("exactly one thing is current", () => {
    it("refuses a second current term for one school", async () => {
      const alpha = await makeSchool({ subdomain: "alpha", year: 2026 });
      const [first] = await db
        .select()
        .from(terms)
        .where(eq(terms.schoolId, alpha.id));

      await db.update(terms).set({ isCurrent: true }).where(eq(terms.id, first.id));

      const second = await db
        .select()
        .from(terms)
        .where(and(eq(terms.schoolId, alpha.id), ne(terms.id, first.id)));

      const err = await db
        .update(terms)
        .set({ isCurrent: true })
        .where(eq(terms.id, second[0].id))
        .then(() => null, (e: unknown) => e);

      expect(isUniqueViolation(err)).toBe(true);
      expect(pgConstraintName(err)).toBe("terms_one_current_per_school");
    });

    it("lets two different schools each have a current term", async () => {
      const alpha = await makeSchool({ subdomain: "alpha", year: 2026 });
      const beta = await makeSchool({ subdomain: "beta", year: 2026 });

      for (const school of [alpha, beta]) {
        const [term] = await db
          .select()
          .from(terms)
          .where(eq(terms.schoolId, school.id));

        await db.update(terms).set({ isCurrent: true }).where(eq(terms.id, term.id));
      }

      // Partial and per-school: the index must not make one tenant's calendar
      // depend on another's.
      const current = await db
        .select()
        .from(terms)
        .where(eq(terms.isCurrent, true));

      expect(current).toHaveLength(2);
    });

    it("refuses a second current year the same way", async () => {
      const alpha = await makeSchool({ subdomain: "alpha", year: 2026 });
      const extra = await db
        .insert(academicYears)
        .values({ schoolId: alpha.id, year: 2027, isCurrent: false })
        .returning();

      // The identical race one function up, and it predates this round — fixed
      // together because it is the same guarantee.
      const err = await db
        .update(academicYears)
        .set({ isCurrent: true })
        .where(eq(academicYears.id, extra[0].id))
        .then(() => null, (e: unknown) => e);

      expect(pgConstraintName(err)).toBe("academic_years_one_current_per_school");
    });

    it("still lets a school move which term is current", async () => {
      const alpha = await makeSchool({ subdomain: "alpha", year: 2026 });
      const admin = await signInAt(alpha.id, "admin");
      const all = await db
        .select()
        .from(terms)
        .where(eq(terms.schoolId, alpha.id));

      // The ordinary path has to keep working: clear-then-set inside one
      // transaction never has two set at the same instant.
      for (const term of all) {
        const res = await app.request(`/terms/${term.id}`, {
          method: "PATCH",
          headers: jsonHeaders("alpha", admin),
          body: JSON.stringify({ isCurrent: true }),
        });
        expect(res.status).toBe(200);
      }

      const current = await db
        .select()
        .from(terms)
        .where(and(eq(terms.schoolId, alpha.id), eq(terms.isCurrent, true)));

      expect(current).toHaveLength(1);
      expect(current[0].id).toBe(all[all.length - 1].id);
    });
  });
});
