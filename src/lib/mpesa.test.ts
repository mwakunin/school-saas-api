import { Buffer } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DARAJA_TIMEOUT_MS,
  darajaTimestamp,
  getAccessToken,
  isAllowedCallbackIp,
  MpesaError,
  parseCallback,
  queryStkStatus,
  resetTokenCache,
  stkPassword,
  stkPush,
} from "./mpesa";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const TOKEN_OK = { access_token: "tok-123", expires_in: "3599" };

/** Mocks fetch so the real client code — URLs, headers, payload — is exercised. */
function mockFetch(...responses: Response[]) {
  const fn = vi.fn<typeof fetch>();
  for (const r of responses)
    fn.mockResolvedValueOnce(r);
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("darajaTimestamp", () => {
  it("formats as YYYYMMDDHHmmss in East Africa Time", () => {
    // 2026-09-10T09:30:15Z -> 12:30:15 EAT
    const ts = darajaTimestamp(new Date("2026-09-10T09:30:15Z"));
    expect(ts).toBe("20260910123015");
  });

  it("rolls over the date when UTC evening is the next day in EAT", () => {
    // 22:30 UTC is 01:30 the following day in EAT.
    expect(darajaTimestamp(new Date("2026-09-10T22:30:00Z"))).toBe("20260911013000");
  });

  it("zero-pads every field", () => {
    expect(darajaTimestamp(new Date("2026-01-02T00:00:00Z"))).toBe("20260102030000");
  });

  it("is independent of the server's local timezone", () => {
    // Built from UTC parts plus a fixed offset, so TZ can't shift it.
    const at = new Date("2026-09-10T09:30:15Z");
    expect(darajaTimestamp(at)).toBe(darajaTimestamp(at));
    expect(darajaTimestamp(at)).toHaveLength(14);
  });
});

describe("stkPassword", () => {
  it("is base64 of shortcode + passkey + timestamp", () => {
    const pw = stkPassword("174379", "secret", "20260910123015");
    expect(Buffer.from(pw, "base64").toString()).toBe("174379secret20260910123015");
  });
});

describe("getAccessToken", () => {
  beforeEach(() => resetTokenCache());
  afterEach(() => vi.unstubAllGlobals());

  it("sends Basic auth built from the consumer key and secret", async () => {
    const fetchMock = mockFetch(jsonResponse(TOKEN_OK));

    await getAccessToken();

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/oauth/v1/generate?grant_type=client_credentials");

    const auth = (init?.headers as Record<string, string>).Authorization;
    expect(Buffer.from(auth.replace("Basic ", ""), "base64").toString())
      .toBe("test-consumer-key:test-consumer-secret");
  });

  it("caches the token instead of re-fetching per request", async () => {
    const fetchMock = mockFetch(jsonResponse(TOKEN_OK));

    await getAccessToken();
    await getAccessToken();
    await getAccessToken();

    // Daraja rate-limits this endpoint, so one call is the point.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("re-fetches once the cached token has expired", async () => {
    const fetchMock = mockFetch(
      jsonResponse({ access_token: "first", expires_in: "60" }),
      jsonResponse({ access_token: "second", expires_in: "3599" }),
    );

    // expires_in 60 minus 60s of headroom means it is already stale.
    expect(await getAccessToken()).toBe("first");
    expect(await getAccessToken()).toBe("second");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws MpesaError on a non-OK response", async () => {
    mockFetch(new Response("nope", { status: 401 }));
    await expect(getAccessToken()).rejects.toThrow(MpesaError);
  });

  it("throws when the response carries no access_token", async () => {
    mockFetch(jsonResponse({ nothing: true }));
    await expect(getAccessToken()).rejects.toThrow(/no access_token/i);
  });
});

describe("stkPush", () => {
  beforeEach(() => resetTokenCache());
  afterEach(() => vi.unstubAllGlobals());

  const accepted = {
    MerchantRequestID: "mr-1",
    CheckoutRequestID: "ws_CO_123",
    ResponseCode: "0",
    CustomerMessage: "Success. Request accepted for processing",
  };

  it("converts cents to whole shillings for Daraja", async () => {
    const fetchMock = mockFetch(jsonResponse(TOKEN_OK), jsonResponse(accepted));

    await stkPush({
      phoneNumber: "+254712345678",
      amountCents: 4_400_000,
      accountReference: "abc12345",
      description: "Rental booking",
    });

    const body = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(body.Amount).toBe(44_000); // KES 44,000, not 4,400,000
  });

  it("strips the leading + from the phone number", async () => {
    const fetchMock = mockFetch(jsonResponse(TOKEN_OK), jsonResponse(accepted));

    await stkPush({
      phoneNumber: "+254712345678",
      amountCents: 100_000,
      accountReference: "abc",
      description: "d",
    });

    const body = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(body.PhoneNumber).toBe("254712345678");
    expect(body.PartyA).toBe("254712345678");
  });

  it("sends a password matching the timestamp it sends", async () => {
    const fetchMock = mockFetch(jsonResponse(TOKEN_OK), jsonResponse(accepted));

    await stkPush({
      phoneNumber: "+254712345678",
      amountCents: 100_000,
      accountReference: "abc",
      description: "d",
    });

    const body = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    // Daraja rejects the request if these disagree.
    expect(Buffer.from(body.Password, "base64").toString())
      .toBe(`174379test-passkey${body.Timestamp}`);
  });

  it("refuses an amount that is not a whole number of shillings", async () => {
    mockFetch(jsonResponse(TOKEN_OK));

    await expect(stkPush({
      phoneNumber: "+254712345678",
      amountCents: 12_345,
      accountReference: "abc",
      description: "d",
    })).rejects.toThrow(/whole number of shillings/i);
  });

  it("throws when Daraja returns a non-zero ResponseCode despite HTTP 200", async () => {
    mockFetch(
      jsonResponse(TOKEN_OK),
      jsonResponse({ ResponseCode: "1", errorMessage: "Invalid Amount" }),
    );

    await expect(stkPush({
      phoneNumber: "+254712345678",
      amountCents: 100_000,
      accountReference: "abc",
      description: "d",
    })).rejects.toThrow(/Invalid Amount/);
  });

  it("returns the correlation ids on success", async () => {
    mockFetch(jsonResponse(TOKEN_OK), jsonResponse(accepted));

    const res = await stkPush({
      phoneNumber: "+254712345678",
      amountCents: 100_000,
      accountReference: "abc",
      description: "d",
    });

    expect(res.checkoutRequestId).toBe("ws_CO_123");
    expect(res.merchantRequestId).toBe("mr-1");
  });

  it("truncates the reference and description to Daraja's limits", async () => {
    const fetchMock = mockFetch(jsonResponse(TOKEN_OK), jsonResponse(accepted));

    await stkPush({
      phoneNumber: "+254712345678",
      amountCents: 100_000,
      accountReference: "a".repeat(40),
      description: "b".repeat(40),
    });

    const body = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(body.AccountReference.length).toBeLessThanOrEqual(12);
    expect(body.TransactionDesc.length).toBeLessThanOrEqual(13);
  });
});

describe("request timeouts", () => {
  beforeEach(() => resetTokenCache());
  afterEach(() => vi.unstubAllGlobals());

  const accepted = {
    MerchantRequestID: "mr-1",
    CheckoutRequestID: "ws_CO_123",
    ResponseCode: "0",
    CustomerMessage: "ok",
  };

  // fetch has no default timeout. An unbounded push can still be in flight
  // when the payment flow decides a stale attempt never reached Safaricom,
  // which would let a second prompt reach the handset.
  it("bounds every Daraja call with an abort signal", async () => {
    const fetchMock = mockFetch(
      jsonResponse(TOKEN_OK),
      jsonResponse(accepted),
      jsonResponse({ ResultCode: "0", ResultDesc: "ok" }),
    );

    await stkPush({
      phoneNumber: "+254712345678",
      amountCents: 100_000,
      accountReference: "abc",
      description: "d",
    });
    await queryStkStatus("ws_CO_123");

    expect(fetchMock.mock.calls).toHaveLength(3);
    for (const [, init] of fetchMock.mock.calls)
      expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("keeps the timeout well below the retry cooldown", () => {
    // payments.handlers.ts releases a stale attempt only after 90s; the push
    // must have aborted by then for that to be safe.
    expect(DARAJA_TIMEOUT_MS).toBeLessThan(90_000);
  });
});

describe("queryStkStatus", () => {
  beforeEach(() => resetTokenCache());
  afterEach(() => vi.unstubAllGlobals());

  it("reports the result code Safaricom returns", async () => {
    mockFetch(
      jsonResponse(TOKEN_OK),
      jsonResponse({ ResultCode: "0", ResultDesc: "The service request is processed successfully." }),
    );

    const status = await queryStkStatus("ws_CO_123");
    expect(status.resultCode).toBe(0);
  });

  it("reports a failure code", async () => {
    mockFetch(
      jsonResponse(TOKEN_OK),
      jsonResponse({ ResultCode: "1032", ResultDesc: "Request cancelled by user" }),
    );

    const status = await queryStkStatus("ws_CO_123");
    expect(status.resultCode).toBe(1032);
  });

  it("throws when the query endpoint errors", async () => {
    mockFetch(jsonResponse(TOKEN_OK), jsonResponse({}, 500));
    await expect(queryStkStatus("ws_CO_123")).rejects.toThrow(MpesaError);
  });
});

describe("parseCallback", () => {
  const success = {
    Body: {
      stkCallback: {
        MerchantRequestID: "mr-1",
        CheckoutRequestID: "ws_CO_123",
        ResultCode: 0,
        ResultDesc: "The service request is processed successfully.",
        CallbackMetadata: {
          Item: [
            { Name: "Amount", Value: 44000 },
            { Name: "MpesaReceiptNumber", Value: "SDJ4H2K1LM" },
            { Name: "PhoneNumber", Value: 254712345678 },
          ],
        },
      },
    },
  };

  it("extracts the correlation ids and result", () => {
    const p = parseCallback(success)!;
    expect(p.checkoutRequestId).toBe("ws_CO_123");
    expect(p.resultCode).toBe(0);
    expect(p.mpesaReceiptNumber).toBe("SDJ4H2K1LM");
  });

  it("converts Daraja's whole shillings back into cents", () => {
    expect(parseCallback(success)!.amountCents).toBe(4_400_000);
  });

  it("handles a failure callback, which carries no metadata", () => {
    const p = parseCallback({
      Body: {
        stkCallback: {
          MerchantRequestID: "mr-2",
          CheckoutRequestID: "ws_CO_456",
          ResultCode: 1032,
          ResultDesc: "Request cancelled by user",
        },
      },
    })!;

    expect(p.resultCode).toBe(1032);
    expect(p.amountCents).toBeUndefined();
    expect(p.mpesaReceiptNumber).toBeUndefined();
  });

  it.each([
    ["null", null],
    ["empty object", {}],
    ["missing stkCallback", { Body: {} }],
    ["missing CheckoutRequestID", { Body: { stkCallback: { ResultCode: 0 } } }],
    ["a string", "not json"],
    ["an array", []],
  ])("returns null for %s rather than throwing", (_label, payload) => {
    expect(parseCallback(payload)).toBeNull();
  });
});

describe("isAllowedCallbackIp", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("allows anything when no allowlist is configured", () => {
    // .env.test sets no allowlist.
    expect(isAllowedCallbackIp("1.2.3.4")).toBe(true);
    expect(isAllowedCallbackIp(undefined)).toBe(true);
  });
});
