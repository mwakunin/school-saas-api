import { asc, eq } from "drizzle-orm";
import * as HttpStatusCodes from "stoker/http-status-codes";
import * as HttpStatusPhrases from "stoker/http-status-phrases";

import type { AppRouteHandler } from "@/lib/types";

import db from "@/db";
import { academicYears, gradeLevels, schools, terms } from "@/db/schema";
import { GRADE_LEVELS, termsForYear } from "@/lib/academic-spine";
import { isUniqueViolation } from "@/lib/db-errors";

import type { CreateRoute, ListRoute, SetStatusRoute } from "./superadmin.routes";

/**
 * These handlers use the OWNER connection on purpose — see db/index.ts.
 *
 * The superadmin plane exists to act across tenants: listing every school and
 * onboarding a new one are both operations no `app.school_id` could express.
 * That makes this file, and the tenant resolver in middlewares/tenant.ts, the
 * complete allowlist of places the unscoped connection may appear;
 * `db-access.test.ts` enforces it.
 */

export const list: AppRouteHandler<ListRoute> = async (c) => {
  const rows = await db
    .select()
    .from(schools)
    .orderBy(asc(schools.name));

  // Drop the Daraja secrets before they reach a response. The select schema
  // omits them too — this is the second of the two, because a leak here costs
  // a school its payment credentials.
  const safe = rows.map(({ mpesaCredentials: _omit, ...rest }) => rest);

  return c.json(safe, HttpStatusCodes.OK);
};

export const create: AppRouteHandler<CreateRoute> = async (c) => {
  const body = c.req.valid("json");
  const year = body.academicYear ?? new Date().getFullYear();

  try {
    const result = await db.transaction(async (tx) => {
      const [school] = await tx
        .insert(schools)
        .values({
          name: body.name,
          subdomain: body.subdomain,
          county: body.county,
          phone: body.phone,
          email: body.email,
          status: body.status,
        })
        .returning();

      const [academicYear] = await tx
        .insert(academicYears)
        .values({ schoolId: school.id, year, isCurrent: true })
        .returning();

      const insertedTerms = await tx
        .insert(terms)
        .values(termsForYear(year).map(t => ({
          schoolId: school.id,
          academicYearId: academicYear.id,
          number: t.number,
          startsOn: t.startsOn,
          endsOn: t.endsOn,
          // Deliberately not marking one current at creation. Which term is
          // current depends on today's date against boundaries the school is
          // about to correct, and a wrong `isCurrent` is worse than none —
          // it silently files marks and invoices under the wrong term.
          isCurrent: false,
        })))
        .returning();

      const insertedGrades = await tx
        .insert(gradeLevels)
        .values(GRADE_LEVELS.map(g => ({
          schoolId: school.id,
          name: g.name,
          sequence: g.sequence,
          phase: g.phase,
        })))
        .returning();

      // Streams are deliberately not seeded: how a school divides a grade into
      // classes ("Blue"/"East"/"A", or not at all) is local, and guessing
      // creates rows an admin then has to find and delete.
      const { mpesaCredentials: _omit, ...safeSchool } = school;

      return {
        school: safeSchool,
        seeded: {
          academicYear: year,
          terms: insertedTerms.length,
          gradeLevels: insertedGrades.length,
        },
      };
    });

    return c.json(result, HttpStatusCodes.CREATED);
  }
  catch (err) {
    if (isUniqueViolation(err)) {
      return c.json(
        { message: "That subdomain is already taken" },
        HttpStatusCodes.CONFLICT,
      );
    }
    throw err;
  }
};

export const setStatus: AppRouteHandler<SetStatusRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const { status } = c.req.valid("json");

  const [updated] = await db
    .update(schools)
    .set({ status })
    .where(eq(schools.id, id))
    .returning();

  if (!updated) {
    return c.json(
      { message: HttpStatusPhrases.NOT_FOUND },
      HttpStatusCodes.NOT_FOUND,
    );
  }

  const { mpesaCredentials: _omit, ...safe } = updated;

  return c.json(safe, HttpStatusCodes.OK);
};
