import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import app from "@/app";
import db from "@/db";
import { academicYears, gradeLevels, memberships, schools, terms } from "@/db/schema";
import {
  makeSchool,
  nextEmail,
  nextPhone,
  resetDb,
  signIn,
  signUpWithEmail,
  tenantHeaders,
} from "@/test/helpers";

/**
 * The superadmin plane: onboarding, listing and suspending schools.
 *
 * It runs outside any tenant on the owner connection, which is what lets it
 * work across schools — and is exactly why its authorization matters more than
 * anywhere else in the system. A hole here is not a leak between two schools;
 * it is access to all of them.
 */
async function postJson(path: string, body: unknown, headers: Record<string, string> = {}) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("superadmin plane", () => {
  beforeEach(async () => {
    await resetDb();
  });

  describe("authorization", () => {
    it("401s an anonymous caller", async () => {
      const res = await app.request("/superadmin/schools");
      expect(res.status).toBe(401);
    });

    it("403s an ordinary signed-in user", async () => {
      const person = await signIn(nextPhone());
      const res = await app.request("/superadmin/schools", {
        headers: person.headers,
      });
      expect(res.status).toBe(403);
    });

    it("403s a school admin, whose authority stops at their own school", async () => {
      const alpha = await makeSchool({ subdomain: "alpha" });
      const admin = await signIn(nextPhone());
      await db.insert(memberships).values({
        userId: admin.id,
        schoolId: alpha.id,
        role: "admin",
      });

      // The distinction CLAUDE.md §4 draws: superadmin is a separate plane,
      // not the top role inside a tenant. Being an admin at one school must
      // never imply anything about the platform.
      const res = await app.request("/superadmin/schools", {
        headers: admin.headers,
      });

      expect(res.status).toBe(403);
    });

    it("admits a superadmin", async () => {
      const boss = await signIn(nextPhone(), "superadmin");
      const res = await app.request("/superadmin/schools", {
        headers: boss.headers,
      });
      expect(res.status).toBe(200);
    });

    it("is reachable regardless of subdomain, having no tenant", async () => {
      const boss = await signIn(nextPhone(), "superadmin");
      await makeSchool({ subdomain: "alpha" });

      const res = await app.request("/superadmin/schools", {
        headers: tenantHeaders("alpha", boss),
      });

      expect(res.status).toBe(200);
    });
  });

  describe("onboarding", () => {
    it("creates the school and seeds its academic spine", async () => {
      const boss = await signIn(nextPhone(), "superadmin");

      const res = await postJson(
        "/superadmin/schools",
        { name: "St Mary's Primary", subdomain: "stmarys", academicYear: 2026 },
        boss.headers,
      );

      expect(res.status).toBe(201);
      const body = await res.json();

      expect(body.school).toMatchObject({
        name: "St Mary's Primary",
        subdomain: "stmarys",
        status: "trial",
      });
      // A school that opens onto Grade 1-9 and three terms believes the
      // product knows its world; one that opens onto empty forms does not.
      expect(body.seeded).toEqual({
        academicYear: 2026,
        terms: 3,
        gradeLevels: 9,
      });

      const grades = await db
        .select()
        .from(gradeLevels)
        .where(eq(gradeLevels.schoolId, body.school.id));

      expect(grades).toHaveLength(9);
      expect(grades.filter(g => g.phase === "primary")).toHaveLength(6);
      expect(grades.filter(g => g.phase === "junior")).toHaveLength(3);
    });

    it("never returns M-Pesa credentials", async () => {
      const boss = await signIn(nextPhone(), "superadmin");
      const res = await postJson(
        "/superadmin/schools",
        { name: "St Mary's", subdomain: "stmarys" },
        boss.headers,
      );

      expect(await res.json()).not.toHaveProperty("school.mpesaCredentials");
    });

    it("leaves no term marked current", async () => {
      const boss = await signIn(nextPhone(), "superadmin");
      const res = await postJson(
        "/superadmin/schools",
        { name: "St Mary's", subdomain: "stmarys", academicYear: 2026 },
        boss.headers,
      );
      const { school } = await res.json();

      // The seeded boundaries are approximate, and a wrong `isCurrent` files
      // marks and invoices under the wrong term — worse than none at all.
      const rows = await db.select().from(terms).where(eq(terms.schoolId, school.id));
      expect(rows.filter(t => t.isCurrent)).toHaveLength(0);
      expect(rows.map(t => t.number).sort()).toEqual([1, 2, 3]);
    });

    it("409s a subdomain already taken", async () => {
      const boss = await signIn(nextPhone(), "superadmin");
      await makeSchool({ subdomain: "taken" });

      const res = await postJson(
        "/superadmin/schools",
        { name: "Another", subdomain: "taken" },
        boss.headers,
      );

      expect(res.status).toBe(409);
    });

    it("leaves nothing behind when onboarding fails", async () => {
      const boss = await signIn(nextPhone(), "superadmin");
      await makeSchool({ subdomain: "taken" });

      const before = await db.select().from(schools);
      await postJson(
        "/superadmin/schools",
        { name: "Another", subdomain: "taken" },
        boss.headers,
      );
      const after = await db.select().from(schools);

      // The insert of the school itself is what conflicts, so nothing partial
      // can survive — but the whole point of the transaction is that this
      // stays true when the seeding grows.
      expect(after).toHaveLength(before.length);
    });

    it.each([
      ["uppercase", "StMarys"],
      ["a space", "st marys"],
      ["an underscore", "st_marys"],
      ["a leading hyphen", "-stmarys"],
      // Reserved names pass the format check but `subdomainFrom` refuses them,
      // so a school created on one would be permanently unreachable.
      ["a reserved name", "www"],
      ["another reserved name", "api"],
    ])("422s a subdomain with %s", async (_case, subdomain) => {
      const boss = await signIn(nextPhone(), "superadmin");
      const res = await postJson(
        "/superadmin/schools",
        { name: "Test", subdomain },
        boss.headers,
      );

      expect(res.status).toBe(422);
    });
  });

  describe("suspension", () => {
    it("suspends a school and locks its staff out with a reason", async () => {
      const boss = await signIn(nextPhone(), "superadmin");
      const alpha = await makeSchool({ subdomain: "alpha" });
      const admin = await signIn(nextPhone());
      await db.insert(memberships).values({
        userId: admin.id,
        schoolId: alpha.id,
        role: "admin",
      });

      expect((await app.request("/school", {
        headers: tenantHeaders("alpha", admin),
      })).status).toBe(200);

      const res = await app.request(`/superadmin/schools/${alpha.id}/status`, {
        method: "PATCH",
        headers: { "content-type": "application/json", ...boss.headers },
        body: JSON.stringify({ status: "suspended" }),
      });

      expect(res.status).toBe(200);
      expect((await res.json()).status).toBe("suspended");

      const locked = await app.request("/school", {
        headers: tenantHeaders("alpha", admin),
      });
      expect(locked.status).toBe(403);
    });

    it("returns the school intact on reactivation", async () => {
      const boss = await signIn(nextPhone(), "superadmin");
      const alpha = await makeSchool({ subdomain: "alpha", status: "suspended" });
      const admin = await signIn(nextPhone());
      await db.insert(memberships).values({
        userId: admin.id,
        schoolId: alpha.id,
        role: "admin",
      });

      await app.request(`/superadmin/schools/${alpha.id}/status`, {
        method: "PATCH",
        headers: { "content-type": "application/json", ...boss.headers },
        body: JSON.stringify({ status: "active" }),
      });

      // Suspension withholds access; it never touches the data. A school that
      // pays its bill must find everything where it left it.
      const res = await app.request("/academic-years", {
        headers: tenantHeaders("alpha", admin),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toHaveLength(1);
    });

    it("404s an unknown school", async () => {
      const boss = await signIn(nextPhone(), "superadmin");
      const res = await app.request(
        "/superadmin/schools/4651e634-a530-4484-9b09-9616a28f35e3/status",
        {
          method: "PATCH",
          headers: { "content-type": "application/json", ...boss.headers },
          body: JSON.stringify({ status: "suspended" }),
        },
      );

      expect(res.status).toBe(404);
    });
  });

  describe("listing", () => {
    it("sees every school, which no tenant connection could", async () => {
      const boss = await signIn(nextPhone(), "superadmin");
      await makeSchool({ subdomain: "alpha", name: "Alpha" });
      await makeSchool({ subdomain: "beta", name: "Beta" });

      const res = await app.request("/superadmin/schools", {
        headers: boss.headers,
      });

      const body = await res.json();
      expect(body.map((s: { name: string }) => s.name)).toEqual(["Alpha", "Beta"]);
    });

    it("withholds M-Pesa credentials from the listing", async () => {
      const boss = await signIn(nextPhone(), "superadmin");
      const alpha = await makeSchool({ subdomain: "alpha" });
      await db
        .update(schools)
        .set({ mpesaCredentials: "super-secret-daraja-blob" })
        .where(eq(schools.id, alpha.id));

      const res = await app.request("/superadmin/schools", {
        headers: boss.headers,
      });

      expect(await res.text()).not.toContain("super-secret-daraja-blob");
    });

    it("reports a seeded year that a tenant request would also see", async () => {
      const boss = await signIn(nextPhone(), "superadmin");
      const res = await postJson(
        "/superadmin/schools",
        { name: "St Mary's", subdomain: "stmarys", academicYear: 2026 },
        boss.headers,
      );
      const { school } = await res.json();

      const years = await db
        .select()
        .from(academicYears)
        .where(eq(academicYears.schoolId, school.id));

      expect(years).toHaveLength(1);
      expect(years[0]).toMatchObject({ year: 2026, isCurrent: true });
    });
  });

  /**
   * Granting the first membership.
   *
   * Without this, onboarding a school leaves NOBODY able to sign into it —
   * `withMembership` finds no row and every tenant route refuses. It lives on
   * this plane rather than the tenant one because the tenant equivalent would
   * be guarded by `admin`, which is the role that does not exist yet.
   */
  describe("granting access to a new school", () => {
    it("lets a granted admin work at a school that had nobody", async () => {
      const boss = await signIn(nextPhone(), "superadmin");
      const alpha = await makeSchool({ subdomain: "alpha" });
      const head = await signUpWithEmail(nextEmail());

      // 404 rather than 403, deliberately: a signed-in non-member must not be
      // able to tell a school that exists from one that does not, or the
      // subdomain space becomes a directory of our customers.
      const before = await app.request("/school", { headers: tenantHeaders("alpha", head) });
      expect(before.status).toBe(404);

      const res = await postJson(
        `/superadmin/schools/${alpha.id}/memberships`,
        { email: head.email, role: "admin" },
        boss.headers,
      );

      expect(res.status).toBe(201);
      expect(await res.json()).toMatchObject({ role: "admin", created: true });

      const after = await app.request("/school", { headers: tenantHeaders("alpha", head) });
      expect(after.status).toBe(200);
    });

    it("adds a role rather than replacing one", async () => {
      const boss = await signIn(nextPhone(), "superadmin");
      const alpha = await makeSchool({ subdomain: "alpha" });
      const person = await signUpWithEmail(nextEmail());

      for (const role of ["teacher", "guardian"] as const) {
        await postJson(
          `/superadmin/schools/${alpha.id}/memberships`,
          { email: person.email, role },
          boss.headers,
        );
      }

      // One login has to cover a teacher who is also a parent at the same
      // school — the reason role lives on the membership (CLAUDE.md §5.1).
      const held = await db
        .select()
        .from(memberships)
        .where(eq(memberships.userId, person.id));

      expect(held.map(m => m.role).sort()).toEqual(["guardian", "teacher"]);
    });

    it("is idempotent, so re-running an onboarding script is safe", async () => {
      const boss = await signIn(nextPhone(), "superadmin");
      const alpha = await makeSchool({ subdomain: "alpha" });
      const head = await signUpWithEmail(nextEmail());
      const body = { email: head.email, role: "admin" as const };

      const first = await postJson(`/superadmin/schools/${alpha.id}/memberships`, body, boss.headers);
      const again = await postJson(`/superadmin/schools/${alpha.id}/memberships`, body, boss.headers);

      expect((await first.json()).created).toBe(true);
      expect((await again.json()).created).toBe(false);
    });

    it("reactivates a membership that had been switched off", async () => {
      const boss = await signIn(nextPhone(), "superadmin");
      const alpha = await makeSchool({ subdomain: "alpha" });
      const bursar = await signUpWithEmail(nextEmail());
      const body = { email: bursar.email, role: "bursar" as const };

      await postJson(`/superadmin/schools/${alpha.id}/memberships`, body, boss.headers);
      await db.update(memberships).set({ isActive: false }).where(eq(memberships.userId, bursar.id));

      // `withMembership` only accepts active rows, so returning the row
      // untouched would answer 201 with a membership granting nothing — the
      // endpoint reporting success while the person still cannot sign in.
      const locked = await app.request("/school", { headers: tenantHeaders("alpha", bursar) });
      expect(locked.status).toBe(404);

      const res = await postJson(`/superadmin/schools/${alpha.id}/memberships`, body, boss.headers);
      expect(await res.json()).toMatchObject({ created: false, isActive: true });

      const restored = await app.request("/school", { headers: tenantHeaders("alpha", bursar) });
      expect(restored.status).toBe(200);
    });

    it("422s an address nobody has signed up with", async () => {
      const boss = await signIn(nextPhone(), "superadmin");
      const alpha = await makeSchool({ subdomain: "alpha" });

      const res = await postJson(
        `/superadmin/schools/${alpha.id}/memberships`,
        { email: "nobody@example.test", role: "admin" },
        boss.headers,
      );

      // The school was found; it is the address that matches nobody, so the
      // caller is told which half of the request to fix.
      expect(res.status).toBe(422);
      expect((await res.json()).error.issues[0].path).toEqual(["email"]);
    });

    it("403s a school admin trying to grant themselves more", async () => {
      const alpha = await makeSchool({ subdomain: "alpha" });
      const admin = await signUpWithEmail(nextEmail());
      await db.insert(memberships).values({
        userId: admin.id,
        schoolId: alpha.id,
        role: "admin",
      });

      const res = await postJson(
        `/superadmin/schools/${alpha.id}/memberships`,
        { email: admin.email, role: "admin" },
        admin.headers,
      );

      expect(res.status).toBe(403);
    });
  });
});
