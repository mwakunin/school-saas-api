import env from "@/env";

/**
 * Africa's Talking, and a record of what it cost.
 *
 * CLAUDE.md §9: guardians are on phones, on patchy data, and SMS has to carry
 * the important things. §6 asks for `sms_messages` before v1 for a blunter
 * reason — AT charges per unit and reports delivery asynchronously, so a school
 * WILL ask what they are spending and whether a message actually arrived.
 * Neither question has an answer without a row per message.
 *
 * This module only talks to the provider. Composing messages, writing rows and
 * deciding who gets one lives in the routes, because those are the parts with
 * tenant rules attached.
 */

export const smsEnabled = Boolean(env.AT_USERNAME && env.AT_API_KEY);

/** Long enough for the API, short enough that a batch cannot hang on one call. */
const SEND_TIMEOUT_MS = 15_000;

/**
 * Test seam, mirroring `sentEmails`.
 *
 * Under test nothing leaves the process, but the senders still RUN — gating
 * them on `smsEnabled` would leave every notification test passing while
 * sending nothing, which is the failure mode that seam exists to prevent.
 */
export const sentSms: Array<{ to: string; body: string }> = [];

export class SmsError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "SmsError";
  }
}

/** What the provider says happened to one recipient. */
export interface SmsResult {
  to: string;
  /** AT's id, which is how an async delivery report finds the row again. */
  providerMessageId: string | null;
  accepted: boolean;
  /** Cents. An SMS costs a fraction of a shilling, so this is sub-100. */
  costCents: number | null;
  reason: string | null;
}

function baseUrl(): string {
  return env.AT_ENV === "production"
    ? "https://api.africastalking.com"
    : "https://api.sandbox.africastalking.com";
}

/**
 * Africa's Talking quotes cost as `"KES 0.8000"` — or `"0"` when it is free.
 *
 * Parsed rather than trusted as a number because the currency prefix is part
 * of the field, and a school's spend report is wrong in a way nobody notices
 * if this silently yields NaN.
 */
export function parseCostCents(raw: unknown): number | null {
  if (typeof raw === "number")
    return Number.isFinite(raw) ? Math.round(raw * 100) : null;

  if (typeof raw !== "string")
    return null;

  const match = raw.match(/-?\d+(?:\.\d+)?/);
  if (!match)
    return null;

  const amount = Number(match[0]);
  return Number.isFinite(amount) ? Math.round(amount * 100) : null;
}

/**
 * Roughly how many units a body will bill as — an ESTIMATE, deliberately.
 *
 * GSM-7 fits 160 characters in one unit and 153 per part beyond that; anything
 * outside that alphabet forces UCS-2 and drops to 70 and 67. So one smart
 * quote pasted out of Word, or a single emoji, can more than double the price
 * of a message going to four hundred families — which is worth warning a
 * bursar about BEFORE they press send rather than on the invoice afterwards.
 *
 * Approximate on purpose, and the approximation is stated rather than hidden:
 * plain ASCII is treated as GSM-7 and everything else as UCS-2. The real
 * alphabet has awkward edges — `[]{}\~^|€` are GSM-7 but cost two septets
 * each — and encoding a full table here would buy accuracy nobody uses, since
 * the AUTHORITATIVE cost comes back from Africa's Talking in the send response
 * and is what gets stored on the row. This number is for the warning; the
 * provider's figure is for the ledger.
 */
export function segmentsFor(body: string): number {
  if (body.length === 0)
    return 1;

  const isAscii = /^[\x20-\x7E\r\n]*$/.test(body);
  const single = isAscii ? 160 : 70;
  const multi = isAscii ? 153 : 67;

  return body.length <= single ? 1 : Math.ceil(body.length / multi);
}

/**
 * Sends one message.
 *
 * One recipient per call rather than AT's comma-separated batch, deliberately.
 * The batch form returns a single blended result and makes "did THIS parent
 * get it" unanswerable — which is the only question anybody asks. A school
 * sending four hundred fee reminders wants four hundred rows it can filter for
 * the ones that failed.
 */
export async function sendSms(input: {
  to: string;
  body: string;
}): Promise<SmsResult> {
  if (env.NODE_ENV === "test") {
    sentSms.push(input);
    return {
      to: input.to,
      providerMessageId: `test-${sentSms.length}`,
      accepted: true,
      costCents: 80,
      reason: null,
    };
  }

  if (!smsEnabled) {
    // Callers gate on `smsEnabled`; arriving here is a configuration bug
    // rather than a deliberate opt-out, so it says so instead of failing quiet.
    throw new SmsError("SMS is not configured (AT_USERNAME / AT_API_KEY)");
  }

  const form = new URLSearchParams({
    username: env.AT_USERNAME!,
    to: input.to,
    message: input.body,
    ...(env.AT_SENDER_ID ? { from: env.AT_SENDER_ID } : {}),
  });

  let payload: any;
  try {
    /*
     * Bounded, because a batch is a loop.
     *
     * `fetch` has no default timeout: one stalled connection would hold the
     * whole send open, and the four hundredth family would be waiting on the
     * first. Fifteen seconds is far longer than the API needs and far shorter
     * than a request that is never coming back.
     */
    const response = await fetch(`${baseUrl()}/version1/messaging`, {
      method: "POST",
      headers: {
        "apiKey": env.AT_API_KEY!,
        "Accept": "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form,
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });

    /*
     * Status checked BEFORE parsing.
     *
     * A gateway 502 comes back as HTML, so parsing first made `.json()` throw
     * and the catch below relabel a plain provider error as "could not reach
     * Africa's Talking" — pointing at the network when the provider had
     * answered perfectly clearly. The body is read as text so whatever it
     * actually said survives into the message.
     */
    if (!response.ok) {
      throw new SmsError(
        `Africa's Talking returned ${response.status}`,
        await response.text().catch(() => null),
      );
    }

    payload = await response.json();
  }
  catch (err) {
    if (err instanceof SmsError)
      throw err;
    throw new SmsError("Could not reach Africa's Talking", err);
  }

  const recipient = payload?.SMSMessageData?.Recipients?.[0];

  /*
   * No recipient entry means AT rejected the request outright — an unregistered
   * sender id, an exhausted balance, a malformed number. That is a real
   * outcome for this message and is recorded as one, rather than thrown: the
   * caller has a row to update either way, and a school needs to see WHICH
   * parent did not get their reminder.
   */
  if (!recipient) {
    return {
      to: input.to,
      providerMessageId: null,
      accepted: false,
      costCents: null,
      reason: String(payload?.SMSMessageData?.Message ?? "Rejected with no recipient detail"),
    };
  }

  /*
   * 100 Processed, 101 Sent, 102 Queued — all three mean accepted.
   *
   * 102 was missing, and it is the one that shows up under load: a queued
   * message is one Africa's Talking has taken and will deliver, so recording
   * it as rejected would have a school chasing failures that were not
   * failures, and paying for messages it believed had not gone. Everything
   * else in the 4xx/5xx range is a refusal with a reason.
   */
  const statusCode = Number(recipient.statusCode);
  const accepted = statusCode === 100 || statusCode === 101 || statusCode === 102;

  return {
    to: input.to,
    providerMessageId: recipient.messageId ?? null,
    accepted,
    costCents: parseCostCents(recipient.cost),
    reason: accepted ? null : String(recipient.status ?? `status ${statusCode}`),
  };
}
