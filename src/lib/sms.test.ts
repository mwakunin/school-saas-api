import { describe, expect, it } from "vitest";

import { parseCostCents, segmentsFor } from "@/lib/sms";

/**
 * The two pure pieces of SMS billing, tested away from the provider.
 *
 * Both feed numbers a school reads and acts on — one on the invoice, one in
 * the warning before a send — and both are easy to get quietly wrong in a way
 * that only shows up as a bill nobody can reconcile.
 */
describe("parseCostCents", () => {
  it.each([
    ["KES 0.8000", 80],
    ["KES 1.6000", 160],
    ["KES 0", 0],
    ["0", 0],
  ])("reads %s as %i cents", (raw, expected) => {
    // The currency prefix is part of the field. Passing this straight to
    // Number() yields NaN, and a spend report full of nulls is one nobody
    // notices is broken until they are asked to explain the AT invoice.
    expect(parseCostCents(raw)).toBe(expected);
  });

  it("survives a shape the provider never documented", () => {
    // Rather than throwing inside a send loop that is halfway through four
    // hundred families. A missing cost is recoverable; a crashed batch is not.
    expect(parseCostCents(undefined)).toBeNull();
    expect(parseCostCents("free")).toBeNull();
    expect(parseCostCents({})).toBeNull();
  });

  it("takes a number as shillings, not as cents", () => {
    // The units are the whole risk here: reading 0.8 as 0 cents would report
    // an entire term's messaging as free.
    expect(parseCostCents(0.8)).toBe(80);
  });
});

describe("segmentsFor", () => {
  it("bills a short plain message as one unit", () => {
    expect(segmentsFor("Results are out.")).toBe(1);
    expect(segmentsFor("a".repeat(160))).toBe(1);
  });

  it("splits a long plain message at 153, not 160", () => {
    // The concatenation header eats part of each segment, so a 161-character
    // message is two units of 153 rather than 160 + 1.
    expect(segmentsFor("a".repeat(161))).toBe(2);
    expect(segmentsFor("a".repeat(306))).toBe(2);
    expect(segmentsFor("a".repeat(307))).toBe(3);
  });

  it("more than doubles the cost for one non-ASCII character", () => {
    /*
     * The case worth warning a bursar about, and the reason this exists.
     *
     * One smart quote pasted out of Word forces UCS-2, which drops the limit
     * from 160 characters to 70 — so a message that was one unit becomes
     * three, times four hundred families, and nobody finds out until the
     * invoice.
     */
    const plain = "a".repeat(150);
    expect(segmentsFor(plain)).toBe(1);
    expect(segmentsFor(`${plain}’`)).toBe(3);
  });

  it("treats an empty body as one unit rather than none", () => {
    // Guards the division: `Math.ceil(0 / 67)` is 0, and a batch estimated at
    // zero cost is the shape of an estimate nobody checks.
    expect(segmentsFor("")).toBe(1);
  });
});
