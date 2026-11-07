import { HTTPException } from "hono/http-exception";
import { describe, expect, it } from "vitest";

import { createRouter, createTestApp } from "@/lib/create-app";
import { requestLogMessage } from "@/middlewares/pino-logger";

import { summarizeError } from "./error-summary";

/** What Drizzle's errors look like: the SQL, then every bound value. */
const QUERY_ERROR = "Failed query: insert into \"guardians\" (\"phone\", \"name\") values ($1, $2)\nparams: +254712345678,Wanjiru Kamau";

/** What the error handler logged, captured from the request's logger. */
const logged: unknown[] = [];

const router = createRouter();
router.get("/boom", () => {
  throw new Error(QUERY_ERROR);
});
router.get("/boom-logged", (c) => {
  c.set("logger", { error: (payload: unknown) => logged.push(payload) } as unknown as typeof c.var.logger);
  throw new Error(QUERY_ERROR);
});
router.get("/refused", () => {
  throw new HTTPException(403, { message: "Not for you" });
});
const app = createTestApp(router);

describe("the error handler", () => {
  it("logs a summary of the error, never its parameters", async () => {
    logged.length = 0;

    await app.request("/boom-logged");

    expect(logged).toEqual([{ err: summarizeError(new Error(QUERY_ERROR)) }]);
    expect(JSON.stringify(logged)).not.toMatch(/\+254712345678|Wanjiru/);
  });

  it("keeps the request's own log line to a fixed message", () => {
    expect(requestLogMessage({ error: new Error(QUERY_ERROR) })).toBe("Request failed");
    expect(requestLogMessage({ error: undefined })).toBe("Request completed");
  });

  it("answers an unhandled error with a fixed message and the request id, never its text", async () => {
    const res = await app.request("/boom");

    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain("+254712345678");
    expect(text).not.toContain("Wanjiru");
    expect(text).not.toContain("Failed query");
    expect(JSON.parse(text)).toEqual({ message: "Internal Server Error", requestId: expect.any(String) });
  });

  it("keeps a deliberate refusal's own status and message", async () => {
    const res = await app.request("/refused");

    expect(res.status).toBe(403);
    expect(await res.text()).toBe("Not for you");
  });
});

describe("error summaries", () => {
  it("keep the query but drop its parameters", () => {
    const summary = summarizeError(new Error(QUERY_ERROR));

    expect(summary.message).toBe("Failed query: insert into \"guardians\" (\"phone\", \"name\") values ($1, $2)");
    expect(JSON.stringify(summary)).not.toContain("+254712345678");
  });

  it("keep the SQLSTATE and constraint a database error carries", () => {
    const err = Object.assign(new Error("duplicate key"), { code: "23505", constraint: "guardians_phone_key" });

    expect(summarizeError(err)).toEqual({
      name: "Error",
      message: "duplicate key",
      code: "23505",
      constraint: "guardians_phone_key",
    });
  });
});
