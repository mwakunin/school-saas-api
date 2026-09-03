import { z } from "@hono/zod-openapi";
import { createSelectSchema } from "drizzle-zod";

import { academicYears, gradeLevels, schools, streams, terms } from "@/db/schema";
import { toZodV4SchemaTyped } from "@/lib/zod-utils";

const rawSelectSchool = createSelectSchema(schools);
const rawSelectAcademicYear = createSelectSchema(academicYears);
const rawSelectTerm = createSelectSchema(terms);
const rawSelectGradeLevel = createSelectSchema(gradeLevels);
const rawSelectStream = createSelectSchema(streams);

/**
 * The school as its own staff see it.
 *
 * Narrower than the superadmin view: `mpesaCredentials` is omitted for the
 * same reason, and `status` stays because a trial school's admin has a
 * legitimate need to know they are on a trial.
 */
export const selectSchoolSchema = toZodV4SchemaTyped(
  rawSelectSchool.omit({ mpesaCredentials: true }),
);

export const selectAcademicYearSchema = toZodV4SchemaTyped(rawSelectAcademicYear);
export const selectTermSchema = toZodV4SchemaTyped(rawSelectTerm);
export const selectGradeLevelSchema = toZodV4SchemaTyped(rawSelectGradeLevel);

/**
 * A stream with the grade it belongs to, because "Blue" alone is meaningless —
 * every list of streams a human reads wants "Grade 4 Blue".
 */
export const selectStreamSchema = toZodV4SchemaTyped(
  rawSelectStream.extend({
    gradeLevel: rawSelectGradeLevel.pick({
      id: true,
      name: true,
      sequence: true,
      phase: true,
    }),
  }),
);

export const createStreamSchema = toZodV4SchemaTyped(
  z.object({
    gradeLevelId: z.uuid(),
    academicYearId: z.uuid(),
    name: z.string().min(1).max(50),
    classTeacherId: z.string().optional(),
  }),
);

export const createAcademicYearSchema = toZodV4SchemaTyped(
  z.object({
    year: z.number().int().min(2020).max(2100),
    isCurrent: z.boolean().default(false),
  }),
);

/**
 * Term edits are limited to the boundaries and the current flag.
 *
 * `number` and `academicYearId` are deliberately absent: renumbering a term
 * would silently re-file every mark and invoice already recorded against it,
 * and there is no legitimate reason to do it. Create and delete are likewise
 * absent — a Kenyan school year has exactly three terms, seeded at onboarding.
 */
export const updateTermSchema = toZodV4SchemaTyped(
  z.object({
    startsOn: z.iso.date().optional(),
    endsOn: z.iso.date().optional(),
    isCurrent: z.boolean().optional(),
  }).refine(
    v => Object.values(v).some(x => x !== undefined),
    { message: "No updates provided" },
  ),
);
