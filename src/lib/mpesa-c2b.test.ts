import { describe, expect, it } from "vitest";

import { parseC2bConfirmation, parseTransTime } from "./mpesa-c2b";

/**
 * Safaricom's C2B confirmation, as it actually arrives.
 *
 * Every value here is a string, including the amount — Daraja does not send
 * JSON numbers for money — and the payload is entirely attacker-controllable,
 * so the parser's job is to shape it and refuse what cannot be stored, never
 * to decide whether to believe it.
 */
const CONFIRMATION = {
  TransactionType: "Pay Bill",
  TransID: "RKTQDM7W6S",
  TransTime: "20260115143045",
  TransAmount: "18000.00",
  BusinessShortCode: "600638",
  BillRefNumber: "2026/118",
  InvoiceNumber: "",
  OrgAccountBalance: "49197.00",
  ThirdPartyTransID: "",
  MSISDN: "254712345678",
  FirstName: "GRACE",
  MiddleName: "",
  LastName: "NJOROGE",
};

describe("parseTransTime", () => {
  it("reads Safaricom's timestamp as East Africa Time", () => {
    // 14:30:45 in Nairobi is 11:30:45 UTC. Read as UTC — which is what
    // `Date.parse` on a server set to UTC would do — an afternoon payment
    // would be filed at breakfast, and a late-night one on the wrong day.
    const parsed = parseTransTime("20260115143045")!;

    expect(parsed.toISOString()).toBe("2026-01-15T11:30:45.000Z");
  });

  it("puts an early-morning payment on the right date", () => {
    // 01:00 in Nairobi is 22:00 UTC the PREVIOUS day. This is the case that
    // silently moves a payment into yesterday's takings.
    const parsed = parseTransTime("20260115010000")!;

    expect(parsed.toISOString()).toBe("2026-01-14T22:00:00.000Z");
  });

  it.each([
    ["empty", ""],
    ["too short", "2026011514304"],
    ["not digits", "2026-01-15 14:30"],
    ["month 13", "20261315143045"],
    ["day 32", "20260132143045"],
    ["30 February", "20260230143045"],
    ["hour 25", "20260115253045"],
  ])("refuses a timestamp that is %s", (_case, value) => {
    expect(parseTransTime(value)).toBeNull();
  });
});

describe("parseC2bConfirmation", () => {
  it("shapes a real confirmation", () => {
    const parsed = parseC2bConfirmation(CONFIRMATION)!;

    expect(parsed).toMatchObject({
      transactionId: "RKTQDM7W6S",
      shortcode: "600638",
      accountReference: "2026/118",
      msisdn: "254712345678",
      payerName: "GRACE NJOROGE",
      // Whole shillings in, integer cents out (CLAUDE.md §3 rule 3).
      amountCents: 1_800_000,
    });
    expect(parsed.transactedAt.toISOString()).toBe("2026-01-15T11:30:45.000Z");
  });

  it("keeps the reference exactly as the parent typed it", () => {
    // Not normalised, not cleaned up. What was typed is evidence, and the
    // reconciliation queue exists because it is frequently not an admission
    // number at all.
    const parsed = parseC2bConfirmation({
      ...CONFIRMATION,
      BillRefNumber: "  ADM 118 ",
    })!;

    expect(parsed.accountReference).toBe("ADM 118");
  });

  it("accepts a missing reference", () => {
    // A parent can pay with no account reference at all. That is a queue item,
    // not a reason to drop the money.
    const parsed = parseC2bConfirmation({ ...CONFIRMATION, BillRefNumber: "" })!;

    expect(parsed.accountReference).toBeNull();
    expect(parsed.amountCents).toBe(1_800_000);
  });

  it("handles a payer with no middle name", () => {
    const parsed = parseC2bConfirmation({
      ...CONFIRMATION,
      MiddleName: "",
      LastName: "",
    })!;

    expect(parsed.payerName).toBe("GRACE");
  });

  it("accepts a numeric amount as well as a string one", () => {
    expect(parseC2bConfirmation({ ...CONFIRMATION, TransAmount: 18000 })!.amountCents)
      .toBe(1_800_000);
  });

  it.each([
    ["no TransID", { TransID: "" }],
    ["no shortcode", { BusinessShortCode: "" }],
    ["no MSISDN", { MSISDN: "" }],
    ["no TransTime", { TransTime: "" }],
    ["unparseable TransTime", { TransTime: "yesterday" }],
    ["zero amount", { TransAmount: "0" }],
    ["negative amount", { TransAmount: "-100" }],
    ["non-numeric amount", { TransAmount: "lots" }],
  ])("refuses a confirmation with %s", (_case, override) => {
    expect(parseC2bConfirmation({ ...CONFIRMATION, ...override })).toBeNull();
  });

  it("refuses a fractional amount rather than letting the insert fail", () => {
    // The column has a CHECK for whole shillings. Rejecting here means the
    // webhook can log something useful instead of returning a 500 to
    // Safaricom, which would then retry a payment it can never deliver.
    expect(parseC2bConfirmation({ ...CONFIRMATION, TransAmount: "1800.50" })).toBeNull();
  });

  it.each([
    ["null", null],
    ["a string", "not an object"],
    ["an array", []],
    ["empty", {}],
  ])("refuses %s", (_case, payload) => {
    expect(parseC2bConfirmation(payload)).toBeNull();
  });
});
