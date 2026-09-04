import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";

import type { AppDb } from "@/db";

import {
  assessments,
  assessmentScores,
  enrollments,
  learningAreas,
  streams,
  termResults,
} from "@/db/schema";

/**
 * Turning marks and judgements into a term result.
 *
 * Two grading systems run side by side and neither is a view of the other.
 * The exam side produces a percentage and a position; the competency side
 * produces a performance level per sub-strand. CBE schools need both — national
 * assessment is competency-based, and internal exams are still out of 100 —
 * and the rules for reducing each are different in kind.
 */

export type PerformanceLevel
  = | "below_expectation"
    | "approaching"
    | "meeting"
    | "exceeding";

/** Ordered worst to best, which is the only ordering these have. */
export const LEVEL_ORDER: PerformanceLevel[] = [
  "below_expectation",
  "approaching",
  "meeting",
  "exceeding",
];

export interface LevelThresholds {
  approaching: number;
  meeting: number;
  exceeding: number;
}

/**
 * A percentage becomes a level by the school's own cut points.
 *
 * Schools differ on where the lines sit, which is why the thresholds live on
 * the school row rather than in this file. Below the `approaching` cut point a
 * child is `below_expectation`; there is no fourth threshold because the
 * bottom band is whatever is left.
 */
export function levelForPercentage(
  thresholds: LevelThresholds,
  percentage: number,
): PerformanceLevel {
  if (percentage >= thresholds.exceeding)
    return "exceeding";
  if (percentage >= thresholds.meeting)
    return "meeting";
  if (percentage >= thresholds.approaching)
    return "approaching";
  return "below_expectation";
}

/**
 * How a set of sub-strand levels reduces to one.
 *
 * `mode_ties_low` — the most frequent level; where two tie, the lower wins.
 * `mode_ties_high` — the same, resolving upward.
 * `lowest` — the weakest sub-strand decides, for a school that treats the
 *   levels as a floor rather than a summary.
 *
 * There is deliberately no `mean`.
 */
export type LevelReduction = "mode_ties_low" | "mode_ties_high" | "lowest";

/**
 * Reduces per-sub-strand levels to the one printed on a report card.
 *
 * **Never an average** (CLAUDE.md §5.6). A child who is `exceeding` in one
 * sub-strand and `below_expectation` in another is not `meeting`: that is a
 * mean of ordinals wearing a competency judgement's clothes, and it conceals
 * precisely what the level system exists to surface. The per-sub-strand
 * breakdown is the real answer; this is the summary line above it.
 *
 * The rule is explicit and per school, because reducing four judgements to one
 * is a policy decision a head should be able to state — not something a
 * function decided quietly on their behalf. Ties resolve DOWN by default: a
 * child who is half exceeding and half approaching is not exceeding, and
 * overstating is the direction that costs a family a conversation they should
 * have had earlier.
 *
 * Returns null for an empty set. A learning area with no competency
 * judgements has no overall level, which is different from having a bad one.
 */
export function reduceLevels(
  levels: PerformanceLevel[],
  rule: LevelReduction = "mode_ties_low",
): PerformanceLevel | null {
  if (levels.length === 0)
    return null;

  if (rule === "lowest") {
    return LEVEL_ORDER[Math.min(...levels.map(l => LEVEL_ORDER.indexOf(l)))];
  }

  const counts = new Map<PerformanceLevel, number>();
  for (const level of levels)
    counts.set(level, (counts.get(level) ?? 0) + 1);

  const highestCount = Math.max(...counts.values());
  const tied = [...counts.entries()]
    .filter(([, count]) => count === highestCount)
    .map(([level]) => LEVEL_ORDER.indexOf(level));

  return LEVEL_ORDER[rule === "mode_ties_high" ? Math.max(...tied) : Math.min(...tied)];
}

export interface LearningAreaResult {
  learningAreaId: string;
  learningAreaName: string;
  sequence: number;
  /** Weighted mean across scored assessments, or null on the competency path. */
  meanScore: number | null;
  overallLevel: PerformanceLevel | null;
  /** The breakdown the summary is drawn from — the part that actually informs. */
  competencyLevels: Array<{
    competencyId: string;
    level: PerformanceLevel;
  }>;
}

/**
 * Computes one enrolment's results for a term, per learning area.
 *
 * Only PUBLISHED assessments count. An unpublished one is still being entered
 * and corrected, and letting a half-finished exam move a term mean would make
 * the mean move under a parent looking at it.
 *
 * Absences are skipped rather than counted as zero. Storing an absence as a
 * zero drags the mean down for a paper the child never sat, and afterwards the
 * two are indistinguishable.
 */
export async function computeLearningAreaResults(
  db: AppDb,
  enrollmentId: string,
  termId: string,
): Promise<LearningAreaResult[]> {
  /*
   * The exam side: a weighted mean of percentages.
   *
   * Each assessment contributes `rawScore / maxScore` scaled by its weight, so
   * an end-term paper out of 100 and a CAT out of 30 combine on the same
   * footing. An assessment with no `maxScore` is pure observation and produces
   * no percentage — it is excluded here and speaks through its levels instead.
   *
   * Weight defaults to 1 when unset, which makes an unweighted school's marks
   * a plain average rather than nothing at all.
   */
  const examRows = await db
    .select({
      learningAreaId: assessments.learningAreaId,
      weightedTotal: sql<string>`
        sum((${assessmentScores.rawScore} / ${assessments.maxScore}) * 100
            * coalesce(${assessments.weight}, 1))
      `,
      weightSum: sql<string>`sum(coalesce(${assessments.weight}, 1))`,
    })
    .from(assessmentScores)
    .innerJoin(assessments, eq(assessmentScores.assessmentId, assessments.id))
    .where(and(
      eq(assessmentScores.enrollmentId, enrollmentId),
      eq(assessments.termId, termId),
      // Published only.
      isNotNull(assessments.publishedAt),
      // The percentage path: one overall result, no competency.
      isNull(assessmentScores.competencyId),
      isNotNull(assessmentScores.rawScore),
      isNotNull(assessments.maxScore),
      eq(assessmentScores.isAbsent, false),
    ))
    .groupBy(assessments.learningAreaId);

  const meanByArea = new Map(
    examRows.map(row => [
      row.learningAreaId,
      Number(row.weightSum) > 0
        ? Number(row.weightedTotal) / Number(row.weightSum)
        : null,
    ]),
  );

  // The competency side: every sub-strand judgement, kept whole.
  const levelRows = await db
    .select({
      learningAreaId: assessments.learningAreaId,
      competencyId: assessmentScores.competencyId,
      level: assessmentScores.level,
    })
    .from(assessmentScores)
    .innerJoin(assessments, eq(assessmentScores.assessmentId, assessments.id))
    .where(and(
      eq(assessmentScores.enrollmentId, enrollmentId),
      eq(assessments.termId, termId),
      isNotNull(assessments.publishedAt),
      isNotNull(assessmentScores.competencyId),
      isNotNull(assessmentScores.level),
      eq(assessmentScores.isAbsent, false),
    ));

  const levelsByArea = new Map<string, Array<{ competencyId: string; level: PerformanceLevel }>>();
  for (const row of levelRows) {
    const list = levelsByArea.get(row.learningAreaId) ?? [];
    list.push({ competencyId: row.competencyId!, level: row.level! });
    levelsByArea.set(row.learningAreaId, list);
  }

  // Every learning area the school teaches, in the order it prints them —
  // including ones with no results yet, so a gap on a report card is visible
  // as a gap rather than as a missing row nobody notices.
  const areas = await db
    .select({
      id: learningAreas.id,
      name: learningAreas.name,
      sequence: learningAreas.sequence,
    })
    .from(learningAreas)
    .orderBy(asc(learningAreas.sequence), asc(learningAreas.name));

  return areas.map(area => ({
    learningAreaId: area.id,
    learningAreaName: area.name,
    sequence: area.sequence,
    meanScore: meanByArea.get(area.id) ?? null,
    overallLevel: null,
    competencyLevels: levelsByArea.get(area.id) ?? [],
  }));
}

/**
 * Writes a term's results for every enrolment in it.
 *
 * Recomputed rather than accumulated: marks get corrected, assessments get
 * published late, and a result that only ever moved forwards would drift from
 * the scores under it. Safe to run repeatedly — that is the point, since a
 * teacher fixing a mark expects the report to follow.
 *
 * Positions are NOT set here. They are derived at finalisation, from the whole
 * cohort at once, and frozen — see `computePositions`.
 */
export async function computeTermResults(
  db: AppDb,
  schoolId: string,
  termId: string,
  reduction: LevelReduction = "mode_ties_low",
): Promise<{ enrolments: number; results: number }> {
  const cohort = await db
    .select({ id: enrollments.id })
    .from(enrollments)
    .where(isNull(enrollments.endedOn));

  let written = 0;

  for (const enrolment of cohort) {
    const areas = await computeLearningAreaResults(db, enrolment.id, termId);

    for (const area of areas) {
      const overallLevel = reduceLevels(
        area.competencyLevels.map(c => c.level),
        reduction,
      );

      // Nothing recorded for this area yet — skip rather than write an empty
      // row, so "no result" and "a result of nothing" stay distinguishable.
      if (area.meanScore === null && overallLevel === null)
        continue;

      await db
        .insert(termResults)
        .values({
          schoolId,
          enrollmentId: enrolment.id,
          termId,
          learningAreaId: area.learningAreaId,
          meanScore: area.meanScore === null ? null : area.meanScore.toFixed(2),
          overallLevel,
        })
        .onConflictDoUpdate({
          target: [
            termResults.enrollmentId,
            termResults.termId,
            termResults.learningAreaId,
          ],
          set: {
            meanScore: area.meanScore === null ? null : area.meanScore.toFixed(2),
            overallLevel,
            computedAt: new Date(),
          },
        });

      written += 1;
    }
  }

  return { enrolments: cohort.length, results: written };
}

/**
 * Ranks a term's results within each stream and each grade.
 *
 * **Position is derived late and derived once** (CLAUDE.md §5.6). Class rank is
 * the most contested number on a Kenyan report card, so it is computed from the
 * whole cohort at one moment, written, and then frozen into the report card
 * snapshot. A rank that silently changed because a late mark was entered is a
 * conversation no school wants to have twice.
 *
 * Ties share a rank, and the next rank skips — the ordinary reading of "joint
 * third". `outOf` counts the cohort, so "4th of 32" survives a child leaving.
 */
export async function computePositions(
  db: AppDb,
  termId: string,
): Promise<number> {
  const result = await db.execute<{ updated: string }>(sql`
    WITH ranked AS (
      SELECT
        tr.id,
        rank() OVER (
          PARTITION BY e.stream_id, tr.learning_area_id
          ORDER BY tr.mean_score DESC NULLS LAST
        ) AS stream_position,
        rank() OVER (
          PARTITION BY s.grade_level_id, tr.learning_area_id
          ORDER BY tr.mean_score DESC NULLS LAST
        ) AS grade_position,
        count(*) OVER (
          PARTITION BY e.stream_id, tr.learning_area_id
        ) AS out_of
      FROM term_results tr
      JOIN enrollments e ON e.id = tr.enrollment_id
      JOIN streams s ON s.id = e.stream_id
      WHERE tr.term_id = ${termId}
        -- Only a mark can be ranked. A competency-only result has no position,
        -- and inventing one would rank children on nothing.
        AND tr.mean_score IS NOT NULL
    )
    UPDATE term_results tr
    SET stream_position = ranked.stream_position,
        grade_position  = ranked.grade_position,
        out_of          = ranked.out_of
    FROM ranked
    WHERE tr.id = ranked.id
    RETURNING 1 AS updated
  `);

  return result.rows.length;
}

export interface ReportCardSnapshot {
  /** Everything a printed report card needs, frozen at finalisation. */
  student: {
    id: string;
    admissionNumber: string;
    name: string;
  };
  class: {
    streamId: string;
    streamName: string;
    gradeLevelName: string;
  };
  term: {
    id: string;
    number: number;
    startsOn: string;
    endsOn: string;
  };
  /** Whether this school publishes positions at all. */
  showsPositions: boolean;
  /** The reduction rule in force when this was computed, so it is explicable. */
  levelReduction: LevelReduction;
  learningAreas: Array<{
    name: string;
    sequence: number;
    meanScore: number | null;
    overallLevel: PerformanceLevel | null;
    streamPosition: number | null;
    gradePosition: number | null;
    outOf: number | null;
    /** The breakdown, which is the body of the report card. */
    competencies: Array<{ title: string; code: string | null; level: PerformanceLevel }>;
  }>;
  finalisedAt: string;
}

/** The stream and grade a term result belongs to, for the snapshot header. */
export async function enrolmentContext(db: AppDb, enrollmentId: string) {
  const [row] = await db
    .select({
      streamId: streams.id,
      streamName: streams.name,
      gradeLevelId: streams.gradeLevelId,
    })
    .from(enrollments)
    .innerJoin(streams, eq(enrollments.streamId, streams.id))
    .where(eq(enrollments.id, enrollmentId));

  return row ?? null;
}
