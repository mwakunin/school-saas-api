import { z } from "@hono/zod-openapi";
import { createSelectSchema } from "drizzle-zod";

import { schools } from "@/db/schema";
import { RESERVED_SUBDOMAINS } from "@/lib/subdomain";
import { toZodV4SchemaTyped } from "@/lib/zod-utils";

/**
 * Subdomains are permanent public identifiers — they end up in URLs, in
 * bookmarks, and on printed material — so the format is enforced here rather
 * than left to whatever the onboarding form sends.
 *
 * The reserved check matters as much as the format one. `subdomainFrom`
 * refuses reserved names at request time, so a school onboarded onto `www`
 * would be created successfully and then be permanently unreachable — a
 * failure nobody would connect back to onboarding. Sharing the same set is
 * what keeps the two ends from drifting apart.
 */
const subdomain = z.string()
  .min(2)
  .max(63)
  .regex(
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/,
    "Lowercase letters, digits and internal hyphens only",
  )
  .refine(
    value => !RESERVED_SUBDOMAINS.has(value),
    `Reserved and would not resolve to a school (${[...RESERVED_SUBDOMAINS].join(", ")})`,
  );

const rawSelectSchool = createSelectSchema(schools);

/**
 * What the superadmin plane returns about a school.
 *
 * `mpesaCredentials` is omitted deliberately, not incidentally: it holds a
 * school's Daraja secrets, and no listing screen has any use for it. Omitting
 * at the schema means a future handler that selects the whole row still cannot
 * leak it through this response.
 */
export const selectSchoolSchema = toZodV4SchemaTyped(
  rawSelectSchool.omit({ mpesaCredentials: true }),
);

export const createSchoolSchema = toZodV4SchemaTyped(
  z.object({
    name: z.string().min(2).max(200),
    subdomain,
    county: z.string().min(1).max(100).optional(),
    phone: z.string().min(1).max(30).optional(),
    email: z.email().optional(),
    status: z.enum(["trial", "active", "demo"]).default("trial"),
    /**
     * The year to seed. Defaults to the current one on the server's clock,
     * which is what onboarding in-year almost always wants.
     */
    academicYear: z.number().int().min(2020).max(2100).optional(),
  }),
);

export const updateSchoolStatusSchema = toZodV4SchemaTyped(
  z.object({
    // No "demo" here: a live school must not be reclassified as the demo
    // tenant, which is reset nightly.
    status: z.enum(["trial", "active", "suspended"]),
  }),
);

/** What onboarding created, so the operator can see the spine actually exists. */
export const onboardedSchoolSchema = toZodV4SchemaTyped(
  z.object({
    school: rawSelectSchool.omit({ mpesaCredentials: true }),
    seeded: z.object({
      academicYear: z.number().int(),
      terms: z.number().int(),
      gradeLevels: z.number().int(),
    }),
  }),
);
