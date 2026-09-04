import { getConnInfo } from "@hono/node-server/conninfo";
import { eq } from "drizzle-orm";
import * as HttpStatusCodes from "stoker/http-status-codes";

import type { AppRouteHandler } from "@/lib/types";

import db from "@/db";
import { mpesaTransactions, schools } from "@/db/schema";
import env from "@/env";
import { resolveClientIp } from "@/lib/client-ip";
import { secretEquals } from "@/lib/crypto";
import { isUniqueViolation } from "@/lib/db-errors";
import { isAllowedCallbackIp } from "@/lib/mpesa";
import { parseC2bConfirmation } from "@/lib/mpesa-c2b";

import type { C2bConfirmationRoute, C2bValidationRoute } from "./webhooks.routes";

/**
 * These use the OWNER connection, and have to.
 *
 * There is no session and no subdomain on a Safaricom callback, so nothing has
 * established a tenant yet — the token in the path is what does, and reading
 * it is the bootstrap. The same argument as the subdomain resolver in
 * middlewares/tenant.ts, and `db-access.test.ts` lists this file for it.
 *
 * The reach is narrow by construction: one lookup by an unguessable token, and
 * one insert whose `school_id` comes from the row that lookup returned. No
 * value from the request body reaches a WHERE clause.
 */

/** Daraja treats anything but this as a failure, and retries. */
const ACK = { ResultCode: 0, ResultDesc: "Accepted" } as const;

/** Parsed once: the allowlist cannot change without a restart. */
const trustedProxies = new Set(
  env.TRUSTED_PROXY_IPS?.split(",").map(ip => ip.trim()).filter(Boolean) ?? [],
);

/**
 * Finds the school a callback token belongs to.
 *
 * Compared in constant time, and only against tokens that exist. A plain
 * equality lookup in SQL would be fine in practice — Postgres is not a timing
 * oracle in any way an attacker could use over a network — but the token is
 * the only thing standing between a stranger and filing fabricated payments
 * against a school, and the constant-time comparison costs nothing.
 */
async function schoolForToken(token: string) {
  if (!token || token.length < 16)
    return null;

  const [school] = await db
    .select({
      id: schools.id,
      name: schools.name,
      status: schools.status,
      mpesaShortcode: schools.mpesaShortcode,
      mpesaCallbackToken: schools.mpesaCallbackToken,
    })
    .from(schools)
    .where(eq(schools.mpesaCallbackToken, token));

  if (!school?.mpesaCallbackToken)
    return null;

  return secretEquals(school.mpesaCallbackToken, token) ? school : null;
}

export const c2bConfirmation: AppRouteHandler<C2bConfirmationRoute> = async (c) => {
  const { token } = c.req.valid("param");
  const payload = c.req.valid("json");
  const logger = c.var.logger;

  const school = await schoolForToken(token);

  if (!school) {
    /*
     * The one case that is not a 200.
     *
     * A token nobody answers to is our own misconfiguration — a URL registered
     * with Safaricom that no longer resolves — not a transient fault, and
     * returning success would swallow it silently while real payments went
     * nowhere. Safaricom's retries are what makes it visible.
     *
     * Nothing is stored, because there is no school to attribute the money to
     * and a row with no tenant is a row no policy can protect.
     */
    logger.error(
      { tokenPrefix: token.slice(0, 6) },
      "M-Pesa C2B confirmation for an unknown callback token",
    );

    return c.json(
      { ResultCode: 1, ResultDesc: "Unknown callback token" },
      HttpStatusCodes.NOT_FOUND,
    );
  }

  const parsed = parseC2bConfirmation(payload);

  if (!parsed) {
    /*
     * Unparseable, and still a 200.
     *
     * Retrying will not make a malformed payload parse, so a failure code buys
     * nothing but repeated deliveries. Logged with the raw body so it can be
     * reconstructed by hand if it turns out to be real money.
     */
    logger.error({ payload, school: school.name }, "Unparseable M-Pesa C2B confirmation");
    return c.json(ACK, HttpStatusCodes.OK);
  }

  /*
   * What the payload claims versus what we know.
   *
   * The shortcode is the field CLAUDE.md §5.8 would have resolved the tenant
   * from. It is public and caller-supplied, so it decides nothing here — the
   * token already established the school. It is still checked, because a
   * mismatch means either a misrouted registration or someone posting to a
   * token they should not have, and both are worth seeing.
   *
   * Stored `rejected` rather than dropped: if it turns out to be genuine, the
   * evidence is on the record. A rejected row is never matched or allocated.
   */
  const claimsRightShortcode = school.mpesaShortcode !== null
    && school.mpesaShortcode === parsed.shortcode;

  const suspicious = school.mpesaShortcode !== null && !claimsRightShortcode;

  if (suspicious) {
    logger.error(
      {
        school: school.name,
        expected: school.mpesaShortcode,
        claimed: parsed.shortcode,
        transactionId: parsed.transactionId,
      },
      "M-Pesa C2B confirmation whose shortcode does not match the school's",
    );
  }

  /*
   * Advisory only.
   *
   * Safaricom publishes a source list that changes, and signs nothing, so an
   * unexpected address is recorded and never used to refuse — dropping a real
   * payment because the published list moved is the worse failure. The token
   * in the path is the actual control.
   */
  let socketAddress: string | undefined;
  try {
    socketAddress = getConnInfo(c).remote.address;
  }
  catch {
    // No socket behind this request — app.request() in tests.
  }

  const sourceIp = resolveClientIp(
    { socketAddress, xForwardedFor: c.req.header("x-forwarded-for") },
    env.TRUST_PROXY_HOPS,
    trustedProxies,
  );

  if (!isAllowedCallbackIp(sourceIp)) {
    logger.warn(
      { school: school.name, sourceIp, transactionId: parsed.transactionId },
      "M-Pesa C2B confirmation from an unlisted source address",
    );
  }

  try {
    await db.insert(mpesaTransactions).values({
      schoolId: school.id,
      transactionId: parsed.transactionId,
      shortcode: parsed.shortcode,
      accountReference: parsed.accountReference,
      msisdn: parsed.msisdn,
      payerName: parsed.payerName,
      amountCents: parsed.amountCents,
      transactedAt: parsed.transactedAt,
      rawPayload: payload,
      status: suspicious ? "rejected" : "unmatched",
      statusReason: suspicious
        ? `Shortcode ${parsed.shortcode} is not this school's (${school.mpesaShortcode})`
        : null,
    });
  }
  catch (err) {
    /*
     * A duplicate receipt is a Safaricom retry, and the correct answer is
     * success — we already have it. Treating it as an error would make
     * Safaricom retry harder, and any attempt to "handle" it by inserting
     * again is how one payment becomes two.
     */
    if (isUniqueViolation(err)) {
      logger.info(
        { transactionId: parsed.transactionId, school: school.name },
        "M-Pesa C2B confirmation already recorded; acknowledging the retry",
      );
      return c.json(ACK, HttpStatusCodes.OK);
    }

    // Anything else is ours, not Safaricom's. Log it with the payload so the
    // money is recoverable, then let the retry come — this one might succeed.
    logger.error({ err, payload, school: school.name }, "Failed to store M-Pesa C2B confirmation");
    throw err;
  }

  logger.info(
    {
      school: school.name,
      transactionId: parsed.transactionId,
      amountCents: parsed.amountCents,
      reference: parsed.accountReference,
    },
    "Recorded M-Pesa C2B confirmation",
  );

  return c.json(ACK, HttpStatusCodes.OK);
};

export const c2bValidation: AppRouteHandler<C2bValidationRoute> = async (c) => {
  const { token } = c.req.valid("param");

  /*
   * Accepts unconditionally, including for an unknown token.
   *
   * Validation runs BEFORE the customer's money moves, and a failure here
   * declines the payment at the till. The reference a parent types is
   * routinely not one we recognise — that is the normal case and the reason
   * the reconciliation queue exists — so refusing on it would turn our
   * bookkeeping into their failed school fees.
   *
   * Registration uses ResponseType "Completed" for the same reason, which
   * means Safaricom completes payments even when this endpoint is unreachable.
   */
  const school = await schoolForToken(token);

  if (!school) {
    c.var.logger.warn(
      { tokenPrefix: token.slice(0, 6) },
      "M-Pesa C2B validation for an unknown callback token; accepting anyway",
    );
  }

  return c.json(ACK, HttpStatusCodes.OK);
};
