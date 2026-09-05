import { and, asc, desc, eq, ne } from "drizzle-orm";
import * as HttpStatusCodes from "stoker/http-status-codes";
import * as HttpStatusPhrases from "stoker/http-status-phrases";

import type { TenantRouteHandler } from "@/lib/types";

import { academicYears, gradeLevels, schools, streams, terms } from "@/db/schema";
import { isCheckViolation, isForeignKeyViolation, isUniqueViolation, pgConstraintName } from "@/lib/db-errors";

import type {
  CreateAcademicYearRoute,
  CreateStreamRoute,
  CreateTermRoute,
  GetSchoolRoute,
  ListAcademicYearsRoute,
  ListGradeLevelsRoute,
  ListStreamsRoute,
  ListTermsRoute,
  UpdateTermRoute,
} from "./academic.routes";

/**
 * Note what is absent from every query below: a `where school_id = ...`.
 *
 * `c.var.db` is the transaction `withTenant` opened, and it carries
 * `app.school_id`. The RLS policies apply that predicate inside Postgres, on
 * reads and writes alike, whether or not a handler remembers to. That is the
 * point of doing it in the database — CLAUDE.md §3 rule 2 asks developers
 * never to forget, and this makes forgetting harmless.
 *
 * The one thing policies cannot do is turn "no rows" into the right status
 * code, so each handler still distinguishes empty from missing itself.
 */

export const getSchool: TenantRouteHandler<GetSchoolRoute> = async (c) => {
  // Reads exactly one row: the policy on `schools` is `id = app_current_school()`.
  const [row] = await c.var.db.select().from(schools).limit(1);

  if (!row) {
    return c.json(
      { message: HttpStatusPhrases.NOT_FOUND },
      HttpStatusCodes.NOT_FOUND,
    );
  }

  const { mpesaCredentials: _omit, ...safe } = row;

  return c.json(safe, HttpStatusCodes.OK);
};

export const listAcademicYears: TenantRouteHandler<ListAcademicYearsRoute> = async (c) => {
  const rows = await c.var.db
    .select()
    .from(academicYears)
    .orderBy(desc(academicYears.year));

  return c.json(rows, HttpStatusCodes.OK);
};

export const createAcademicYear: TenantRouteHandler<CreateAcademicYearRoute> = async (c) => {
  const body = c.req.valid("json");
  const schoolId = c.var.school.id;

  try {
    const created = await c.var.db.transaction(async (tx) => {
      if (body.isCurrent) {
        // Exactly one year is current. Clearing first inside the same
        // transaction keeps that true even if two admins submit at once —
        // the second blocks on the first's row locks rather than racing it.
        await tx
          .update(academicYears)
          .set({ isCurrent: false })
          .where(eq(academicYears.isCurrent, true));
      }

      const [row] = await tx
        .insert(academicYears)
        // schoolId is supplied because the column is NOT NULL, not to scope
        // the write — the policy's WITH CHECK rejects any other value anyway.
        .values({ schoolId, year: body.year, isCurrent: body.isCurrent })
        .returning();

      return row;
    });

    return c.json(created, HttpStatusCodes.CREATED);
  }
  catch (err) {
    if (isCurrentClash(err)) {
      return c.json(
        { message: "Another year was made current a moment ago. Reload and try again." },
        HttpStatusCodes.CONFLICT,
      );
    }
    if (isUniqueViolation(err)) {
      return c.json(
        { message: "That year already exists" },
        HttpStatusCodes.CONFLICT,
      );
    }
    throw err;
  }
};

/**
 * Two requests raced to set the same flag.
 *
 * The partial unique index is what actually holds "one current per school";
 * these handlers clear-then-set, which is right on its own and cannot see an
 * uncommitted sibling. Reported as a conflict rather than retried, because the
 * caller asked for a state somebody else reached first and should be told so
 * rather than have one of the two answers silently win.
 */
function isCurrentClash(err: unknown): boolean {
  const constraint = pgConstraintName(err);
  return constraint === "terms_one_current_per_school"
    || constraint === "academic_years_one_current_per_school";
}

export const listTerms: TenantRouteHandler<ListTermsRoute> = async (c) => {
  const { academicYearId } = c.req.valid("query");

  const rows = await c.var.db
    .select()
    .from(terms)
    .where(academicYearId ? eq(terms.academicYearId, academicYearId) : undefined)
    // By date rather than by number, so two years' worth still read in the
    // order they happened rather than 1,1,2,2,3,3.
    .orderBy(asc(terms.startsOn));

  return c.json(rows, HttpStatusCodes.OK);
};

export const createTerm: TenantRouteHandler<CreateTermRoute> = async (c) => {
  const body = c.req.valid("json");
  const db = c.var.db;

  // Invisible under RLS if it belongs to another school, so this doubles as
  // the tenant check.
  const [year] = await db
    .select({ id: academicYears.id })
    .from(academicYears)
    .where(eq(academicYears.id, body.academicYearId));

  if (!year) {
    return c.json(
      {
        success: false as const,
        error: {
          issues: [{
            code: "custom" as const,
            path: ["academicYearId"],
            message: "No such academic year at this school",
          }],
          name: "ZodError",
        },
      },
      HttpStatusCodes.UNPROCESSABLE_ENTITY,
    );
  }

  try {
    const created = await db.transaction(async (tx) => {
      if (body.isCurrent) {
        // Exactly one term is current, the same way exactly one year is.
        await tx
          .update(terms)
          .set({ isCurrent: false })
          .where(eq(terms.isCurrent, true));
      }

      const [row] = await tx
        .insert(terms)
        .values({
          schoolId: c.var.school.id,
          academicYearId: body.academicYearId,
          number: body.number,
          startsOn: body.startsOn,
          endsOn: body.endsOn,
          isCurrent: body.isCurrent,
        })
        .returning();

      return row;
    });

    return c.json(created, HttpStatusCodes.CREATED);
  }
  catch (err) {
    if (isCurrentClash(err)) {
      return c.json(
        { message: "Another term was made current a moment ago. Reload and try again." },
        HttpStatusCodes.CONFLICT,
      );
    }
    if (isUniqueViolation(err)) {
      return c.json(
        { message: `That year already has a term ${body.number}` },
        HttpStatusCodes.CONFLICT,
      );
    }
    throw err;
  }
};

export const updateTerm: TenantRouteHandler<UpdateTermRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");

  try {
    const updated = await c.var.db.transaction(async (tx) => {
      if (body.isCurrent) {
        await tx
          .update(terms)
          .set({ isCurrent: false })
          .where(and(eq(terms.isCurrent, true), ne(terms.id, id)));
      }

      const [row] = await tx
        .update(terms)
        .set(body)
        .where(eq(terms.id, id))
        .returning();

      return row;
    });

    if (!updated) {
      return c.json(
        { message: HttpStatusPhrases.NOT_FOUND },
        HttpStatusCodes.NOT_FOUND,
      );
    }

    return c.json(updated, HttpStatusCodes.OK);
  }
  catch (err) {
    // PATCH can set `isCurrent` too, so it races the same way POST does.
    if (isCurrentClash(err)) {
      return c.json(
        { message: "Another term was made current a moment ago. Reload and try again." },
        HttpStatusCodes.CONFLICT,
      );
    }
    // `terms_dates_ordered` fires when a partial update would leave endsOn on
    // or before startsOn — patching only one of the pair is the common way in.
    if (isCheckViolation(err)) {
      return c.json(
        {
          success: false as const,
          error: {
            issues: [{
              code: "custom" as const,
              path: ["endsOn"],
              message: "A term must end after it starts",
            }],
            name: "ZodError",
          },
        },
        HttpStatusCodes.UNPROCESSABLE_ENTITY,
      );
    }
    throw err;
  }
};

export const listGradeLevels: TenantRouteHandler<ListGradeLevelsRoute> = async (c) => {
  const rows = await c.var.db
    .select()
    .from(gradeLevels)
    .orderBy(asc(gradeLevels.sequence));

  return c.json(rows, HttpStatusCodes.OK);
};

export const listStreams: TenantRouteHandler<ListStreamsRoute> = async (c) => {
  const rows = await c.var.db
    .select({
      id: streams.id,
      schoolId: streams.schoolId,
      gradeLevelId: streams.gradeLevelId,
      academicYearId: streams.academicYearId,
      name: streams.name,
      classTeacherId: streams.classTeacherId,
      gradeLevel: {
        id: gradeLevels.id,
        name: gradeLevels.name,
        sequence: gradeLevels.sequence,
        phase: gradeLevels.phase,
      },
    })
    .from(streams)
    // An inner join is safe here only because both sides carry policies: a
    // stream can never reference another school's grade level, so the join
    // cannot drop rows or reveal them.
    .innerJoin(gradeLevels, eq(streams.gradeLevelId, gradeLevels.id))
    .orderBy(asc(gradeLevels.sequence), asc(streams.name));

  return c.json(rows, HttpStatusCodes.OK);
};

export const createStream: TenantRouteHandler<CreateStreamRoute> = async (c) => {
  const body = c.req.valid("json");
  const schoolId = c.var.school.id;

  try {
    const [created] = await c.var.db
      .insert(streams)
      .values({ ...body, schoolId })
      .returning();

    const [grade] = await c.var.db
      .select({
        id: gradeLevels.id,
        name: gradeLevels.name,
        sequence: gradeLevels.sequence,
        phase: gradeLevels.phase,
      })
      .from(gradeLevels)
      .where(eq(gradeLevels.id, created.gradeLevelId));

    return c.json({ ...created, gradeLevel: grade }, HttpStatusCodes.CREATED);
  }
  catch (err) {
    if (isUniqueViolation(err)) {
      return c.json(
        { message: "That grade already has a stream by this name for the year" },
        HttpStatusCodes.CONFLICT,
      );
    }

    /*
     * A grade level or academic year belonging to another school is invisible
     * under RLS, so the foreign key finds nothing and Postgres reports a key
     * violation rather than a policy one. Reported as 422 against the field,
     * not 403: from the caller's side the id simply does not exist, and saying
     * "forbidden" would confirm that it exists somewhere else.
     */
    if (isForeignKeyViolation(err)) {
      return c.json(
        {
          success: false as const,
          error: {
            issues: [{
              code: "custom" as const,
              path: ["gradeLevelId"],
              message: "No such grade level or academic year at this school",
            }],
            name: "ZodError",
          },
        },
        HttpStatusCodes.UNPROCESSABLE_ENTITY,
      );
    }
    throw err;
  }
};
