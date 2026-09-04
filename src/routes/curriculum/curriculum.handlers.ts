import { and, asc, eq } from "drizzle-orm";
import * as HttpStatusCodes from "stoker/http-status-codes";
import * as HttpStatusPhrases from "stoker/http-status-phrases";

import type { AppDb } from "@/db";
import type { TenantRouteHandler } from "@/lib/types";

import { competencies, learningAreas } from "@/db/schema";
import { areasForPhase, CURRICULUM_SEED, isPlaceholder } from "@/lib/curriculum-seed";
import { isForeignKeyViolation, isUniqueViolation } from "@/lib/db-errors";

import type {
  AddCompetencyRoute,
  CreateAreaRoute,
  GetAreaRoute,
  ListAreasRoute,
  RemoveAreaRoute,
  RemoveCompetencyRoute,
  SeedRoute,
  UpdateAreaRoute,
} from "./curriculum.routes";

/** Field-level 422, shaped like the one `defaultHook` produces for Zod. */
function fieldError(path: string[], message: string) {
  return {
    success: false as const,
    error: {
      issues: [{ code: "custom" as const, path, message }],
      name: "ZodError",
    },
  };
}

interface CompetencyRow {
  id: string;
  schoolId: string;
  learningAreaId: string;
  parentId: string | null;
  code: string | null;
  title: string;
  sequence: number;
}

/**
 * Assembles the flat rows into the tree everyone actually wants.
 *
 * Done once here rather than in each client, because "group by parentId and
 * sort" is the kind of thing three callers implement three slightly different
 * ways — and a report card that ordered sub-strands differently from the marks
 * grid would be quietly wrong in a way nobody reports as a bug.
 */
function toTree(rows: CompetencyRow[]) {
  const byParent = new Map<string | null, CompetencyRow[]>();

  for (const row of rows) {
    const siblings = byParent.get(row.parentId) ?? [];
    siblings.push(row);
    byParent.set(row.parentId, siblings);
  }

  const build = (parentId: string | null): unknown[] =>
    (byParent.get(parentId) ?? [])
      .sort((a, b) => a.sequence - b.sequence || a.title.localeCompare(b.title))
      .map(row => ({
        ...row,
        // Surfaced so a screen can say "this came from the starter set" rather
        // than letting a teacher assume it is their school's own curriculum.
        isPlaceholder: isPlaceholder(row.title),
        children: build(row.id),
      }));

  return build(null);
}

async function areaDetail(db: AppDb, areaId: string) {
  const [area] = await db
    .select()
    .from(learningAreas)
    .where(eq(learningAreas.id, areaId));

  if (!area)
    return null;

  const rows = await db
    .select()
    .from(competencies)
    .where(eq(competencies.learningAreaId, areaId))
    .orderBy(asc(competencies.sequence));

  return { ...area, strands: toTree(rows) };
}

export const seed: TenantRouteHandler<SeedRoute> = async (c) => {
  const { phase } = c.req.valid("json");
  const db = c.var.db;
  const schoolId = c.var.school.id;

  const wanted = phase ? areasForPhase(phase) : CURRICULUM_SEED;

  /*
   * Re-running must be harmless.
   *
   * A school seeds, edits a strand to match how it actually teaches, then
   * someone presses the button again. Copying over the top would discard that
   * work silently, so an area the school already has by name is skipped
   * entirely — edits and all.
   */
  const existing = await db
    .select({ name: learningAreas.name })
    .from(learningAreas);

  const have = new Set(existing.map(a => a.name.toLowerCase()));

  let learningAreasCreated = 0;
  let competenciesCreated = 0;
  let skippedExisting = 0;

  for (const spec of wanted) {
    if (have.has(spec.name.toLowerCase())) {
      skippedExisting += 1;
      continue;
    }

    await db.transaction(async (tx) => {
      const [area] = await tx
        .insert(learningAreas)
        .values({
          schoolId,
          name: spec.name,
          code: spec.code,
          isCore: spec.isCore,
          sequence: spec.sequence,
        })
        .returning();

      learningAreasCreated += 1;

      for (const strand of spec.strands) {
        const [parent] = await tx
          .insert(competencies)
          .values({
            schoolId,
            learningAreaId: area.id,
            code: strand.code,
            title: strand.title,
            sequence: Number(strand.code?.split(".")[0] ?? 0),
          })
          .returning();

        competenciesCreated += 1;

        for (const [index, child] of (strand.children ?? []).entries()) {
          await tx.insert(competencies).values({
            schoolId,
            learningAreaId: area.id,
            parentId: parent.id,
            code: child.code,
            title: child.title,
            sequence: index + 1,
          });
          competenciesCreated += 1;
        }
      }
    });
  }

  return c.json(
    { learningAreasCreated, competenciesCreated, skippedExisting },
    HttpStatusCodes.CREATED,
  );
};

export const listAreas: TenantRouteHandler<ListAreasRoute> = async (c) => {
  const query = c.req.valid("query");
  const db = c.var.db;

  const filters = [];
  if (query.gradeLevelId)
    filters.push(eq(learningAreas.gradeLevelId, query.gradeLevelId));
  if (!query.includeNonCore)
    filters.push(eq(learningAreas.isCore, true));

  const rows = await db
    .select()
    .from(learningAreas)
    .where(filters.length > 0 ? and(...filters) : undefined)
    // Report-card order, which is what `sequence` exists for.
    .orderBy(asc(learningAreas.sequence), asc(learningAreas.name));

  return c.json(rows, HttpStatusCodes.OK);
};

export const getArea: TenantRouteHandler<GetAreaRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const area = await areaDetail(c.var.db, id);

  if (!area) {
    return c.json(
      { message: HttpStatusPhrases.NOT_FOUND },
      HttpStatusCodes.NOT_FOUND,
    );
  }

  return c.json(area, HttpStatusCodes.OK);
};

export const createArea: TenantRouteHandler<CreateAreaRoute> = async (c) => {
  const body = c.req.valid("json");

  try {
    const [created] = await c.var.db
      .insert(learningAreas)
      .values({ ...body, schoolId: c.var.school.id })
      .returning();

    return c.json(created, HttpStatusCodes.CREATED);
  }
  catch (err) {
    if (isForeignKeyViolation(err)) {
      return c.json(
        fieldError(["gradeLevelId"], "No such grade level at this school"),
        HttpStatusCodes.UNPROCESSABLE_ENTITY,
      );
    }
    /*
     * The case-insensitive name index, which `updateArea` already answered for
     * and this did not — so the commonest way to hit it, adding "Mathematics"
     * to a school that seeded, came back a 500.
     *
     * It matters beyond the status code: the seed decides what to skip by
     * name, so a second area sharing one leaves that check ambiguous, and a
     * report card prints the subject twice.
     */
    if (isUniqueViolation(err)) {
      return c.json(
        fieldError(["name"], "This school already has a learning area by that name"),
        HttpStatusCodes.UNPROCESSABLE_ENTITY,
      );
    }
    throw err;
  }
};

export const updateArea: TenantRouteHandler<UpdateAreaRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");

  try {
    const [updated] = await c.var.db
      .update(learningAreas)
      .set(body)
      .where(eq(learningAreas.id, id))
      .returning();

    if (!updated) {
      return c.json(
        { message: HttpStatusPhrases.NOT_FOUND },
        HttpStatusCodes.NOT_FOUND,
      );
    }

    return c.json(updated, HttpStatusCodes.OK);
  }
  catch (err) {
    // Same shape as `createArea`: a grade level from another school is
    // invisible here, so the reference finds nothing.
    if (isForeignKeyViolation(err)) {
      return c.json(
        fieldError(["gradeLevelId"], "No such grade level at this school"),
        HttpStatusCodes.UNPROCESSABLE_ENTITY,
      );
    }
    // The case-insensitive name index — renaming onto an area the school
    // already has would print the subject twice.
    if (isUniqueViolation(err)) {
      return c.json(
        fieldError(["name"], "This school already has a learning area by that name"),
        HttpStatusCodes.UNPROCESSABLE_ENTITY,
      );
    }
    throw err;
  }
};

export const removeArea: TenantRouteHandler<RemoveAreaRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const db = c.var.db;

  try {
    await db.transaction(async (tx) => {
      // Strands go with the area they belong to; the foreign key from
      // assessment_scores is what refuses the whole thing if anything has
      // actually been assessed.
      await tx.delete(competencies).where(eq(competencies.learningAreaId, id));
      await tx.delete(learningAreas).where(eq(learningAreas.id, id));
    });
  }
  catch (err) {
    if (isForeignKeyViolation(err)) {
      return c.json(
        {
          message:
            "Something has already been assessed against this learning area. "
            + "Removing it would take those marks with it.",
        },
        HttpStatusCodes.CONFLICT,
      );
    }
    throw err;
  }

  return c.body(null, HttpStatusCodes.NO_CONTENT);
};

export const addCompetency: TenantRouteHandler<AddCompetencyRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  const db = c.var.db;

  if (body.parentId) {
    /*
     * A sub-strand must hang off a strand in the SAME area.
     *
     * The composite foreign key already stops it crossing schools, but not
     * crossing learning areas within one — and a Mathematics sub-strand under
     * an English strand would print on the wrong half of a report card.
     */
    const [parent] = await db
      .select({ learningAreaId: competencies.learningAreaId })
      .from(competencies)
      .where(eq(competencies.id, body.parentId));

    if (!parent || parent.learningAreaId !== id) {
      return c.json(
        fieldError(["parentId"], "That strand belongs to a different learning area"),
        HttpStatusCodes.UNPROCESSABLE_ENTITY,
      );
    }
  }

  try {
    await db.insert(competencies).values({
      schoolId: c.var.school.id,
      learningAreaId: id,
      parentId: body.parentId,
      code: body.code,
      title: body.title,
      sequence: body.sequence,
    });
  }
  catch (err) {
    if (isForeignKeyViolation(err)) {
      return c.json(
        { message: HttpStatusPhrases.NOT_FOUND },
        HttpStatusCodes.NOT_FOUND,
      );
    }
    throw err;
  }

  return c.json((await areaDetail(db, id))!, HttpStatusCodes.CREATED);
};

export const removeCompetency: TenantRouteHandler<RemoveCompetencyRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const db = c.var.db;

  // Refused while it still has sub-strands. Cascading would silently delete a
  // teacher's work; the alternative is orphaning them, which is worse.
  const children = await db
    .select({ id: competencies.id })
    .from(competencies)
    .where(eq(competencies.parentId, id));

  if (children.length > 0) {
    return c.json(
      { message: "Remove its sub-strands first" },
      HttpStatusCodes.CONFLICT,
    );
  }

  try {
    const removed = await db
      .delete(competencies)
      .where(eq(competencies.id, id))
      .returning({ id: competencies.id });

    if (removed.length === 0) {
      return c.json(
        { message: HttpStatusPhrases.NOT_FOUND },
        HttpStatusCodes.NOT_FOUND,
      );
    }
  }
  catch (err) {
    if (isForeignKeyViolation(err)) {
      return c.json(
        { message: "This strand has been assessed; removing it would take those judgements with it" },
        HttpStatusCodes.CONFLICT,
      );
    }
    throw err;
  }

  return c.body(null, HttpStatusCodes.NO_CONTENT);
};
