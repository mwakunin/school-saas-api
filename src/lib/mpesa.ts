import { Buffer } from "node:buffer";

import env from "@/env";

/**
 * Safaricom Daraja client — OAuth, STK push, and transaction status query.
 *
 * Amounts cross this boundary as WHOLE SHILLINGS. Everything inside the app
 * stores integer cents, and the DB CHECK guarantees divisibility by 100, so
 * the conversion here is always exact.
 */

const HOSTS = {
  sandbox: "https://sandbox.safaricom.co.ke",
  production: "https://api.safaricom.co.ke",
} as const;

/**
 * Hard ceiling on any Daraja call.
 *
 * `fetch` has no default timeout, so without this a request can hang
 * indefinitely. That matters beyond tying up a handler: a push still in flight
 * has not yet recorded its checkoutRequestId, and the payment flow treats a
 * pending attempt with no checkout id as "no prompt was ever delivered". This
 * bound is what makes that true — it must stay comfortably below
 * PUSH_COOLDOWN_MS in payments.handlers.ts, so any in-flight push has aborted
 * before a stale attempt becomes eligible for release.
 */
export const DARAJA_TIMEOUT_MS = 30_000;

export function baseUrl(): string {
  return HOSTS[env.MPESA_ENV];
}

/**
 * Thrown when Daraja rejects a request or is unreachable.
 *
 * `definitive` answers the only question the payment flow cares about: did
 * Safaricom actually refuse, so no prompt can exist? A 5xx or a timeout is NOT
 * definitive — the request may have been processed anyway — and treating it as
 * such would release an attempt whose prompt is live.
 */
export class MpesaError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: unknown,
    readonly definitive = false,
  ) {
    super(message);
    this.name = "MpesaError";
  }
}

/**
 * What Safaricom's STK result code tells us about a transaction.
 *
 * The single source of truth for this question. It used to be answered
 * differently in three places — the push-error path, the callback path, and
 * the stale-attempt path — which is how 1001 ("transaction in process") ended
 * up being treated as a terminal failure by one of them and as still-live by
 * another. Route every such decision through here.
 */
export type TransactionVerdict = "paid" | "dead" | "indeterminate";

/** Codes that definitively mean the transaction is over and no prompt is live. */
const TERMINAL_FAILURE_CODES = new Set([
  1, // insufficient balance
  1032, // cancelled by user
  1037, // timed out, user unreachable
  2001, // wrong PIN
]);

export function verdictFor(resultCode: number): TransactionVerdict {
  if (resultCode === 0)
    return "paid";

  // Deliberately an allowlist: an unrecognised code, and 1001 in particular,
  // means the transaction may still be running. Only "dead" may release an
  // attempt's hold on the booking.
  return TERMINAL_FAILURE_CODES.has(resultCode) ? "dead" : "indeterminate";
}

function requireConfig() {
  const {
    MPESA_CONSUMER_KEY: consumerKey,
    MPESA_CONSUMER_SECRET: consumerSecret,
    MPESA_SHORTCODE: shortcode,
    MPESA_PASSKEY: passkey,
    MPESA_CALLBACK_URL: callbackUrl,
  } = env;

  if (!consumerKey || !consumerSecret || !shortcode || !passkey || !callbackUrl)
    throw new MpesaError("M-Pesa is not configured");

  return { consumerKey, consumerSecret, shortcode, passkey, callbackUrl };
}

/**
 * Daraja's timestamp format: YYYYMMDDHHmmss in East Africa Time.
 *
 * Built from UTC parts plus the fixed +3 offset rather than from the server's
 * local clock — Kenya has no DST and the API rejects a timestamp that drifts
 * from the password it was hashed into, so a server in another timezone must
 * not produce a different value.
 */
export function darajaTimestamp(now: Date = new Date()): string {
  const eat = new Date(now.getTime() + 3 * 60 * 60 * 1000);
  const p = (n: number, width = 2) => String(n).padStart(width, "0");

  return [
    p(eat.getUTCFullYear(), 4),
    p(eat.getUTCMonth() + 1),
    p(eat.getUTCDate()),
    p(eat.getUTCHours()),
    p(eat.getUTCMinutes()),
    p(eat.getUTCSeconds()),
  ].join("");
}

/** base64(shortcode + passkey + timestamp), as Daraja specifies. */
export function stkPassword(
  shortcode: string,
  passkey: string,
  timestamp: string,
): string {
  return Buffer.from(`${shortcode}${passkey}${timestamp}`).toString("base64");
}

// Tokens last an hour; Daraja rate-limits the token endpoint, so reuse one
// until shortly before it expires rather than fetching per request.
let cachedToken: { value: string; expiresAt: number } | null = null;

/** Exposed for tests — token caching would otherwise leak between cases. */
export function resetTokenCache() {
  cachedToken = null;
}

export async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt)
    return cachedToken.value;

  const { consumerKey, consumerSecret } = requireConfig();
  const basic = Buffer.from(`${consumerKey}:${consumerSecret}`).toString("base64");

  const res = await fetch(
    `${baseUrl()}/oauth/v1/generate?grant_type=client_credentials`,
    {
      headers: { Authorization: `Basic ${basic}` },
      signal: AbortSignal.timeout(DARAJA_TIMEOUT_MS),
    },
  );

  if (!res.ok) {
    throw new MpesaError(
      `Daraja token request failed (${res.status})`,
      res.status,
      await res.text().catch(() => undefined),
    );
  }

  const body = await res.json() as { access_token?: string; expires_in?: string };
  if (!body.access_token)
    throw new MpesaError("Daraja token response had no access_token", res.status, body);

  const ttlSeconds = Number(body.expires_in ?? 3599);
  cachedToken = {
    value: body.access_token,
    // 60s of headroom so a token can't expire mid-flight.
    expiresAt: Date.now() + Math.max(ttlSeconds - 60, 0) * 1000,
  };

  return cachedToken.value;
}

export interface StkPushResult {
  merchantRequestId: string;
  checkoutRequestId: string;
  customerMessage: string;
}

/**
 * Prompts the guest's handset for a PIN. Returns as soon as Safaricom accepts
 * the request — the actual payment outcome arrives later on the callback, or
 * can be polled with queryStkStatus.
 */
export async function stkPush(input: {
  /** E.164, e.g. +254712345678. Daraja wants it without the plus. */
  phoneNumber: string;
  amountCents: number;
  /** Shown on the guest's statement. */
  accountReference: string;
  description: string;
}): Promise<StkPushResult> {
  const { shortcode, passkey, callbackUrl } = requireConfig();
  const timestamp = darajaTimestamp();
  const token = await getAccessToken();

  if (input.amountCents % 100 !== 0) {
    throw new MpesaError(
      `Amount ${input.amountCents} is not a whole number of shillings`,
    );
  }

  const res = await fetch(`${baseUrl()}/mpesa/stkpush/v1/processrequest`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(DARAJA_TIMEOUT_MS),
    body: JSON.stringify({
      BusinessShortCode: shortcode,
      Password: stkPassword(shortcode, passkey, timestamp),
      Timestamp: timestamp,
      TransactionType: "CustomerPayBillOnline",
      Amount: input.amountCents / 100,
      PartyA: input.phoneNumber.replace(/^\+/, ""),
      PartyB: shortcode,
      PhoneNumber: input.phoneNumber.replace(/^\+/, ""),
      CallBackURL: callbackUrl,
      AccountReference: input.accountReference.slice(0, 12),
      TransactionDesc: input.description.slice(0, 13),
    }),
  });

  const body = await res.json().catch(() => ({})) as Record<string, unknown>;

  // Daraja signals failure both by HTTP status and by a non-zero ResponseCode.
  if (!res.ok || String(body.ResponseCode ?? "") !== "0") {
    // Only two things prove no prompt exists: a 4xx (the request was never
    // accepted) or a 2xx carrying an explicit non-zero ResponseCode (Safaricom
    // answered and refused).
    //
    // A 5xx means Safaricom broke, not that it refused. And a 2xx with NO
    // ResponseCode at all is a malformed or truncated answer, not a rejection —
    // the push may well have been processed. Both stay indeterminate, so the
    // attempt keeps holding its booking.
    const hasBusinessCode = body.ResponseCode !== undefined && body.ResponseCode !== null;
    const definitive = (res.status >= 400 && res.status < 500)
      || (res.ok && hasBusinessCode);

    throw new MpesaError(
      typeof body.errorMessage === "string"
        ? body.errorMessage
        : `STK push rejected (${res.status})`,
      res.status,
      body,
      definitive,
    );
  }

  return {
    merchantRequestId: String(body.MerchantRequestID ?? ""),
    checkoutRequestId: String(body.CheckoutRequestID ?? ""),
    customerMessage: String(body.CustomerMessage ?? ""),
  };
}

export interface StkStatus {
  /** 0 means the customer paid. Anything else is a failure or still pending. */
  resultCode: number;
  resultDesc: string;
}

/**
 * Asks Safaricom what actually happened to a checkout request.
 *
 * This is the authority on whether money moved. Callbacks are unauthenticated
 * and the checkout id is known to the client, so a callback alone must never
 * be enough to confirm a booking.
 */
export async function queryStkStatus(checkoutRequestId: string): Promise<StkStatus> {
  const { shortcode, passkey } = requireConfig();
  const timestamp = darajaTimestamp();
  const token = await getAccessToken();

  const res = await fetch(`${baseUrl()}/mpesa/stkpushquery/v1/query`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(DARAJA_TIMEOUT_MS),
    body: JSON.stringify({
      BusinessShortCode: shortcode,
      Password: stkPassword(shortcode, passkey, timestamp),
      Timestamp: timestamp,
      CheckoutRequestID: checkoutRequestId,
    }),
  });

  const body = await res.json().catch(() => ({})) as Record<string, unknown>;

  if (!res.ok) {
    throw new MpesaError(
      `STK status query failed (${res.status})`,
      res.status,
      body,
    );
  }

  return {
    resultCode: Number(body.ResultCode ?? -1),
    resultDesc: String(body.ResultDesc ?? ""),
  };
}

/** One entry of the callback's CallbackMetadata.Item array. */
interface CallbackItem {
  Name?: unknown;
  Value?: unknown;
}

export interface ParsedCallback {
  merchantRequestId: string;
  checkoutRequestId: string;
  resultCode: number;
  resultDesc: string;
  /** Present only on success. */
  mpesaReceiptNumber?: string;
  amountCents?: number;
  phoneNumber?: string;
}

/**
 * Pulls the fields we care about out of Safaricom's callback envelope.
 *
 * The payload is attacker-controllable, so this only shapes it — every value
 * is verified against our own records before anything is trusted.
 */
export function parseCallback(payload: unknown): ParsedCallback | null {
  const stk = (payload as { Body?: { stkCallback?: Record<string, unknown> } })
    ?.Body
    ?.stkCallback;

  if (!stk || typeof stk !== "object")
    return null;

  const checkoutRequestId = typeof stk.CheckoutRequestID === "string"
    ? stk.CheckoutRequestID
    : "";

  if (!checkoutRequestId)
    return null;

  const items = (stk.CallbackMetadata as { Item?: CallbackItem[] } | undefined)?.Item;
  const pick = (name: string) =>
    Array.isArray(items)
      ? items.find(i => i.Name === name)?.Value
      : undefined;

  const rawAmount = pick("Amount");
  const receipt = pick("MpesaReceiptNumber");
  const phone = pick("PhoneNumber");

  return {
    merchantRequestId: typeof stk.MerchantRequestID === "string"
      ? stk.MerchantRequestID
      : "",
    checkoutRequestId,
    resultCode: Number(stk.ResultCode ?? -1),
    resultDesc: typeof stk.ResultDesc === "string" ? stk.ResultDesc : "",
    mpesaReceiptNumber: typeof receipt === "string" ? receipt : undefined,
    // Daraja reports whole shillings; the app stores cents.
    amountCents: typeof rawAmount === "number" ? Math.round(rawAmount * 100) : undefined,
    phoneNumber: phone != null ? String(phone) : undefined,
  };
}

/** Whether `ip` may POST the callback. An unset allowlist permits everything. */
export function isAllowedCallbackIp(ip: string | undefined): boolean {
  const allowed = env.MPESA_CALLBACK_ALLOWED_IPS
    ?.split(",")
    .map(s => s.trim())
    .filter(Boolean) ?? [];

  if (allowed.length === 0)
    return true;

  return ip != null && allowed.includes(ip);
}
