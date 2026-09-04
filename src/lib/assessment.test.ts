import { describe, expect, it } from "vitest";

import type { PerformanceLevel } from "@/lib/assessment";

import { levelForPercentage, reduceLevels } from "@/lib/assessment";

/**
 * The two reductions a report card depends on, tested in isolation.
 *
 * Both are easy to get subtly wrong in ways nobody notices until a parent
 * disputes a grade — and by then the number has been printed.
 */
describe("levelForPercentage", () => {
  // The defaults on `schools.level_thresholds`.
  const thresholds = { approaching: 40, meeting: 60, exceeding: 80 };

  it.each([
    [0, "below_expectation"],
    [39, "below_expectation"],
    [40, "approaching"],
    [59, "approaching"],
    [60, "meeting"],
    [79, "meeting"],
    [80, "exceeding"],
    [100, "exceeding"],
  ])("puts %i%% at %s", (percentage, expected) => {
    // The cut point itself belongs to the band above it — 40 is approaching,
    // not below. A school reading its own policy expects the boundary to be
    // inclusive, and off-by-one here moves real children between bands.
    expect(levelForPercentage(thresholds, percentage)).toBe(expected);
  });

  it("uses the school's own cut points, not these ones", () => {
    // Schools differ, which is why the thresholds live on the school row.
    const strict = { approaching: 50, meeting: 70, exceeding: 90 };
    expect(levelForPercentage(strict, 60)).toBe("approaching");
    expect(levelForPercentage(thresholds, 60)).toBe("meeting");
  });
});

describe("reduceLevels", () => {
  it("returns null for no judgements at all", () => {
    // A learning area with nothing recorded has no overall level, which is a
    // different thing from having a bad one.
    expect(reduceLevels([])).toBeNull();
  });

  it("takes the mode, not the mean", () => {
    const levels: PerformanceLevel[] = [
      "meeting",
      "meeting",
      "meeting",
      "exceeding",
    ];
    expect(reduceLevels(levels)).toBe("meeting");
  });

  it("does not average a split child into the middle", () => {
    /*
     * The case CLAUDE.md §5.6 calls out by name.
     *
     * Exceeding in one sub-strand and below expectation in another averages to
     * "meeting" — a level the child has not reached in anything. That is a mean
     * of ordinals wearing a competency judgement's clothes, and it hides
     * exactly what the level system exists to surface.
     */
    const split: PerformanceLevel[] = ["exceeding", "below_expectation"];

    expect(reduceLevels(split)).not.toBe("meeting");
    // Tied, so the default rule resolves down.
    expect(reduceLevels(split)).toBe("below_expectation");
  });

  it("resolves a tie downward by default", () => {
    const tied: PerformanceLevel[] = ["approaching", "approaching", "exceeding", "exceeding"];

    // Overstating is the direction that costs a family a conversation they
    // should have had earlier.
    expect(reduceLevels(tied)).toBe("approaching");
  });

  it("resolves upward when the school says so", () => {
    const tied: PerformanceLevel[] = ["approaching", "approaching", "exceeding", "exceeding"];
    expect(reduceLevels(tied, "mode_ties_high")).toBe("exceeding");
  });

  it("lets the weakest sub-strand decide, for a school that reads levels as a floor", () => {
    const levels: PerformanceLevel[] = [
      "exceeding",
      "exceeding",
      "exceeding",
      "approaching",
    ];

    expect(reduceLevels(levels, "lowest")).toBe("approaching");
    // The mode would have said exceeding, which is why the rule is a choice a
    // head makes rather than one this function makes for them.
    expect(reduceLevels(levels)).toBe("exceeding");
  });

  it("is unmoved by the order judgements were entered in", () => {
    const a: PerformanceLevel[] = ["meeting", "exceeding", "meeting"];
    const b: PerformanceLevel[] = ["exceeding", "meeting", "meeting"];

    // Marks go in over days and in whatever order a teacher works through the
    // register; a result that depended on that would be indefensible.
    expect(reduceLevels(a)).toBe(reduceLevels(b));
  });

  it("handles a single judgement", () => {
    expect(reduceLevels(["below_expectation"])).toBe("below_expectation");
  });

  it("never invents a level nobody was given", () => {
    // Whatever the rule, the answer is always one of the levels actually
    // recorded — the failure mode of an average is producing one that is not.
    const levels: PerformanceLevel[] = ["below_expectation", "exceeding", "exceeding"];

    for (const rule of ["mode_ties_low", "mode_ties_high", "lowest"] as const)
      expect(levels).toContain(reduceLevels(levels, rule));
  });
});
