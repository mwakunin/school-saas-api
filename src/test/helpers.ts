import type { SQL } from "drizzle-orm";

import { eq, sql } from "drizzle-orm";

import type { MembershipRole, UserRole } from "@/lib/types";

import app from "@/app";
import db, { pool } from "@/db";
import {
  academicYears,
  enrollments,
  gradeLevels,
  invoiceLines,
  invoices,
  memberships,
  payments,
  schools,
  streams,
  students,
  terms,
  user,
} from "@/db/schema";
import { GRADE_LEVELS, termsForYear } from "@/lib/academic-spine";
import { sentOtps } from "@/lib/auth";
import { sentEmails } from "@/lib/email";
import { normalizeKenyanPhone } from "@/lib/phone";
import { redis } from "@/lib/redis";

/**
 * Wipes every table between tests. Discovered dynamically so a new table
 * doesn't silently start leaking state across tests.
 */
/**
 * Clears rate-limit counters so each test starts with a full budget.
 *
 * Every test request arrives with no IP, so they all share one key — without
 * this, later tests in a file would be throttled by earlier ones and fail for
 * reasons unrelated to what they assert.
 */
export async function resetRateLimits() {
  const keys = await redis.keys("rl:*");
  if (keys.length > 0)
    await redis.del(...keys);
}

export async function resetDb() {
  await resetRateLimits();

  // Captured mail is per-test state like anything else. Left uncleared, a
  // later test sees a previous one's messages and asserts against them.
  sentEmails.length = 0;

  const { rows } = await pool.query<{ tablename: string }>(`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '__drizzle_migrations'
  `);

  if (rows.length === 0)
    return;

  const tables = rows.map(r => `"${r.tablename}"`).join(", ");
  await pool.query(`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`);
}

async function postJson(path: string, body: unknown, cookie?: string) {
  return app.request(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

export interface TestUser {
  id: string;
  phoneNumber: string;
  /** Set when the account was created with email+password. */
  email?: string;
  /** Ready-to-spread request headers carrying the session cookie. */
  headers: { cookie: string };
}

/**
 * Signs a user in through the real phone+OTP flow rather than forging a
 * session row — that way the tests exercise the same code path production
 * does, and cookie signing can't silently drift out of sync.
 *
 * `role` is applied directly to the row afterwards because role is
 * deliberately not client-settable.
 */
export async function signIn(
  phoneNumber: string,
  role: UserRole = "user",
): Promise<TestUser> {
  const normalized = normalizeKenyanPhone(phoneNumber);
  if (!normalized)
    throw new Error(`Test used an invalid Kenyan number: ${phoneNumber}`);

  const sent = await postJson("/api/auth/phone-number/send-otp", {
    phoneNumber: normalized,
  });
  if (!sent.ok)
    throw new Error(`send-otp failed: ${sent.status} ${await sent.text()}`);

  const code = sentOtps.get(normalized);
  if (!code)
    throw new Error(`No OTP captured for ${normalized}`);

  const verified = await postJson("/api/auth/phone-number/verify", {
    phoneNumber: normalized,
    code,
  });
  if (!verified.ok)
    throw new Error(`verify failed: ${verified.status} ${await verified.text()}`);

  const setCookie = verified.headers.get("set-cookie");
  if (!setCookie)
    throw new Error("verify returned no session cookie");

  // Keep only the name=value pairs; a request Cookie header carries no attributes.
  const cookie = setCookie
    .split(/,(?=\s*[^;=\s]+=)/)
    .map(c => c.split(";")[0].trim())
    .join("; ");

  const [row] = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.phoneNumber, normalized));

  if (!row)
    throw new Error(`User row missing after verify for ${normalized}`);

  if (role !== "user")
    await db.update(user).set({ role }).where(eq(user.id, row.id));

  return { id: row.id, phoneNumber: normalized, headers: { cookie } };
}

let phoneCounter = 0;

/** Unique valid Kenyan mobile number, so tests never collide on the unique index. */
export function nextPhone() {
  phoneCounter += 1;
  return `+2547${String(10_000_000 + phoneCounter).slice(0, 8)}`;
}

/** The Postgres backend behind a transaction, so lock tests can name their holder. */
export async function backendPid(
  tx: { execute: (query: SQL) => Promise<{ rows: Record<string, unknown>[] }> },
): Promise<number> {
  const { rows } = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
  return Number(rows[0].pid);
}

/**
 * Waits until Postgres reports a backend blocked on a lock.
 *
 * A fixed sleep only guesses that contention happened and passes whenever the
 * timer is generous; this asks the database directly. The window sits under
 * vitest's default test timeout so a missing lock fails as an assertion
 * rather than an opaque "test timed out".
 */
export async function waitForBlockedBackend(
  holderPid: number,
  timeoutMs = 2500,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    // Only waiters blocked by *this* holder count. Any active backend waiting
    // on any lock would otherwise satisfy the check — a dev server, a studio
    // session, a leftover connection — and the test would pass without the
    // contention it claims to observe.
    const { rows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE wait_event_type = 'Lock' AND state = 'active'
         AND $1 = ANY(pg_blocking_pids(pid))`,
      [holderPid],
    );
    if (rows[0].n > 0)
      return true;

    await new Promise(resolve => setTimeout(resolve, 20));
  }

  return false;
}

/** `offset` days from today as a YYYY-MM-DD string, matching the `date` columns. */
export function dayFromNow(offset: number) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

/**
 * Signs up and signs in with email+password — the method that works while SMS
 * is deferred, and the right one for staff at a desk regardless.
 */
export async function signUpWithEmail(
  email: string,
  password = "correct-horse-battery",
  name = "Test User",
): Promise<TestUser> {
  const res = await postJson("/api/auth/sign-up/email", { email, password, name });
  if (!res.ok)
    throw new Error(`sign-up failed: ${res.status} ${await res.text()}`);

  const setCookie = res.headers.get("set-cookie");
  if (!setCookie)
    throw new Error("sign-up returned no session cookie");

  const cookie = setCookie
    .split(/,(?=\s*[^;=\s]+=)/)
    .map(c => c.split(";")[0].trim())
    .join("; ");

  const [row] = await db.select({ id: user.id }).from(user).where(eq(user.email, email));
  if (!row)
    throw new Error(`User row missing after sign-up for ${email}`);

  return { id: row.id, phoneNumber: "", email, headers: { cookie } };
}

let emailCounter = 0;

/** Unique address, so tests never collide on user.email's unique index. */
export function nextEmail() {
  emailCounter += 1;
  return `person${emailCounter}@example.test`;
}

// ---------------------------------------------------------------------------
// Tenancy
// ---------------------------------------------------------------------------

let subdomainCounter = 0;

/**
 * Creates a school with its academic spine, on the OWNER connection.
 *
 * Test setup legitimately works across tenants — an isolation test needs two
 * schools to exist before either can be shown to be invisible to the other —
 * so this is one of the few places outside the superadmin plane that may use
 * the unscoped connection.
 */
export async function makeSchool(overrides: {
  name?: string;
  subdomain?: string;
  status?: "trial" | "active" | "suspended" | "demo";
  year?: number;
} = {}) {
  subdomainCounter += 1;
  const subdomain = overrides.subdomain ?? `school${subdomainCounter}`;
  const year = overrides.year ?? 2026;

  const [school] = await db
    .insert(schools)
    .values({
      name: overrides.name ?? `Test School ${subdomainCounter}`,
      subdomain,
      status: overrides.status ?? "active",
    })
    .returning();

  const [academicYear] = await db
    .insert(academicYears)
    .values({ schoolId: school.id, year, isCurrent: true })
    .returning();

  const insertedTerms = await db
    .insert(terms)
    .values(termsForYear(year).map(t => ({
      schoolId: school.id,
      academicYearId: academicYear.id,
      number: t.number,
      startsOn: t.startsOn,
      endsOn: t.endsOn,
    })))
    .returning();

  const insertedGrades = await db
    .insert(gradeLevels)
    .values(GRADE_LEVELS.map(g => ({
      schoolId: school.id,
      name: g.name,
      sequence: g.sequence,
      phase: g.phase,
    })))
    .returning();

  return {
    ...school,
    subdomain,
    academicYear,
    terms: insertedTerms,
    gradeLevels: insertedGrades,
  };
}

/** Gives `userId` a role at `schoolId`. A person may hold several. */
export async function addMembership(
  userId: string,
  schoolId: string,
  role: MembershipRole,
) {
  const [row] = await db
    .insert(memberships)
    .values({ userId, schoolId, role })
    .returning();

  return row;
}

/**
 * Request headers addressing a school, carrying a signed-in session.
 *
 * The Host header is how the tenant is chosen, so a test that forgets it is
 * testing the 404 path rather than what it meant to. `ROOT_DOMAIN` defaults to
 * `localhost` in test, matching .env.test.
 */
export function tenantHeaders(subdomain: string, user?: TestUser) {
  return {
    host: `${subdomain}.localhost`,
    ...(user ? user.headers : {}),
  };
}

/**
 * Signs someone in and gives them a role at a school, which is the setup
 * almost every tenant test needs.
 */
export async function signInAt(
  schoolId: string,
  role: MembershipRole,
): Promise<TestUser> {
  const person = await signIn(nextPhone());
  await addMembership(person.id, schoolId, role);
  return person;
}

/**
 * A class at a school — "Grade 4 Blue" — in its current academic year.
 *
 * Takes the grade by sequence rather than by id, because a test that says
 * `makeStream(alpha, 4, "Blue")` reads as what it means, and looking the id up
 * here keeps the seeded-spine detail out of every test body.
 */
export async function makeStream(
  school: { id: string; academicYear: { id: string }; gradeLevels: Array<{ id: string; sequence: number }> },
  gradeSequence: number,
  name: string,
) {
  const grade = school.gradeLevels.find(g => g.sequence === gradeSequence);
  if (!grade)
    throw new Error(`No Grade ${gradeSequence} at this school`);

  const [row] = await db
    .insert(streams)
    .values({
      schoolId: school.id,
      gradeLevelId: grade.id,
      academicYearId: school.academicYear.id,
      name,
    })
    .returning();

  return row;
}

// ---------------------------------------------------------------------------
// Students and fees
// ---------------------------------------------------------------------------

type SeededSchool = Awaited<ReturnType<typeof makeSchool>>;

/** A student on the register, optionally placed in a class. */
export async function makeStudent(
  school: SeededSchool,
  admissionNumber: string,
  overrides: {
    givenName?: string;
    familyName?: string;
    streamId?: string;
    boardingStatus?: "day" | "boarder";
  } = {},
) {
  const [student] = await db
    .insert(students)
    .values({
      schoolId: school.id,
      admissionNumber,
      givenName: overrides.givenName ?? "Wanjiku",
      familyName: overrides.familyName ?? "Njoroge",
      admittedOn: "2026-01-06",
      status: "active",
    })
    .returning();

  if (overrides.streamId) {
    await db.insert(enrollments).values({
      schoolId: school.id,
      studentId: student.id,
      streamId: overrides.streamId,
      boardingStatus: overrides.boardingStatus ?? "day",
      startedOn: "2026-01-06",
    });
  }

  return student;
}

/**
 * An invoice with a matching line, so the stored total and the lines agree.
 *
 * `termIndex` picks which of the school's three seeded terms to bill, because
 * one invoice per student per term is a unique constraint — a test wanting two
 * invoices for one child must put them in different terms.
 */
export async function makeInvoice(
  school: SeededSchool,
  student: { id: string },
  options: { totalCents: number; termIndex?: number; issuedOn?: string },
) {
  const term = school.terms[options.termIndex ?? 0];

  const [invoice] = await db
    .insert(invoices)
    .values({
      schoolId: school.id,
      studentId: student.id,
      termId: term.id,
      totalCents: options.totalCents,
      issuedOn: options.issuedOn ?? "2026-01-06",
    })
    .returning();

  await db.insert(invoiceLines).values({
    schoolId: school.id,
    invoiceId: invoice.id,
    description: "Tuition",
    amountCents: options.totalCents,
  });

  return invoice;
}

export async function makePayment(
  school: SeededSchool,
  student: { id: string },
  options: {
    amountCents: number;
    invoiceId?: string;
    method?: "mpesa" | "bank" | "cash" | "cheque";
    receivedAt?: Date;
  },
) {
  const [payment] = await db
    .insert(payments)
    .values({
      schoolId: school.id,
      studentId: student.id,
      invoiceId: options.invoiceId,
      method: options.method ?? "cash",
      amountCents: options.amountCents,
      receivedAt: options.receivedAt ?? new Date(),
    })
    .returning();

  return payment;
}
