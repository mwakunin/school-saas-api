/**
 * Term dates built around today, not around the calendar.
 *
 * CLAUDE.md §8: "dates relative to today. A demo whose current term expired in
 * March is worse than no demo." The natural Kenyan year — January to April,
 * May to August, September to October — only satisfies "two terms finished and
 * one in progress" for about eight weeks of the year. Every other month, a
 * demo seeded on those boundaries opens on a school that is either between
 * terms or has no history to show.
 *
 * So the three terms are placed relative to whatever day the seed runs, with
 * today sitting a few weeks into term 3. The shape is the real one — three
 * terms of roughly thirteen weeks with holidays between — and `PATCH /terms`
 * is what applies it, so the seed adjusts dates the same way a school does.
 */

/** `offset` days from today, as the `YYYY-MM-DD` a `date` column takes. */
export function day(offset: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

/** Midday UTC on a day `offset` from today — an instant, for `timestamp` columns. */
export function instant(offset: number, hour = 12): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  d.setUTCHours(hour, 0, 0, 0);
  return d;
}

/**
 * Where today sits inside the current term.
 *
 * Five weeks in: far enough that two rounds of assessment have happened and
 * fees are overdue rather than merely issued, but with enough term left that
 * marks are still going in — which is what makes the unpublished assessment
 * and the outstanding balances look like a school mid-term rather than one
 * winding down.
 */
const WEEKS_INTO_CURRENT_TERM = 5;
const TERM_WEEKS = 13;
const HOLIDAY_WEEKS = 3;

const TERM_DAYS = TERM_WEEKS * 7;
const CYCLE_DAYS = (TERM_WEEKS + HOLIDAY_WEEKS) * 7;

/** Day offsets, relative to today, for each term boundary. */
export const TERM_OFFSETS = [1, 2, 3].map((number) => {
  // Term 3 starts five weeks ago; each earlier term is one full cycle back.
  const startsOn = -(WEEKS_INTO_CURRENT_TERM * 7) - (3 - number) * CYCLE_DAYS;
  return {
    number,
    startsOn,
    endsOn: startsOn + TERM_DAYS,
    isCurrent: number === 3,
  };
});

export const TERM_DATES = TERM_OFFSETS.map(t => ({
  number: t.number,
  startsOn: day(t.startsOn),
  endsOn: day(t.endsOn),
  isCurrent: t.isCurrent,
}));

/** The academic year label — the calendar year the current term sits in. */
export const ACADEMIC_YEAR = Number(day(0).slice(0, 4));

/**
 * The intake year an admission number carries.
 *
 * A child in Grade 4 was admitted in Grade 1 three years ago, so the number on
 * their file reads `2023/041` while a new Grade 1's reads `2026/118`. Bursars
 * read intake straight off the number, and a demo where every child was
 * admitted this year loses that.
 */
export function intakeYear(gradeSequence: number): number {
  return ACADEMIC_YEAR - (gradeSequence - 1);
}
