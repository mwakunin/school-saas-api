import { describe, expect, it, vi } from "vitest";

import { startOfBusinessDay, todayInBusinessZone } from "./dates";

/**
 * Kenya is UTC+3, so for the first three hours of each Kenyan day UTC still
 * reports yesterday. Read in UTC, a stay beginning today looks like it begins
 * tomorrow for those three hours — long enough for the "has this stay begun?"
 * guard to let a cancellation through on the arrival date itself.
 */
describe("todayInBusinessZone", () => {
  it.each([
    // 01:00 in Nairobi on the 1st is still 22:00 UTC on the previous day.
    ["2026-08-31T22:00:00Z", "2026-09-01"],
    ["2026-08-31T21:00:00Z", "2026-09-01"],
    // 23:59 UTC is already the next day in Nairobi.
    ["2026-08-31T23:59:00Z", "2026-09-01"],
    // Comfortably inside the same day either way.
    ["2026-09-01T09:00:00Z", "2026-09-01"],
    // 20:59 UTC is still the same Kenyan day.
    ["2026-08-31T20:59:00Z", "2026-08-31"],
  ])("at %s the Kenyan calendar day is %s", (instant, expected) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(instant));

    try {
      expect(todayInBusinessZone()).toBe(expected);
    }
    finally {
      vi.useRealTimers();
    }
  });

  // The shape is what makes the value comparable to a `date` column at all.
  // A locale fallback that printed 9/1/2026 would not throw — it would just
  // compare wrongly, and "2026-09-01" <= "9/1/2026" is true, so every stay
  // would look already begun.
  it("always produces a zero-padded YYYY-MM-DD", () => {
    vi.useFakeTimers();

    try {
      for (const instant of [
        "2026-01-05T09:00:00Z",
        "2026-09-01T09:00:00Z",
        "2026-12-31T21:30:00Z",
      ]) {
        vi.setSystemTime(new Date(instant));
        expect(todayInBusinessZone()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    }
    finally {
      vi.useRealTimers();
    }
  });

  it("orders correctly as a string, which is how it is compared", () => {
    vi.useFakeTimers();

    try {
      vi.setSystemTime(new Date("2026-01-05T09:00:00Z"));
      const january = todayInBusinessZone();
      vi.setSystemTime(new Date("2026-09-01T09:00:00Z"));
      const september = todayInBusinessZone();

      expect(january).toBe("2026-01-05");
      expect(january < september).toBe(true);
    }
    finally {
      vi.useRealTimers();
    }
  });

  it("disagrees with UTC exactly when Kenya has already turned over", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-31T22:00:00Z"));

    try {
      expect(new Date().toISOString().slice(0, 10)).toBe("2026-08-31");
      expect(todayInBusinessZone()).toBe("2026-09-01");
    }
    finally {
      vi.useRealTimers();
    }
  });
});

/**
 * A money window bounded in UTC is three hours out of step with the Kenyan
 * day it claims to cover — it drops the first three hours of the day and
 * picks up the last three of the day before.
 */
describe("startOfBusinessDay", () => {
  it.each([
    ["2026-09-01", "2026-08-31T21:00:00.000Z"],
    ["2026-01-01", "2025-12-31T21:00:00.000Z"],
    // A leap day, and the day after it.
    ["2028-02-29", "2028-02-28T21:00:00.000Z"],
    ["2028-03-01", "2028-02-29T21:00:00.000Z"],
  ])("puts the start of %s at %s", (day, expected) => {
    expect(startOfBusinessDay(day).toISOString()).toBe(expected);
  });

  it("is exactly 24 hours before the next day starts", () => {
    const day = startOfBusinessDay("2026-09-01").getTime();
    const next = startOfBusinessDay("2026-09-02").getTime();

    expect(next - day).toBe(24 * 60 * 60 * 1000);
  });

  // The boundary has to agree with what todayInBusinessZone calls today, or
  // "money taken today" and "today" mean different days for three hours.
  it("agrees with todayInBusinessZone at the edges of a Kenyan day", () => {
    vi.useFakeTimers();
    try {
      // 21:00:00Z is the first instant of 2026-09-01 in Nairobi.
      vi.setSystemTime(new Date("2026-08-31T21:00:00Z"));
      expect(todayInBusinessZone()).toBe("2026-09-01");
      expect(startOfBusinessDay(todayInBusinessZone()).getTime())
        .toBe(new Date("2026-08-31T21:00:00Z").getTime());

      // One millisecond earlier is still the previous Kenyan day.
      vi.setSystemTime(new Date("2026-08-31T20:59:59.999Z"));
      expect(todayInBusinessZone()).toBe("2026-08-31");
    }
    finally {
      vi.useRealTimers();
    }
  });
});
