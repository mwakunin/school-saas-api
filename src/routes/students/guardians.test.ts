import { beforeEach, describe, expect, it } from "vitest";

import type { TestUser } from "@/test/helpers";

import app from "@/app";
import db from "@/db";
import { guardians as guardiansTable } from "@/db/schema";
import {
  makeSchool,
  makeStream,
  resetDb,
  signInAt,
  tenantHeaders,
} from "@/test/helpers";

/**
 * Guardians, and why they are a table rather than columns on the student.
 *
 * Siblings share a parent. Without this you send the same fee reminder three
 * times, store the phone number three ways, and have no way to answer "how
 * much does this family owe".
 */
function jsonHeaders(subdomain: string, user: TestUser) {
  return { "content-type": "application/json", ...tenantHeaders(subdomain, user) };
}

async function post(path: string, body: unknown, headers: Record<string, string>) {
  return app.request(path, { method: "POST", headers, body: JSON.stringify(body) });
}

async function setup(subdomain: string) {
  const school = await makeSchool({ subdomain });
  const blue = await makeStream(school, 4, "Blue");
  const clerk = await signInAt(school.id, "bursar");

  async function admit(admissionNumber: string, givenName: string) {
    const res = await post(
      "/students",
      {
        admissionNumber,
        givenName,
        familyName: "Njoroge",
        admittedOn: "2026-01-06",
        enrollment: { streamId: blue.id, boardingStatus: "day" },
      },
      jsonHeaders(subdomain, clerk),
    );
    return res.json();
  }

  return { school, blue, clerk, admit };
}

const PARENT = {
  name: "Grace Njoroge",
  phone: "0712345678",
  relationship: "mother",
};

describe("guardians", () => {
  beforeEach(async () => {
    await resetDb();
  });

  describe("recording a guardian", () => {
    it("normalises the phone number to E.164 on write", async () => {
      const { clerk } = await setup("alpha");

      const res = await post(
        "/guardians",
        { name: "Grace Njoroge", phone: "0712345678" },
        jsonHeaders("alpha", clerk),
      );

      expect(res.status).toBe(201);
      // Normalised on write, not at send time — the same parent typed four
      // different ways would otherwise be four rows and four reminders.
      expect((await res.json()).phone).toBe("+254712345678");
    });

    it.each([
      ["national format", "0712345678"],
      ["international with plus", "+254712345678"],
      ["international without plus", "254712345678"],
      ["bare subscriber number", "712345678"],
      ["with spaces", "0712 345 678"],
    ])("accepts %s and stores one canonical form", async (_case, phone) => {
      const { clerk } = await setup("alpha");

      const res = await post(
        "/guardians",
        { name: "Grace", phone },
        jsonHeaders("alpha", clerk),
      );

      expect(res.status).toBe(201);
      expect((await res.json()).phone).toBe("+254712345678");
    });

    it("422s a number that is not a Kenyan mobile", async () => {
      const { clerk } = await setup("alpha");

      const res = await post(
        "/guardians",
        { name: "Grace", phone: "+1 555 0100" },
        jsonHeaders("alpha", clerk),
      );

      expect(res.status).toBe(422);
    });

    it("409s a duplicate phone and hands back the existing record", async () => {
      const { clerk } = await setup("alpha");

      await post("/guardians", PARENT, jsonHeaders("alpha", clerk));
      // Entered differently the second time, which is exactly how duplicates
      // get created in practice.
      const again = await post(
        "/guardians",
        { name: "G. Njoroge", phone: "+254712345678" },
        jsonHeaders("alpha", clerk),
      );

      expect(again.status).toBe(409);
      const body = await again.json();
      // The existing record comes back so the caller can link to it rather
      // than being told "no" with nothing to act on.
      expect(body.existing).toMatchObject({ name: "Grace Njoroge" });
    });

    it("does not treat two schools' guardians as duplicates", async () => {
      const { clerk: alphaClerk } = await setup("alpha");
      const { clerk: betaClerk } = await setup("beta");

      expect((await post("/guardians", PARENT, jsonHeaders("alpha", alphaClerk))).status).toBe(201);
      expect((await post("/guardians", PARENT, jsonHeaders("beta", betaClerk))).status).toBe(201);
    });
  });

  describe("linking to children", () => {
    it("attaches a new guardian to a child in one request", async () => {
      const { clerk, admit } = await setup("alpha");
      const child = await admit("2026/001", "Wanjiku");

      const res = await post(
        `/students/${child.id}/guardians`,
        { guardian: { name: "Grace Njoroge", phone: "0712345678" }, relationship: "mother", isPrimary: true },
        jsonHeaders("alpha", clerk),
      );

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.guardians).toHaveLength(1);
      expect(body.guardians[0]).toMatchObject({
        name: "Grace Njoroge",
        phone: "+254712345678",
        relationship: "mother",
        isPrimary: true,
        canCollect: true,
      });
    });

    it("shares one guardian across siblings", async () => {
      const { clerk, admit } = await setup("alpha");
      const first = await admit("2026/001", "Wanjiku");
      const second = await admit("2026/002", "Kamau");

      const created = await (await post(
        "/guardians",
        PARENT,
        jsonHeaders("alpha", clerk),
      )).json();

      for (const child of [first, second]) {
        const res = await post(
          `/students/${child.id}/guardians`,
          { guardianId: created.id, relationship: "mother", isPrimary: true },
          jsonHeaders("alpha", clerk),
        );
        expect(res.status).toBe(201);
      }

      // One row, two children — which is what makes a single fee reminder
      // possible instead of one per child.
      expect(await db.select().from(guardiansTable)).toHaveLength(1);

      const view = await (await app.request(`/guardians/${created.id}`, {
        headers: tenantHeaders("alpha", clerk),
      })).json();

      expect(view.students).toHaveLength(2);
      expect(view.students.map((s: { givenName: string }) => s.givenName).sort())
        .toEqual(["Kamau", "Wanjiku"]);
    });

    it("keeps at most one primary contact per child", async () => {
      const { clerk, admit } = await setup("alpha");
      const child = await admit("2026/001", "Wanjiku");

      await post(
        `/students/${child.id}/guardians`,
        { guardian: { name: "Grace", phone: "0712345678" }, isPrimary: true },
        jsonHeaders("alpha", clerk),
      );
      const res = await post(
        `/students/${child.id}/guardians`,
        { guardian: { name: "Peter", phone: "0722345678" }, isPrimary: true },
        jsonHeaders("alpha", clerk),
      );

      const body = await res.json();
      // "Who do we ring" with two answers is the same as no answer.
      expect(body.guardians.filter((g: { isPrimary: boolean }) => g.isPrimary))
        .toHaveLength(1);
      expect(body.guardians[0].name).toBe("Peter");
    });

    it("409s linking the same guardian twice", async () => {
      const { clerk, admit } = await setup("alpha");
      const child = await admit("2026/001", "Wanjiku");
      const created = await (await post("/guardians", PARENT, jsonHeaders("alpha", clerk))).json();

      const body = { guardianId: created.id, relationship: "mother" };
      await post(`/students/${child.id}/guardians`, body, jsonHeaders("alpha", clerk));
      const again = await post(`/students/${child.id}/guardians`, body, jsonHeaders("alpha", clerk));

      expect(again.status).toBe(409);
    });

    it("422s a guardian from another school", async () => {
      const { clerk: alphaClerk, admit } = await setup("alpha");
      const { clerk: betaClerk } = await setup("beta");

      const child = await admit("2026/001", "Wanjiku");
      const betaGuardian = await (await post(
        "/guardians",
        PARENT,
        jsonHeaders("beta", betaClerk),
      )).json();

      const res = await post(
        `/students/${child.id}/guardians`,
        { guardianId: betaGuardian.id, relationship: "mother" },
        jsonHeaders("alpha", alphaClerk),
      );

      // Invisible under RLS, so the composite foreign key finds nothing.
      // Reported as 422 rather than 403: from alpha's side it does not exist.
      expect(res.status).toBe(422);
    });

    it("422s providing both an id and a new guardian", async () => {
      const { clerk, admit } = await setup("alpha");
      const child = await admit("2026/001", "Wanjiku");
      const created = await (await post("/guardians", PARENT, jsonHeaders("alpha", clerk))).json();

      const res = await post(
        `/students/${child.id}/guardians`,
        {
          guardianId: created.id,
          guardian: { name: "Someone", phone: "0733345678" },
        },
        jsonHeaders("alpha", clerk),
      );

      expect(res.status).toBe(422);
    });
  });

  describe("changing and removing a link", () => {
    it("changes what a guardian may do", async () => {
      const { clerk, admit } = await setup("alpha");
      const child = await admit("2026/001", "Wanjiku");

      const linked = await (await post(
        `/students/${child.id}/guardians`,
        { guardian: { name: "Uncle", phone: "0712345678" }, relationship: "uncle" },
        jsonHeaders("alpha", clerk),
      )).json();
      const guardianId = linked.guardians[0].id;

      const res = await app.request(
        `/students/${child.id}/guardians/${guardianId}`,
        {
          method: "PATCH",
          headers: jsonHeaders("alpha", clerk),
          body: JSON.stringify({ canCollect: false, receivesInvoices: false }),
        },
      );

      expect(res.status).toBe(200);
      expect((await res.json()).guardians[0]).toMatchObject({
        canCollect: false,
        receivesInvoices: false,
      });
    });

    it("removes a wrongly attached adult completely", async () => {
      const { clerk, admit } = await setup("alpha");
      const child = await admit("2026/001", "Wanjiku");

      const linked = await (await post(
        `/students/${child.id}/guardians`,
        { guardian: { name: "Wrong Person", phone: "0712345678" } },
        jsonHeaders("alpha", clerk),
      )).json();
      const guardianId = linked.guardians[0].id;

      const res = await app.request(
        `/students/${child.id}/guardians/${guardianId}`,
        { method: "DELETE", headers: tenantHeaders("alpha", clerk) },
      );

      expect(res.status).toBe(200);
      // The one genuine delete in the system: a right to collect a child must
      // not linger behind a flag some query forgot to filter on.
      expect((await res.json()).guardians).toEqual([]);

      // The guardian record itself survives — only the claim that they are
      // connected to this child goes.
      expect(await db.select().from(guardiansTable)).toHaveLength(1);
    });

    it("403s a teacher trying to detach a guardian", async () => {
      const { school, clerk, admit } = await setup("alpha");
      const child = await admit("2026/001", "Wanjiku");
      const linked = await (await post(
        `/students/${child.id}/guardians`,
        { guardian: { name: "Grace", phone: "0712345678" } },
        jsonHeaders("alpha", clerk),
      )).json();

      // Safeguarding decisions are an office function, not a classroom one.
      const teacher = await signInAt(school.id, "teacher");

      const res = await app.request(
        `/students/${child.id}/guardians/${linked.guardians[0].id}`,
        { method: "DELETE", headers: tenantHeaders("alpha", teacher) },
      );

      expect(res.status).toBe(403);
    });
  });

  describe("finding an existing guardian", () => {
    it("matches however the number was typed", async () => {
      const { clerk } = await setup("alpha");
      await post("/guardians", PARENT, jsonHeaders("alpha", clerk));

      // The clerk has "0712345678" on a form; the row holds "+254712345678".
      const res = await app.request("/guardians?phone=0712345678", {
        headers: tenantHeaders("alpha", clerk),
      });

      expect(await res.json()).toHaveLength(1);
    });

    it("finds nobody from another school", async () => {
      const { clerk: alphaClerk } = await setup("alpha");
      const { clerk: betaClerk } = await setup("beta");
      await post("/guardians", PARENT, jsonHeaders("beta", betaClerk));

      const res = await app.request("/guardians?phone=0712345678", {
        headers: tenantHeaders("alpha", alphaClerk),
      });

      expect(await res.json()).toEqual([]);
    });
  });
});
