import { beforeEach, describe, expect, it } from "vitest";

import type { TestUser } from "@/test/helpers";

import app from "@/app";
import {
  addMembership,
  makeSchool,
  nextEmail,
  resetDb,
  signInAt,
  signUpWithEmail,
  tenantHeaders,
} from "@/test/helpers";

/**
 * A school running its own access.
 *
 * The superadmin plane grants the FIRST membership, because a school that has
 * just been created has no admin to do it. Needing the platform operator for
 * every bursar after that is what turns a product into a service — these
 * routes are what removes that.
 */
function jsonHeaders(subdomain: string, person: TestUser) {
  return { "content-type": "application/json", ...tenantHeaders(subdomain, person) };
}

function post(path: string, body: unknown, headers: Record<string, string>) {
  return app.request(path, { method: "POST", headers, body: JSON.stringify(body) });
}

function patch(path: string, body: unknown, headers: Record<string, string>) {
  return app.request(path, { method: "PATCH", headers, body: JSON.stringify(body) });
}

async function seed(subdomain: string) {
  const school = await makeSchool({ subdomain });
  const head = await signInAt(school.id, "admin");
  return { school, head, subdomain };
}

describe("staff", () => {
  beforeEach(async () => {
    await resetDb();
  });

  describe("granting", () => {
    it("lets a head add their own bursar", async () => {
      const ctx = await seed("alpha");
      const bursar = await signUpWithEmail(nextEmail());

      const before = await app.request("/balances", { headers: tenantHeaders("alpha", bursar) });
      expect(before.status).toBe(404);

      const res = await post(
        "/memberships",
        { email: bursar.email, role: "bursar" },
        jsonHeaders("alpha", ctx.head),
      );
      expect(res.status).toBe(201);

      // No platform operator involved, which is the entire point.
      const after = await app.request("/balances", { headers: tenantHeaders("alpha", bursar) });
      expect(after.status).toBe(200);
    });

    it("adds a role rather than replacing one", async () => {
      const ctx = await seed("alpha");
      const person = await signUpWithEmail(nextEmail());

      for (const role of ["teacher", "guardian"] as const) {
        await post("/memberships", { email: person.email, role }, jsonHeaders("alpha", ctx.head));
      }

      const listed = await (await app.request("/memberships", {
        headers: tenantHeaders("alpha", ctx.head),
      })).json();

      // A teacher who is also a parent is one login with two memberships —
      // the reason role lives on the membership and not on the user (§5.1).
      const theirs = listed.filter((m: { userId: string }) => m.userId === person.id);
      expect(theirs.map((m: { role: string }) => m.role).sort()).toEqual(["guardian", "teacher"]);
    });

    it("restores access rather than handing back a dead row", async () => {
      const ctx = await seed("alpha");
      const teacher = await signUpWithEmail(nextEmail());
      const granted = await (await post(
        "/memberships",
        { email: teacher.email, role: "teacher" },
        jsonHeaders("alpha", ctx.head),
      )).json();

      await patch(`/memberships/${granted.id}`, { isActive: false }, jsonHeaders("alpha", ctx.head));

      const again = await (await post(
        "/memberships",
        { email: teacher.email, role: "teacher" },
        jsonHeaders("alpha", ctx.head),
      )).json();

      // `withMembership` only accepts active rows, so returning the
      // deactivated one would answer 201 with access that does not work.
      expect(again.isActive).toBe(true);
      const check = await app.request("/school", { headers: tenantHeaders("alpha", teacher) });
      expect(check.status).toBe(200);
    });

    it("says so when nobody has signed up with that address", async () => {
      const ctx = await seed("alpha");

      const res = await post(
        "/memberships",
        { email: "nobody@example.test", role: "bursar" },
        jsonHeaders("alpha", ctx.head),
      );

      // The head needs to know to tell them to create an account first — a
      // vague error would make the feature unusable.
      expect(res.status).toBe(422);
      expect((await res.json()).error.issues[0].path).toEqual(["email"]);
    });
  });

  describe("revoking", () => {
    it("takes effect on the next request", async () => {
      const ctx = await seed("alpha");
      const teacher = await signUpWithEmail(nextEmail());
      const granted = await (await post(
        "/memberships",
        { email: teacher.email, role: "teacher" },
        jsonHeaders("alpha", ctx.head),
      )).json();

      expect((await app.request("/school", {
        headers: tenantHeaders("alpha", teacher),
      })).status).toBe(200);

      await patch(`/memberships/${granted.id}`, { isActive: false }, jsonHeaders("alpha", ctx.head));

      // 404 rather than 403, so a revoked person cannot tell the school exists.
      expect((await app.request("/school", {
        headers: tenantHeaders("alpha", teacher),
      })).status).toBe(404);
    });

    it("refuses to remove the last admin", async () => {
      const ctx = await seed("alpha");
      const listed = await (await app.request("/memberships?role=admin", {
        headers: tenantHeaders("alpha", ctx.head),
      })).json();

      const res = await patch(
        `/memberships/${listed[0].id}`,
        { isActive: false },
        jsonHeaders("alpha", ctx.head),
      );

      /*
       * A school that locked itself out would need the platform operator to
       * get back in — the exact dependency these routes exist to remove.
       */
      expect(res.status).toBe(409);
      expect((await res.json()).message).toContain("last admin");
    });

    it("allows it once a second admin exists", async () => {
      const ctx = await seed("alpha");
      const deputy = await signUpWithEmail(nextEmail());
      await post(
        "/memberships",
        { email: deputy.email, role: "admin" },
        jsonHeaders("alpha", ctx.head),
      );

      const listed = await (await app.request("/memberships?role=admin", {
        headers: tenantHeaders("alpha", ctx.head),
      })).json();
      const mine = listed.find((m: { userId: string }) => m.userId === ctx.head.id);

      const res = await patch(
        `/memberships/${mine.id}`,
        { isActive: false },
        jsonHeaders("alpha", ctx.head),
      );

      // Handing over is a real thing a head does; only the LAST one is blocked.
      expect(res.status).toBe(200);
    });
  });

  describe("who may use it", () => {
    it("is the head's, not the bursar's", async () => {
      const ctx = await seed("alpha");
      const bursar = await signInAt(ctx.school.id, "bursar");

      expect((await app.request("/memberships", {
        headers: tenantHeaders("alpha", bursar),
      })).status).toBe(403);

      const granted = await post(
        "/memberships",
        { email: "someone@example.test", role: "admin" },
        jsonHeaders("alpha", bursar),
      );
      // Otherwise a bursar could make themselves an admin.
      expect(granted.status).toBe(403);
    });

    it("cannot reach another school's memberships", async () => {
      const alpha = await seed("alpha");
      const beta = await seed("beta");
      const outsider = await signUpWithEmail(nextEmail());
      await addMembership(outsider.id, beta.school.id, "admin");

      const listed = await (await app.request("/memberships", {
        headers: tenantHeaders("alpha", alpha.head),
      })).json();

      expect(listed.every((m: { userId: string }) => m.userId !== outsider.id)).toBe(true);
    });
  });
});
