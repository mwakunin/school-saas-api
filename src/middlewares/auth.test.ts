import { createRoute, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContent } from "stoker/openapi/helpers";
import { beforeEach, describe, expect, it } from "vitest";

import db from "@/db";
import { user } from "@/db/schema";
import { activeAuthMethods, googleEnabled, phoneOtpEnabled } from "@/lib/auth";
import { forbiddenSchema, unauthorizedSchema } from "@/lib/constants";
import { createRouter, createTestApp } from "@/lib/create-app";
import { emailEnabled } from "@/lib/email";
import { nextEmail, nextPhone, resetDb, signIn, signUpWithEmail } from "@/test/helpers";

import { requireAuth, requireRole } from "./auth";

const whoAmI = createRoute({
  path: "/whoami",
  method: "get",
  middleware: [requireAuth] as const,
  responses: {
    [HttpStatusCodes.OK]: jsonContent(z.object({ role: z.string() }), "The caller"),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(unauthorizedSchema, "Not signed in"),
  },
});

const superadminOnly = createRoute({
  path: "/superadmin-only",
  method: "get",
  middleware: [requireAuth, requireRole("superadmin")] as const,
  responses: {
    [HttpStatusCodes.OK]: jsonContent(z.object({ ok: z.boolean() }), "Allowed"),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(unauthorizedSchema, "Not signed in"),
    [HttpStatusCodes.FORBIDDEN]: jsonContent(forbiddenSchema, "Wrong role"),
  },
});

const router = createRouter()
  .openapi(whoAmI, c => c.json({ role: c.var.user!.role }, HttpStatusCodes.OK))
  .openapi(superadminOnly, c => c.json({ ok: true }, HttpStatusCodes.OK));

const app = createTestApp(router);

describe("auth middleware", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("rejects an unauthenticated request with 401", async () => {
    const res = await app.request("/whoami");
    expect(res.status).toBe(401);
  });

  it("rejects a garbage session cookie with 401", async () => {
    const res = await app.request("/whoami", {
      headers: { cookie: "better-auth.session_token=not-a-real-token" },
    });
    expect(res.status).toBe(401);
  });

  it("allows a signed-in user and exposes their role", async () => {
    const person = await signIn(nextPhone());

    const res = await app.request("/whoami", { headers: person.headers });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ role: "user" });
  });

  it("defaults a newly signed-up user to the plain user role", async () => {
    const person = await signIn(nextPhone());
    const res = await app.request("/whoami", { headers: person.headers });
    expect((await res.json()).role).toBe("user");
  });

  it("rejects a plain user from a superadmin-only route with 403, not 401", async () => {
    const person = await signIn(nextPhone());

    const res = await app.request("/superadmin-only", { headers: person.headers });
    expect(res.status).toBe(403);
  });

  it("allows a superadmin through a superadmin-only route", async () => {
    const superadmin = await signIn(nextPhone(), "superadmin");

    const res = await app.request("/superadmin-only", { headers: superadmin.headers });
    expect(res.status).toBe(200);
  });

  it("returns 401 (not 403) on a role-gated route when unauthenticated", async () => {
    const res = await app.request("/superadmin-only");
    expect(res.status).toBe(401);
  });
});

describe("sign-in methods available while SMS is deferred", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("lets someone sign up with email and password", async () => {
    const person = await signUpWithEmail(nextEmail());

    const res = await app.request("/whoami", { headers: person.headers });
    expect(res.status).toBe(200);
    expect((await res.json()).role).toBe("user");
  });

  it("rejects a weak password", async () => {
    const res = await app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: nextEmail(),
        password: "short",
        name: "Test",
      }),
    });
    expect(res.ok).toBe(false);
  });

  it("signs an existing user back in", async () => {
    const email = nextEmail();
    await signUpWithEmail(email, "correct-horse-battery");

    const res = await app.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "correct-horse-battery" }),
    });
    expect(res.ok).toBe(true);
  });

  it("rejects a wrong password", async () => {
    const email = nextEmail();
    await signUpWithEmail(email, "correct-horse-battery");

    const res = await app.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "wrong-password-entirely" }),
    });
    expect(res.ok).toBe(false);
  });

  it("cannot self-assign a role at sign-up", async () => {
    const email = nextEmail();
    const res = await app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email,
        password: "correct-horse-battery",
        name: "Sneaky",
        role: "superadmin",
      }),
    });
    expect(res.ok).toBe(true);

    const [row] = await db.select().from(user).where(eq(user.email, email));
    expect(row.role).toBe("user");
  });

  it("keeps phone OTP working, so it can be switched on without code changes", async () => {
    const person = await signIn(nextPhone());
    const res = await app.request("/whoami", { headers: person.headers });
    expect(res.status).toBe(200);
  });

  it("reports email+password as an active method and phone OTP as dormant", () => {
    expect(activeAuthMethods).toContain("email_password");
    expect(phoneOtpEnabled).toBe(false);
    expect(activeAuthMethods).not.toContain("phone_otp");
  });

  it("does not advertise Google when credentials are absent", async () => {
    // .env.test sets no Google credentials.
    expect(googleEnabled).toBe(false);

    const res = await app.request("/api/auth/sign-in/social", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "google", callbackURL: "/" }),
    });
    expect(res.ok).toBe(false);
  });
});

describe("email ownership", () => {
  beforeEach(async () => {
    await resetDb();
  });

  // user.email is UNIQUE, so an unverified sign-up permanently squats an
  // address the registrant never proved they own.
  it("blocks a second account on an address already taken", async () => {
    const email = nextEmail();
    await signUpWithEmail(email);

    const res = await app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email,
        password: "another-password-here",
        name: "Someone Else",
      }),
    });

    // This is exactly why verification is required wherever mail can be sent.
    expect(res.ok).toBe(false);
  });

  it("requires verification wherever email can actually be sent", () => {
    // Tests run without RESEND_*, so it is off here; production mandates
    // those vars, so it is on there.
    expect(emailEnabled).toBe(false);
  });

  it("does not link a Google identity into an unverified local account", () => {
    // Better Auth's requireLocalEmailVerified defaults to true, which is what
    // stops pre-registration turning into account takeover once Google is on.
    expect(googleEnabled).toBe(false);
  });
});
