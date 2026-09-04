/** Where the schools are, and therefore what "today" means to a term. */
export const BUSINESS_TIME_ZONE = "Africa/Nairobi";

/**
 * The calendar day, as the `date` columns store it.
 *
 * `terms.starts_on` / `ends_on`, `invoices.due_on` and `enrollments.started_on`
 * are `date`, not `timestamp` — a term is a calendar range, not an instant
 * (CLAUDE.md §3 rule 9). Anything comparing "now" against them has to reduce
 * now to the same shape, and every such place must reduce it the *same* way:
 * a fee reminder deciding an invoice is overdue and a handler deciding which
 * term is current cannot be allowed to disagree about what day it is.
 *
 * That day is Kenya's, not UTC's. The dates on a term mean local calendar
 * days — a term beginning on the 1st means the 1st in Nairobi — and Kenya is
 * UTC+3, so for the first three hours of each Kenyan day UTC still reports
 * yesterday. Read in UTC, a term beginning today looks like it begins tomorrow
 * for those three hours, and one that ended today looks still open.
 *
 * The time zone is passed explicitly rather than read from TZ, because the
 * container sets `TZ=UTC` on purpose: the database is UTC and the process must
 * not drift from it. Only this calendar question is local.
 */
const dayParts = new Intl.DateTimeFormat("en-US", {
  timeZone: BUSINESS_TIME_ZONE,
  // Pinned so the parts are Gregorian and written in Latin digits whatever the
  // host's defaults are.
  calendar: "gregory",
  numberingSystem: "latn",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function todayInBusinessZone(): string {
  // Assembled from typed parts rather than read off a formatted string.
  // `toLocaleDateString("en-CA")` happens to print YYYY-MM-DD, but only while
  // en-CA actually resolves; on a build whose ICU data lacks it the call
  // silently falls back and returns something like 9/1/2026. Nothing throws —
  // the string simply stops being comparable to a date column, and
  // `"2026-09-01" <= "9/1/2026"` is true, so every stay would look already
  // begun and every confirmed booking already finished. Taking the parts by
  // name cannot go wrong that way.
  const parts = dayParts.formatToParts(new Date());
  const value = (type: string) => parts.find(p => p.type === type)?.value ?? "";

  return `${value("year")}-${value("month")}-${value("day")}`;
}

/**
 * The instant a calendar day begins in the business zone.
 *
 * `payments.received_at` is a `timestamptz`, but "how much did the school
 * collect in September" is a question about Kenyan calendar days. Reading the
 * boundary in UTC shifts the window three hours: a fee paid at 01:00 Nairobi
 * on the 1st was received at 22:00 UTC on the previous day, so a UTC-bounded
 * September both drops the first three hours of the 1st and picks up the last
 * three of August. Small, and exactly the kind of discrepancy that makes a
 * bursar's collection figure impossible to reconcile against anything else.
 *
 * The offset is derived from the zone rather than written as +03:00. Kenya has
 * not observed DST since 1960 so the constant would be right today, but it
 * would silently stop being right the moment `BUSINESS_TIME_ZONE` changed —
 * and that is one edit away.
 */
const zonedParts = new Intl.DateTimeFormat("en-US", {
  timeZone: BUSINESS_TIME_ZONE,
  calendar: "gregory",
  numberingSystem: "latn",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

/** How far the zone's wall clock is ahead of UTC at a given instant. */
function offsetMsAt(instant: Date): number {
  const parts = zonedParts.formatToParts(instant);
  const value = (type: string) => Number(parts.find(p => p.type === type)?.value);

  // Hour 24 is how en-US with hour12:false spells midnight.
  const hour = value("hour") % 24;

  const wallClockAsUtc = Date.UTC(
    value("year"),
    value("month") - 1,
    value("day"),
    hour,
    value("minute"),
    value("second"),
  );

  return wallClockAsUtc - instant.getTime();
}

export function startOfBusinessDay(day: string): Date {
  const midnightUtc = Date.parse(`${day}T00:00:00Z`);

  // Two passes: the offset is looked up at an instant, and the instant is what
  // is being solved for. The first guess lands within a day of the answer,
  // which is close enough for the second to read the correct offset — the
  // standard way round this, and exact for a zone whose offset is fixed.
  const guess = new Date(midnightUtc - offsetMsAt(new Date(midnightUtc)));

  return new Date(midnightUtc - offsetMsAt(guess));
}
