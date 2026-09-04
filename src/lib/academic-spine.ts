import type { MembershipRole } from "./types";

/**
 * The structure every Kenyan primary + junior school shares, used to seed a
 * tenant at onboarding.
 *
 * CLAUDE.md §4: the superadmin plane "onboards schools, seeds their academic
 * year and class structure". A school whose first screen already knows it has
 * Grade 1 to Grade 9 and three terms believes the product understands its
 * world; one that opens to empty forms closes the tab.
 */

/** Grade 1-9, with the phase boundary CBE draws between primary and junior. */
export const GRADE_LEVELS = Array.from({ length: 9 }, (_, i) => {
  const sequence = i + 1;
  return {
    name: `Grade ${sequence}`,
    sequence,
    // Primary is Grade 1-6, junior school Grade 7-9. Junior school has
    // additional learning areas, so anything that differs between them must
    // filter on `phase` and never on a hardcoded grade number — the boundary
    // is a curriculum decision and has moved before.
    phase: (sequence <= 6 ? "primary" : "junior") as "primary" | "junior",
  };
});

/**
 * The three-term Kenyan school year, as month/day boundaries.
 *
 * Approximate by design. The Ministry publishes exact dates each year and
 * schools adjust them locally, so these exist to give a newly onboarded school
 * a working spine on day one — not to be authoritative. Terms are editable
 * afterwards, and `terms_dates_ordered` in the schema is what actually
 * guarantees they stay coherent.
 */
const TERM_BOUNDARIES = [
  { number: 1, startsOn: [1, 6], endsOn: [4, 10] },
  { number: 2, startsOn: [5, 4], endsOn: [8, 7] },
  { number: 3, startsOn: [8, 31], endsOn: [10, 23] },
] as const;

function isoDate(year: number, month: number, day: number): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** Term rows for a given calendar year, ready to insert. */
export function termsForYear(year: number) {
  return TERM_BOUNDARIES.map(t => ({
    number: t.number,
    startsOn: isoDate(year, t.startsOn[0], t.startsOn[1]),
    endsOn: isoDate(year, t.endsOn[0], t.endsOn[1]),
  }));
}

/**
 * Which term contains a given day, or null outside all of them.
 *
 * Holidays are genuinely outside every term, so null is a real answer and not
 * an error — callers deciding "the current term" must handle a school being
 * between terms rather than defaulting to term 1.
 */
export function termForDay(year: number, day: string): number | null {
  const match = termsForYear(year)
    .find(t => day >= t.startsOn && day <= t.endsOn);

  return match?.number ?? null;
}

/** Roles the superadmin plane may grant when onboarding a school's first user. */
export const ONBOARDING_ROLES: MembershipRole[] = ["admin", "bursar", "teacher", "guardian"];
