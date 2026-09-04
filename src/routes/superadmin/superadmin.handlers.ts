import { and, asc, eq } from "drizzle-orm";
import * as HttpStatusCodes from "stoker/http-status-codes";
import * as HttpStatusPhrases from "stoker/http-status-phrases";

import type { AppRouteHandler } from "@/lib/types";

import db from "@/db";
import { academicYears, gradeLevels, memberships, schools, terms, user } from "@/db/schema";
import { GRADE_LEVELS, termsForYear } from "@/lib/academic-spine";
import { isUniqueViolation } from "@/lib/db-errors";

import type {
  CreateRoute,
  GrantMembershipRoute,
  ListRoute,
  SetStatusRoute,
} from "./superadmin.routes";

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

export const grantMembership: AppRouteHandler<GrantMembershipRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const { email, role } = c.req.valid("json");

  const [school] = await db
    .select({ id: schools.id })
    .from(schools)
    .where(eq(schools.id, id));

  if (!school) {
    return c.json(
      { message: HttpStatusPhrases.NOT_FOUND },
      HttpStatusCodes.NOT_FOUND,
    );
  }

  const [person] = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, email));

  /*
   * A 422 naming the field, not a 404.
   *
   * The school was found; it is the address that matches nobody, and the
   * person running this needs to be told to have them sign up first rather
   * than left wondering which half of the request was wrong.
   */
  if (!person) {
    return c.json(
      {
        success: false as const,
        error: {
          issues: [{
            code: "custom" as const,
            path: ["email"],
            message: "Nobody has signed up with that address yet",
          }],
          name: "ZodError",
        },
      },
      HttpStatusCodes.UNPROCESSABLE_ENTITY,
    );
  }

  /*
   * Idempotent, because the unique is on (user, school, role) and re-running
   * an onboarding script is the normal case rather than an error. A person may
   * hold several roles at one school — a teacher who is also a parent — so
   * this adds a role and never replaces one.
   */
  const [granted] = await db
    .insert(memberships)
    .values({ userId: person.id, schoolId: id, role })
    .onConflictDoNothing()
    .returning();

  if (granted)
    return c.json({ ...granted, created: true }, HttpStatusCodes.CREATED);

  /*
   * A row already existed — reactivate it rather than hand it back as it is.
   *
   * `withMembership` only accepts memberships with `isActive` true, so
   * returning a deactivated row would answer 201 with a membership that grants
   * nothing: the endpoint would report success and the person would still be
   * unable to act, with nothing in the response to say why. Granting access is
   * this route's whole purpose, so it has to mean it.
   *
   * Nothing sets `isActive` false today — there is no deactivation route yet —
   * so this is the correct behaviour waiting for the obvious next feature
   * rather than a bug anyone can currently reach.
   */
  const [reactivated] = await db
    .update(memberships)
    .set({ isActive: true })
    .where(and(
      eq(memberships.userId, person.id),
      eq(memberships.schoolId, id),
      eq(memberships.role, role),
    ))
    .returning();

  return c.json({ ...reactivated, created: false }, HttpStatusCodes.CREATED);
};
