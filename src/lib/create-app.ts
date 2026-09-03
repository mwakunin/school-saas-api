import type { Schema } from "hono";

import { OpenAPIHono } from "@hono/zod-openapi";
import { requestId } from "hono/request-id";
import { notFound, onError, serveEmojiFavicon } from "stoker/middlewares";
import { defaultHook } from "stoker/openapi";

import { withSession } from "@/middlewares/auth";
import { pinoLogger } from "@/middlewares/pino-logger";
import { rateLimits } from "@/middlewares/rate-limit";

import type { AppBindings, AppOpenAPI } from "./types";

import { auth } from "./auth";

export function createRouter() {
  return new OpenAPIHono<AppBindings>({
    strict: false,
    defaultHook,
  });
}

export default function createApp() {
  const app = createRouter();
  app.use(requestId())
    .use(serveEmojiFavicon("🎓"))
    .use(pinoLogger());

  // Better Auth owns everything under /api/auth — sign-in, OTP, sign-out.
  // Mounted before withSession so the handler manages its own cookies.
  //
  // Rate limited by IP: these are the brute-force and enumeration targets, and
  // the caller is by definition not yet authenticated.
  app.on(
    ["GET", "POST"],
    "/api/auth/*",
    rateLimits.auth(),
    c => auth.handler(c.req.raw),
  );

  // Resolves the session onto every request; routes opt into requiring it.
  app.use(withSession);

  app.notFound(notFound);
  app.onError(onError);
  return app;
}

export function createTestApp<S extends Schema>(router: AppOpenAPI<S>) {
  return createApp().route("/", router);
}
