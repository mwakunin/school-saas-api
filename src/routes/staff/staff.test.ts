import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import type { TestUser } from "@/test/helpers";

import app from "@/app";
import db from "@/db";
import { memberships } from "@/db/schema";
import {
  addMembership,
  backendPid,
  makeSchool,
  nextEmail,
  resetDb,
  signInAt,
  signUpWithEmail,
  tenantHeaders,
  waitForBlockedBackend,
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

  describe("two requests at once", () => {
    it("serialises the last-admin check on the school row", async () => {
      const ctx = await seed("alpha");
      const deputy = await signInAt(ctx.school.id, "admin");

      const admins = await (await app.request("/memberships?role=admin", {
        headers: tenantHeaders("alpha", ctx.head),
      })).json();
      expect(admins).toHaveLength(2);

      /*
       * Racing two requests and hoping to land in the window does not work.
       *
       * Written that way first, this passed with the lock REMOVED — the two
       * requests never interleaved, so it proved nothing. What has to be shown
       * is that the check takes the lock at all; holding that lock and
       * watching the request wait is the deterministic version.
       *
       * The lock matters because both requests otherwise read a count that
       * includes the other admin and both conclude it is safe to go, leaving
       * the school with nobody who can let anyone back in.
       */
      const holderPid = Promise.withResolvers<number>();
      const release = Promise.withResolvers<void>();

      const holder = db.transaction(async (tx) => {
        const pid = await backendPid(tx);
        /*
         * FOR NO KEY UPDATE, not FOR UPDATE, and the difference is the test.
         *
         * Updating a membership and writing an audit row both take FOR KEY
         * SHARE on this school through their foreign keys. FOR UPDATE
         * conflicts with that, so holding one made the request block whether
         * or not the handler took a lock of its own — and the test passed with
         * the fix removed. FOR NO KEY UPDATE conflicts with the handler's FOR
         * UPDATE and not with an FK check, so only the real thing blocks.
         */
        await tx.execute(
          sql`SELECT 1 FROM schools WHERE id = ${ctx.school.id} FOR NO KEY UPDATE`,
        );
        holderPid.resolve(pid);
        await release.promise;
      });

      const pid = await holderPid.promise;

      /*
       * Everything after this runs in a `finally`.
       *
       * The first version released the holder only on the happy path, so one
       * failed assertion left an open transaction holding a row lock and a
       * pooled connection — and every test after it timed out in its hook.
       * A flaky assertion should fail one test, not the rest of the file.
       */
      let pending: Promise<Response> | null = null;
      try {
        pending = Promise.resolve(patch(
          `/memberships/${admins[0].id}`,
          { isActive: false },
          jsonHeaders("alpha", ctx.head),
        ));

        // Asked of Postgres rather than guessed with a sleep: a generous timer
        // always passes whether or not anything blocked. The window is wide
        // because the whole suite is running — 2.5s was not always enough for
        // the request to reach the lock, and the flake looked like a bug.
        expect(await waitForBlockedBackend(pid, 15_000)).toBe(true);
      }
      finally {
        release.resolve();
        await holder;
        await pending;
      }

      const left = await db
        .select()
        .from(memberships)
        .where(and(
          eq(memberships.schoolId, ctx.school.id),
          eq(memberships.role, "admin"),
          eq(memberships.isActive, true),
        ));

      // Whatever happened, somebody can still let people back in.
      expect(left.length).toBeGreaterThanOrEqual(1);
      void deputy;
    }, 30_000);
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
