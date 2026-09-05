import type { SchoolContext } from "./01-school";
import type { Curriculum } from "./02-curriculum";
import type { Register } from "./03-students";

import { EXAMINED } from "./02-curriculum";
import { day, intakeYear, shiftYear, TERM_OFFSETS } from "./lib/calendar";
import { childName } from "./lib/names";
import { Rng } from "./lib/random";

/**
 * Last year's results, and the certificates that came out of them.
 *
 * A transition certificate says a learner COMPLETED Grade 6 or Grade 9, and the
 * API refuses to issue one before that year's term 3 has ended. The demo's
 * current year is deliberately mid-term-3 (§8: a demo whose current term
 * expired is worse than no demo), so nothing in it can ever be certified —
 * which would have left the feature invisible in the one place anyone looks.
 *
 * Two cohorts, for the two milestones CBE actually marks:
 *
 * - **Grade 6 → junior school**, for children who are in Grade 7 here NOW.
 *   01-school built last year's Grade 6 class and 03-students walked them up
 *   through it, so the certificate belongs to pupils still on the register and
 *   the demo carries a real progression.
 * - **Grade 9 → senior school**, for children who then left. They carry
 *   `graduated`, a status nothing else in the seed produces, and they stay
 *   fully queryable afterwards — which is rule 5's whole point.
 */

const GRADE_9_LEAVERS = 16;

export interface Leavers {
  academicYear: number;
  certificatesIssued: number;
  graduated: number;
  /** One certificate a presenter can open and scan. */
  sample: { verificationUrl: string; studentName: string; milestone: string };
}

export async function seedLeavers(
  ctx: SchoolContext,
  curriculum: Curriculum,
  register: Register,
): Promise<Leavers> {
  const rng = new Rng(4_820_115);
  const head = ctx.api("head");
  const teacher = ctx.api("teacher");

  const prior = ctx.priorYear;
  const examined = curriculum.areas.filter(a => EXAMINED.includes(a.name));

  /** One end-of-year paper per examined area, marked and published. */
  async function record(streamId: string, enrolmentIds: string[]) {
    if (enrolmentIds.length === 0)
      return;

    for (const area of examined) {
      const assessment = await teacher.post("/assessments", {
        termId: prior.finalTermId,
        learningAreaId: area.id,
        streamId,
        title: "End of Year Exam",
        kind: "exam",
        maxScore: 100,
        weight: 3,
        administeredOn: shiftYear(day(TERM_OFFSETS[2].endsOn - 10)),
      });

      await teacher.put(`/assessments/${assessment.id}/scores`, {
        scores: enrolmentIds.map(enrollmentId => ({
          enrollmentId,
          rawScore: rng.around(58, 20, 25, 96),
        })),
      });
      await teacher.post(`/assessments/${assessment.id}/publish`);
    }
  }

  // ---------------------------------------- last year's Grade 6, now in Grade 7
  const cameUp = register.pupils.filter(p => p.priorEnrollmentId);
  await record(prior.gradeSixStreamId, cameUp.map(p => p.priorEnrollmentId!));

  // ------------------------------------------- last year's Grade 9, since gone
  const leavers: Array<{ id: string; enrolmentId: string; name: string }> = [];

  for (let i = 0; i < GRADE_9_LEAVERS; i++) {
    const name = childName(rng);
    const student = await head.post("/students", {
      admissionNumber: `${intakeYear(9) - 1}/${String(900 + i).padStart(3, "0")}`,
      givenName: name.givenName,
      middleNames: name.middleNames,
      familyName: name.familyName,
      sex: name.sex,
      // Nine years ago, so the intake year on the file still reads true.
      admittedOn: day(TERM_OFFSETS[0].startsOn - 365 * 9),
      enrollment: {
        streamId: prior.gradeNineStreamId,
        boardingStatus: rng.chance(0.4) ? "boarder" : "day",
        startedOn: prior.startsOn,
      },
    });

    leavers.push({
      id: student.id,
      enrolmentId: student.currentEnrollment.id,
      name: `${name.givenName} ${name.familyName}`,
    });
  }

  await record(prior.gradeNineStreamId, leavers.map(l => l.enrolmentId));
  await head.post("/term-results/compute", { termId: prior.finalTermId });

  // --------------------------------------------------------------- certificates
  let certificatesIssued = 0;
  let sample: Leavers["sample"] | null = null;

  for (const [index, pupil] of cameUp.entries()) {
    const certificate = await head.post("/transition-certificates", {
      enrollmentId: pupil.priorEnrollmentId,
      termId: prior.finalTermId,
      headComment: "Promoted to junior school here. We look forward to Grade 7.",
    });
    certificatesIssued += 1;

    if (index === 0) {
      sample = {
        verificationUrl: certificate.verificationUrl,
        studentName: `${pupil.name.givenName} ${pupil.name.familyName}`,
        milestone: "Grade 6 to junior school",
      };
    }
  }

  let graduated = 0;
  for (const leaver of leavers) {
    await head.post("/transition-certificates", {
      enrollmentId: leaver.enrolmentId,
      termId: prior.finalTermId,
      headComment: "Completed junior school. Proceeding to senior school.",
    });
    certificatesIssued += 1;

    /*
     * Exited AFTER the certificate, which is the order it happens in: the
     * document is what a family leaves with. Nothing hard-deletes, so the
     * child, their marks and their certificate all stay queryable.
     */
    await head.post(`/students/${leaver.id}/exit`, {
      status: "graduated",
      exitedOn: prior.endsOn,
    });
    graduated += 1;
  }

  return {
    academicYear: prior.year,
    certificatesIssued,
    graduated,
    sample: sample!,
  };
}
