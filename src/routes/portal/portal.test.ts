import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import type { TestUser } from "@/test/helpers";

import app from "@/app";
import db from "@/db";
import { guardians, studentGuardians, user } from "@/db/schema";
import {
  addMembership,
  makeInvoice,
  makeSchool,
  makeStream,
  makeStudent,
  nextEmail,
  nextPhone,
  resetDb,
  signIn,
  signInAt,
  signUpWithEmail,
  tenantHeaders,
} from "@/test/helpers";

/**
 * The parent portal, and the authorization axis it introduces.
 *
 * RLS keeps one school out of another's data and does NOTHING to keep one
 * family out of another's — every guardian at a school passes the same tenant
 * policy. So most of what follows is about the second scoping: a guardian sees
 * their own children and, however they ask, nobody else's.
 */
function jsonHeaders(subdomain: string, person: TestUser) {
  return { "content-type": "application/json", ...tenantHeaders(subdomain, person) };
}

function post(path: string, body: unknown, headers: Record<string, string>) {
  return app.request(path, { method: "POST", headers, body: JSON.stringify(body) });
}

async function seed(subdomain: string) {
  const school = await makeSchool({ subdomain });
  const blue = await makeStream(school, 4, "Blue");
  const office = await signInAt(school.id, "admin");

  /** A family: one guardian record, two children, and a login to claim it. */
  async function family(phone: string, admissionNumbers: string[]) {
    const [guardian] = await db
      .insert(guardians)
      .values({ schoolId: school.id, name: `Parent ${phone}`, phone })
      .returning();

    const children = [];
    for (const admissionNumber of admissionNumbers) {
      const student = await makeStudent(school, admissionNumber, { streamId: blue.id });
      await db.insert(studentGuardians).values({
        schoolId: school.id,
        studentId: student.id,
        guardianId: guardian.id,
        isPrimary: true,
        relationship: "mother",
      });
      children.push(student);
    }

    return { guardian, children };
  }

  return { school, blue, office, family, subdomain };
}

/** A guardian login whose phone is verified, which is what claiming needs. */
async function guardianLogin(schoolId: string, phone: string) {
  const person = await signIn(phone);
  await db.update(user).set({ phoneNumberVerified: true }).where(eq(user.id, person.id));
  await addMembership(person.id, schoolId, "guardian");
  return person;
}

describe("parent portal", () => {
  beforeEach(async () => {
    await resetDb();
  });

  describe("claiming an account", () => {
    it("works for a parent who has never been granted anything", async () => {
      const ctx = await seed("alpha");
      const phone = nextPhone();
      await ctx.family(phone, ["2026/001"]);

      // A real parent signs up and arrives with NO membership. Claiming is how
      // they get one, so claiming behind `withMembership` meant they could
      // never reach it — the portal was open only to people an admin had
      // already granted the role to by hand, which is nobody.
      const parent = await signIn(phone);
      await db.update(user)
        .set({ phoneNumberVerified: true })
        .where(eq(user.id, parent.id));

      const claimed = await (await post("/portal/claim", {}, jsonHeaders("alpha", parent))).json();
      expect(claimed.linked).toBe(1);

      // And the claim granted the role, so the rest of the portal opens.
      const children = await app.request("/portal/children", {
        headers: tenantHeaders("alpha", parent),
      });
      expect(children.status).toBe(200);
    });

    it("links a guardian by their verified phone number", async () => {
      const ctx = await seed("alpha");
      const phone = nextPhone();
      await ctx.family(phone, ["2026/001", "2026/002"]);
      const parent = await guardianLogin(ctx.school.id, phone);

      const claimed = await (await post("/portal/claim", {}, jsonHeaders("alpha", parent))).json();

      expect(claimed.linked).toBe(1);
      expect(claimed.matchedOn).toEqual(["phone"]);
      // Siblings: one guardian record, two children. The reason guardians are
      // a table and not columns on the student (§5.3).
      expect(claimed.children).toBe(2);
    });

    it("will not link on an UNVERIFIED identifier", async () => {
      const ctx = await seed("alpha");
      const phone = nextPhone();
      await ctx.family(phone, ["2026/001"]);

      // Signed in with the right number, but never proved they hold it.
      const parent = await signIn(phone);
      await db.update(user)
        .set({ phoneNumberVerified: false })
        .where(eq(user.id, parent.id));
      await addMembership(parent.id, ctx.school.id, "guardian");

      const claimed = await (await post("/portal/claim", {}, jsonHeaders("alpha", parent))).json();

      /*
       * The whole safety of self-service claiming rests on this.
       *
       * An unverified identifier means anyone who knows a parent's number
       * could sign up with it and read a child's marks.
       */
      expect(claimed.linked).toBe(0);
      expect(claimed.matchedOn).toEqual([]);
    });

    it("does not take a record another account already holds", async () => {
      const ctx = await seed("alpha");
      const shared = nextPhone();
      await ctx.family(shared, ["2026/001"]);

      const first = await guardianLogin(ctx.school.id, shared);
      await post("/portal/claim", {}, jsonHeaders("alpha", first));

      // Two parents can legitimately share a number; the first to claim holds
      // it. Reassigning would move one family's view onto another login.
      const second = await signIn(nextPhone());
      await db.update(user)
        .set({ phoneNumber: shared, phoneNumberVerified: true })
        .where(eq(user.id, second.id))
        .catch(() => null);
      await addMembership(second.id, ctx.school.id, "guardian");

      const claimed = await (await post("/portal/claim", {}, jsonHeaders("alpha", second))).json();
      expect(claimed.linked).toBe(0);
    });

    it("is safe to run twice", async () => {
      const ctx = await seed("alpha");
      const phone = nextPhone();
      await ctx.family(phone, ["2026/001"]);
      const parent = await guardianLogin(ctx.school.id, phone);

      await post("/portal/claim", {}, jsonHeaders("alpha", parent));
      const again = await (await post("/portal/claim", {}, jsonHeaders("alpha", parent))).json();

      expect(again.linked).toBe(0);
      expect(again.alreadyLinked).toBe(1);
      expect(again.children).toBe(1);
    });
  });

  describe("seeing only your own children", () => {
    async function twoFamilies() {
      const ctx = await seed("alpha");
      const minePhone = nextPhone();
      const mine = await ctx.family(minePhone, ["2026/001"]);
      const theirs = await ctx.family(nextPhone(), ["2026/002"]);
      const parent = await guardianLogin(ctx.school.id, minePhone);
      await post("/portal/claim", {}, jsonHeaders("alpha", parent));

      return { ctx, parent, mine, theirs };
    }

    it("lists my children and nobody else's", async () => {
      const { parent, mine } = await twoFamilies();

      const children = await (await app.request("/portal/children", {
        headers: tenantHeaders("alpha", parent),
      })).json();

      expect(children).toHaveLength(1);
      expect(children[0].studentId).toBe(mine.children[0].id);
      expect(children[0].className).toBe("Grade 4 Blue");
    });

    it.each([
      ["results", "/portal/children/{id}/results"],
      ["report cards", "/portal/children/{id}/report-cards"],
      ["fees", "/portal/children/{id}/fees"],
    ])("404s another family's child on %s", async (_label, template) => {
      const { parent, theirs } = await twoFamilies();

      const res = await app.request(
        template.replace("{id}", theirs.children[0].id),
        { headers: tenantHeaders("alpha", parent) },
      );

      /*
       * 404, not 403.
       *
       * A 403 would confirm the id names a real pupil here, which turns the
       * URL into a way to walk the register — the same reasoning that makes a
       * non-member get 404 rather than 403.
       */
      expect(res.status).toBe(404);
    });

    it("tells an unlinked account what to do rather than showing nothing", async () => {
      const ctx = await seed("alpha");
      const stranger = await guardianLogin(ctx.school.id, nextPhone());

      const res = await app.request("/portal/children", {
        headers: tenantHeaders("alpha", stranger),
      });

      // An empty list would look like "you have no children here", which is a
      // different problem with a different remedy.
      expect(res.status).toBe(409);
      expect((await res.json()).message).toContain("not linked");
    });
  });

  describe("what a parent may see", () => {
    it("shows the balance and the number to pay to", async () => {
      const ctx = await seed("alpha");
      const phone = nextPhone();
      const mine = await ctx.family(phone, ["2026/001"]);
      await makeInvoice(ctx.school, mine.children[0], { totalCents: 1_500_000 });
      const parent = await guardianLogin(ctx.school.id, phone);
      await post("/portal/claim", {}, jsonHeaders("alpha", parent));

      const fees = await (await app.request(
        `/portal/children/${mine.children[0].id}/fees`,
        { headers: tenantHeaders("alpha", parent) },
      )).json();

      expect(fees.balanceCents).toBe(1_500_000);
      // The admission number IS the M-Pesa account reference (§5.3): a parent
      // paying from this screen cannot mistype it.
      expect(fees.payToAccount).toBe("2026/001");
      expect(fees.invoices).toHaveLength(1);
    });

    it("refuses a staff member without a guardian membership", async () => {
      const ctx = await seed("alpha");

      const res = await app.request("/portal/children", {
        headers: tenantHeaders("alpha", ctx.office),
      });

      // An admin is not a parent. A person who is both holds two memberships.
      expect(res.status).toBe(403);
    });
  });

  describe("the office fallback", () => {
    it("grants the guardian role, or the link achieves nothing", async () => {
      const ctx = await seed("alpha");
      const mine = await ctx.family(nextPhone(), ["2026/001"]);
      // Signed up, never granted anything.
      const parent = await signUpWithEmail(nextEmail());

      await post(
        `/guardians/${mine.guardian.id}/link`,
        { email: parent.email },
        jsonHeaders("alpha", ctx.office),
      );

      // Without the membership the office would have done the work and the
      // family would still get a 404 from every portal route.
      const res = await app.request("/portal/children", {
        headers: tenantHeaders("alpha", parent),
      });
      expect(res.status).toBe(200);
    });

    it("links a parent whose details do not match the school's", async () => {
      const ctx = await seed("alpha");
      const mine = await ctx.family(nextPhone(), ["2026/001"]);

      // Signed up with an address the school never recorded — the ordinary
      // case self-service cannot cover.
      const parent = await signUpWithEmail(nextEmail());
      await addMembership(parent.id, ctx.school.id, "guardian");

      const linked = await post(
        `/guardians/${mine.guardian.id}/link`,
        { email: parent.email },
        jsonHeaders("alpha", ctx.office),
      );
      expect(linked.status).toBe(200);

      const children = await (await app.request("/portal/children", {
        headers: tenantHeaders("alpha", parent),
      })).json();
      expect(children).toHaveLength(1);
    });

    it("will not silently move a record off another account", async () => {
      const ctx = await seed("alpha");
      const phone = nextPhone();
      const mine = await ctx.family(phone, ["2026/001"]);
      const held = await guardianLogin(ctx.school.id, phone);
      await post("/portal/claim", {}, jsonHeaders("alpha", held));

      const other = await signUpWithEmail(nextEmail());
      const res = await post(
        `/guardians/${mine.guardian.id}/link`,
        { email: other.email },
        jsonHeaders("alpha", ctx.office),
      );

      // Re-linking is a real need, but doing it quietly would take one
      // person's view of their children away with nothing recorded.
      expect(res.status).toBe(409);
    });
  });
});
