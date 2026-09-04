import { Buffer } from "node:buffer";

import env from "@/env";

import { decryptSecret } from "./crypto";
import { baseUrl, DARAJA_TIMEOUT_MS, MpesaError } from "./mpesa";

/**
 * Daraja C2B: the customer pays the school's paybill from their own handset,
 * and Safaricom posts a confirmation here.
 *
 * Separate from `mpesa.ts`, which is the STK-push client inherited from the
 * scaffold and currently dormant. The two differ in the direction the money
 * starts, and in almost every field name Safaricom uses — a C2B confirmation
 * is nothing like an `stkCallback` envelope — so sharing a parser would mean a
 * function that is wrong for both.
 *
 * What IS shared: the OAuth dance, the host selection, and the error taxonomy.
 *
 * The credentials are per school (CLAUDE.md §5.8). Money never routes through
 * our account, so there is no platform paybill to fall back on and every call
 * here takes the school it is acting for.
 */

/** A school's decrypted Daraja credentials. Never logged, never returned. */
export interface DarajaCredentials {
  consumerKey: string;
  consumerSecret: string;
}

/** The shape stored, encrypted, in `schools.mpesa_credentials`. */
interface StoredCredentials {
  consumerKey: string;
  consumerSecret: string;
}

/**
 * Reads a school's credentials out of the encrypted column.
 *
 * Throws rather than returning null for a school that has none: every caller
 * is trying to talk to Safaricom on that school's behalf, and "no credentials"
 * is a configuration problem an operator must see, not a condition to route
 * around silently.
 */
export function credentialsFor(school: {
  name: string;
  mpesaCredentials: string | null;
}): DarajaCredentials {
  if (!school.mpesaCredentials) {
    throw new MpesaError(
      `${school.name} has no M-Pesa credentials configured`,
      undefined,
      undefined,
      true,
    );
  }

  const parsed = JSON.parse(decryptSecret(school.mpesaCredentials)) as StoredCredentials;

  if (!parsed.consumerKey || !parsed.consumerSecret)
    throw new MpesaError(`${school.name}'s stored M-Pesa credentials are incomplete`);

  return parsed;
}

/** Serialises credentials for storage. The caller encrypts the result. */
export function serialiseCredentials(credentials: DarajaCredentials): string {
  return JSON.stringify({
    consumerKey: credentials.consumerKey,
    consumerSecret: credentials.consumerSecret,
  } satisfies StoredCredentials);
}

/*
 * Access tokens, cached per credential rather than per process.
 *
 * The scaffold's client holds a single module-level token because it had one
 * set of credentials. Here every school has its own, and one shared slot would
 * hand school B a token minted for school A — every call then failing, or
 * worse, succeeding against the wrong paybill.
 *
 * Keyed by consumer key, which is what the token is actually minted for. Two
 * schools sharing an aggregator's key legitimately share a token.
 */
const tokenCache = new Map<string, { value: string; expiresAt: number }>();

/** Exposed for tests — cached tokens would otherwise leak between cases. */
export function resetC2bTokenCache() {
  tokenCache.clear();
}

export async function accessTokenFor(
  credentials: DarajaCredentials,
): Promise<string> {
  const cached = tokenCache.get(credentials.consumerKey);
  if (cached && Date.now() < cached.expiresAt)
    return cached.value;

  const basic = Buffer
    .from(`${credentials.consumerKey}:${credentials.consumerSecret}`)
    .toString("base64");

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
  tokenCache.set(credentials.consumerKey, {
    value: body.access_token,
    // 60s of headroom so a token cannot expire mid-flight.
    expiresAt: Date.now() + Math.max(ttlSeconds - 60, 0) * 1000,
  });

  return body.access_token;
}

/**
 * The confirmation URL for one school.
 *
 * The token in the path is what identifies the tenant. CLAUDE.md §5.8 reads it
 * from the `shortcode` in the payload instead, which cannot work: the endpoint
 * is unauthenticated and the shortcode is a public value the caller supplies,
 * so anyone could post fabricated payments against any school.
 */
export function confirmationUrlFor(callbackToken: string): string {
  if (!env.MPESA_C2B_BASE_URL)
    throw new MpesaError("MPESA_C2B_BASE_URL is not configured");

  return `${env.MPESA_C2B_BASE_URL.replace(/\/$/, "")}/webhooks/mpesa/c2b/${callbackToken}/confirmation`;
}

export function validationUrlFor(callbackToken: string): string {
  if (!env.MPESA_C2B_BASE_URL)
    throw new MpesaError("MPESA_C2B_BASE_URL is not configured");

  return `${env.MPESA_C2B_BASE_URL.replace(/\/$/, "")}/webhooks/mpesa/c2b/${callbackToken}/validation`;
}

/**
 * Tells Safaricom where to send this school's confirmations.
 *
 * `ResponseType: "Completed"` means a payment still completes if our validation
 * endpoint is unreachable. The alternative, "Cancelled", would reject the
 * parent's payment at the till whenever our service was down — turning our
 * outage into their failed school fees, which is not a trade a school would
 * accept.
 */
export async function registerC2bUrls(input: {
  shortcode: string;
  credentials: DarajaCredentials;
  confirmationUrl: string;
  validationUrl: string;
}): Promise<void> {
  const token = await accessTokenFor(input.credentials);

  const res = await fetch(`${baseUrl()}/mpesa/c2b/v1/registerurl`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(DARAJA_TIMEOUT_MS),
    body: JSON.stringify({
      ShortCode: input.shortcode,
      ResponseType: "Completed",
      ConfirmationURL: input.confirmationUrl,
      ValidationURL: input.validationUrl,
    }),
  });

  const body = await res.json().catch(() => ({})) as Record<string, unknown>;

  if (!res.ok || String(body.ResponseCode ?? "") !== "0") {
    throw new MpesaError(
      typeof body.errorMessage === "string"
        ? body.errorMessage
        : `URL registration rejected (${res.status})`,
      res.status,
      body,
      res.status >= 400 && res.status < 500,
    );
  }
}

export interface C2bConfirmation {
  transactionId: string;
  shortcode: string;
  accountReference: string | null;
  msisdn: string;
  payerName: string | null;
  amountCents: number;
  transactedAt: Date;
}

/**
 * Daraja's `TransTime`: `YYYYMMDDHHmmss`, in East Africa Time.
 *
 * Built from the parts rather than handed to `Date.parse`, which would read it
 * as the server's local time — and the server is UTC on purpose. Kenya is
 * UTC+3 with no DST, so the offset is a constant subtraction; getting it wrong
 * files an 8am payment at 5am and puts late-night payments on the wrong day.
 */
export function parseTransTime(value: string): Date | null {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(value.trim());
  if (!match)
    return null;

  const [, year, month, day, hour, minute, second] = match.map(Number);

  /*
   * Built as a wall clock first, then shifted.
   *
   * `Date.UTC` rolls impossible values over rather than failing — month 13
   * becomes the following January, 30 February becomes 2 March — so a
   * malformed timestamp would otherwise parse to a plausible-looking date
   * three weeks from the truth. Reading the parts back is what catches it, and
   * that comparison has to happen before the offset is applied, or every
   * timestamp before 03:00 would look like it had rolled.
   */
  const wall = new Date(Date.UTC(year, month - 1, day, hour, minute, second));

  const roundTrips = wall.getUTCFullYear() === year
    && wall.getUTCMonth() === month - 1
    && wall.getUTCDate() === day
    && wall.getUTCHours() === hour
    && wall.getUTCMinutes() === minute
    && wall.getUTCSeconds() === second;

  if (!roundTrips)
    return null;

  // Kenya is UTC+3 year round, with no DST to complicate the subtraction.
  return new Date(wall.getTime() - 3 * 60 * 60 * 1000);
}

/**
 * Shapes a C2B confirmation. Validates nothing about whether to believe it.
 *
 * The payload is unauthenticated and entirely attacker-controllable, so this
 * only converts it into something typed. Whether the shortcode is really the
 * school's, and whether the reference names a real child, are decisions made
 * afterwards against our own records.
 *
 * Returns null when a field the row cannot exist without is missing or
 * unusable — there is nothing to store and nothing to reconcile later.
 */
export function parseC2bConfirmation(payload: unknown): C2bConfirmation | null {
  if (typeof payload !== "object" || payload === null)
    return null;

  const body = payload as Record<string, unknown>;

  const str = (key: string): string | null => {
    const value = body[key];
    if (typeof value === "string" && value.trim() !== "")
      return value.trim();
    if (typeof value === "number")
      return String(value);
    return null;
  };

  const transactionId = str("TransID");
  const shortcode = str("BusinessShortCode");
  const msisdn = str("MSISDN");
  const rawAmount = body.TransAmount;
  const transTime = str("TransTime");

  if (!transactionId || !shortcode || !msisdn || !transTime)
    return null;

  // Safaricom sends the amount as a string in whole shillings ("1500.00").
  const shillings = typeof rawAmount === "number"
    ? rawAmount
    : Number(String(rawAmount ?? "").trim());

  if (!Number.isFinite(shillings) || shillings <= 0)
    return null;

  const amountCents = Math.round(shillings * 100);

  // The database CHECK requires whole shillings, and a fractional amount would
  // reject at insert — losing the record of a payment that really happened.
  // Rejecting here means the webhook can say so rather than 500.
  if (amountCents % 100 !== 0)
    return null;

  const transactedAt = parseTransTime(transTime);
  if (!transactedAt)
    return null;

  const names = ["FirstName", "MiddleName", "LastName"]
    .map(key => str(key))
    .filter((part): part is string => part !== null);

  return {
    transactionId,
    shortcode,
    // What the parent typed. Frequently not an admission number at all, which
    // is the entire reason the reconciliation queue exists.
    accountReference: str("BillRefNumber"),
    msisdn,
    payerName: names.length > 0 ? names.join(" ") : null,
    amountCents,
    transactedAt,
  };
}
