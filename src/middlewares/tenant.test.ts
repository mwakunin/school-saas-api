import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import app from "@/app";
import db, { appPool } from "@/db";
import { academicYears, memberships, schools, terms } from "@/db/schema";
import {
  addMembership,
  makeSchool,
  nextPhone,
  resetDb,
  signIn,
  signInAt,
  tenantHeaders,
} from "@/test/helpers";

/**
 * Tenant resolution end to end, over HTTP.
 *
 * rls.test.ts proves the database refuses cross-tenant access even when the
 * application forgets to ask. This proves the application asks correctly in
 * the first place — that the Host header picks the school, that membership is
 * evaluated per school, and that the two combine so a real request sees
 * exactly one school's data.
 */
describe("tenant middleware", () => {
  beforeEach(async () => {
    await resetDb();
  });

  describe("resolving the school", () => {
    it("serves the school named by the subdomain", async () => {
      const alpha = await makeSchool({ subdomain: "alpha", name: "Alpha Academy" });
      const person = await signInAt(alpha.id, "admin");

      const res = await app.request("/school", {
        headers: tenantHeaders("alpha", person),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        id: alpha.id,
        name: "Alpha Academy",
      });
    });

    it("never returns M-Pesa credentials", async () => {
      const alpha = await makeSchool({ subdomain: "alpha" });
      await db
        .update(schools)
        .set({ mpesaCredentials: "super-secret-daraja-blob" })
        .where(eq(schools.id, alpha.id));

      const person = await signInAt(alpha.id, "admin");
      const res = await app.request("/school", {
        headers: tenantHeaders("alpha", person),
      });

      const body = await res.text();
      expect(body).not.toContain("super-secret-daraja-blob");
      expect(JSON.parse(body)).not.toHaveProperty("mpesaCredentials");
    });

    it("404s an unknown subdomain", async () => {
      const alpha = await makeSchool({ subdomain: "alpha" });
      const person = await signInAt(alpha.id, "admin");

      const res = await app.request("/school", {
        headers: tenantHeaders("nosuchschool", person),
      });

      expect(res.status).toBe(404);
    });

    it("404s the apex domain, which belongs to no school", async () => {
      const alpha = await makeSchool({ subdomain: "alpha" });
      const person = await signInAt(alpha.id, "admin");

      const res = await app.request("/school", {
        headers: { host: "localhost", ...person.headers },
      });

      expect(res.status).toBe(404);
    });

    it("tells a suspended school's staff why, rather than 404ing them", async () => {
      const alpha = await makeSchool({ subdomain: "alpha", status: "suspended" });
      const person = await signInAt(alpha.id, "admin");

      const res = await app.request("/school", {
        headers: tenantHeaders("alpha", person),
      });

      // A non-payer's admin needs to know the account is suspended so they can
      // act on it. An unknown subdomain gets 404 precisely because that
      // distinction must not be available to a stranger.
      expect(res.status).toBe(403);
      expect((await res.json()).message).toMatch(/suspended/i);
    });
  });

  describe("membership", () => {
    it("401s a request with no session", async () => {
      await makeSchool({ subdomain: "alpha" });

      const res = await app.request("/school", {
        headers: tenantHeaders("alpha"),
      });

      expect(res.status).toBe(401);
    });

    it("404s a signed-in user who has no membership here", async () => {
      await makeSchool({ subdomain: "alpha" });
      const outsider = await signIn(nextPhone());

      const res = await app.request("/school", {
        headers: tenantHeaders("alpha", outsider),
      });

      // 404, not 403: otherwise the subdomain space becomes a directory of
      // our customers that anyone with an account can enumerate.
      expect(res.status).toBe(404);
    });

    it("does not carry a membership at one school over to another", async () => {
      const alpha = await makeSchool({ subdomain: "alpha" });
      await makeSchool({ subdomain: "beta" });

      const alphaAdmin = await signInAt(alpha.id, "admin");

      const atAlpha = await app.request("/school", {
        headers: tenantHeaders("alpha", alphaAdmin),
      });
      const atBeta = await app.request("/school", {
        headers: tenantHeaders("beta", alphaAdmin),
      });

      expect(atAlpha.status).toBe(200);
      expect(atBeta.status).toBe(404);
    });

    it("admits someone who holds a role at both schools, separately", async () => {
      const alpha = await makeSchool({ subdomain: "alpha" });
      const beta = await makeSchool({ subdomain: "beta" });

      // A teacher who moved, or who works at two schools — CLAUDE.md §5.1
      // keeps this on one login.
      const person = await signInAt(alpha.id, "teacher");
      await addMembership(person.id, beta.id, "bursar");

      const atAlpha = await app.request("/school", {
        headers: tenantHeaders("alpha", person),
      });
      const atBeta = await app.request("/school", {
        headers: tenantHeaders("beta", person),
      });

      expect(atAlpha.status).toBe(200);
      expect(atBeta.status).toBe(200);
      expect((await atAlpha.json()).id).toBe(alpha.id);
      expect((await atBeta.json()).id).toBe(beta.id);
    });

    it("honours several roles at one school", async () => {
      const alpha = await makeSchool({ subdomain: "alpha" });
      // A teacher who is also a parent at the same school.
      const person = await signInAt(alpha.id, "teacher");
      await addMembership(person.id, alpha.id, "guardian");

      // Reading is open to any member; creating a year is admin-only, and
      // neither of their roles is admin.
      const read = await app.request("/grade-levels", {
        headers: tenantHeaders("alpha", person),
      });
      const write = await app.request("/academic-years", {
        method: "POST",
        headers: { "content-type": "application/json", ...tenantHeaders("alpha", person) },
        body: JSON.stringify({ year: 2027 }),
      });

      expect(read.status).toBe(200);
      expect(write.status).toBe(403);
    });

    it("ignores a deactivated membership", async () => {
      const alpha = await makeSchool({ subdomain: "alpha" });
      const person = await signInAt(alpha.id, "admin");

      // Deactivated rather than deleted — CLAUDE.md §3 rule 5, and the
      // runtime role has no DELETE privilege anyway.
      await db
        .update(memberships)
        .set({ isActive: false })
        .where(eq(memberships.userId, person.id));

      const res = await app.request("/school", {
        headers: tenantHeaders("alpha", person),
      });

      expect(res.status).toBe(404);
    });
  });

  describe("data isolation over HTTP", () => {
    it("shows each school only its own academic spine", async () => {
      const alpha = await makeSchool({ subdomain: "alpha", year: 2026 });
      const beta = await makeSchool({ subdomain: "beta", year: 2026 });

      // Give beta a second year, so the two schools genuinely differ.
      await db
        .insert(academicYears)
        .values({ schoolId: beta.id, year: 2027 });

      const alphaAdmin = await signInAt(alpha.id, "admin");
      const betaAdmin = await signInAt(beta.id, "admin");

      const alphaYears = await (await app.request("/academic-years", {
        headers: tenantHeaders("alpha", alphaAdmin),
      })).json();
      const betaYears = await (await app.request("/academic-years", {
        headers: tenantHeaders("beta", betaAdmin),
      })).json();

      expect(alphaYears.map((y: { year: number }) => y.year)).toEqual([2026]);
      expect(betaYears.map((y: { year: number }) => y.year)).toEqual([2027, 2026]);

      // Every returned row belongs to the school that asked.
      for (const y of alphaYears)
        expect(y.schoolId).toBe(alpha.id);
      for (const y of betaYears)
        expect(y.schoolId).toBe(beta.id);
    });

    it("cannot reach another school's record by its id", async () => {
      const alpha = await makeSchool({ subdomain: "alpha" });
      const beta = await makeSchool({ subdomain: "beta" });
      const alphaAdmin = await signInAt(alpha.id, "admin");

      // A term id that certainly exists — just not at alpha.
      const res = await app.request(`/terms/${beta.terms[0].id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", ...tenantHeaders("alpha", alphaAdmin) },
        body: JSON.stringify({ isCurrent: true }),
      });

      expect(res.status).toBe(404);

      // And beta's term is untouched.
      const [betaTerm] = await db
        .select()
        .from(terms)
        .where(eq(terms.id, beta.terms[0].id));

      expect(betaTerm.isCurrent).toBe(false);
    });

    it("refuses to build a stream on another school's grade level", async () => {
      const alpha = await makeSchool({ subdomain: "alpha" });
      const beta = await makeSchool({ subdomain: "beta" });
      const alphaAdmin = await signInAt(alpha.id, "admin");

      const res = await app.request("/streams", {
        method: "POST",
        headers: { "content-type": "application/json", ...tenantHeaders("alpha", alphaAdmin) },
        body: JSON.stringify({
          gradeLevelId: beta.gradeLevels[0].id,
          academicYearId: alpha.academicYear.id,
          name: "Blue",
        }),
      });

      // 422 against the field rather than 403: from alpha's side that id
      // simply does not exist, and "forbidden" would confirm it exists
      // somewhere else.
      expect(res.status).toBe(422);
    });
  });

  describe("the request transaction", () => {
    it("persists a successful write", async () => {
      const alpha = await makeSchool({ subdomain: "alpha" });
      const admin = await signInAt(alpha.id, "admin");

      const res = await app.request("/academic-years", {
        method: "POST",
        headers: { "content-type": "application/json", ...tenantHeaders("alpha", admin) },
        body: JSON.stringify({ year: 2028, isCurrent: true }),
      });

      expect(res.status).toBe(201);

      const rows = await db
        .select()
        .from(academicYears)
        .where(eq(academicYears.year, 2028));

      expect(rows).toHaveLength(1);
      expect(rows[0].schoolId).toBe(alpha.id);
    });

    it("rolls back a write when the handler answers with an error status", async () => {
      const alpha = await makeSchool({ subdomain: "alpha", year: 2026 });
      const admin = await signInAt(alpha.id, "admin");

      /*
       * Creating 2026 again conflicts. The handler clears `isCurrent` on the
       * existing year *before* the insert that fails, so without the rollback
       * the school would be left with no current year at all — a 409 that
       * quietly corrupted state.
       */
      const res = await app.request("/academic-years", {
        method: "POST",
        headers: { "content-type": "application/json", ...tenantHeaders("alpha", admin) },
        body: JSON.stringify({ year: 2026, isCurrent: true }),
      });

      expect(res.status).toBe(409);

      const [year] = await db
        .select()
        .from(academicYears)
        .where(eq(academicYears.schoolId, alpha.id));

      expect(year.isCurrent).toBe(true);
    });
  });

  /**
   * One transaction per request, whatever the route.
   *
   * Every tenant router mounts at `/` and registers its middleware at `/*`, so
   * `withTenant` runs once per router mounted at or before the matched route.
   * Without a re-entry guard each of those opened another top-level
   * transaction on another pooled connection — nine of them for `/memberships`
   * — which capped the whole application at about one in-flight request and
   * surfaced as "timeout exceeded when trying to connect" under any
   * concurrency at all.
   */
  describe("connections per request", () => {
    async function peakBusyDuring(path: string, headers: Record<string, string>) {
      let peak = 0;
      const timer = setInterval(() => {
        peak = Math.max(peak, appPool.totalCount - appPool.idleCount);
      }, 2);

      const res = await app.request(path, { headers });
      clearInterval(timer);
      return { peak, status: res.status };
    }

    it("holds one connection however late the router is mounted", async () => {
      const alpha = await makeSchool({ subdomain: "alpha" });
      const head = await signInAt(alpha.id, "admin");
      const headers = tenantHeaders("alpha", head);

      // `/school` is the first tenant router, `/memberships` one of the last.
      // Before the guard those measured 1 and 9.
      for (const path of ["/school", "/students", "/memberships"]) {
        const { peak, status } = await peakBusyDuring(path, headers);
        expect(status).toBe(200);
        expect(peak, `${path} held ${peak} connections`).toBe(1);
      }
    });

    it("serves more concurrent requests than the pool has room to nest", async () => {
      const alpha = await makeSchool({ subdomain: "alpha" });
      const head = await signInAt(alpha.id, "admin");
      const headers = tenantHeaders("alpha", head);

      // Five at once against a late-mounted route. Before the guard this
      // needed forty-five connections and the pool holds ten.
      const results = await Promise.all(
        Array.from({ length: 5 }, () => app.request("/memberships", { headers })),
      );

      expect(results.map(r => r.status)).toEqual([200, 200, 200, 200, 200]);
    });
  });
});
