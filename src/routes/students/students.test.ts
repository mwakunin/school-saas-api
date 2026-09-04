import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import type { TestUser } from "@/test/helpers";

import app from "@/app";
import db from "@/db";
import { enrollments, students } from "@/db/schema";
import {
  makeSchool,
  makeStream,
  resetDb,
  signInAt,
  tenantHeaders,
} from "@/test/helpers";

/**
 * The register: admitting children, placing them in classes, moving them, and
 * exiting them without losing anything.
 */
function jsonHeaders(subdomain: string, user: TestUser) {
  return { "content-type": "application/json", ...tenantHeaders(subdomain, user) };
}

async function post(path: string, body: unknown, headers: Record<string, string>) {
  return app.request(path, { method: "POST", headers, body: JSON.stringify(body) });
}

const CHILD = {
  admissionNumber: "2026/118",
  givenName: "Wanjiku",
  familyName: "Njoroge",
  admittedOn: "2026-01-06",
};

describe("students", () => {
  beforeEach(async () => {
    await resetDb();
  });

  describe("admission", () => {
    it("admits a child and places them in a class in one step", async () => {
      const alpha = await makeSchool({ subdomain: "alpha" });
      const stream = await makeStream(alpha, 4, "Blue");
      const clerk = await signInAt(alpha.id, "bursar");

      const res = await post(
        "/students",
        { ...CHILD, enrollment: { streamId: stream.id, boardingStatus: "day" } },
        jsonHeaders("alpha", clerk),
      );

      expect(res.status).toBe(201);
      const body = await res.json();

      expect(body).toMatchObject({
        admissionNumber: "2026/118",
        givenName: "Wanjiku",
        familyName: "Njoroge",
        status: "active",
      });
      // The class comes from the open enrollment, not a column on the student.
      expect(body.currentEnrollment).toMatchObject({
        boardingStatus: "day",
        // Defaults to the admission date, which is what it is in practice.
        startedOn: "2026-01-06",
        stream: { name: "Blue", gradeLevel: { name: "Grade 4" } },
      });
    });

    it("admits without a class, since a school may not have decided yet", async () => {
      const alpha = await makeSchool({ subdomain: "alpha" });
      const clerk = await signInAt(alpha.id, "bursar");

      const res = await post("/students", CHILD, jsonHeaders("alpha", clerk));

      expect(res.status).toBe(201);
      expect((await res.json()).currentEnrollment).toBeNull();
    });

    it("409s a duplicate admission number at the same school", async () => {
      const alpha = await makeSchool({ subdomain: "alpha" });
      const clerk = await signInAt(alpha.id, "bursar");

      await post("/students", CHILD, jsonHeaders("alpha", clerk));
      const second = await post("/students", CHILD, jsonHeaders("alpha", clerk));

      expect(second.status).toBe(409);
    });

    it("allows the same admission number at a different school", async () => {
      const alpha = await makeSchool({ subdomain: "alpha" });
      const beta = await makeSchool({ subdomain: "beta" });
      const alphaClerk = await signInAt(alpha.id, "bursar");
      const betaClerk = await signInAt(beta.id, "bursar");

      // Admission numbers are school-scoped; "2026/118" at two schools is two
      // different children and must not collide.
      expect((await post("/students", CHILD, jsonHeaders("alpha", alphaClerk))).status).toBe(201);
      expect((await post("/students", CHILD, jsonHeaders("beta", betaClerk))).status).toBe(201);
    });

    it("allows the same UPI at a different school, since transfers duplicate it", async () => {
      const alpha = await makeSchool({ subdomain: "alpha" });
      const beta = await makeSchool({ subdomain: "beta" });
      const alphaClerk = await signInAt(alpha.id, "bursar");
      const betaClerk = await signInAt(beta.id, "bursar");

      const withUpi = { ...CHILD, upiNumber: "UPI-0001" };

      // A globally unique UPI would need one row readable by two tenants,
      // which puts a hole through the isolation model. A transfer creates a
      // fresh row at the receiving school instead.
      expect((await post("/students", withUpi, jsonHeaders("alpha", alphaClerk))).status).toBe(201);
      expect((await post("/students", withUpi, jsonHeaders("beta", betaClerk))).status).toBe(201);
    });

    it("lets many students have no UPI without colliding", async () => {
      const alpha = await makeSchool({ subdomain: "alpha" });
      const clerk = await signInAt(alpha.id, "bursar");

      // Postgres treats NULLs as distinct, which is what makes the unique
      // constraint usable while most children have no UPI recorded yet.
      for (const n of ["2026/001", "2026/002", "2026/003"]) {
        const res = await post(
          "/students",
          { ...CHILD, admissionNumber: n },
          jsonHeaders("alpha", clerk),
        );
        expect(res.status).toBe(201);
      }
    });

    it("422s a stream belonging to another school", async () => {
      const alpha = await makeSchool({ subdomain: "alpha" });
      const beta = await makeSchool({ subdomain: "beta" });
      const betaStream = await makeStream(beta, 4, "Blue");
      const clerk = await signInAt(alpha.id, "bursar");

      const res = await post(
        "/students",
        { ...CHILD, enrollment: { streamId: betaStream.id, boardingStatus: "day" } },
        jsonHeaders("alpha", clerk),
      );

      expect(res.status).toBe(422);
      // And nothing was admitted — the whole request rolls back.
      expect(await db.select().from(students)).toHaveLength(0);
    });

    it("422s a birth date in the future", async () => {
      const alpha = await makeSchool({ subdomain: "alpha" });
      const clerk = await signInAt(alpha.id, "bursar");

      const res = await post(
        "/students",
        { ...CHILD, dateOfBirth: "2099-01-01" },
        jsonHeaders("alpha", clerk),
      );

      expect(res.status).toBe(422);
    });

    it("403s a teacher, since admission is an office function", async () => {
      const alpha = await makeSchool({ subdomain: "alpha" });
      const teacher = await signInAt(alpha.id, "teacher");

      const res = await post("/students", CHILD, jsonHeaders("alpha", teacher));
      expect(res.status).toBe(403);
    });

    it("403s a guardian outright", async () => {
      const alpha = await makeSchool({ subdomain: "alpha" });
      const parent = await signInAt(alpha.id, "guardian");

      // The register is not the parent portal. A guardian must never be able
      // to enumerate other people's children.
      const res = await app.request("/students", {
        headers: tenantHeaders("alpha", parent),
      });
      expect(res.status).toBe(403);
    });
  });

  describe("the register", () => {
    async function seedClass(subdomain: string) {
      const school = await makeSchool({ subdomain });
      const blue = await makeStream(school, 4, "Blue");
      const east = await makeStream(school, 5, "East");
      const clerk = await signInAt(school.id, "bursar");

      const names = [
        ["2026/001", "Wanjiku", "Njoroge"],
        ["2026/002", "Otieno", "Achieng"],
        ["2026/003", "Kiplagat", "Chebet"],
      ] as const;

      for (const [admissionNumber, givenName, familyName] of names) {
        await post(
          "/students",
          {
            admissionNumber,
            givenName,
            familyName,
            admittedOn: "2026-01-06",
            enrollment: {
              streamId: admissionNumber === "2026/003" ? east.id : blue.id,
              boardingStatus: "day",
            },
          },
          jsonHeaders(subdomain, clerk),
        );
      }

      return { school, blue, east, clerk };
    }

    it("lists active students in family-name order", async () => {
      const { clerk } = await seedClass("alpha");

      const res = await app.request("/students", {
        headers: tenantHeaders("alpha", clerk),
      });

      const body = await res.json();
      expect(body.total).toBe(3);
      // Family name first — how a Kenyan register is read and looked up.
      expect(body.students.map((s: { familyName: string }) => s.familyName))
        .toEqual(["Achieng", "Chebet", "Njoroge"]);
    });

    it("filters to one class by open enrollment", async () => {
      const { blue, clerk } = await seedClass("alpha");

      const res = await app.request(`/students?streamId=${blue.id}`, {
        headers: tenantHeaders("alpha", clerk),
      });

      const body = await res.json();
      expect(body.total).toBe(2);
      expect(body.students.every((s: { currentEnrollment: { streamId: string } }) =>
        s.currentEnrollment.streamId === blue.id)).toBe(true);
    });

    it("searches names and admission numbers", async () => {
      const { clerk } = await seedClass("alpha");

      const byName = await (await app.request("/students?q=Wanjiku", {
        headers: tenantHeaders("alpha", clerk),
      })).json();
      expect(byName.total).toBe(1);

      // Half the time the office is reading a number off a fee slip.
      const byNumber = await (await app.request("/students?q=2026/003", {
        headers: tenantHeaders("alpha", clerk),
      })).json();
      expect(byNumber.total).toBe(1);
      expect(byNumber.students[0].givenName).toBe("Kiplagat");
    });

    it("shows one school none of another's children", async () => {
      await seedClass("alpha");
      const beta = await makeSchool({ subdomain: "beta" });
      const betaClerk = await signInAt(beta.id, "bursar");

      const res = await app.request("/students", {
        headers: tenantHeaders("beta", betaClerk),
      });

      expect((await res.json()).total).toBe(0);
    });
  });

  describe("moving between classes", () => {
    it("closes the old enrollment when opening a new one", async () => {
      const alpha = await makeSchool({ subdomain: "alpha" });
      const blue = await makeStream(alpha, 4, "Blue");
      const east = await makeStream(alpha, 4, "East");
      const clerk = await signInAt(alpha.id, "bursar");

      const created = await (await post(
        "/students",
        { ...CHILD, enrollment: { streamId: blue.id, boardingStatus: "day" } },
        jsonHeaders("alpha", clerk),
      )).json();

      const res = await post(
        `/students/${created.id}/enrollments`,
        { streamId: east.id, boardingStatus: "day", startedOn: "2026-05-04" },
        jsonHeaders("alpha", clerk),
      );

      expect(res.status).toBe(201);
      const body = await res.json();

      expect(body.currentEnrollment.stream.name).toBe("East");
      expect(body.enrollments).toHaveLength(2);

      // The old row is closed, not rewritten — which is what keeps last term's
      // marks pointing at Blue.
      const closed = body.enrollments.find(
        (e: { stream: { name: string } }) => e.stream.name === "Blue",
      );
      expect(closed.endedOn).toBe("2026-05-03");
    });

    it("refuses two classes covering the same day", async () => {
      const alpha = await makeSchool({ subdomain: "alpha" });
      const blue = await makeStream(alpha, 4, "Blue");
      const east = await makeStream(alpha, 4, "East");
      const clerk = await signInAt(alpha.id, "bursar");

      const created = await (await post(
        "/students",
        { ...CHILD, enrollment: { streamId: blue.id, boardingStatus: "day" } },
        jsonHeaders("alpha", clerk),
      )).json();

      // Ending Blue on the 4th while East also starts on the 4th: a child in
      // two classes on one day. Scores hang off enrollmentId, so this would
      // make a mark's class genuinely ambiguous.
      const res = await post(
        `/students/${created.id}/enrollments`,
        {
          streamId: east.id,
          boardingStatus: "day",
          startedOn: "2026-05-04",
          previousEndedOn: "2026-05-04",
        },
        jsonHeaders("alpha", clerk),
      );

      expect(res.status).toBe(409);

      // And the move did not half-happen.
      const rows = await db
        .select()
        .from(enrollments)
        .where(eq(enrollments.studentId, created.id));
      expect(rows).toHaveLength(1);
      expect(rows[0].endedOn).toBeNull();
    });

    it("422s a move dated before the current placement began", async () => {
      const alpha = await makeSchool({ subdomain: "alpha" });
      const blue = await makeStream(alpha, 4, "Blue");
      const east = await makeStream(alpha, 4, "East");
      const clerk = await signInAt(alpha.id, "bursar");

      const created = await (await post(
        "/students",
        { ...CHILD, enrollment: { streamId: blue.id, boardingStatus: "day" } },
        jsonHeaders("alpha", clerk),
      )).json();

      // Blue began on 2026-01-06, so closing it "the day before" 2026-01-01
      // would end it before it started. A mistyped date, not a server fault.
      const res = await post(
        `/students/${created.id}/enrollments`,
        { streamId: east.id, boardingStatus: "day", startedOn: "2026-01-01" },
        jsonHeaders("alpha", clerk),
      );

      expect(res.status).toBe(422);
    });

    it("keeps a boarding change as a new enrollment, not an edit", async () => {
      const alpha = await makeSchool({ subdomain: "alpha" });
      const blue = await makeStream(alpha, 4, "Blue");
      const clerk = await signInAt(alpha.id, "bursar");

      const created = await (await post(
        "/students",
        { ...CHILD, enrollment: { streamId: blue.id, boardingStatus: "day" } },
        jsonHeaders("alpha", clerk),
      )).json();

      const res = await post(
        `/students/${created.id}/enrollments`,
        { streamId: blue.id, boardingStatus: "boarder", startedOn: "2026-05-04" },
        jsonHeaders("alpha", clerk),
      );

      // Fees differ between day and boarder, so when the change happened has
      // to survive — editing the existing row would lose it.
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.currentEnrollment.boardingStatus).toBe("boarder");
      expect(body.enrollments).toHaveLength(2);
    });
  });

  describe("leaving", () => {
    async function admitted(subdomain: string) {
      const school = await makeSchool({ subdomain });
      const blue = await makeStream(school, 4, "Blue");
      const clerk = await signInAt(school.id, "bursar");
      const student = await (await post(
        "/students",
        { ...CHILD, enrollment: { streamId: blue.id, boardingStatus: "day" } },
        jsonHeaders(subdomain, clerk),
      )).json();
      return { school, blue, clerk, student };
    }

    it("closes the enrollment and records the date", async () => {
      const { clerk, student } = await admitted("alpha");

      const res = await post(
        `/students/${student.id}/exit`,
        { status: "transferred_out", exitedOn: "2026-03-20" },
        jsonHeaders("alpha", clerk),
      );

      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.status).toBe("transferred_out");
      expect(body.exitedOn).toBe("2026-03-20");
      // Leaving the enrollment open is what produces a withdrawn child who
      // still appears on class lists and still gets invoiced.
      expect(body.currentEnrollment).toBeNull();
      expect(body.enrollments[0].endedOn).toBe("2026-03-20");
    });

    it("keeps the record fully queryable afterwards", async () => {
      const { clerk, student } = await admitted("alpha");

      await post(
        `/students/${student.id}/exit`,
        { status: "withdrawn", exitedOn: "2026-03-20" },
        jsonHeaders("alpha", clerk),
      );

      // CLAUDE.md §3 rule 5: nothing hard-deletes. A transfer certificate two
      // years from now depends on this.
      const res = await app.request(`/students/${student.id}`, {
        headers: tenantHeaders("alpha", clerk),
      });
      expect(res.status).toBe(200);
      expect((await res.json()).enrollments).toHaveLength(1);
    });

    it("drops them from the default register but keeps them findable", async () => {
      const { clerk, student } = await admitted("alpha");

      await post(
        `/students/${student.id}/exit`,
        { status: "withdrawn", exitedOn: "2026-03-20" },
        jsonHeaders("alpha", clerk),
      );

      const active = await (await app.request("/students", {
        headers: tenantHeaders("alpha", clerk),
      })).json();
      expect(active.total).toBe(0);

      const all = await (await app.request("/students?includeExited=true", {
        headers: tenantHeaders("alpha", clerk),
      })).json();
      expect(all.total).toBe(1);
    });

    it("409s a second exit", async () => {
      const { clerk, student } = await admitted("alpha");
      const body = { status: "withdrawn", exitedOn: "2026-03-20" };

      await post(`/students/${student.id}/exit`, body, jsonHeaders("alpha", clerk));
      const again = await post(
        `/students/${student.id}/exit`,
        body,
        jsonHeaders("alpha", clerk),
      );

      expect(again.status).toBe(409);
    });

    it("422s an exit before admission", async () => {
      const { clerk, student } = await admitted("alpha");

      const res = await post(
        `/students/${student.id}/exit`,
        { status: "withdrawn", exitedOn: "2025-01-01" },
        jsonHeaders("alpha", clerk),
      );

      expect(res.status).toBe(422);
    });

    it("readmits a child exited by mistake", async () => {
      const { blue, clerk, student } = await admitted("alpha");

      await post(
        `/students/${student.id}/exit`,
        { status: "withdrawn", exitedOn: "2026-03-20" },
        jsonHeaders("alpha", clerk),
      );

      const res = await post(
        `/students/${student.id}/readmit`,
        {
          enrollment: {
            streamId: blue.id,
            boardingStatus: "day",
            startedOn: "2026-03-21",
          },
        },
        jsonHeaders("alpha", clerk),
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("active");
      expect(body.exitedOn).toBeNull();
      expect(body.currentEnrollment.stream.name).toBe("Blue");
      // The old enrollment stays closed — the gap is real history.
      expect(body.enrollments).toHaveLength(2);
    });

    it("keeps status and exit date consistent at the database level", async () => {
      const { student } = await admitted("alpha");

      // The CHECK constraint, reached directly. An active student with an exit
      // date, or a withdrawn one without, breaks every roll and invoice run —
      // so the pair moves together or not at all.
      await expect(
        db.update(students)
          .set({ status: "withdrawn" })
          .where(eq(students.id, student.id)),
      ).rejects.toThrow();
    });
  });
});
