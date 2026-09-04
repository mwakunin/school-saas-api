import { z } from "@hono/zod-openapi";
import { createSelectSchema } from "drizzle-zod";

import { competencies, learningAreas } from "@/db/schema";
import { toZodV4SchemaTyped } from "@/lib/zod-utils";

const rawLearningArea = createSelectSchema(learningAreas);
const rawCompetency = createSelectSchema(competencies);

export const learningAreaSchema = toZodV4SchemaTyped(rawLearningArea);

/**
 * A strand with its sub-strands.
 *
 * The tree is returned assembled rather than as a flat list with parent ids,
 * because every caller wants it nested and doing it once here is better than
 * three clients each getting it slightly wrong.
 */
export const competencyTreeSchema: z.ZodType<unknown> = toZodV4SchemaTyped(
  rawCompetency.extend({
    children: z.array(z.lazy(() => competencyTreeSchema as z.ZodType)),
    /** Seeded placeholder rather than the school's own curriculum. */
    isPlaceholder: z.boolean(),
  }),
);

export const learningAreaDetailSchema = toZodV4SchemaTyped(
  rawLearningArea.extend({
    strands: z.array(z.unknown()),
  }),
);

export const createLearningAreaSchema = toZodV4SchemaTyped(
  z.object({
    name: z.string().min(1).max(100),
    code: z.string().max(20).optional(),
    gradeLevelId: z.uuid().optional(),
    isCore: z.boolean().default(true),
    sequence: z.number().int().min(0).max(9999),
  }),
);

export const updateLearningAreaSchema = toZodV4SchemaTyped(
  z.object({
    name: z.string().min(1).max(100).optional(),
    code: z.string().max(20).nullable().optional(),
    gradeLevelId: z.uuid().nullable().optional(),
    isCore: z.boolean().optional(),
    sequence: z.number().int().min(0).max(9999).optional(),
  }).refine(v => Object.keys(v).length > 0, { message: "No updates provided" }),
);

export const createCompetencySchema = toZodV4SchemaTyped(
  z.object({
    /** Omit for a strand; supply a strand's id for a sub-strand. */
    parentId: z.uuid().optional(),
    code: z.string().max(20).optional(),
    title: z.string().min(1).max(300),
    sequence: z.number().int().min(0).max(9999),
  }),
);

export const seedCurriculumSchema = toZodV4SchemaTyped(
  z.object({
    /**
     * Which phase's areas to copy. Omit for both.
     *
     * A school running only primary should not find junior school's Integrated
     * Science on its report cards.
     */
    phase: z.enum(["primary", "junior"]).optional(),
  }),
);

export const seedResultSchema = toZodV4SchemaTyped(
  z.object({
    learningAreasCreated: z.number().int(),
    competenciesCreated: z.number().int(),
    /** Areas left alone because the school already had one by that name. */
    skippedExisting: z.number().int(),
  }),
);
