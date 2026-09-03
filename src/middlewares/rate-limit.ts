import type { Context } from "hono";
import type { Redis } from "ioredis";
import type { RateLimiterRes } from "rate-limiter-flexible";

import { getConnInfo } from "@hono/node-server/conninfo";
import { createMiddleware } from "hono/factory";
import { RateLimiterRedis } from "rate-limiter-flexible";
import * as HttpStatusCodes from "stoker/http-status-codes";

import type { AppBindings } from "@/lib/types";

import env from "@/env";
import { resolveClientIp } from "@/lib/client-ip";
import { redis } from "@/lib/redis";

/**
 * Rate limiting, backed by Redis so the counters are shared across instances —
 * an in-memory limiter would let N instances allow N times the traffic.
 *
 * Limits are per endpoint group rather than global, because the endpoints
 * differ enormously in what abusing them costs. An STK push spends money and
 * puts a prompt on someone's handset; browsing listings costs a query.
 */

export interface RateLimitOptions {
  /** Requests allowed per window. */
  points: number;
  /** Window length in seconds. */
  duration: number;
  /** Namespaces the counters so groups don't share a budget. */
  keyPrefix: string;
  /**
   * Defaults to the shared client. Overridable so a caller can point at a
   * different Redis — and so the fail-open path can be exercised against a
   * genuinely unreachable one, without disconnecting the shared connection
   * out from under every other request.
   */
  client?: Redis;
}

/** Distinguishes "you are rate limited" from "the store broke". */
function isRateLimiterRes(err: unknown): err is RateLimiterRes {
  return typeof err === "object" && err !== null && "msBeforeNext" in err;
}

/**
 * Identifies an unauthenticated caller.
 *
 * Falls back to a shared bucket only when no address can be determined at
 * all, which should not happen over TCP. Sharing is deliberate: an
 * unidentifiable caller being limited alongside others is safer than not
 * being limited.
 */
/** Parsed once: the allowlist cannot change without a restart. */
const trustedProxies = new Set(
  env.TRUSTED_PROXY_IPS?.split(",").map(ip => ip.trim()).filter(Boolean) ?? [],
);

function anonymousKey(c: Context<AppBindings>): string {
  let socketAddress: string | undefined;
  try {
    socketAddress = getConnInfo(c).remote.address;
  }
  catch {
    // No socket behind this request — e.g. app.request() in tests.
  }

  return resolveClientIp(
    {
      socketAddress,
      xForwardedFor: c.req.header("x-forwarded-for"),
    },
    env.TRUST_PROXY_HOPS,
    trustedProxies,
  ) ?? "unknown";
}

export function rateLimit(options: RateLimitOptions) {
  const limiter = new RateLimiterRedis({
    storeClient: options.client ?? redis,
    keyPrefix: `rl:${options.keyPrefix}`,
    points: options.points,
    duration: options.duration,
  });

  return createMiddleware<AppBindings>(async (c, next) => {
    // Signed-in callers are limited per account, so one person on a shared or
    // NAT'd connection cannot exhaust the budget for everyone behind it.
    //
    // Anonymous traffic falls back to the caller's address — resolved from
    // the socket, not from a header the client writes. Taking X-Forwarded-For
    // at face value would let anyone rotate it for a fresh counter per
    // request, which is no rate limiting at all.
    const key = c.var.user?.id ?? anonymousKey(c);

    try {
      await limiter.consume(key);
    }
    catch (err) {
      if (isRateLimiterRes(err)) {
        const retryAfter = Math.max(1, Math.ceil(err.msBeforeNext / 1000));
        c.header("Retry-After", String(retryAfter));

        return c.json(
          {
            message: "Too many requests. Please slow down and try again shortly.",
            retryAfterSeconds: retryAfter,
          },
          HttpStatusCodes.TOO_MANY_REQUESTS,
        );
      }

      // Redis is unreachable. Fail OPEN: a cache outage should not become a
      // total outage, and the expensive endpoints have their own structural
      // guards — one pending payment per booking, the booking overlap
      // constraint. Logged so the degradation is visible rather than silent.
      c.var.logger.error(
        { err, keyPrefix: options.keyPrefix },
        "Rate limiter store unavailable; allowing the request",
      );
    }

    await next();
  });
}

/**
 * Presets, so call sites read as intent rather than arithmetic.
 *
 * The auth and payment numbers are deliberately low: both are attractive to
 * abuse and neither has a legitimate high-frequency use.
 */
export const rateLimits = {
  /** Sign-in, sign-up, OTP. Brute force and account enumeration. */
  auth: () => rateLimit({ points: 10, duration: 60, keyPrefix: "auth" }),

  /** STK push. Every call costs money and rings a real phone. */
  payment: () => rateLimit({ points: 5, duration: 300, keyPrefix: "pay" }),

  /** Creating bookings and blackouts — cheap, but writes. */
  write: () => rateLimit({ points: 30, duration: 60, keyPrefix: "write" }),

  /** Public browsing. Generous; this is the traffic we actually want. */
  read: () => rateLimit({ points: 120, duration: 60, keyPrefix: "read" }),
};
