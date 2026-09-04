import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import type { TestUser } from "@/test/helpers";

import app from "@/app";
import db from "@/db";
import { assessmentScores, enrollments, learningAreas, reportCards, schools, termResults } from "@/db/schema";
import { isCheckViolation, pgConstraintName } from "@/lib/db-errors";
import {
  makeSchool,
  makeStream,
  makeStudent,
  resetDb,
  signInAt,
  tenantHeaders,
} from "@/test/helpers";

/**
 * The CBE grading flow, end to end.
 *
 * Two systems run side by side: percentage exams that produce a mark and a
 * position, and competency judgements that produce a level per sub-strand.
 * Most of what follows is about them staying distinct — the failure mode is a
 * report card that averages one into the other and reads plausibly while
 * saying something nobody meant.
 */
function jsonHeaders(subdomain: string, user: TestUser) {
  return { "content-type": "application/json", ...tenantHeaders(subdomain, user) };
}

function post(path: string, body: unknown, headers: Record<string, string>) {
  return app.request(path, { method: "POST", headers, body: JSON.stringify(body) });
}

function put(path: string, body: unknown, headers: Record<string, string>) {
  return app.request(path, { method: "PUT", headers, body: JSON.stringify(body) });
}

/** A school with a curriculum, a class, and three children in it. */
async function seed(subdomain: string) {
  const school = await makeSchool({ subdomain });
  const blue = await makeStream(school, 4, "Blue");
  const admin = await signInAt(school.id, "admin");
  const teacher = await signInAt(school.id, "teacher");
  const term = school.terms[0];

  await post("/curriculum/seed", { phase: "primary" }, jsonHeaders(subdomain, admin));

  // Scoped by school: this runs on the OWNER connection, which is exempt from
  // RLS, so a bare name lookup would pick whichever school seeded first.
  const [maths] = await db
    .select()
    .from(learningAreas)
    .where(and(
      eq(learningAreas.schoolId, school.id),
      eq(learningAreas.name, "Mathematics"),
    ));

  const area = await (await app.request(`/learning-areas/${maths.id}`, {
    headers: tenantHeaders(subdomain, admin),
  })).json();

  const subStrands = area.strands.flatMap(
    (s: { children: Array<{ id: string; title: string }> }) => s.children,
  );

  const pupils = [];
  for (const [n, name] of [
    ["2026/001", "Wanjiku"],
    ["2026/002", "Otieno"],
    ["2026/003", "Chebet"],
  ] as const) {
    const student = await makeStudent(school, n, {
      givenName: name,
      streamId: blue.id,
    });
    const [enrolment] = await db
      .select()
      .from(enrollments)
      .where(eq(enrollments.studentId, student.id));
    pupils.push({ student, enrolmentId: enrolment.id });
  }

  return { school, blue, admin, teacher, term, maths, subStrands, pupils, subdomain };
}

async function makeAssessment(
  ctx: Awaited<ReturnType<typeof seed>>,
  overrides: Record<string, unknown> = {},
) {
  const res = await post("/assessments", {
    termId: ctx.term.id,
    learningAreaId: ctx.maths.id,
    streamId: ctx.blue.id,
    title: "Opener Exam",
    kind: "exam",
    maxScore: 100,
    ...overrides,
  }, jsonHeaders(ctx.subdomain, ctx.teacher));

  return res.json();
}

describe("assessment", () => {
  beforeEach(async () => {
    await resetDb();
  });

  describe("the curriculum a school starts from", () => {
    it("seeds learning areas with a strand tree", async () => {
      const { admin, maths, subdomain } = await seed("alpha");

      const area = await (await app.request(`/learning-areas/${maths.id}`, {
        headers: tenantHeaders(subdomain, admin),
      })).json();

      expect(area.name).toBe("Mathematics");
      expect(area.strands).toHaveLength(2);
      expect(area.strands[0].children).toHaveLength(2);
    });

    it("marks seeded strands as placeholders rather than pretending", async () => {
      const { admin, maths, subdomain } = await seed("alpha");

      const area = await (await app.request(`/learning-areas/${maths.id}`, {
        headers: tenantHeaders(subdomain, admin),
      })).json();

      // A teacher must be able to tell the starter set from their school's own
      // curriculum, rather than assuming these are KICD's published designs.
      expect(area.strands[0].isPlaceholder).toBe(true);
    });

    it("gives junior school the areas primary does not have", async () => {
      const school = await makeSchool({ subdomain: "beta" });
      const admin = await signInAt(school.id, "admin");

      await post("/curriculum/seed", { phase: "junior" }, jsonHeaders("beta", admin));

      const areas = await (await app.request("/learning-areas", {
        headers: tenantHeaders("beta", admin),
      })).json();
      const names = areas.map((a: { name: string }) => a.name);

      // The reason `phase` exists rather than a grade number.
      expect(names).toContain("Integrated Science");
      expect(names).toContain("Pre-Technical Studies");
      expect(names).not.toContain("Environmental Activities");
    });

    it("is safe to re-run and keeps the school's edits", async () => {
      const { admin, maths, subdomain } = await seed("alpha");

      await app.request(`/learning-areas/${maths.id}`, {
        method: "PATCH",
        headers: jsonHeaders(subdomain, admin),
        body: JSON.stringify({ name: "Mathematics (Upper)" }),
      });

      const again = await (await post(
        "/curriculum/seed",
        { phase: "primary" },
        jsonHeaders(subdomain, admin),
      )).json();

      // The renamed area no longer matches by name, so it is re-created — but
      // the school's edit survives untouched, which is the property that
      // matters.
      const areas = await (await app.request("/learning-areas", {
        headers: tenantHeaders(subdomain, admin),
      })).json();
      expect(areas.map((a: { name: string }) => a.name)).toContain("Mathematics (Upper)");
      expect(again.skippedExisting).toBeGreaterThan(0);
    });

    it("names the field when an area is added twice, rather than falling over", async () => {
      const { admin, subdomain } = await seed("alpha");

      // The commonest way to hit the name index: a school that seeded, then
      // added a subject it thought was missing. `updateArea` already answered
      // for this; creating did not, so it came back a 500.
      const res = await post("/learning-areas", {
        name: "mathematics",
        code: "MAT2",
        sequence: 31,
      }, jsonHeaders(subdomain, admin));

      expect(res.status).toBe(422);
      expect((await res.json()).error.issues[0].path).toEqual(["name"]);
    });

    it("refuses to remove a learning area that has been assessed", async () => {
      const ctx = await seed("alpha");
      const assessment = await makeAssessment(ctx);
      await put(`/assessments/${assessment.id}/scores`, {
        scores: [{ enrollmentId: ctx.pupils[0].enrolmentId, rawScore: 70 }],
      }, jsonHeaders("alpha", ctx.teacher));

      const res = await app.request(`/learning-areas/${ctx.maths.id}`, {
        method: "DELETE",
        headers: tenantHeaders("alpha", ctx.admin),
      });

      // Removing it would take a child's marks with it.
      expect(res.status).toBe(409);
    });
  });

  describe("entering marks", () => {
    it("saves the whole grid in one request", async () => {
      const ctx = await seed("alpha");
      const assessment = await makeAssessment(ctx);

      const res = await put(`/assessments/${assessment.id}/scores`, {
        scores: ctx.pupils.map((p, i) => ({
          enrollmentId: p.enrolmentId,
          rawScore: 60 + i * 10,
        })),
      }, jsonHeaders("alpha", ctx.teacher));

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ saved: 3 });
      expect(await db.select().from(assessmentScores)).toHaveLength(3);
    });

    it("corrects rather than duplicates when the grid is re-submitted", async () => {
      const ctx = await seed("alpha");
      const assessment = await makeAssessment(ctx);
      const grid = (score: number) => ({
        scores: [{ enrollmentId: ctx.pupils[0].enrolmentId, rawScore: score }],
      });

      await put(`/assessments/${assessment.id}/scores`, grid(70), jsonHeaders("alpha", ctx.teacher));
      await put(`/assessments/${assessment.id}/scores`, grid(75), jsonHeaders("alpha", ctx.teacher));

      /*
       * The NULLS NOT DISTINCT unique is what makes this work.
       *
       * On the percentage path `competency_id` is null, and Postgres treats
       * nulls as distinct by default — so an ordinary unique would have let a
       * corrected mark become a second row, and the child would have two marks
       * for one paper.
       */
      const rows = await db.select().from(assessmentScores);
      expect(rows).toHaveLength(1);
      expect(Number(rows[0].rawScore)).toBe(75);
    });

    it("refuses a mark above the paper's total", async () => {
      const ctx = await seed("alpha");
      const assessment = await makeAssessment(ctx, { maxScore: 50 });

      const res = await put(`/assessments/${assessment.id}/scores`, {
        scores: [{ enrollmentId: ctx.pupils[0].enrolmentId, rawScore: 500 }],
      }, jsonHeaders("alpha", ctx.teacher));

      // A doubled digit, every time.
      expect(res.status).toBe(422);
    });

    it("refuses a mark alongside an absence", async () => {
      const ctx = await seed("alpha");
      const assessment = await makeAssessment(ctx);

      const res = await put(`/assessments/${assessment.id}/scores`, {
        scores: [{ enrollmentId: ctx.pupils[0].enrolmentId, rawScore: 0, isAbsent: true }],
      }, jsonHeaders("alpha", ctx.teacher));

      // An absence is not a zero: storing it as one drags a mean down for a
      // paper the child never sat, and afterwards they are indistinguishable.
      expect(res.status).toBe(422);
    });

    it("saves nothing when one row of the grid is bad", async () => {
      const ctx = await seed("alpha");
      const assessment = await makeAssessment(ctx);

      await put(`/assessments/${assessment.id}/scores`, {
        scores: [
          { enrollmentId: ctx.pupils[0].enrolmentId, rawScore: 70 },
          { enrollmentId: "4651e634-a530-4484-9b09-9616a28f35e3", rawScore: 80 },
        ],
      }, jsonHeaders("alpha", ctx.teacher));

      // A partly saved grid is worse than a failed one: a teacher cannot tell
      // which rows landed, and re-entering risks doubling the ones that did.
      expect(await db.select().from(assessmentScores)).toHaveLength(0);
    });

    it("403s a bursar, who has no business entering marks", async () => {
      const ctx = await seed("alpha");
      const bursar = await signInAt(ctx.school.id, "bursar");
      const assessment = await makeAssessment(ctx);

      const res = await put(`/assessments/${assessment.id}/scores`, {
        scores: [{ enrollmentId: ctx.pupils[0].enrolmentId, rawScore: 70 }],
      }, jsonHeaders("alpha", bursar));

      expect(res.status).toBe(403);
    });
  });

  describe("publishing", () => {
    it("keeps unpublished marks out of the term result", async () => {
      const ctx = await seed("alpha");
      const assessment = await makeAssessment(ctx);
      await put(`/assessments/${assessment.id}/scores`, {
        scores: [{ enrollmentId: ctx.pupils[0].enrolmentId, rawScore: 80 }],
      }, jsonHeaders("alpha", ctx.teacher));

      const before = await (await post("/term-results/compute", {
        termId: ctx.term.id,
      }, jsonHeaders("alpha", ctx.admin))).json();

      // Teachers enter over days and correct as they go; a mean that moved
      // under a parent looking at it is the complaint this prevents.
      expect(before.results).toBe(0);

      await post(`/assessments/${assessment.id}/publish`, {}, jsonHeaders("alpha", ctx.teacher));

      const after = await (await post("/term-results/compute", {
        termId: ctx.term.id,
      }, jsonHeaders("alpha", ctx.admin))).json();
      expect(after.results).toBe(1);
    });

    it("closes a published assessment to edits", async () => {
      const ctx = await seed("alpha");
      const assessment = await makeAssessment(ctx);
      await post(`/assessments/${assessment.id}/publish`, {}, jsonHeaders("alpha", ctx.teacher));

      const res = await put(`/assessments/${assessment.id}/scores`, {
        scores: [{ enrollmentId: ctx.pupils[0].enrolmentId, rawScore: 90 }],
      }, jsonHeaders("alpha", ctx.teacher));

      // Withdrawing first makes the change deliberate, and visible.
      expect(res.status).toBe(409);

      await post(`/assessments/${assessment.id}/unpublish`, {}, jsonHeaders("alpha", ctx.teacher));
      const retry = await put(`/assessments/${assessment.id}/scores`, {
        scores: [{ enrollmentId: ctx.pupils[0].enrolmentId, rawScore: 90 }],
      }, jsonHeaders("alpha", ctx.teacher));
      expect(retry.status).toBe(200);
    });

    it("makes a concurrent publish wait rather than landing mid-save", async () => {
      const ctx = await seed("alpha");
      const assessment = await makeAssessment(ctx);

      /*
       * The published check is only worth something if the answer cannot
       * change between reading it and writing the marks.
       *
       * READ COMMITTED gives every statement its own snapshot, so a publish
       * committing in that gap left the save going ahead into an assessment
       * parents had already been shown — and nothing afterwards recorded that
       * it happened, because both requests returned success.
       *
       * Racing two requests and hoping to land in the window would be a test
       * that mostly passes either way. Instead an uncommitted publish is held
       * open, which is the real thing: the same row, the same lock, taken by
       * the same statement `publishAssessment` runs.
       */
      const publishing = Promise.withResolvers<void>();
      const commit = Promise.withResolvers<void>();

      const holder = db.transaction(async (tx) => {
        await tx.execute(sql`
          UPDATE assessments SET published_at = now() WHERE id = ${assessment.id}
        `);
        publishing.resolve();
        await commit.promise;
      });

      await publishing.promise;

      const save = Promise.resolve(put(`/assessments/${assessment.id}/scores`, {
        scores: [{ enrollmentId: ctx.pupils[0].enrolmentId, rawScore: 90 }],
      }, jsonHeaders("alpha", ctx.teacher)));

      /*
       * Note what does NOT hold this up on its own. The scores insert takes
       * `FOR KEY SHARE` on the parent assessment through the foreign key, and
       * that does not conflict with the `FOR NO KEY UPDATE` an ordinary column
       * update takes — so without the lock on the read, this request sails
       * straight past an in-flight publish.
       */
      const settledEarly = await Promise.race([
        save.then(() => true),
        new Promise<false>(r => setTimeout(() => r(false), 300)),
      ]);

      expect(settledEarly).toBe(false);

      commit.resolve();
      await holder;

      // And having waited, it sees the publish that won and refuses — rather
      // than writing marks into an assessment parents can already read.
      expect((await save).status).toBe(409);
    });
  });

  describe("term results", () => {
    async function withMarks(subdomain: string) {
      const ctx = await seed(subdomain);
      const assessment = await makeAssessment(ctx);

      await put(`/assessments/${assessment.id}/scores`, {
        scores: [
          { enrollmentId: ctx.pupils[0].enrolmentId, rawScore: 90 },
          { enrollmentId: ctx.pupils[1].enrolmentId, rawScore: 70 },
          { enrollmentId: ctx.pupils[2].enrolmentId, rawScore: 50 },
        ],
      }, jsonHeaders(subdomain, ctx.teacher));
      await post(`/assessments/${assessment.id}/publish`, {}, jsonHeaders(subdomain, ctx.teacher));

      return { ...ctx, assessment };
    }

    it("computes a mean and ranks the class", async () => {
      const ctx = await withMarks("alpha");

      await post("/term-results/compute", { termId: ctx.term.id }, jsonHeaders("alpha", ctx.admin));

      const results = await (await app.request(
        `/term-results?termId=${ctx.term.id}`,
        { headers: tenantHeaders("alpha", ctx.admin) },
      )).json();

      const byEnrolment = Object.fromEntries(
        results.map((r: { enrollmentId: string }) => [r.enrollmentId, r]),
      );

      expect(Number(byEnrolment[ctx.pupils[0].enrolmentId].meanScore)).toBe(90);
      expect(byEnrolment[ctx.pupils[0].enrolmentId].streamPosition).toBe(1);
      expect(byEnrolment[ctx.pupils[2].enrolmentId].streamPosition).toBe(3);
      expect(byEnrolment[ctx.pupils[0].enrolmentId].outOf).toBe(3);
    });

    it("refuses a reduction rule this code cannot apply", async () => {
      const ctx = await withMarks("alpha");
      await post("/term-results/compute", { termId: ctx.term.id }, jsonHeaders("alpha", ctx.admin));

      /*
       * Deliberately reaching past the API, on the owner connection, because
       * no route can do this — `computeResults` validates against a Zod enum.
       * The constraint is there for the paths that are not the API: a backfill,
       * a hand-run correction, a fourth rule added to the enum without a
       * migration.
       *
       * It matters because `reduceLevels` treats an unrecognised rule as
       * `mode_ties_low` SILENTLY, so the row would be labelled with a policy
       * that did not produce it — and `finaliseReportCard` copies that label
       * verbatim into a snapshot and freezes it.
       */
      const err = await db.update(termResults)
        .set({ levelReduction: "mean" as never })
        .where(eq(termResults.schoolId, ctx.school.id))
        .then(() => null, (e: unknown) => e);

      // Named rather than merely "something failed", so this keeps testing the
      // constraint it is about and not whichever one happens to fire next.
      expect(isCheckViolation(err)).toBe(true);
      expect(pgConstraintName(err)).toBe("term_results_level_reduction_known");
    });

    it("skips an absence rather than counting it as zero", async () => {
      const ctx = await seed("alpha");
      const first = await makeAssessment(ctx, { title: "Opener" });
      const second = await makeAssessment(ctx, { title: "Midterm" });

      await put(`/assessments/${first.id}/scores`, {
        scores: [{ enrollmentId: ctx.pupils[0].enrolmentId, rawScore: 80 }],
      }, jsonHeaders("alpha", ctx.teacher));
      await put(`/assessments/${second.id}/scores`, {
        scores: [{ enrollmentId: ctx.pupils[0].enrolmentId, isAbsent: true }],
      }, jsonHeaders("alpha", ctx.teacher));

      await post(`/assessments/${first.id}/publish`, {}, jsonHeaders("alpha", ctx.teacher));
      await post(`/assessments/${second.id}/publish`, {}, jsonHeaders("alpha", ctx.teacher));
      await post("/term-results/compute", { termId: ctx.term.id }, jsonHeaders("alpha", ctx.admin));

      const results = await (await app.request(
        `/term-results?termId=${ctx.term.id}&enrollmentId=${ctx.pupils[0].enrolmentId}`,
        { headers: tenantHeaders("alpha", ctx.admin) },
      )).json();

      // 80, not 40. Counting the missed paper as zero would halve a mark for
      // an exam the child never sat.
      expect(Number(results[0].meanScore)).toBe(80);
    });

    it("weights a big paper more heavily than a small one", async () => {
      const ctx = await seed("alpha");
      const cat = await makeAssessment(ctx, { title: "CAT", maxScore: 30, weight: 1 });
      const final = await makeAssessment(ctx, { title: "End term", maxScore: 100, weight: 3 });

      // 100% on the CAT, 60% on the end-term.
      await put(`/assessments/${cat.id}/scores`, {
        scores: [{ enrollmentId: ctx.pupils[0].enrolmentId, rawScore: 30 }],
      }, jsonHeaders("alpha", ctx.teacher));
      await put(`/assessments/${final.id}/scores`, {
        scores: [{ enrollmentId: ctx.pupils[0].enrolmentId, rawScore: 60 }],
      }, jsonHeaders("alpha", ctx.teacher));

      await post(`/assessments/${cat.id}/publish`, {}, jsonHeaders("alpha", ctx.teacher));
      await post(`/assessments/${final.id}/publish`, {}, jsonHeaders("alpha", ctx.teacher));
      await post("/term-results/compute", { termId: ctx.term.id }, jsonHeaders("alpha", ctx.admin));

      const results = await (await app.request(
        `/term-results?termId=${ctx.term.id}&enrollmentId=${ctx.pupils[0].enrolmentId}`,
        { headers: tenantHeaders("alpha", ctx.admin) },
      )).json();

      // (100×1 + 60×3) / 4 = 70. A paper out of 30 and one out of 100 combine
      // on the same footing because each becomes a percentage first.
      expect(Number(results[0].meanScore)).toBe(70);
    });

    it("takes the mode of competency judgements, never the mean", async () => {
      const ctx = await seed("alpha");
      const observation = await makeAssessment(ctx, {
        title: "Project",
        kind: "observation",
        maxScore: undefined,
      });

      // Exceeding in one sub-strand, below expectation in the other.
      await put(`/assessments/${observation.id}/scores`, {
        scores: [
          {
            enrollmentId: ctx.pupils[0].enrolmentId,
            competencyId: ctx.subStrands[0].id,
            level: "exceeding",
          },
          {
            enrollmentId: ctx.pupils[0].enrolmentId,
            competencyId: ctx.subStrands[1].id,
            level: "below_expectation",
          },
        ],
      }, jsonHeaders("alpha", ctx.teacher));
      await post(`/assessments/${observation.id}/publish`, {}, jsonHeaders("alpha", ctx.teacher));
      await post("/term-results/compute", { termId: ctx.term.id }, jsonHeaders("alpha", ctx.admin));

      const results = await (await app.request(
        `/term-results?termId=${ctx.term.id}&enrollmentId=${ctx.pupils[0].enrolmentId}`,
        { headers: tenantHeaders("alpha", ctx.admin) },
      )).json();

      // Averaging would say "meeting" — a level the child reached in nothing.
      expect(results[0].overallLevel).not.toBe("meeting");
      expect(results[0].overallLevel).toBe("below_expectation");
      // And no mean, because an observation carries no mark.
      expect(results[0].meanScore).toBeNull();
    });

    it("follows a corrected mark", async () => {
      const ctx = await withMarks("alpha");
      await post("/term-results/compute", { termId: ctx.term.id }, jsonHeaders("alpha", ctx.admin));

      await post(`/assessments/${ctx.assessment.id}/unpublish`, {}, jsonHeaders("alpha", ctx.teacher));
      await put(`/assessments/${ctx.assessment.id}/scores`, {
        scores: [{ enrollmentId: ctx.pupils[2].enrolmentId, rawScore: 95 }],
      }, jsonHeaders("alpha", ctx.teacher));
      await post(`/assessments/${ctx.assessment.id}/publish`, {}, jsonHeaders("alpha", ctx.teacher));
      await post("/term-results/compute", { termId: ctx.term.id }, jsonHeaders("alpha", ctx.admin));

      const results = await (await app.request(
        `/term-results?termId=${ctx.term.id}&enrollmentId=${ctx.pupils[2].enrolmentId}`,
        { headers: tenantHeaders("alpha", ctx.admin) },
      )).json();

      // Recomputed rather than accumulated: the child who was last is now first.
      expect(Number(results[0].meanScore)).toBe(95);
      expect(results[0].streamPosition).toBe(1);
    });
  });

  describe("children who left mid-term", () => {
    it("still gets a result for the term they were present for", async () => {
      const ctx = await seed("alpha");
      const assessment = await makeAssessment(ctx);

      await put(`/assessments/${assessment.id}/scores`, {
        scores: [{ enrollmentId: ctx.pupils[0].enrolmentId, rawScore: 80 }],
      }, jsonHeaders("alpha", ctx.teacher));
      await post(`/assessments/${assessment.id}/publish`, {}, jsonHeaders("alpha", ctx.teacher));

      // Transfers out after sitting the exam — CLAUDE.md §8 asks for exactly
      // this case in the demo data.
      await post(`/students/${ctx.pupils[0].student.id}/exit`, {
        status: "transferred_out",
        exitedOn: "2026-02-20",
      }, jsonHeaders("alpha", ctx.admin));

      await post("/term-results/compute", { termId: ctx.term.id }, jsonHeaders("alpha", ctx.admin));

      const results = await (await app.request(
        `/term-results?termId=${ctx.term.id}&enrollmentId=${ctx.pupils[0].enrolmentId}`,
        { headers: tenantHeaders("alpha", ctx.admin) },
      )).json();

      /*
       * Selecting only currently-open enrolments skipped them entirely: their
       * marks sat in the database with nothing computed from them, so no
       * report card could be produced for a term they were taught in.
       */
      expect(results).toHaveLength(1);
      expect(Number(results[0].meanScore)).toBe(80);
    });

    it("leaves out a child who was never there during the term", async () => {
      const ctx = await seed("alpha");

      // Enrolled only in term 3; term 1 should not see them.
      const late = await makeStudent(ctx.school, "2026/900", { givenName: "Later" });
      const { enrollments } = await import("@/db/schema");
      await db.insert(enrollments).values({
        schoolId: ctx.school.id,
        studentId: late.id,
        streamId: ctx.blue.id,
        boardingStatus: "day",
        startedOn: ctx.school.terms[2].startsOn,
      });

      const body = await (await post(
        "/term-results/compute",
        { termId: ctx.term.id },
        jsonHeaders("alpha", ctx.admin),
      )).json();

      // Overlap, not "everyone ever enrolled".
      expect(body.enrolments).toBe(3);
    });
  });

  describe("recomputing after a withdrawal", () => {
    it("removes a result that nothing published stands behind any more", async () => {
      const ctx = await seed("alpha");
      const assessment = await makeAssessment(ctx);

      await put(`/assessments/${assessment.id}/scores`, {
        scores: [{ enrollmentId: ctx.pupils[0].enrolmentId, rawScore: 80 }],
      }, jsonHeaders("alpha", ctx.teacher));
      await post(`/assessments/${assessment.id}/publish`, {}, jsonHeaders("alpha", ctx.teacher));
      await post("/term-results/compute", { termId: ctx.term.id }, jsonHeaders("alpha", ctx.admin));

      const before = await (await app.request(
        `/term-results?termId=${ctx.term.id}&enrollmentId=${ctx.pupils[0].enrolmentId}`,
        { headers: tenantHeaders("alpha", ctx.admin) },
      )).json();
      expect(before).toHaveLength(1);

      // The assessment is withdrawn — a mark was wrong and is being redone.
      await post(`/assessments/${assessment.id}/unpublish`, {}, jsonHeaders("alpha", ctx.teacher));
      const recompute = await (await post(
        "/term-results/compute",
        { termId: ctx.term.id },
        jsonHeaders("alpha", ctx.admin),
      )).json();

      /*
       * The previous figure used to stand, so `/term-results` and any report
       * card finalised afterwards reported a mark derived from data no longer
       * published. Stale reads as fact; absent reads as "not marked yet".
       */
      expect(recompute.cleared).toBeGreaterThan(0);

      const after = await (await app.request(
        `/term-results?termId=${ctx.term.id}&enrollmentId=${ctx.pupils[0].enrolmentId}`,
        { headers: tenantHeaders("alpha", ctx.admin) },
      )).json();
      expect(after).toEqual([]);
    });
  });

  describe("the marks grid", () => {
    it("reports how many marks it corrected, not how many were sent", async () => {
      const ctx = await seed("alpha");
      const assessment = await makeAssessment(ctx);
      const grid = (scores: Array<[string, number]>) => ({
        scores: scores.map(([enrollmentId, rawScore]) => ({ enrollmentId, rawScore })),
      });

      const first = await (await put(
        `/assessments/${assessment.id}/scores`,
        grid([[ctx.pupils[0].enrolmentId, 70], [ctx.pupils[1].enrolmentId, 60]]),
        jsonHeaders("alpha", ctx.teacher),
      )).json();

      // Nothing existed, so nothing was corrected.
      expect(first).toMatchObject({ saved: 2, updated: 0 });

      const second = await (await put(
        `/assessments/${assessment.id}/scores`,
        grid([[ctx.pupils[0].enrolmentId, 75], [ctx.pupils[2].enrolmentId, 50]]),
        jsonHeaders("alpha", ctx.teacher),
      )).json();

      // One replaced, one new. Counting returned rows made this always equal
      // `saved`, so the field said "how many were submitted" while claiming to
      // say "how many replaced an existing mark".
      expect(second).toMatchObject({ saved: 2, updated: 1 });
    });

    it("takes the last value when a pupil appears twice in one grid", async () => {
      const ctx = await seed("alpha");
      const assessment = await makeAssessment(ctx);

      const res = await put(`/assessments/${assessment.id}/scores`, {
        scores: [
          { enrollmentId: ctx.pupils[0].enrolmentId, rawScore: 40 },
          { enrollmentId: ctx.pupils[0].enrolmentId, rawScore: 65 },
        ],
      }, jsonHeaders("alpha", ctx.teacher));

      // A single statement cannot touch one conflict target twice, so the grid
      // is collapsed first — a repeated row is a correction, not a failure.
      expect(res.status).toBe(200);
      const rows = await db.select().from(assessmentScores);
      expect(rows).toHaveLength(1);
      expect(Number(rows[0].rawScore)).toBe(65);
    });
  });

  describe("report cards", () => {
    async function computed(subdomain: string) {
      const ctx = await seed(subdomain);
      const exam = await makeAssessment(ctx);
      const observation = await makeAssessment(ctx, {
        title: "Project",
        kind: "observation",
        maxScore: undefined,
      });

      await put(`/assessments/${exam.id}/scores`, {
        scores: ctx.pupils.map((p, i) => ({
          enrollmentId: p.enrolmentId,
          rawScore: 90 - i * 20,
        })),
      }, jsonHeaders(subdomain, ctx.teacher));

      await put(`/assessments/${observation.id}/scores`, {
        scores: [
          {
            enrollmentId: ctx.pupils[0].enrolmentId,
            competencyId: ctx.subStrands[0].id,
            level: "exceeding",
          },
          {
            enrollmentId: ctx.pupils[0].enrolmentId,
            competencyId: ctx.subStrands[1].id,
            level: "exceeding",
          },
        ],
      }, jsonHeaders(subdomain, ctx.teacher));

      await post(`/assessments/${exam.id}/publish`, {}, jsonHeaders(subdomain, ctx.teacher));
      await post(`/assessments/${observation.id}/publish`, {}, jsonHeaders(subdomain, ctx.teacher));
      await post("/term-results/compute", { termId: ctx.term.id }, jsonHeaders(subdomain, ctx.admin));

      return ctx;
    }

    it("freezes the computed content into a snapshot", async () => {
      const ctx = await computed("alpha");

      const res = await post("/report-cards/finalise", {
        enrollmentId: ctx.pupils[0].enrolmentId,
        termId: ctx.term.id,
        classTeacherComment: "A strong term.",
      }, jsonHeaders("alpha", ctx.admin));

      expect(res.status).toBe(201);
      const card = await res.json();
      const snapshot = card.snapshot;

      expect(snapshot.student.admissionNumber).toBe("2026/001");
      expect(snapshot.class.gradeLevelName).toBe("Grade 4");

      const maths = snapshot.learningAreas.find(
        (a: { name: string }) => a.name === "Mathematics",
      );
      expect(maths.meanScore).toBe(90);
      expect(maths.streamPosition).toBe(1);
      // The per-sub-strand breakdown is the BODY of a CBE report card; the
      // mean and position are the summary strip above it.
      expect(maths.competencies).toHaveLength(2);
      expect(maths.overallLevel).toBe("exceeding");
    });

    it("does not change when the marks behind it change", async () => {
      const ctx = await computed("alpha");
      const card = await (await post("/report-cards/finalise", {
        enrollmentId: ctx.pupils[0].enrolmentId,
        termId: ctx.term.id,
      }, jsonHeaders("alpha", ctx.admin))).json();

      // A mark is corrected after the report card was issued.
      const assessments = await (await app.request(
        `/assessments?termId=${ctx.term.id}`,
        { headers: tenantHeaders("alpha", ctx.admin) },
      )).json();
      const exam = assessments.find((a: { title: string }) => a.title === "Opener Exam");

      await post(`/assessments/${exam.id}/unpublish`, {}, jsonHeaders("alpha", ctx.teacher));
      await put(`/assessments/${exam.id}/scores`, {
        scores: [{ enrollmentId: ctx.pupils[0].enrolmentId, rawScore: 10 }],
      }, jsonHeaders("alpha", ctx.teacher));
      await post(`/assessments/${exam.id}/publish`, {}, jsonHeaders("alpha", ctx.teacher));
      await post("/term-results/compute", { termId: ctx.term.id }, jsonHeaders("alpha", ctx.admin));

      const reread = await (await app.request(`/report-cards/${card.id}`, {
        headers: tenantHeaders("alpha", ctx.admin),
      })).json();

      /*
       * CLAUDE.md §3 rule 7. Reprinting a 2026 report card in 2028 must produce
       * the same document — the parent is holding a copy, and a figure that
       * quietly changed would make every other figure on it suspect.
       */
      const maths = reread.snapshot.learningAreas.find(
        (a: { name: string }) => a.name === "Mathematics",
      );
      expect(maths.meanScore).toBe(90);
    });

    it("refuses to rewrite a finalised snapshot at the database level", async () => {
      const ctx = await computed("alpha");
      const card = await (await post("/report-cards/finalise", {
        enrollmentId: ctx.pupils[0].enrolmentId,
        termId: ctx.term.id,
      }, jsonHeaders("alpha", ctx.admin))).json();

      // Not a convention — a trigger. The snapshot is the printed document.
      await expect(
        db.update(reportCards)
          .set({ snapshot: { tampered: true } })
          .where(eq(reportCards.id, card.id)),
      ).rejects.toThrow();
    });

    it("omits positions entirely for a school that does not rank children", async () => {
      const ctx = await computed("alpha");
      await db
        .update(schools)
        .set({ showsPositions: false })
        .where(eq(schools.id, ctx.school.id));

      const card = await (await post("/report-cards/finalise", {
        enrollmentId: ctx.pupils[0].enrolmentId,
        termId: ctx.term.id,
      }, jsonHeaders("alpha", ctx.admin))).json();

      const maths = card.snapshot.learningAreas.find(
        (a: { name: string }) => a.name === "Mathematics",
      );

      // Some schools have moved away from ranking under CBE. Honouring that
      // means the rank is not in the frozen document at all, rather than being
      // hidden one query away from a screen that decides to show it.
      expect(card.snapshot.showsPositions).toBe(false);
      expect(maths.streamPosition).toBeNull();
    });

    it("records the reduction rule that actually produced the levels", async () => {
      const ctx = await seed("alpha");
      const observation = await makeAssessment(ctx, {
        title: "Project",
        kind: "observation",
        maxScore: undefined,
      });

      await put(`/assessments/${observation.id}/scores`, {
        scores: [
          {
            enrollmentId: ctx.pupils[0].enrolmentId,
            competencyId: ctx.subStrands[0].id,
            level: "exceeding",
          },
          {
            enrollmentId: ctx.pupils[0].enrolmentId,
            competencyId: ctx.subStrands[1].id,
            level: "approaching",
          },
        ],
      }, jsonHeaders("alpha", ctx.teacher));
      await post(`/assessments/${observation.id}/publish`, {}, jsonHeaders("alpha", ctx.teacher));

      // Computed with `lowest`, not the default.
      await post("/term-results/compute", {
        termId: ctx.term.id,
        levelReduction: "lowest",
      }, jsonHeaders("alpha", ctx.admin));

      const card = await (await post("/report-cards/finalise", {
        enrollmentId: ctx.pupils[0].enrolmentId,
        termId: ctx.term.id,
      }, jsonHeaders("alpha", ctx.admin))).json();

      /*
       * Hardcoding the default meant a school computing with `lowest` got a
       * frozen document claiming `mode_ties_low` — the snapshot misdescribing
       * its own contents, which is worse than not recording the rule at all.
       */
      expect(card.snapshot.levelReduction).toBe("lowest");

      const maths = card.snapshot.learningAreas.find(
        (a: { name: string }) => a.name === "Mathematics",
      );
      expect(maths.overallLevel).toBe("approaching");
    });

    it("422s attendance given as half a pair", async () => {
      const ctx = await computed("alpha");

      const res = await post("/report-cards/finalise", {
        enrollmentId: ctx.pupils[0].enrolmentId,
        termId: ctx.term.id,
        attendancePresent: 42,
      }, jsonHeaders("alpha", ctx.admin));

      // The database CHECK refuses it either way; without the schema rule that
      // arrived as a 500 rather than a message naming the field.
      expect(res.status).toBe(422);
    });

    it("422s a child attending more days than the term had", async () => {
      const ctx = await computed("alpha");

      const res = await post("/report-cards/finalise", {
        enrollmentId: ctx.pupils[0].enrolmentId,
        termId: ctx.term.id,
        attendancePresent: 90,
        attendanceTotal: 60,
      }, jsonHeaders("alpha", ctx.admin));

      expect(res.status).toBe(422);
    });

    it("will not release something that was never frozen", async () => {
      const ctx = await computed("alpha");
      const card = await (await post("/report-cards/finalise", {
        enrollmentId: ctx.pupils[0].enrolmentId,
        termId: ctx.term.id,
      }, jsonHeaders("alpha", ctx.admin))).json();

      const released = await post(
        `/report-cards/${card.id}/release`,
        {},
        jsonHeaders("alpha", ctx.admin),
      );
      expect(released.status).toBe(200);
      expect((await released.json()).releasedAt).not.toBeNull();

      // Twice is a conflict, not a silent second release.
      const again = await post(
        `/report-cards/${card.id}/release`,
        {},
        jsonHeaders("alpha", ctx.admin),
      );
      expect(again.status).toBe(409);
    });

    it("409s a second finalisation", async () => {
      const ctx = await computed("alpha");
      const body = {
        enrollmentId: ctx.pupils[0].enrolmentId,
        termId: ctx.term.id,
      };

      await post("/report-cards/finalise", body, jsonHeaders("alpha", ctx.admin));
      const again = await post("/report-cards/finalise", body, jsonHeaders("alpha", ctx.admin));

      expect(again.status).toBe(409);
    });

    it("422s a child with nothing computed yet", async () => {
      const ctx = await seed("alpha");

      const res = await post("/report-cards/finalise", {
        enrollmentId: ctx.pupils[0].enrolmentId,
        termId: ctx.term.id,
      }, jsonHeaders("alpha", ctx.admin));

      // An empty report card is worse than none: it looks like a judgement.
      expect(res.status).toBe(422);
    });

    it("403s a teacher finalising", async () => {
      const ctx = await computed("alpha");

      const res = await post("/report-cards/finalise", {
        enrollmentId: ctx.pupils[0].enrolmentId,
        termId: ctx.term.id,
      }, jsonHeaders("alpha", ctx.teacher));

      expect(res.status).toBe(403);
    });
  });

  describe("isolation", () => {
    it("shows one school none of another's assessments", async () => {
      const alpha = await seed("alpha");
      await makeAssessment(alpha);
      const beta = await seed("beta");

      const rows = await (await app.request(`/assessments?termId=${beta.term.id}`, {
        headers: tenantHeaders("beta", beta.admin),
      })).json();

      expect(rows).toEqual([]);
    });

    it("refuses a mark against another school's enrolment", async () => {
      const alpha = await seed("alpha");
      const beta = await seed("beta");
      const assessment = await makeAssessment(alpha);

      const res = await put(`/assessments/${assessment.id}/scores`, {
        scores: [{ enrollmentId: beta.pupils[0].enrolmentId, rawScore: 70 }],
      }, jsonHeaders("alpha", alpha.teacher));

      expect(res.status).toBe(422);
    });
  });
});
