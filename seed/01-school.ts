import type { Api, Session } from "./lib/client";

import { ACADEMIC_YEAR, TERM_DATES } from "./lib/calendar";
import { makeSuperadmin, platformApi, schoolApi, signUp, signUpOperator } from "./lib/client";

/**
 * The school, its year, its classes and the four people who will log in.
 *
 * Everything here goes through the superadmin plane or a tenant route, which
 * is the point: onboarding a demo school and onboarding a real one are the
 * same sequence of calls. If this file needs a shortcut, so would a real
 * school, and that is worth finding out here rather than in front of a head
 * teacher.
 */

export const SUBDOMAIN = "demo";

/**
 * Four logins, because four people evaluate this product differently.
 *
 * CLAUDE.md §8 names them. The head asks whether the report cards look like
 * the ones they sign; the bursar asks what happens to a payment with the wrong
 * reference; the class teacher asks how long marks entry takes; the parent —
 * whose view is the one that convinces the head that fee follow-up gets easier
 * — asks whether they can see the balance without phoning the office.
 */
export const LOGINS = {
  head: { email: "head@demo.school", name: "Margaret Wanjiru Kimani", role: "admin" },
  bursar: { email: "bursar@demo.school", name: "Peter Otieno Owino", role: "bursar" },
  teacher: { email: "teacher@demo.school", name: "Faith Chebet Rotich", role: "teacher" },
  parent: { email: "parent@demo.school", name: "Alice Nyambura Njoroge", role: "guardian" },
} as const;

/**
 * Two streams per primary grade, one per junior grade.
 *
 * CLAUDE.md §8's shape, and it is the realistic one: a school that has been
 * running primary for years and added junior school recently has bigger lower
 * classes and one class per junior grade. It also exercises the thing that
 * matters — a report card and a fee run that work whether or not a grade is
 * streamed.
 */
export const STREAM_PLAN = [
  ...[1, 2, 3, 4, 5, 6].flatMap(sequence => [
    { sequence, name: "Blue" },
    { sequence, name: "Green" },
  ]),
  ...[7, 8, 9].map(sequence => ({ sequence, name: "East" })),
];

export interface SchoolContext {
  schoolId: string;
  subdomain: string;
  academicYearId: string;
  terms: Array<{ id: string; number: number; startsOn: string; endsOn: string }>;
  gradeLevels: Array<{ id: string; name: string; sequence: number; phase: string }>;
  streams: Array<{ id: string; name: string; gradeLevelId: string; sequence: number }>;
  sessions: Record<keyof typeof LOGINS, Session>;
  /** The unguessable segment of this school's C2B confirmation URL. */
  callbackToken: string;
  api: (as: keyof typeof LOGINS) => Api;
}

export async function seedSchool(): Promise<SchoolContext> {
  /*
   * The operator account. Its role is the one thing no endpoint can grant.
   *
   * A password generated per run and thrown away — unlike the four demo staff
   * logins, this account is superadmin across EVERY school, so a value anyone
   * could read from the repository would be a way into every tenant.
   */
  const operator = await signUpOperator("operator@demo.school", "Demo Operator");
  await makeSuperadmin(operator);
  const platform = platformApi(operator.cookie);

  const { school } = await platform.post("/superadmin/schools", {
    name: "Mwangaza Junior Academy",
    subdomain: SUBDOMAIN,
    county: "Kiambu",
    phone: "+254720111222",
    email: "office@mwangaza.ac.ke",
    // A real tenant with a status of its own, not a special code path.
    status: "demo",
    academicYear: ACADEMIC_YEAR,
  });

  // Sign everyone up, then grant each of them a role at the school.
  const sessions = {} as Record<keyof typeof LOGINS, Session>;
  for (const [key, login] of Object.entries(LOGINS)) {
    const session = await signUp(login.email, login.name);
    sessions[key as keyof typeof LOGINS] = session;

    await platform.post(`/superadmin/schools/${school.id}/memberships`, {
      email: login.email,
      role: login.role,
    });
  }

  const api = (as: keyof typeof LOGINS) => schoolApi(SUBDOMAIN, sessions[as].cookie);
  const head = api("head");

  /*
   * Move the terms onto dates around today.
   *
   * Onboarding seeds the Ministry's approximate boundaries, which is right for
   * a real school — they then correct them locally, which is exactly what this
   * is doing. See lib/calendar.ts for why the demo cannot just use the
   * calendar year's real dates.
   */
  const seededTerms = await head.get("/terms");
  const terms = [];
  for (const wanted of TERM_DATES) {
    const term = seededTerms.find((t: { number: number }) => t.number === wanted.number);
    terms.push(await head.patch(`/terms/${term.id}`, {
      startsOn: wanted.startsOn,
      endsOn: wanted.endsOn,
      isCurrent: wanted.isCurrent,
    }));
  }

  const gradeLevels = await head.get("/grade-levels");
  const [academicYear] = await head.get("/academic-years");

  const streams = [];
  for (const plan of STREAM_PLAN) {
    const grade = gradeLevels.find(
      (g: { sequence: number }) => g.sequence === plan.sequence,
    );
    const created = await head.post("/streams", {
      gradeLevelId: grade.id,
      academicYearId: academicYear.id,
      name: plan.name,
      // The one teacher who logs in takes a class, so "my class" is not empty
      // when they sign in. Grade 4 Blue — see 04-history.ts.
      ...(plan.sequence === 4 && plan.name === "Blue"
        ? { classTeacherId: sessions.teacher.id }
        : {}),
    });
    streams.push({ ...created, sequence: plan.sequence });
  }

  /*
   * M-Pesa, configured but never registered.
   *
   * `registerUrls` stays false: registration talks to Daraja, and a seed that
   * reached a third party every night would be both slow and rude. What this
   * is for is the callback token — the unguessable path segment 05-fees.ts
   * posts confirmations to, so the queue fills the way it does in production
   * rather than by writing rows.
   *
   * Sandbox credentials, and worth being plain about it: these are fake and
   * the demo never calls Safaricom.
   */
  // Admin-only, not the bursar: Daraja credentials are a school-configuration
  // act rather than a money one.
  const settings = await head.put("/mpesa/settings", {
    shortcode: "600100",
    consumerKey: "demo-consumer-key",
    consumerSecret: "demo-consumer-secret",
    registerUrls: false,
  });

  const callbackToken = settings.confirmationUrl.split("/c2b/")[1].split("/")[0];

  return {
    schoolId: school.id,
    subdomain: SUBDOMAIN,
    academicYearId: academicYear.id,
    terms,
    gradeLevels,
    streams,
    sessions,
    callbackToken,
    api,
  };
}
