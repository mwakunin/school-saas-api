import { describe, expect, it } from "vitest";

import { assertKenyanPhone, normalizeKenyanPhone } from "./phone";

describe("normalizeKenyanPhone", () => {
  it.each([
    // Every shape a Kenyan guest might realistically type.
    ["0712345678", "+254712345678"],
    ["+254712345678", "+254712345678"],
    ["254712345678", "+254712345678"],
    ["712345678", "+254712345678"],
    ["0112345678", "+254112345678"],
    ["+254112345678", "+254112345678"],
    // Formatting noise.
    ["0712 345 678", "+254712345678"],
    ["0712-345-678", "+254712345678"],
    ["(0712) 345678", "+254712345678"],
    ["  +254 712 345 678  ", "+254712345678"],
    ["+254-712-345-678", "+254712345678"],
  ])("normalizes %s -> %s", (input, expected) => {
    expect(normalizeKenyanPhone(input)).toBe(expected);
  });

  it.each([
    ["", "empty"],
    ["07123456789", "too long"],
    ["071234567", "too short"],
    ["0812345678", "invalid mobile prefix (8)"],
    ["0612345678", "invalid mobile prefix (6)"],
    ["+255712345678", "Tanzania country code"],
    ["+1712345678", "US country code"],
    ["not a phone", "non-numeric"],
    ["+254 712 345 abc", "trailing letters"],
  ])("rejects %s (%s)", (input) => {
    expect(normalizeKenyanPhone(input)).toBeNull();
  });

  it("is idempotent — normalizing twice changes nothing", () => {
    const once = normalizeKenyanPhone("0712345678")!;
    expect(normalizeKenyanPhone(once)).toBe(once);
  });

  it("maps every shape of one number onto a single identity", () => {
    const shapes = ["0712345678", "+254712345678", "254712345678", "712345678"];
    const normalized = new Set(shapes.map(s => normalizeKenyanPhone(s)));
    expect(normalized.size).toBe(1);
  });
});

describe("assertKenyanPhone", () => {
  it("returns the normalized number when valid", () => {
    expect(assertKenyanPhone("0712345678")).toBe("+254712345678");
  });

  it("throws when invalid", () => {
    expect(() => assertKenyanPhone("0812345678")).toThrow(/not a valid kenyan/i);
  });
});
