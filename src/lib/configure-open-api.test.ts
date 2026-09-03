import { createRoute, z } from "@hono/zod-openapi";
import { createSelectSchema } from "drizzle-zod";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers";
import { describe, expect, it } from "vitest";

import { user } from "@/db/schema";
import configureOpenAPI from "@/lib/configure-open-api";
import { createRouter, createTestApp } from "@/lib/create-app";
import { toZodV4SchemaTyped } from "@/lib/zod-utils";

/**
 * The OpenAPI document, generated from the same zod schemas the routes
 * validate with.
 *
 * This is the seam `toZodV4SchemaTyped` bridges, and it bridges it with an
 * `as unknown as` cast — TypeScript is explicitly told to stop checking there,
 * so a zod or drizzle-zod change that broke schema serialisation would not
 * fail the build. It would not fail the route tests either: those exercise
 * validation, which keeps working even if the *description* of a schema comes
 * out empty. The docs are a shipped feature, so the description is worth
 * asserting on its own.
 *
 * The probe route below stands in for a domain route until step 2 brings real
 * ones. Asserting against a route defined here rather than against whichever
 * domain route happens to exist is deliberate — the previous version of this
 * file broke the moment the domain changed, which taught nothing about the
 * cast it exists to guard.
 */

// Kept unwrapped so it can still be `.extend()`ed below — toZodV4SchemaTyped
// casts away the object shape that composition needs.
const rawSelectUser = createSelectSchema(user);

const probeResponseSchema = toZodV4SchemaTyped(
  rawSelectUser.extend({
    // A nested drizzle-zod schema, to prove it isn't collapsed to an
    // untyped array.
    sessions: z.array(rawSelectUser.pick({ id: true, createdAt: true })),
    // And a hand-written half beside it.
    memberships: z.array(z.object({
      schoolId: z.string(),
      role: z.string(),
    })),
  }),
);

const probeBodySchema = toZodV4SchemaTyped(
  z.object({ reason: z.string().min(1).max(500) }),
);

const probe = createRoute({
  tags: ["Probe"],
  method: "post",
  path: "/_openapi-probe/{id}",
  request: {
    params: z.object({ id: z.string() }),
    query: z.object({
      term: z.string(),
      includeInactive: z.string().optional(),
    }),
    body: jsonContentRequired(probeBodySchema, "Probe body"),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(probeResponseSchema, "Probe response"),
  },
});

const router = createRouter().openapi(
  probe,
  // Never called — only the generated document is under test.
  c => c.json({} as never, HttpStatusCodes.OK),
);

const app = createTestApp(router);
configureOpenAPI(app);

describe("the OpenAPI document", () => {
  it("serves a document describing its routes", async () => {
    const res = await app.request("/doc");
    expect(res.status).toBe(200);

    const spec = await res.json();
    expect(spec.openapi).toMatch(/^3\./);
    expect(spec.info.title).toBe("School API");
    expect(Object.keys(spec.paths ?? {})).toContain("/_openapi-probe/{id}");
  });

  // An empty or constraint-free schema is the failure mode to catch: the API
  // keeps rejecting bad input, but the documentation stops saying what "bad"
  // means, and a client written against it gets 422s it cannot explain.
  it("renders request bodies with their constraints intact", async () => {
    const spec = await (await app.request("/doc")).json();
    const body = spec.paths["/_openapi-probe/{id}"].post
      .requestBody
      .content["application/json"]
      .schema;

    expect(body.type).toBe("object");
    expect(body.properties.reason).toMatchObject({
      type: "string",
      minLength: 1,
      maxLength: 500,
    });
  });

  it("renders query parameters rather than dropping them", async () => {
    const spec = await (await app.request("/doc")).json();
    const params = spec.paths["/_openapi-probe/{id}"].post.parameters;

    const names = params.map((p: { name: string }) => p.name);
    expect(names).toEqual(expect.arrayContaining(["id", "term", "includeInactive"]));
  });

  /**
   * The composed case, which is the one the cast is actually awkward about.
   *
   * A plain pass-through — drizzle-zod output wrapped and nothing else — is
   * the easy half. Composition is why CLAUDE.md insists it happens *before*
   * `toZodV4SchemaTyped`: the cast throws `.shape` away, so a regression
   * confined to that mixture would degrade exactly the response schemas that
   * join a table to its children, while a simpler assertion stayed green.
   */
  it("renders a schema that mixes drizzle-zod output with hand-written zod", async () => {
    const spec = await (await app.request("/doc")).json();
    const schema = spec.paths["/_openapi-probe/{id}"].post
      .responses["200"]
      .content["application/json"]
      .schema;

    // The table half survived the extend.
    expect(Object.keys(schema.properties ?? {})).toEqual(
      expect.arrayContaining(["id", "email", "role", "sessions", "memberships"]),
    );

    // A nested drizzle-zod schema, not collapsed to an untyped array.
    expect(schema.properties.sessions.type).toBe("array");
    expect(Object.keys(schema.properties.sessions.items?.properties ?? {})).toEqual(
      expect.arrayContaining(["id", "createdAt"]),
    );

    // And the hand-written half beside it.
    expect(schema.properties.memberships.type).toBe("array");
    expect(Object.keys(schema.properties.memberships.items?.properties ?? {})).toEqual(
      expect.arrayContaining(["schoolId", "role"]),
    );
  });
});
