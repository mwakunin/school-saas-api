import { createRoute, z } from "@hono/zod-openapi";
import { Redis } from "ioredis";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContent } from "stoker/openapi/helpers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import realApp from "@/app";
import { tooManyRequestsSchema } from "@/lib/constants";
import { createRouter, createTestApp } from "@/lib/create-app";
import { nextPhone, resetDb, signIn } from "@/test/helpers";

import { rateLimit } from "./rate-limit";

/** Three requests per minute, so the boundary is quick to reach. */
const limited = createRoute({
  path: "/limited",
  method: "get",
  middleware: [rateLimit({ points: 3, duration: 60, keyPrefix: "test" })],
  responses: {
    [HttpStatusCodes.OK]: jsonContent(z.object({ ok: z.boolean() }), "Allowed"),
    [HttpStatusCodes.TOO_MANY_REQUESTS]: jsonContent(tooManyRequestsSchema, "Throttled"),
  },
});

const app = createTestApp(
  createRouter().openapi(limited, c => c.json({ ok: true }, HttpStatusCodes.OK)),
);

describe("rate limiting", () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterEach(() => vi.restoreAllMocks());

  it("allows requests up to the limit", async () => {
    for (let i = 0; i < 3; i += 1)
      expect((await app.request("/limited")).status).toBe(200);
  });

  it("rejects the request after the limit with 429", async () => {
    for (let i = 0; i < 3; i += 1)
      await app.request("/limited");

    const res = await app.request("/limited");
    expect(res.status).toBe(429);
  });

  it("tells the caller when to retry", async () => {
    for (let i = 0; i < 4; i += 1)
      await app.request("/limited");

    const res = await app.request("/limited");
    const retryAfter = Number(res.headers.get("retry-after"));

    // Without this a client has no way to back off other than guessing.
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);
    expect((await res.json()).retryAfterSeconds).toBe(retryAfter);
  });

  it("counts per caller, not globally", async () => {
    // Two different IPs must not share one budget.
    for (let i = 0; i < 3; i += 1)
      await app.request("/limited", { headers: { "x-forwarded-for": "1.1.1.1" } });

    expect((await app.request("/limited", {
      headers: { "x-forwarded-for": "1.1.1.1" },
    })).status).toBe(429);

    expect((await app.request("/limited", {
      headers: { "x-forwarded-for": "2.2.2.2" },
    })).status).toBe(200);
  });

  // The chain is read from the right, where our own edge writes. Entries the
  // client prepends are inert — otherwise rotating the header would hand out
  // a fresh budget on every request, which is no rate limiting at all.
  it("cannot be bypassed by prepending to the forwarded chain", async () => {
    const realEdge = "172.16.0.1";
    for (let i = 0; i < 3; i += 1) {
      await app.request("/limited", {
        headers: { "x-forwarded-for": `9.9.9.9, ${realEdge}` },
      });
    }

    expect((await app.request("/limited", {
      headers: { "x-forwarded-for": `9.9.9.9, ${realEdge}` },
    })).status).toBe(429);

    // Same caller, a different forged prefix — still throttled.
    expect((await app.request("/limited", {
      headers: { "x-forwarded-for": `8.8.8.8, evil, ${realEdge}` },
    })).status).toBe(429);
  });

  // X-Real-IP carries no hop structure, so a proxy-set value and a forged one
  // are indistinguishable. It must never be consulted.
  //
  // Deliberately sends NO X-Forwarded-For: with one present the chain
  // resolves first and this path is never reached, so the test would pass
  // whether or not the fallback exists.
  it("cannot be bypassed by rotating X-Real-IP", async () => {
    for (let i = 0; i < 3; i += 1)
      await app.request("/limited", { headers: { "x-real-ip": `1.1.1.${i}` } });

    // A fresh X-Real-IP must not buy a fresh budget.
    expect((await app.request("/limited", {
      headers: { "x-real-ip": "9.9.9.9" },
    })).status).toBe(429);
  });

  it("still separates genuinely different callers behind the same proxy", async () => {
    for (let i = 0; i < 3; i += 1) {
      await app.request("/limited", {
        headers: { "x-forwarded-for": "203.0.113.1" },
      });
    }

    expect((await app.request("/limited", {
      headers: { "x-forwarded-for": "203.0.113.1" },
    })).status).toBe(429);
    expect((await app.request("/limited", {
      headers: { "x-forwarded-for": "203.0.113.2" },
    })).status).toBe(200);
  });

  it("limits a signed-in caller by account, not by address", async () => {
    const guest = await signIn(nextPhone());

    // Same account from two addresses shares one budget, so switching
    // networks is not a way around the limit.
    for (let i = 0; i < 3; i += 1) {
      await app.request("/limited", {
        headers: { ...guest.headers, "x-forwarded-for": "1.1.1.1" },
      });
    }

    const res = await app.request("/limited", {
      headers: { ...guest.headers, "x-forwarded-for": "5.5.5.5" },
    });
    expect(res.status).toBe(429);
  });

  it("keeps separate budgets per keyPrefix", async () => {
    const other = createTestApp(
      createRouter().openapi(
        createRoute({
          path: "/other",
          method: "get",
          middleware: [rateLimit({ points: 3, duration: 60, keyPrefix: "other" })],
          responses: {
            [HttpStatusCodes.OK]: jsonContent(z.object({ ok: z.boolean() }), "Allowed"),
            [HttpStatusCodes.TOO_MANY_REQUESTS]: jsonContent(tooManyRequestsSchema, "Throttled"),
          },
        }),
        c => c.json({ ok: true }, HttpStatusCodes.OK),
      ),
    );

    for (let i = 0; i < 4; i += 1)
      await app.request("/limited");

    expect((await app.request("/limited")).status).toBe(429);
    // Exhausting one group's budget must not lock someone out of another.
    expect((await other.request("/other")).status).toBe(200);
  });

  // Points at a genuinely unreachable Redis rather than mocking a method:
  // the limiter reaches Redis through a command registered via
  // defineCommand, so stubbing `eval` would intercept nothing and the test
  // would pass for the wrong reason. Disconnecting the shared client instead
  // leaks into every other test, since ioredis reconnects on its own.
  it("fails OPEN when Redis is unreachable", async () => {
    const dead = new Redis("redis://127.0.0.1:1", {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
    });
    dead.on("error", () => {});

    const withDeadRedis = createTestApp(
      createRouter().openapi(
        createRoute({
          path: "/dead",
          method: "get",
          middleware: [rateLimit({
            points: 3,
            duration: 60,
            keyPrefix: "dead",
            client: dead,
          })],
          responses: {
            [HttpStatusCodes.OK]: jsonContent(z.object({ ok: z.boolean() }), "Allowed"),
            [HttpStatusCodes.TOO_MANY_REQUESTS]: jsonContent(tooManyRequestsSchema, "Throttled"),
          },
        }),
        c => c.json({ ok: true }, HttpStatusCodes.OK),
      ),
    );

    try {
      // A cache outage must not become a total outage. The expensive
      // endpoints have their own structural guards regardless.
      for (let i = 0; i < 10; i += 1)
        expect((await withDeadRedis.request("/dead")).status).toBe(200);
    }
    finally {
      dead.disconnect();
    }
  });

  it("still limits through the healthy client while another is down", async () => {
    // Proves the fail-open path above is specific to the broken store, not a
    // limiter that quietly stopped working everywhere.
    for (let i = 0; i < 3; i += 1)
      expect((await app.request("/limited")).status).toBe(200);
    expect((await app.request("/limited")).status).toBe(429);
  });
});

describe("rate limits applied to real endpoints", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("throttles repeated auth attempts", async () => {
    // 10 per minute: brute force and account enumeration are the threat.
    const attempt = () => realApp.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "nobody@example.test", password: "wrong-password-x" }),
    });

    let throttled = false;
    for (let i = 0; i < 12; i += 1) {
      if ((await attempt()).status === 429) {
        throttled = true;
        break;
      }
    }

    expect(throttled).toBe(true);
  });

  // The M-Pesa C2B confirmation endpoint must also stay unthrottled —
  // Safaricom retries, and dropping a confirmation loses track of real money.
  // That assertion returns with the endpoint itself in step 5; it is not
  // written here as a pending test because a route that does not exist cannot
  // meaningfully be described as unthrottled.

  it("does not throttle the health check", async () => {
    // Monitoring hits this constantly; throttling it would fake an outage.
    for (let i = 0; i < 30; i += 1)
      expect((await realApp.request("/health")).status).toBe(200);
  });
});
