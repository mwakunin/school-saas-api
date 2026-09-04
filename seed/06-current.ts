import type { SchoolContext } from "./01-school";
import type { Curriculum } from "./02-curriculum";
import type { Register } from "./03-students";

import { EXAMINED } from "./02-curriculum";
import { abilities } from "./04-history";
import { day, TERM_OFFSETS } from "./lib/calendar";
import { Rng } from "./lib/random";

/**
 * The term in progress — a school caught mid-work rather than mid-sentence.
 *
 * The state that matters here is the half-finished one. Two rounds of exams
 * are marked and published; the end-of-term paper is sat, partly entered, and
 * NOT published. That single unpublished assessment is what lets the demo
 * answer the question every head asks — "can parents see marks before I've
 * checked them?" — by showing the parent view rather than promising.
 */

export interface CurrentTerm {
  /** The assessment deliberately left unpublished, for the demo script. */
  unpublished: { id: string; title: string; streamName: string };
  published: number;
}

export async function seedCurrentTerm(
  ctx: SchoolContext,
  curriculum: Curriculum,
  register: Register,
): Promise<CurrentTerm> {
  const rng = new Rng(31_337);
  const ability = abilities(register.pupils);
  const teacher = ctx.api("teacher");
  const head = ctx.api("head");

  const term = ctx.terms.find(t => t.number === 3)!;
  const offsets = TERM_OFFSETS.find(t => t.number === 3)!;
  const examined = curriculum.areas.filter(a => EXAMINED.includes(a.name));

  let published = 0;
  let unpublished: CurrentTerm["unpublished"] | null = null;

  // Five weeks in, so the opener is done and marked and the mid-term is not.
  const papers = [
    { title: "Opener CAT", kind: "cat" as const, maxScore: 30, weight: 1, atWeek: 2 },
    { title: "Mid-term Exam", kind: "exam" as const, maxScore: 100, weight: 2, atWeek: 4 },
  ];

  for (const stream of ctx.streams) {
    const roll = register.byStream.get(stream.id)!;

    for (const area of examined) {
      for (const paper of papers) {
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

        const scores = roll.map((pupil) => {
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
        published += 1;
      }
    }
  }

  /*
   * The one that stays unpublished, in the class the demo teacher teaches.
   *
   * Marks are entered for two thirds of the register and then stopped, which
   * is what a teacher's Tuesday evening actually looks like. `publishedAt`
   * null keeps every one of them out of the parent portal and out of the term
   * mean — so the same screen, viewed as the head and as the parent, shows
   * different things, and nobody has to take the claim on trust.
   */
  const demoStream = ctx.streams.find(s => s.sequence === 4 && s.name === "Blue")!;
  const demoRoll = register.byStream.get(demoStream.id)!;
  const maths = curriculum.areas.find(a => a.name === "Mathematics")!;

  const inProgress = await teacher.post("/assessments", {
    termId: term.id,
    learningAreaId: maths.id,
    streamId: demoStream.id,
    title: "End of Term Exam",
    kind: "exam",
    maxScore: 100,
    weight: 3,
    administeredOn: day(-3),
  });

  const entered = demoRoll.slice(0, Math.ceil(demoRoll.length * 0.65));
  await teacher.put(`/assessments/${inProgress.id}/scores`, {
    scores: entered.map(pupil => ({
      enrollmentId: pupil.enrollmentId,
      rawScore: Math.round(rng.around(ability.get(pupil.id)!, 12, 8, 99)),
    })),
  });

  unpublished = {
    id: inProgress.id,
    title: "End of Term Exam",
    streamName: `Grade 4 ${demoStream.name}`,
  };

  /*
   * Compute, so the current term has standings too.
   *
   * The unpublished paper is excluded by the computation itself, not by
   * anything here — which is the property worth demonstrating: publish it, run
   * this again, and the means move.
   */
  await head.post("/term-results/compute", { termId: term.id });

  return { unpublished, published };
}
