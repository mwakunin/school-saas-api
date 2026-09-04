import type { SchoolContext } from "./01-school";
import type { Curriculum } from "./02-curriculum";
import type { Register, SeededPupil } from "./03-students";

import { EXAMINED, OBSERVED } from "./02-curriculum";
import { day, TERM_OFFSETS } from "./lib/calendar";
import { Rng } from "./lib/random";

/**
 * Two finished terms, so the demo has a past.
 *
 * Without history the product can only show what it will do; with it, a head
 * can ask "how did this child do last term" and get an answer. That question
 * is the one that decides whether a report card is worth paying for, and it is
 * unanswerable on an empty database.
 *
 * Both grading systems run side by side here, because CBE schools run both
 * (CLAUDE.md §5.5): percentage exams that produce a mark and a position, and
 * competency judgements that produce a level per sub-strand. A demo that
 * showed only one would lose half the room.
 */

/** How the exams in a term are weighted against each other. */
const PAPERS = [
  { title: "Opener CAT", kind: "cat" as const, maxScore: 30, weight: 1, atWeek: 2 },
  { title: "Mid-term Exam", kind: "exam" as const, maxScore: 100, weight: 2, atWeek: 6 },
  { title: "End of Term Exam", kind: "exam" as const, maxScore: 100, weight: 3, atWeek: 11 },
];

const LEVELS = ["below_expectation", "approaching", "meeting", "exceeding"] as const;

/**
 * A latent ability per child, so results hang together across terms.
 *
 * Marks drawn fresh each term would shuffle the class order completely between
 * terms, and "last term's position" — the number parents actually compare
 * against — would be noise. A child who was third is usually still near the
 * top, and occasionally is not, which is what a real class looks like.
 */
export function abilities(pupils: SeededPupil[]): Map<string, number> {
  const rng = new Rng(773311);
  return new Map(pupils.map(p => [p.id, rng.around(58, 22, 25, 92)]));
}

export interface HistoryOptions {
  /** Which streams get finalised, released report cards. */
  reportCardStreamIds: Set<string>;
}

export async function seedHistory(
  ctx: SchoolContext,
  curriculum: Curriculum,
  register: Register,
  options: HistoryOptions,
): Promise<{ assessments: number; reportCards: number }> {
  const rng = new Rng(90210);
  const ability = abilities(register.pupils);
  const teacher = ctx.api("teacher");
  const head = ctx.api("head");

  const examined = curriculum.areas.filter(a => EXAMINED.includes(a.name));
  const observed = curriculum.areas.find(a => a.name === OBSERVED)!;

  let assessments = 0;
  let reportCards = 0;

  // Terms 1 and 2. Term 3 is in progress and belongs to 06-current.ts.
  for (const term of ctx.terms.filter(t => t.number <= 2)) {
    const offsets = TERM_OFFSETS.find(t => t.number === term.number)!;

    for (const stream of ctx.streams) {
      const roll = register.byStream.get(stream.id)!;

      for (const area of examined) {
        for (const paper of PAPERS) {
          const assessment = await teacher.post("/assessments", {
            termId: term.id,
            learningAreaId: area.id,
            streamId: stream.id,
            title: paper.title,
            kind: paper.kind,
            maxScore: paper.maxScore,
            weight: paper.weight,
            administeredOn: day(offsets.startsOn + paper.atWeek * 7),
          });
          assessments += 1;

          const scores = roll.map((pupil) => {
            /*
             * An absence is not a zero (CLAUDE.md §5.6), and the demo has to
             * contain one for that to be demonstrable rather than asserted.
             * The term mean skips these, and a CHECK forbids a mark on an
             * absent row — so this is also the shape that proves the rule.
             */
            if (rng.chance(0.02))
              return { enrollmentId: pupil.enrollmentId, isAbsent: true };

            const percentage = rng.around(ability.get(pupil.id)!, 12, 8, 99);
            return {
              enrollmentId: pupil.enrollmentId,
              rawScore: Math.round((percentage / 100) * paper.maxScore),
            };
          });

          await teacher.put(`/assessments/${assessment.id}/scores`, { scores });
          await teacher.post(`/assessments/${assessment.id}/publish`);
        }
      }

      /*
       * The competency side: one judgement per sub-strand, no marks at all.
       *
       * `competencyId` populated is what distinguishes this from the exam path
       * — the same table holds both (CLAUDE.md §5.5). Levels are drawn around
       * the child's ability so the two systems tell a consistent story about
       * the same child, which is what a parent comparing the two halves of the
       * report card will check first.
       */
      const subStrands = curriculum.subStrands.get(observed.id)!;
      const observation = await teacher.post("/assessments", {
        termId: term.id,
        learningAreaId: observed.id,
        streamId: stream.id,
        title: "Termly Observation",
        kind: "observation",
        administeredOn: day(offsets.startsOn + 10 * 7),
      });
      assessments += 1;

      const levelScores = roll.flatMap(pupil =>
        subStrands.map((strand) => {
          const band = ability.get(pupil.id)! + rng.int(-14, 14);
          const index = band >= 80 ? 3 : band >= 60 ? 2 : band >= 40 ? 1 : 0;
          return {
            enrollmentId: pupil.enrollmentId,
            competencyId: strand.id,
            level: LEVELS[index],
          };
        }),
      );

      await teacher.put(`/assessments/${observation.id}/scores`, { scores: levelScores });
      await teacher.post(`/assessments/${observation.id}/publish`);
    }

    /*
     * Compute once for the whole term, after every mark is in.
     *
     * Positions are derived here and frozen into the report card at
     * finalisation — the most contested number on a Kenyan report card, and
     * the one CLAUDE.md §5.6 says to compute late and never recompute.
     */
    await head.post("/term-results/compute", { termId: term.id });

    for (const streamId of options.reportCardStreamIds) {
      for (const pupil of register.byStream.get(streamId)!) {
        const present = rng.int(56, 65);
        const card = await head.post("/report-cards/finalise", {
          enrollmentId: pupil.enrollmentId,
          termId: term.id,
          classTeacherComment: rng.pick([
            "A steady term. Reads well and is starting to explain her thinking.",
            "Works hard and asks good questions. Needs to check his work before handing it in.",
            "Has grown in confidence this term, particularly in group work.",
            "Capable, but easily distracted. More consistency next term.",
            "Excellent participation. Should keep up the reading at home.",
          ]),
          headComment: rng.pick([
            "Well done. Keep it up.",
            "A promising term's work.",
            "We would like to see more consistency next term.",
          ]),
          attendancePresent: present,
          attendanceTotal: 65,
        });

        // Released, because a finished term's report card that parents cannot
        // see is a half-finished demo.
        await head.post(`/report-cards/${card.id}/release`);
        reportCards += 1;
      }
    }
  }

  return { assessments, reportCards };
}
