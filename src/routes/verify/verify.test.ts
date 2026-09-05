import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import type { TestUser } from "@/test/helpers";

import app from "@/app";
import db from "@/db";
import { learningAreas, payments } from "@/db/schema";
import {
  makeSchool,
  makeStream,
  makeStudent,
  resetDb,
  signInAt,
  tenantHeaders,
} from "@/test/helpers";

/**
 * Documents that prove they are genuine.
 *
 * The value is entirely in what a stranger can and cannot learn. Somebody
 * handed a report card at admission must be able to confirm it; the same
 * person must not be able to walk the school's records, and must be told when
 * a receipt they are holding has been reversed — a case where "authentic" is
 * a true answer that misleads.
 */
async function seed(subdomain: string) {
  const school = await makeSchool({ subdomain });
  const blue = await makeStream(school, 4, "Blue");
  const admin = await signInAt(school.id, "admin");
  const bursar = await signInAt(school.id, "bursar");
  const teacher = await signInAt(school.id, "teacher");
  const term = school.terms[0];

  const headers = { "content-type": "application/json", ...tenantHeaders(subdomain, admin) };
  await app.request("/curriculum/seed", {
    method: "POST",
    headers,
    body: JSON.stringify({ phase: "primary" }),
  });

  const [maths] = await db
    .select()
    .from(learningAreas)
    .where(and(
      eq(learningAreas.schoolId, school.id),
      eq(learningAreas.name, "Mathematics"),
    ));

  const student = await makeStudent(school, "2026/001", {
    givenName: "Wanjiku",
    streamId: blue.id,
  });

  return { school, blue, admin, bursar, teacher, term, maths, student, subdomain };
}

function jsonHeaders(subdomain: string, user: TestUser) {
  return { "content-type": "application/json", ...tenantHeaders(subdomain, user) };
}

describe("document verification", () => {
  beforeEach(async () => {
    await resetDb();
  });

  describe("a fee receipt", () => {
    it("confirms a payment to somebody holding the receipt", async () => {
      const ctx = await seed("alpha");

      const payment = await (await app.request("/payments", {
        method: "POST",
        headers: jsonHeaders("alpha", ctx.bursar),
        body: JSON.stringify({
          studentId: ctx.student.id,
          method: "cash",
          amountCents: 500_000,
          reference: "Cash at the office",
        }),
      })).json();

      // No session, no subdomain — the way somebody outside the school arrives.
      const res = await app.request(`/verify/${payment.verificationCode}`);
      expect(res.status).toBe(200);

      const verified = await res.json();
      expect(verified.documentType).toBe("payment_receipt");
      expect(verified.student.admissionNumber).toBe("2026/001");
      expect(verified.summary.amountCents).toBe(500_000);
      expect(verified.status).toBe("valid");
    });

    it("says a reversed receipt is withdrawn, not merely authentic", async () => {
      const ctx = await seed("alpha");

      const payment = await (await app.request("/payments", {
        method: "POST",
        headers: jsonHeaders("alpha", ctx.bursar),
        body: JSON.stringify({
          studentId: ctx.student.id,
          method: "cash",
          amountCents: 500_000,
        }),
      })).json();

      await app.request(`/payments/${payment.id}/reverse`, {
        method: "POST",
        headers: jsonHeaders("alpha", ctx.bursar),
        body: JSON.stringify({ reason: "Recorded against the wrong child" }),
      });

      const verified = await (await app.request(`/verify/${payment.verificationCode}`)).json();

      /*
       * The case the whole feature is for.
       *
       * The paper is real and the money is not on the account any more, and
       * the person checking is very often checking BECAUSE of that. Answering
       * only "verified" would be a true statement that sends them away
       * satisfied and wrong.
       */
      expect(verified.status).toBe("withdrawn");
      expect(verified.statusReason).toContain("wrong child");
    });
  });

  describe("a report card", () => {
    async function finalisedCard(ctx: Awaited<ReturnType<typeof seed>>) {
      const assessment = await (await app.request("/assessments", {
        method: "POST",
        headers: jsonHeaders("alpha", ctx.teacher),
        body: JSON.stringify({
          termId: ctx.term.id,
          learningAreaId: ctx.maths.id,
          streamId: ctx.blue.id,
          title: "End of Term",
          kind: "exam",
          maxScore: 100,
        }),
      })).json();

      const detail = await (await app.request(`/students/${ctx.student.id}`, {
        headers: tenantHeaders("alpha", ctx.admin),
      })).json();

      await app.request(`/assessments/${assessment.id}/scores`, {
        method: "PUT",
        headers: jsonHeaders("alpha", ctx.teacher),
        body: JSON.stringify({
          scores: [{ enrollmentId: detail.currentEnrollment.id, rawScore: 82 }],
        }),
      });
      await app.request(`/assessments/${assessment.id}/publish`, {
        method: "POST",
        headers: jsonHeaders("alpha", ctx.teacher),
      });
      await app.request("/term-results/compute", {
        method: "POST",
        headers: jsonHeaders("alpha", ctx.admin),
        body: JSON.stringify({ termId: ctx.term.id }),
      });

      const card = await (await app.request("/report-cards/finalise", {
        method: "POST",
        headers: jsonHeaders("alpha", ctx.admin),
        body: JSON.stringify({
          enrollmentId: detail.currentEnrollment.id,
          termId: ctx.term.id,
          headComment: "A good term.",
        }),
      })).json();

      return { card, assessment, enrollmentId: detail.currentEnrollment.id };
    }

    it("shows what was printed, not what the marks say now", async () => {
      const ctx = await seed("alpha");
      const { card, assessment, enrollmentId } = await finalisedCard(ctx);

      const before = await (await app.request(`/verify/${card.verificationCode}`)).json();
      expect(before.documentType).toBe("report_card");
      expect(before.summary.learningAreas[0].meanScore).toBe(82);

      /*
       * The property rule 7 exists for, checked from the outside — by actually
       * moving the mark.
       *
       * The first version of this test rewrote `classTeacherComment`, which is
       * a column on the row and not part of the snapshot at all: the mean could
       * not have changed, so it asserted nothing. Correcting a published mark
       * and recomputing is the real thing, and it is the case that matters —
       * a parent's genuine document must not start failing verification the
       * moment a teacher fixes a number behind it.
       */
      await app.request(`/assessments/${assessment.id}/unpublish`, {
        method: "POST",
        headers: jsonHeaders("alpha", ctx.teacher),
      });
      await app.request(`/assessments/${assessment.id}/scores`, {
        method: "PUT",
        headers: jsonHeaders("alpha", ctx.teacher),
        body: JSON.stringify({ scores: [{ enrollmentId, rawScore: 41 }] }),
      });
      await app.request(`/assessments/${assessment.id}/publish`, {
        method: "POST",
        headers: jsonHeaders("alpha", ctx.teacher),
      });
      await app.request("/term-results/compute", {
        method: "POST",
        headers: jsonHeaders("alpha", ctx.admin),
        body: JSON.stringify({ termId: ctx.term.id }),
      });

      // The live result really did move; the frozen document did not.
      const live = await (await app.request(
        `/term-results?termId=${ctx.term.id}&enrollmentId=${enrollmentId}`,
        { headers: tenantHeaders("alpha", ctx.admin) },
      )).json();
      expect(Number(live[0].meanScore)).toBe(41);

      const after = await (await app.request(`/verify/${card.verificationCode}`)).json();
      expect(after.summary.learningAreas[0].meanScore).toBe(82);
    });

    it("verifies a child who has since moved class", async () => {
      const ctx = await seed("alpha");
      const { card } = await finalisedCard(ctx);

      const green = await makeStream(ctx.school, 4, "Green");
      await app.request(`/students/${ctx.student.id}/enrollments`, {
        method: "POST",
        headers: jsonHeaders("alpha", ctx.admin),
        body: JSON.stringify({
          streamId: green.id,
          boardingStatus: "day",
          startedOn: new Date().toISOString().slice(0, 10),
        }),
      });

      /*
       * The document says the class the child was in when it was printed.
       *
       * Reading this from the live enrolment — which is what the first version
       * did — meant a pupil who changed stream had their genuine report card
       * verified against a class it does not name, and the person checking
       * would reasonably conclude it was forged.
       */
      const verified = await (await app.request(`/verify/${card.verificationCode}`)).json();
      expect(verified.className).toBe("Grade 4 Blue");
    });

    it("carries a QR and an address a person could type", async () => {
      const ctx = await seed("alpha");
      const { card } = await finalisedCard(ctx);

      const printable = await (await app.request(`/report-cards/${card.id}`, {
        headers: tenantHeaders("alpha", ctx.admin),
      })).json();

      // The SVG travels with the document, so whatever renders the page has it
      // in hand rather than needing a second call it might forget to make.
      expect(printable.verificationQrSvg).toContain("<svg");
      expect(printable.verificationUrl).toContain(printable.verificationCode);
    });
  });

  describe("what it refuses", () => {
    it("answers the same way for an unknown code as a mistyped one", async () => {
      const missing = await app.request("/verify/aaaaaaaaaaaaaaaaaaaaaaaa");
      expect(missing.status).toBe(404);
      expect((await missing.json()).verified).toBe(false);
    });

    it("has no way to ask for anything but one document", async () => {
      const ctx = await seed("alpha");
      await app.request("/payments", {
        method: "POST",
        headers: jsonHeaders("alpha", ctx.bursar),
        body: JSON.stringify({
          studentId: ctx.student.id,
          method: "cash",
          amountCents: 500_000,
        }),
      });

      /*
       * The isolation argument for a public endpoint on the owner connection.
       *
       * There is no parameter here that could widen a result set — no name, no
       * admission number, no date. A caller can only ever name one code, so
       * the reach of this route is exactly the documents they already hold.
       */
      const [row] = await db.select().from(payments).limit(1);
      const res = await app.request(`/verify/${row.verificationCode}`);
      const verified = await res.json();

      expect(Object.keys(verified).sort()).toEqual([
        "className",
        "documentType",
        "issuedAt",
        "school",
        "status",
        "statusReason",
        "student",
        "summary",
        "term",
      ]);
    });
  });
});
