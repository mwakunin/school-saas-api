import type { SchoolContext } from "./01-school";

/**
 * The learning areas, from the starter set the product ships.
 *
 * Through `POST /curriculum/seed` rather than by writing rows, so the demo
 * shows the same button a real school presses at onboarding — and so a change
 * to that endpoint shows up here rather than drifting apart from it.
 *
 * Both phases, because this school teaches Grade 1 to 9 on one compound. The
 * endpoint skips an area the school already has by name, so the overlap
 * between the two calls costs nothing.
 *
 * The strands underneath are marked `(placeholder)` and the API says so — see
 * lib/curriculum-seed.ts. That is honest rather than embarrassing: a head who
 * asks "are these the KICD designs?" gets a straight answer and a screen that
 * already labels them, instead of a demo quietly presenting invented strands
 * as the national curriculum.
 */
export interface Curriculum {
  areas: Array<{ id: string; name: string; sequence: number; isCore: boolean }>;
  /** Sub-strands of the areas history is recorded against, by area id. */
  subStrands: Map<string, Array<{ id: string; title: string }>>;
}

/**
 * The areas the demo carries marks for.
 *
 * Not all eleven, deliberately. A school does not formally examine every
 * learning area every term — the core four carry the exams and the positions,
 * and the rest are taught and reported on less formally. Seeding marks for
 * everything would make the report card longer and the demo less true, and it
 * would triple the number of assessments for no extra thing to show.
 */
export const EXAMINED = ["English", "Kiswahili", "Mathematics"];

/** The area whose sub-strands carry competency judgements rather than marks. */
export const OBSERVED = "Creative Arts and Sports";

export async function seedCurriculum(ctx: SchoolContext): Promise<Curriculum> {
  const head = ctx.api("head");

  await head.post("/curriculum/seed", { phase: "primary" });
  await head.post("/curriculum/seed", { phase: "junior" });

  const areas = await head.get("/learning-areas?includeNonCore=true");
  const subStrands = new Map<string, Array<{ id: string; title: string }>>();

  for (const area of areas) {
    if (![...EXAMINED, OBSERVED].includes(area.name))
      continue;

    const detail = await head.get(`/learning-areas/${area.id}`);
    subStrands.set(
      area.id,
      detail.strands.flatMap(
        (strand: { children: Array<{ id: string; title: string }> }) => strand.children,
      ),
    );
  }

  return { areas, subStrands };
}
