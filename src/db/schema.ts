import { relations, sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { account, session, user, verification } from "./auth-schema";

// Re-exported so the rest of the app can `import { user } from "./schema"`
// alongside everything else, without caring that identity tables live in a
// separate Better-Auth-generated file.
export { account, session, user, verification };

// ---------------------------------------------------------------------------
// Shared column builders
//
// The domain tables land in step 2 (tenancy + academic spine). These are kept
// here rather than added alongside them because the rules they encode —
// timestamptz for instants, whole shillings for money — are decisions from
// CLAUDE.md §3, not incidental to whichever table happens to be written first.
// ---------------------------------------------------------------------------

// `.$onUpdate` is what actually makes updated_at move — `.defaultNow()` alone
// freezes it at insert time.
export function updatedAt() {
  return timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());
}

export function createdAt() {
  return timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
}

/**
 * Money is stored as integer cents (CLAUDE.md §3 rule 3). M-Pesa only
 * transacts whole shillings, so every amount must be divisible by 100 —
 * enforced in the database so a seed script, migration or manual SQL can't
 * sneak a bad row past the Zod layer.
 *
 * Not applied to `invoice_lines.amount_cents`, which is deliberately allowed
 * to go negative: a bursary or discount is a negative line (CLAUDE.md §5.7).
 * That column takes the divisibility half of this check without the `>= 0`.
 */
export function wholeShillings(name: string, column: unknown) {
  return check(name, sql`${column} % 100 = 0 AND ${column} >= 0`);
}

/** Divisible by 100, but may be negative — for discount and bursary lines. */
export function wholeShillingsSigned(name: string, column: unknown) {
  return check(name, sql`${column} % 100 = 0`);
}

/**
 * Divisible by 100 and strictly positive — for payments.
 *
 * A zero-shilling receipt is not a payment; it is either a mistake or an
 * attempt to express a reversal, and reversals have their own columns. A
 * negative one would be a refund pretending to be a payment, which makes
 * "how much has this family paid" unanswerable by summation.
 */
export function wholeShillingsPositive(name: string, column: unknown) {
  return check(name, sql`${column} % 100 = 0 AND ${column} > 0`);
}

/**
 * A text column restricted to a known set of values.
 *
 * `.$type<"a" | "b">()` is a TypeScript fiction: it constrains what this
 * codebase can assign and nothing else. The database will take any string, so
 * a seed, a migration, a backfill or a hand-run correction can put a value in
 * that every switch in the app silently falls through — and the failure is
 * quiet, because an unrecognised status is not a crash, it is a row that stops
 * matching filters. A withdrawn pupil who is neither active nor withdrawn
 * simply stops appearing.
 *
 * `pgEnum` is the other way to say this, and `performance_level` uses it. The
 * difference that matters here is evolution: adding a value to an enum type is
 * `ALTER TYPE ... ADD VALUE`, which cannot then be used in the same
 * transaction, while a CHECK is dropped and re-added in one ordinary
 * migration. These sets change with the product — a fifth payment method, a
 * sixth assessment kind — so the constraint that is cheap to change is the
 * right one.
 *
 * NULL passes a CHECK, so a nullable column needs no special case; the column
 * definition is what decides whether the value may be absent.
 */
export function oneOf(name: string, column: unknown, values: readonly string[]) {
  /*
   * `sql.raw`, and the guard that makes it safe.
   *
   * An interpolated `sql`${value}`` is a BIND PARAMETER, not a literal — which
   * is right for a query and wrong for DDL. drizzle-kit rendered the first
   * version of this as `IN ($1, $2)`, a migration that cannot run. A constraint
   * definition has to carry the values themselves.
   *
   * Nothing here is user input; every set is written in this file. The guard is
   * so that stays true — a value with a quote in it would otherwise end up
   * concatenated into DDL, and this is the one place in the codebase where that
   * could happen.
   */
  for (const value of values) {
    // Lowercase, digits, underscore and dot: enough for `grade_6` and
    // `marks.saved`, and still nothing that could close a quote or end a
    // statement. The point is the shape of what may reach DDL, not brevity.
    if (!/^[a-z0-9_.]+$/.test(value))
      throw new Error(`oneOf(${name}): unexpected value ${JSON.stringify(value)}`);
  }

  const list = values.map(v => `'${v}'`).join(", ");
  return check(name, sql`${column} IN (${sql.raw(list)})`);
}

/**
 * The code printed on a document so anyone holding it can check it is real.
 *
 * A Kenyan school gets handed report cards and fee receipts from elsewhere all
 * the time — at admission, at a transfer, when a parent disputes a payment —
 * and has no way to tell a genuine one from a photocopy somebody edited. A
 * document that verifies itself is the cheapest trust we can offer, and it is
 * nearly free here because the content is ALREADY frozen: rule 7 snapshots
 * exist precisely so that reprinting one cannot produce different output.
 *
 * 160 bits, base64url. Unguessable for the same reason `mpesa_callback_token`
 * is: the endpoint that answers it is public and unauthenticated, so the code
 * is the only thing between a stranger and somebody else's document. Short
 * enough to fit under a QR without wrapping.
 */
function verificationCode(name = "verification_code") {
  return text(name);
}

/**
 * A foreign key to the Better Auth user table.
 *
 * `text`, NOT `uuid`. Better Auth generates its own string ids and declares
 * `user.id` as `text` (see auth-schema.ts) — a `uuid` column here fails to
 * create the constraint at migration time, and CLAUDE.md's schema sketch is
 * wrong about this in every place it references a user.
 */
function userRef(name: string) {
  return text(name);
}

// ---------------------------------------------------------------------------
// 5.1 Tenancy and identity
// ---------------------------------------------------------------------------

export const schools = pgTable("schools", {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull(),
  subdomain: text().notNull().unique(),

  county: text(),
  postalAddress: text(),
  phone: text(),
  email: text(),
  logoUrl: text(),

  // Per-tenant M-Pesa. Money NEVER routes through our account: each school
  // collects on its own paybill (CLAUDE.md §5.8).
  mpesaShortcode: text(),
  /** AES-256-GCM, `v1.iv.tag.ciphertext` — see lib/crypto.ts. Never returned. */
  mpesaCredentials: text(),
  /**
   * The school's own segment of the C2B confirmation URL.
   *
   * CLAUDE.md §5.8 resolves the tenant from the `shortcode` in the payload.
   * That cannot work: the confirmation endpoint is unauthenticated and the
   * shortcode is a public field an attacker supplies, so anyone could file
   * fabricated payments against any school. The tenant comes from this token
   * in the path instead — 256 bits, never published — and a payload whose
   * shortcode disagrees with the school's is stored `rejected` rather than
   * believed.
   */
  mpesaCallbackToken: text().unique(),

  // Percentage -> performance level cut points; schools differ.
  levelThresholds: jsonb()
    .$type<{ approaching: number; meeting: number; exceeding: number }>()
    .default({ approaching: 40, meeting: 60, exceeding: 80 })
    .notNull(),

  // Some schools have moved away from publishing class rank under CBE.
  showsPositions: boolean().default(true).notNull(),

  status: text()
    .$type<"trial" | "active" | "suspended" | "demo">()
    .notNull(),

  createdAt: createdAt(),
}, t => [
  // `suspended` is what stops a non-payer's tenant resolving at all, so a
  // status this table does not recognise is a school that is neither serving
  // nor stopped.
  oneOf("schools_status_known", t.status, ["trial", "active", "suspended", "demo"]),
]);

/**
 * Which people may act at which school, and as what.
 *
 * Role lives here rather than on `user` because one login has to cover a
 * teacher who is also a parent at the same school, and a person who works at
 * two schools. `user.role` answers a different and much narrower question —
 * see `UserRole` in lib/types.ts.
 */
export const memberships = pgTable("memberships", {
  id: uuid().primaryKey().defaultRandom(),
  userId: userRef("user_id").notNull().references(() => user.id),
  schoolId: uuid().notNull().references(() => schools.id),
  role: text()
    .$type<"admin" | "bursar" | "teacher" | "guardian">()
    .notNull(),
  isActive: boolean().default(true).notNull(),
  createdAt: createdAt(),
}, t => [
  unique().on(t.userId, t.schoolId, t.role),
  // The lookup every single tenant request makes.
  index().on(t.userId, t.schoolId),
  // `requireMembershipRole` compares against these four. A fifth string is a
  // person who passes no role check and fails every one, at a school that
  // thinks they are staff.
  oneOf("memberships_role_known", t.role, ["admin", "bursar", "teacher", "guardian"]),
]);

// ---------------------------------------------------------------------------
// 5.2 Academic spine
// ---------------------------------------------------------------------------

/**
 * Why several tables below carry `unique().on(schoolId, id)`.
 *
 * Row-level security does NOT constrain foreign keys. Postgres validates a
 * reference internally, as the table's owner, bypassing policies entirely — so
 * a policy-scoped insert can still point a row at another tenant's parent. The
 * first version of this schema did exactly that: a stream at one school could
 * reference another school's grade level, and every policy allowed it, because
 * the row it *wrote* carried the correct school_id.
 *
 * The fix is structural. Referencing `(school_id, id)` instead of `(id)` makes
 * the tenant part of the reference itself, so a cross-tenant pointer fails the
 * foreign key rather than passing the policy. That needs a unique constraint on
 * the parent's `(school_id, id)` — redundant against the primary key, and
 * cheap, which is the price of making the mistake unrepresentable.
 */
export const academicYears = pgTable("academic_years", {
  id: uuid().primaryKey().defaultRandom(),
  schoolId: uuid().notNull().references(() => schools.id),
  year: integer().notNull(),
  isCurrent: boolean().default(false).notNull(),
}, t => [
  /*
   * At most one current year per school, enforced here rather than by the
   * handlers.
   *
   * They clear the flag and then set it, which is correct on its own and races
   * against itself: under READ COMMITTED a second request's UPDATE cannot see
   * the row the first has not committed yet, so both clear nothing of each
   * other's and both insert. The result is two current years and no error —
   * and everything that reads "the current year" then picks whichever sorts
   * first, silently, for ever.
   *
   * A partial index because `is_current` is false on most rows and they must
   * not collide with each other.
   */
  uniqueIndex("academic_years_one_current_per_school")
    .on(t.schoolId)
    .where(sql`${t.isCurrent}`),
  unique().on(t.schoolId, t.year),
  unique("academic_years_school_id_id_key").on(t.schoolId, t.id),
]);

export const terms = pgTable("terms", {
  id: uuid().primaryKey().defaultRandom(),
  schoolId: uuid().notNull().references(() => schools.id),
  academicYearId: uuid().notNull(),
  number: integer().notNull(),
  // Term boundaries are calendar days, not instants (CLAUDE.md §3 rule 9).
  startsOn: date().notNull(),
  endsOn: date().notNull(),
  isCurrent: boolean().default(false).notNull(),
}, t => [
  /*
   * At most one current term per school, enforced here rather than by the
   * handlers.
   *
   * They clear the flag and then set it, which is correct on its own and races
   * against itself: under READ COMMITTED a second request's UPDATE cannot see
   * the row the first has not committed yet, so both clear nothing of each
   * other's and both insert. The result is two current terms and no error —
   * and everything that reads "the current term" then picks whichever sorts
   * first, silently, for ever.
   *
   * A partial index because `is_current` is false on most rows and they must
   * not collide with each other.
   */
  uniqueIndex("terms_one_current_per_school")
    .on(t.schoolId)
    .where(sql`${t.isCurrent}`),
  unique().on(t.academicYearId, t.number),
  unique("terms_school_id_id_key").on(t.schoolId, t.id),
  // Tenant-carrying reference: a term cannot belong to another school's year.
  foreignKey({
    columns: [t.schoolId, t.academicYearId],
    foreignColumns: [academicYears.schoolId, academicYears.id],
    name: "terms_school_academic_year_fk",
  }),
  check("terms_number_valid", sql`${t.number} BETWEEN 1 AND 3`),
  check("terms_dates_ordered", sql`${t.endsOn} > ${t.startsOn}`),
]);

/**
 * The stable definition of "Grade 4" — persists across years.
 *
 * `phase` distinguishes primary (Grade 1-6) from junior school (Grade 7-9),
 * which have different learning areas. Filter on `phase`, never on hardcoded
 * grade numbers. Grade 6 and Grade 9 are candidate years (KPSEA and KJSEA);
 * derive that from `sequence` rather than storing a flag.
 */
export const gradeLevels = pgTable("grade_levels", {
  id: uuid().primaryKey().defaultRandom(),
  schoolId: uuid().notNull().references(() => schools.id),
  name: text().notNull(),
  sequence: integer().notNull(),
  phase: text().$type<"primary" | "junior">().notNull(),
}, t => [
  unique().on(t.schoolId, t.sequence),
  unique("grade_levels_school_id_id_key").on(t.schoolId, t.id),
  check("grade_levels_sequence_valid", sql`${t.sequence} BETWEEN 1 AND 9`),
  // Filtered on rather than the grade number (CLAUDE.md §5.2), so a third
  // value is a grade whose learning areas nothing selects.
  oneOf("grade_levels_phase_known", t.phase, ["primary", "junior"]),
]);

/** The yearly instance — "Grade 4 Blue, 2026" — which holds actual children. */
export const streams = pgTable("streams", {
  id: uuid().primaryKey().defaultRandom(),
  schoolId: uuid().notNull().references(() => schools.id),
  gradeLevelId: uuid().notNull(),
  academicYearId: uuid().notNull(),
  name: text().notNull(),
  classTeacherId: userRef("class_teacher_id").references(() => user.id),
}, t => [
  unique().on(t.gradeLevelId, t.academicYearId, t.name),
  unique("streams_school_id_id_key").on(t.schoolId, t.id),
  // Both parents are referenced through the tenant, so "Grade 4 Blue" can only
  // ever be built from this school's Grade 4 and this school's academic year.
  foreignKey({
    columns: [t.schoolId, t.gradeLevelId],
    foreignColumns: [gradeLevels.schoolId, gradeLevels.id],
    name: "streams_school_grade_level_fk",
  }),
  foreignKey({
    columns: [t.schoolId, t.academicYearId],
    foreignColumns: [academicYears.schoolId, academicYears.id],
    name: "streams_school_academic_year_fk",
  }),
]);

// ---------------------------------------------------------------------------
// 5.3 Students, guardians, enrollment
// ---------------------------------------------------------------------------

/**
 * A child on the register.
 *
 * **A student is not a user.** `userId` is nullable and usually null — most
 * Grade 1-9 pupils will never have a login. The parent portal belongs to
 * guardians.
 *
 * **Name parts, not firstName/lastName.** Kenyan names do not split reliably
 * into a fixed given/surname order, and forcing them to loses information that
 * cannot be recovered.
 */
export const students = pgTable("students", {
  id: uuid().primaryKey().defaultRandom(),
  schoolId: uuid().notNull().references(() => schools.id),

  // School-scoped, human-facing, and doubles as the M-Pesa account reference a
  // parent types when paying. Format is the school's own ("2026/118").
  admissionNumber: text().notNull(),

  /*
   * Ministry-issued, and follows the child between schools.
   *
   * Unique per school, NOT globally. A globally unique UPI would need one row
   * readable by two tenants, which puts a hole straight through the isolation
   * model. A transfer creates a fresh row at the receiving school instead.
   */
  upiNumber: text(),
  birthCertNumber: text(),

  givenName: text().notNull(),
  middleNames: text(),
  familyName: text().notNull(),
  preferredName: text(),

  // A birthday is a calendar day, not an instant (CLAUDE.md §3 rule 9).
  dateOfBirth: date(),
  sex: text().$type<"male" | "female">(),
  photoUrl: text(),

  userId: userRef("user_id").references(() => user.id),

  status: text()
    .$type<"active" | "transferred_out" | "graduated" | "withdrawn" | "deceased">()
    .notNull()
    .default("active"),

  admittedOn: date().notNull(),
  exitedOn: date(),
  previousSchool: text(),
}, t => [
  unique().on(t.schoolId, t.admissionNumber),
  // Nullable, and Postgres treats NULLs as distinct — so the many students
  // without a UPI yet do not collide.
  unique().on(t.schoolId, t.upiNumber),
  unique("students_school_id_id_key").on(t.schoolId, t.id),
  // Nullable — plenty of admission forms leave it blank, and a CHECK passes
  // on NULL. What it refuses is a third spelling of the two it knows.
  oneOf("students_sex_known", t.sex, ["male", "female"]),
  /*
   * Nothing hard-deletes (CLAUDE.md §3 rule 5), so this column is the ONLY
   * thing separating a pupil who left from one who is here. An unrecognised
   * status is a child who is neither: absent from the active register, absent
   * from the leavers' list, and still countable in a fee run.
   */
  oneOf("students_status_known", t.status, [
    "active",
    "transferred_out",
    "graduated",
    "withdrawn",
    "deceased",
  ]),
  // "Find all the Wanjikus" is a query bursars run constantly.
  index().on(t.schoolId, t.familyName),
  // A child cannot leave before they arrived.
  check("students_exit_after_admission", sql`${t.exitedOn} IS NULL OR ${t.exitedOn} >= ${t.admittedOn}`),
  /*
   * An exit date and a non-active status travel together. Without this, a
   * student can be marked `withdrawn` with no date (so no report can say when)
   * or carry an exit date while still counted as active — and the second one
   * inflates every roll, every invoice run and every class list.
   */
  check(
    "students_exit_matches_status",
    sql`(${t.status} = 'active') = (${t.exitedOn} IS NULL)`,
  ),
]);

/**
 * A parent or other adult responsible for a child.
 *
 * A table, not columns on the student, because siblings share a parent.
 * Without this you send the same fee reminder three times and store the phone
 * number three different ways.
 */
export const guardians = pgTable("guardians", {
  id: uuid().primaryKey().defaultRandom(),
  schoolId: uuid().notNull().references(() => schools.id),
  // Null until they sign up for the portal.
  userId: userRef("user_id").references(() => user.id),
  name: text().notNull(),
  // E.164, normalised on write (CLAUDE.md §3 rule 10). This is the SMS target,
  // and SMS is what actually reaches a Kenyan parent.
  phone: text().notNull(),
  altPhone: text(),
  email: text(),
  nationalId: text(),
  occupation: text(),
}, t => [
  unique("guardians_school_id_id_key").on(t.schoolId, t.id),
  /*
   * Indexed, not unique. A household may genuinely share one handset, and a
   * unique constraint would block the second parent from being recorded at
   * all. Deduplication is offered at the API instead, where a human can decide
   * whether two people are really one.
   */
  index().on(t.schoolId, t.phone),
]);

export const studentGuardians = pgTable("student_guardians", {
  schoolId: uuid().notNull().references(() => schools.id),
  studentId: uuid().notNull(),
  guardianId: uuid().notNull(),
  relationship: text(),
  isPrimary: boolean().default(false).notNull(),
  receivesInvoices: boolean().default(true).notNull(),
  // Safeguarding: who may collect this child from school.
  canCollect: boolean().default(true).notNull(),
}, t => [
  primaryKey({ columns: [t.studentId, t.guardianId] }),
  foreignKey({
    columns: [t.schoolId, t.studentId],
    foreignColumns: [students.schoolId, students.id],
    name: "student_guardians_school_student_fk",
  }),
  foreignKey({
    columns: [t.schoolId, t.guardianId],
    foreignColumns: [guardians.schoolId, guardians.id],
    name: "student_guardians_school_guardian_fk",
  }),
  index().on(t.schoolId, t.guardianId),
]);

/**
 * Which class a child is in, for a stretch of time.
 *
 * **There is deliberately no `streamId` on `students`.** "Which class is this
 * child in" is the open enrollment row — the one with `endedOn` null. That is
 * what keeps last year's marks and invoices pointing at the correct class
 * after progression or a stream switch, instead of being silently rewritten
 * when the child moves.
 *
 * Scores hang off `enrollmentId`, never `studentId` (CLAUDE.md §3 rule 6): a
 * mark is "this child, in this stream, in this year".
 */
export const enrollments = pgTable("enrollments", {
  id: uuid().primaryKey().defaultRandom(),
  schoolId: uuid().notNull().references(() => schools.id),
  studentId: uuid().notNull(),
  streamId: uuid().notNull(),
  boardingStatus: text().$type<"day" | "boarder">().notNull(),
  startedOn: date().notNull(),
  // Null = current.
  endedOn: date(),
}, t => [
  unique("enrollments_school_id_id_key").on(t.schoolId, t.id),
  // Picks which fee structure a child is billed from, so a third value is an
  // enrolment no invoice run can price.
  oneOf("enrollments_boarding_status_known", t.boardingStatus, ["day", "boarder"]),
  foreignKey({
    columns: [t.schoolId, t.studentId],
    foreignColumns: [students.schoolId, students.id],
    name: "enrollments_school_student_fk",
  }),
  foreignKey({
    columns: [t.schoolId, t.streamId],
    foreignColumns: [streams.schoolId, streams.id],
    name: "enrollments_school_stream_fk",
  }),
  index().on(t.schoolId, t.streamId),
  index().on(t.schoolId, t.studentId),
  check(
    "enrollments_dates_ordered",
    sql`${t.endedOn} IS NULL OR ${t.endedOn} >= ${t.startedOn}`,
  ),
  // The overlap constraint itself is an EXCLUDE, which drizzle cannot express;
  // it is added by hand in the migration. See 0003.
]);

// ---------------------------------------------------------------------------
// 5.7 Fees
// ---------------------------------------------------------------------------

/**
 * What one kind of pupil pays for one term.
 *
 * A template, not a record. Fees differ by grade level (junior school costs
 * more) and by whether a child boards, so the key is the three of them
 * together.
 */
export const feeStructures = pgTable("fee_structures", {
  id: uuid().primaryKey().defaultRandom(),
  schoolId: uuid().notNull().references(() => schools.id),
  termId: uuid().notNull(),
  gradeLevelId: uuid().notNull(),
  boardingStatus: text().$type<"day" | "boarder">().notNull(),
}, t => [
  unique().on(t.termId, t.gradeLevelId, t.boardingStatus),
  unique("fee_structures_school_id_id_key").on(t.schoolId, t.id),
  // The other half of that pairing: a structure nothing matches is fees a
  // school entered and no child is ever charged.
  oneOf("fee_structures_boarding_status_known", t.boardingStatus, ["day", "boarder"]),
  foreignKey({
    columns: [t.schoolId, t.termId],
    foreignColumns: [terms.schoolId, terms.id],
    name: "fee_structures_school_term_fk",
  }),
  foreignKey({
    columns: [t.schoolId, t.gradeLevelId],
    foreignColumns: [gradeLevels.schoolId, gradeLevels.id],
    name: "fee_structures_school_grade_level_fk",
  }),
]);

export const feeItems = pgTable("fee_items", {
  id: uuid().primaryKey().defaultRandom(),
  schoolId: uuid().notNull().references(() => schools.id),
  feeStructureId: uuid().notNull(),
  name: text().notNull(),
  amountCents: integer().notNull(),
  /**
   * Not billed automatically.
   *
   * Transport and lunch are the usual cases: real charges, but only for the
   * families that take them. Including them in a bulk run would invoice every
   * child for a bus they do not ride, and a parent who spots that stops
   * trusting every other figure on the sheet. Added per student instead.
   */
  isOptional: boolean().default(false).notNull(),
}, t => [
  unique("fee_items_school_id_id_key").on(t.schoolId, t.id),
  foreignKey({
    columns: [t.schoolId, t.feeStructureId],
    foreignColumns: [feeStructures.schoolId, feeStructures.id],
    name: "fee_items_school_structure_fk",
  }),
  index().on(t.schoolId, t.feeStructureId),
  wholeShillings("fee_items_amount_whole", t.amountCents),
]);

/**
 * What one child owes for one term.
 *
 * One per student per term, which is what makes "have they been billed yet"
 * answerable and a re-run of the generator harmless.
 */
export const invoices = pgTable("invoices", {
  id: uuid().primaryKey().defaultRandom(),
  schoolId: uuid().notNull().references(() => schools.id),
  studentId: uuid().notNull(),
  termId: uuid().notNull(),
  /**
   * The frozen total, maintained to equal the sum of the lines.
   *
   * Stored rather than derived because an invoice is a printed document
   * (CLAUDE.md §3 rule 7) — reprinting a 2026 invoice in 2028 must produce the
   * same figure even if someone later corrects a line. Balances, by contrast,
   * are always derived (rule 4); see lib/balances.ts.
   */
  totalCents: integer().notNull(),
  issuedOn: date().notNull(),
  dueOn: date(),
  /** Voided, never deleted. A cancelled invoice still has to be explicable. */
  voidedAt: timestamp({ withTimezone: true }),
  voidReason: text(),
}, t => [
  unique().on(t.studentId, t.termId),
  unique("invoices_school_id_id_key").on(t.schoolId, t.id),
  /*
   * Lets `payments` reference (school_id, invoice_id, student_id).
   *
   * Without the student in the reference, a payment can name one child and
   * point at another child's invoice: both two-column keys are satisfied,
   * because each is individually true. That is money credited to the wrong
   * family, and it reads as correct on both screens.
   */
  unique("invoices_school_id_id_student_id_key").on(t.schoolId, t.id, t.studentId),
  foreignKey({
    columns: [t.schoolId, t.studentId],
    foreignColumns: [students.schoolId, students.id],
    name: "invoices_school_student_fk",
  }),
  foreignKey({
    columns: [t.schoolId, t.termId],
    foreignColumns: [terms.schoolId, terms.id],
    name: "invoices_school_term_fk",
  }),
  index().on(t.schoolId, t.studentId),
  index().on(t.schoolId, t.termId),
  // Signed: a bursary larger than the fees leaves a credit, which is a real
  // outcome and not one to refuse at the constraint.
  wholeShillingsSigned("invoices_total_whole", t.totalCents),
  check(
    "invoices_void_has_reason",
    sql`(${t.voidedAt} IS NULL) = (${t.voidReason} IS NULL)`,
  ),
  check(
    "invoices_due_after_issue",
    sql`${t.dueOn} IS NULL OR ${t.dueOn} >= ${t.issuedOn}`,
  ),
]);

/**
 * The line items, COPIED from the fee structure at generation time.
 *
 * Copied, not joined. When a school raises tuition mid-year, every invoice
 * already issued must keep saying what it said — a parent holding a printed
 * sheet and a bursar reading the screen have to see the same number. Joining
 * back to `fee_items` at read time would silently rewrite history.
 */
export const invoiceLines = pgTable("invoice_lines", {
  id: uuid().primaryKey().defaultRandom(),
  schoolId: uuid().notNull().references(() => schools.id),
  invoiceId: uuid().notNull(),
  description: text().notNull(),
  /** Negative = bursary or discount. */
  amountCents: integer().notNull(),
}, t => [
  foreignKey({
    columns: [t.schoolId, t.invoiceId],
    foreignColumns: [invoices.schoolId, invoices.id],
    name: "invoice_lines_school_invoice_fk",
  }),
  index().on(t.schoolId, t.invoiceId),
  wholeShillingsSigned("invoice_lines_amount_whole", t.amountCents),
]);

/**
 * Everything Safaricom sent, exactly as sent. Append-only.
 *
 * This is half of what makes M-Pesa reconciliation trustworthy, and the
 * separation from `payments` is the entire feature (CLAUDE.md §5.8). The
 * webhook writes here and stops — it never guesses which child a payment
 * belongs to, never allocates, and never rejects a reference it does not
 * recognise. Matching happens afterwards, against a row that is already safe.
 *
 * Because the raw row is never rewritten, a mis-allocation is always
 * reversible and "where did this KES 15,000 go" always has an answer. A
 * trigger enforces that: only `status` and the review columns may change.
 */
export const mpesaTransactions = pgTable("mpesa_transactions", {
  id: uuid().primaryKey().defaultRandom(),
  schoolId: uuid().notNull().references(() => schools.id),

  /**
   * The Safaricom receipt number, e.g. `RKTQDM7W6S`.
   *
   * Unique across the whole table rather than per school, which is what makes
   * the webhook idempotent: Safaricom retries a confirmation it did not see
   * acknowledged, and a retry must not become a second payment. Receipts are
   * globally unique in Safaricom's own numbering, so this cannot collide
   * between two genuine transactions at different schools.
   */
  transactionId: text().notNull().unique(),

  /** As Safaricom reported it. Checked against the school's own, not trusted. */
  shortcode: text().notNull(),
  /** What the parent actually typed. Frequently not an admission number. */
  accountReference: text(),
  msisdn: text().notNull(),
  payerName: text(),
  amountCents: integer().notNull(),
  /** When Safaricom says the money moved, parsed from `TransTime` in EAT. */
  transactedAt: timestamp({ withTimezone: true }).notNull(),
  /** The whole envelope, so a field we did not model is still recoverable. */
  rawPayload: jsonb().notNull(),

  status: text()
    .$type<"unmatched" | "allocated" | "rejected">()
    .notNull()
    .default("unmatched"),
  /** Why a bursar set it aside, or why the system refused it. */
  statusReason: text(),

  receivedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
}, t => [
  unique("mpesa_transactions_school_id_id_key").on(t.schoolId, t.id),
  // The reconciliation queue: unmatched first, oldest first.
  index().on(t.schoolId, t.status),
  index().on(t.schoolId, t.accountReference),
  wholeShillingsPositive("mpesa_transactions_amount_whole", t.amountCents),
  /*
   * The reconciliation queue is `status = 'unmatched'`, and the immutability
   * trigger lets this column be one of the two things a bursar may change. A
   * fourth value is real money that has arrived, is attributed to nobody, and
   * appears in no queue for anyone to notice.
   */
  oneOf("mpesa_transactions_status_known", t.status, ["unmatched", "allocated", "rejected"]),
]);

/**
 * A ledger entry against a student.
 *
 * M-Pesa is one method among four, and the only one that is never entered by
 * hand: an `mpesa` payment exists because a raw confirmation was matched to a
 * child, so `mpesaTransactionId` points back at what Safaricom actually said.
 * Cash, bank and cheque carry no such row and are recorded directly.
 */
export const payments = pgTable("payments", {
  id: uuid().primaryKey().defaultRandom(),
  schoolId: uuid().notNull().references(() => schools.id),
  studentId: uuid().notNull(),
  /** Null = a credit on account, not yet applied to a particular term. */
  invoiceId: uuid(),
  method: text().$type<"mpesa" | "bank" | "cash" | "cheque">().notNull(),
  /** The raw confirmation this came from, for an `mpesa` payment. */
  mpesaTransactionId: uuid(),
  amountCents: integer().notNull(),
  reference: text(),
  /** Printed on the receipt, so a parent's copy can be checked against us. */
  verificationCode: verificationCode(),
  recordedBy: userRef("recorded_by").references(() => user.id),
  /** An instant, not a day — when the money actually arrived. */
  receivedAt: timestamp({ withTimezone: true }).notNull(),
  /** Reversed, never deleted: "where did this KES 15,000 go" stays answerable. */
  reversedAt: timestamp({ withTimezone: true }),
  reversalReason: text(),
  createdAt: createdAt(),
}, t => [
  unique("payments_school_id_id_key").on(t.schoolId, t.id),
  unique("payments_verification_code_key").on(t.verificationCode),
  // How a family paid is what a bursar reconciles against — the M-Pesa
  // statement, the bank slip, the cash book. A method belonging to none of
  // them cannot be checked against anything.
  oneOf("payments_method_known", t.method, ["mpesa", "bank", "cash", "cheque"]),
  foreignKey({
    columns: [t.schoolId, t.studentId],
    foreignColumns: [students.schoolId, students.id],
    name: "payments_school_student_fk",
  }),
  /*
   * The invoice reference carries the student, not just the school.
   *
   * A two-column (school_id, invoice_id) key would let a payment name child A
   * and settle child B's invoice — each key true on its own, the pair wrong.
   * Including student_id makes that unrepresentable.
   *
   * `invoice_id` is nullable for a credit on account. Under the default MATCH
   * SIMPLE, a NULL in any referencing column switches the constraint off for
   * that row, which is exactly the behaviour a credit needs.
   */
  foreignKey({
    columns: [t.schoolId, t.invoiceId, t.studentId],
    foreignColumns: [invoices.schoolId, invoices.id, invoices.studentId],
    name: "payments_school_invoice_student_fk",
  }),
  foreignKey({
    columns: [t.schoolId, t.mpesaTransactionId],
    foreignColumns: [mpesaTransactions.schoolId, mpesaTransactions.id],
    name: "payments_school_mpesa_transaction_fk",
  }),
  index().on(t.schoolId, t.studentId),
  index().on(t.schoolId, t.invoiceId),
  /*
   * At most one LIVE payment per confirmation.
   *
   * A plain unique would be wrong: reversing a mis-allocated payment leaves
   * the row in place (rule 5), so it would hold the confirmation hostage and
   * the money could never be re-allocated to the right child — which is the
   * whole recovery path. Partial on `reversed_at IS NULL`, so a reversed
   * payment releases the transaction while staying on the record.
   *
   * What it does prevent is the realistic mistake: a bursar double-clicking
   * "allocate" and crediting one M-Pesa receipt to two families.
   */
  uniqueIndex("payments_one_live_per_mpesa_transaction")
    .on(t.mpesaTransactionId)
    .where(sql`${t.reversedAt} IS NULL`),
  wholeShillingsPositive("payments_amount_whole", t.amountCents),
  check(
    "payments_reversal_has_reason",
    sql`(${t.reversedAt} IS NULL) = (${t.reversalReason} IS NULL)`,
  ),
  /*
   * `mpesa` is the one method that cannot be entered by hand. A payment with
   * that method must point at the confirmation it came from, and a payment
   * with any other method must not — otherwise "this money came from
   * Safaricom" stops being checkable.
   */
  check(
    "payments_mpesa_has_transaction",
    sql`(${t.method} = 'mpesa') = (${t.mpesaTransactionId} IS NOT NULL)`,
  ),
]);

// ---------------------------------------------------------------------------
// 5.4 Curriculum
// ---------------------------------------------------------------------------

/**
 * A subject, as CBE names them.
 *
 * `gradeLevelId` is nullable because some learning areas run the whole way
 * through and some belong to one grade. Junior school (Grade 7-9) carries
 * additional areas that primary does not, which is why anything reasoning
 * about the difference filters on `gradeLevels.phase` rather than on a number.
 */
export const learningAreas = pgTable("learning_areas", {
  id: uuid().primaryKey().defaultRandom(),
  schoolId: uuid().notNull().references(() => schools.id),
  gradeLevelId: uuid(),
  name: text().notNull(),
  code: text(),
  isCore: boolean().default(true).notNull(),
  /** Report card ordering — Mathematics before Music, as the school prints it. */
  sequence: integer().notNull(),
}, t => [
  unique("learning_areas_school_id_id_key").on(t.schoolId, t.id),
  /*
   * One area per name per school, case-insensitively.
   *
   * The seed skips an area the school already has by name, but nothing stopped
   * a second "Mathematics" arriving through the ordinary create route — after
   * which the seed's own skip check becomes ambiguous and a report card prints
   * the subject twice. Case-insensitive because "mathematics" and
   * "Mathematics" are the same subject to everyone except a byte comparison.
   */
  uniqueIndex("learning_areas_school_name_unique")
    .on(t.schoolId, sql`lower(${t.name})`),
  foreignKey({
    columns: [t.schoolId, t.gradeLevelId],
    foreignColumns: [gradeLevels.schoolId, gradeLevels.id],
    name: "learning_areas_school_grade_level_fk",
  }),
  index().on(t.schoolId, t.gradeLevelId),
]);

/**
 * Strand, then sub-strand. Self-referencing so the depth stays flexible.
 *
 * KICD designs nest to two levels today and there is no guarantee they always
 * will, so the shape is a tree rather than two tables. A root row is a strand;
 * a row with a parent is a sub-strand; nothing stops a third level if a
 * curriculum revision introduces one.
 */
export const competencies = pgTable("competencies", {
  id: uuid().primaryKey().defaultRandom(),
  schoolId: uuid().notNull().references(() => schools.id),
  learningAreaId: uuid().notNull(),
  parentId: uuid(),
  /** '1.2', '1.2.3' — the numbering a teacher recognises from the design. */
  code: text(),
  title: text().notNull(),
  sequence: integer().notNull(),
}, t => [
  unique("competencies_school_id_id_key").on(t.schoolId, t.id),
  foreignKey({
    columns: [t.schoolId, t.learningAreaId],
    foreignColumns: [learningAreas.schoolId, learningAreas.id],
    name: "competencies_school_learning_area_fk",
  }),
  // Self-referencing, and still tenant-carrying: a sub-strand cannot hang off
  // another school's strand.
  foreignKey({
    columns: [t.schoolId, t.parentId],
    foreignColumns: [t.schoolId, t.id],
    name: "competencies_school_parent_fk",
  }),
  index().on(t.schoolId, t.learningAreaId),
]);

// ---------------------------------------------------------------------------
// 5.5 Assessment
// ---------------------------------------------------------------------------

export const performanceLevel = pgEnum("performance_level", [
  "below_expectation",
  "approaching",
  "meeting",
  "exceeding",
]);

export const assessments = pgTable("assessments", {
  id: uuid().primaryKey().defaultRandom(),
  schoolId: uuid().notNull().references(() => schools.id),
  termId: uuid().notNull(),
  learningAreaId: uuid().notNull(),
  /** Null = the whole grade sits it, rather than one class. */
  streamId: uuid(),

  title: text().notNull(),
  kind: text().$type<
    "exam" | "cat" | "project" | "practical" | "observation" | "national"
  >().notNull(),

  /** Null for pure observation, which produces a level and no mark. */
  maxScore: integer(),
  /** How much this counts towards the term mean. */
  weight: numeric({ precision: 5, scale: 2 }),

  administeredOn: date(),
  createdBy: userRef("created_by").references(() => user.id),
  /**
   * Null = teachers are still entering marks.
   *
   * Gates parent visibility. Marks go in over days and get corrected; a parent
   * seeing a half-entered exam would ring the school about a mark that is
   * about to change.
   */
  publishedAt: timestamp({ withTimezone: true }),
}, t => [
  unique("assessments_school_id_id_key").on(t.schoolId, t.id),
  oneOf("assessments_kind_known", t.kind, [
    "exam",
    "cat",
    "project",
    "practical",
    "observation",
    "national",
  ]),
  foreignKey({
    columns: [t.schoolId, t.termId],
    foreignColumns: [terms.schoolId, terms.id],
    name: "assessments_school_term_fk",
  }),
  foreignKey({
    columns: [t.schoolId, t.learningAreaId],
    foreignColumns: [learningAreas.schoolId, learningAreas.id],
    name: "assessments_school_learning_area_fk",
  }),
  foreignKey({
    columns: [t.schoolId, t.streamId],
    foreignColumns: [streams.schoolId, streams.id],
    name: "assessments_school_stream_fk",
  }),
  index().on(t.schoolId, t.termId),
  check("assessments_max_score_positive", sql`${t.maxScore} IS NULL OR ${t.maxScore} > 0`),
  check("assessments_weight_positive", sql`${t.weight} IS NULL OR ${t.weight} > 0`),
]);

/**
 * One mark, or one competency judgement.
 *
 * **`competencyId` nullable is what lets both grading systems live in one
 * table** (CLAUDE.md §5.5). Null means one overall result for the assessment —
 * the percentage-exam path. Populated means one row per sub-strand — the
 * competency path. CBE schools run both: national assessment is
 * competency-based, but internal exams are still marked out of 100 and parents
 * still expect a mark and a position. A system that refuses to store a
 * percentage gets rejected.
 *
 * Hangs off `enrollmentId`, never `studentId` (rule 6): a mark is this child,
 * in this stream, in this year.
 */
export const assessmentScores = pgTable("assessment_scores", {
  id: uuid().primaryKey().defaultRandom(),
  schoolId: uuid().notNull().references(() => schools.id),
  assessmentId: uuid().notNull(),
  enrollmentId: uuid().notNull(),
  competencyId: uuid(),

  rawScore: numeric({ precision: 6, scale: 2 }),
  level: performanceLevel(),
  isAbsent: boolean().default(false).notNull(),
  comment: text(),

  enteredBy: userRef("entered_by").references(() => user.id),
  enteredAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
}, t => [
  unique("assessment_scores_school_id_id_key").on(t.schoolId, t.id),
  /*
   * NULLS NOT DISTINCT is the whole point of this constraint.
   *
   * Postgres treats NULLs as distinct by default, so a plain unique over
   * (assessment, enrollment, competency) would happily accept two overall
   * marks for the same child on the same exam — the exact duplicate it exists
   * to prevent, and the common case, since the percentage path always has a
   * null competency. Requires Postgres 15+, which the Docker image and Neon
   * both are.
   */
  unique("assessment_scores_unique_entry")
    .on(t.assessmentId, t.enrollmentId, t.competencyId)
    .nullsNotDistinct(),
  foreignKey({
    columns: [t.schoolId, t.assessmentId],
    foreignColumns: [assessments.schoolId, assessments.id],
    name: "assessment_scores_school_assessment_fk",
  }),
  foreignKey({
    columns: [t.schoolId, t.enrollmentId],
    foreignColumns: [enrollments.schoolId, enrollments.id],
    name: "assessment_scores_school_enrollment_fk",
  }),
  foreignKey({
    columns: [t.schoolId, t.competencyId],
    foreignColumns: [competencies.schoolId, competencies.id],
    name: "assessment_scores_school_competency_fk",
  }),
  index().on(t.schoolId, t.assessmentId),
  index().on(t.schoolId, t.enrollmentId),
  check("assessment_scores_raw_score_positive", sql`${t.rawScore} IS NULL OR ${t.rawScore} >= 0`),
  /*
   * An absence is not a zero.
   *
   * Storing it as one drags a child's mean down for an exam they never sat,
   * and the difference is invisible afterwards. Absent rows carry no mark and
   * no level, and the term mean skips them.
   */
  check(
    "assessment_scores_absent_has_no_result",
    sql`NOT ${t.isAbsent} OR (${t.rawScore} IS NULL AND ${t.level} IS NULL)`,
  ),
]);

/**
 * Portfolio evidence: the photograph of the work, the recording of the recital.
 *
 * CBE assessment is partly observational, and teachers currently keep this on
 * their phones and lose it. A genuine selling point rather than a nicety.
 */
export const scoreAttachments = pgTable("score_attachments", {
  id: uuid().primaryKey().defaultRandom(),
  schoolId: uuid().notNull().references(() => schools.id),
  assessmentScoreId: uuid().notNull(),
  url: text().notNull(),
  kind: text().$type<"image" | "audio" | "video" | "document">().notNull(),
  caption: text(),
  uploadedBy: userRef("uploaded_by").references(() => user.id),
  uploadedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
}, t => [
  foreignKey({
    columns: [t.schoolId, t.assessmentScoreId],
    foreignColumns: [assessmentScores.schoolId, assessmentScores.id],
    name: "score_attachments_school_score_fk",
  }),
  index().on(t.schoolId, t.assessmentScoreId),
  // Decides how a screen renders the artefact. An unknown kind is portfolio
  // evidence a teacher uploaded and nothing knows how to show.
  oneOf("score_attachments_kind_known", t.kind, ["image", "audio", "video", "document"]),
]);

// ---------------------------------------------------------------------------
// 5.6 Results and report cards
// ---------------------------------------------------------------------------

export const termResults = pgTable("term_results", {
  id: uuid().primaryKey().defaultRandom(),
  schoolId: uuid().notNull().references(() => schools.id),
  enrollmentId: uuid().notNull(),
  termId: uuid().notNull(),
  learningAreaId: uuid().notNull(),

  /** Exam side: weighted mean of scored assessments, as a percentage. */
  meanScore: numeric({ precision: 5, scale: 2 }),
  /** Derived late and frozen at finalisation — never recomputed. */
  streamPosition: integer(),
  gradePosition: integer(),
  outOf: integer(),

  /**
   * Competency side: the MODE across sub-strands, never the mean.
   *
   * A child who is `exceeding` in one sub-strand and `below_expectation` in
   * another is not `meeting` — that is an average of ordinals wearing a
   * competency judgement's clothes, and it hides exactly what the level system
   * exists to surface. See lib/assessment.ts.
   */
  overallLevel: performanceLevel(),

  /**
   * The reduction rule that produced `overallLevel`.
   *
   * Stored with the result rather than assumed at print time. "Explicit and
   * configurable" (CLAUDE.md §5.6) means a report card can say which policy
   * turned four sub-strand judgements into one — and a school that changed the
   * rule between terms must not have last term's levels relabelled under the
   * new one.
   */
  levelReduction: text()
    .$type<"mode_ties_low" | "mode_ties_high" | "lowest">()
    .notNull()
    .default("mode_ties_low"),

  teacherComment: text(),
  computedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
}, t => [
  unique().on(t.enrollmentId, t.termId, t.learningAreaId),
  unique("term_results_school_id_id_key").on(t.schoolId, t.id),
  foreignKey({
    columns: [t.schoolId, t.enrollmentId],
    foreignColumns: [enrollments.schoolId, enrollments.id],
    name: "term_results_school_enrollment_fk",
  }),
  foreignKey({
    columns: [t.schoolId, t.termId],
    foreignColumns: [terms.schoolId, terms.id],
    name: "term_results_school_term_fk",
  }),
  foreignKey({
    columns: [t.schoolId, t.learningAreaId],
    foreignColumns: [learningAreas.schoolId, learningAreas.id],
    name: "term_results_school_learning_area_fk",
  }),
  index().on(t.schoolId, t.termId),
  /*
   * The rule has to be one this code can actually apply.
   *
   * `.$type<>()` is a TypeScript fiction — it constrains nothing in the
   * database, and `reduceLevels` treats any rule it does not recognise as
   * `mode_ties_low` SILENTLY. So an unrecognised value here would produce
   * levels computed one way and labelled another, then get copied verbatim
   * into a report card snapshot and frozen there. That is the same defect
   * fixed by storing the rule in the first place, arriving by a different
   * door: a backfill, a manual correction, or a fourth rule added to the
   * enum without a migration.
   */
  oneOf("term_results_level_reduction_known", t.levelReduction, [
    "mode_ties_low",
    "mode_ties_high",
    "lowest",
  ]),
]);

/**
 * The printed thing, frozen (CLAUDE.md §3 rule 7).
 *
 * `snapshot` holds the computed content as it stood at finalisation, so
 * regenerating a 2026 report card in 2028 produces the same document — after
 * the fee structure changed, after a mark was corrected, after the class was
 * renamed. Anything read back for printing comes from the snapshot, never from
 * a fresh computation.
 */
export const reportCards = pgTable("report_cards", {
  id: uuid().primaryKey().defaultRandom(),
  schoolId: uuid().notNull().references(() => schools.id),
  enrollmentId: uuid().notNull(),
  termId: uuid().notNull(),

  snapshot: jsonb().notNull(),
  pdfUrl: text(),

  /**
   * Printed on the document so a stranger holding it can check it is real.
   *
   * Set at finalisation, alongside the snapshot it verifies — before that
   * there is nothing frozen to stand behind. See `verificationCode` above.
   */
  verificationCode: verificationCode(),

  classTeacherComment: text(),
  headComment: text(),
  attendancePresent: integer(),
  attendanceTotal: integer(),

  finalisedBy: userRef("finalised_by").references(() => user.id),
  finalisedAt: timestamp({ withTimezone: true }),
  /** Null = not visible to guardians yet. */
  releasedAt: timestamp({ withTimezone: true }),
}, t => [
  unique().on(t.enrollmentId, t.termId),
  unique("report_cards_verification_code_key").on(t.verificationCode),
  unique("report_cards_school_id_id_key").on(t.schoolId, t.id),
  foreignKey({
    columns: [t.schoolId, t.enrollmentId],
    foreignColumns: [enrollments.schoolId, enrollments.id],
    name: "report_cards_school_enrollment_fk",
  }),
  foreignKey({
    columns: [t.schoolId, t.termId],
    foreignColumns: [terms.schoolId, terms.id],
    name: "report_cards_school_term_fk",
  }),
  index().on(t.schoolId, t.termId),
  check("report_cards_attendance_sane", sql`
    (${t.attendancePresent} IS NULL AND ${t.attendanceTotal} IS NULL)
    OR (${t.attendancePresent} >= 0 AND ${t.attendanceTotal} >= ${t.attendancePresent})
  `),
  // Released implies finalised: a guardian must never see a document that was
  // never frozen, because it would change under them.
  check(
    "report_cards_released_after_finalised",
    sql`${t.releasedAt} IS NULL OR ${t.finalisedAt} IS NOT NULL`,
  ),
  // And a code implies something to verify. The code is minted with the
  // snapshot at finalisation; one on an unfrozen row would resolve publicly to
  // a document whose contents could still change — which is the opposite of
  // what it is for.
  check(
    "report_cards_verified_after_finalised",
    sql`${t.verificationCode} IS NULL OR ${t.finalisedAt} IS NOT NULL`,
  ),
]);

/**
 * Every tenant-scoped table, for the migration that puts RLS on them.
 *
 * Kept as a list so adding a table and forgetting to protect it is a visible
 * omission rather than an invisible one — `rls.test.ts` asserts that every
 * table carrying a `school_id` column appears here with a policy.
 */
// ---------------------------------------------------------------------------
// 5.9 Verifiable documents, messaging and the audit trail
// ---------------------------------------------------------------------------

/**
 * Certificates for the two points a CBE learner moves on.
 *
 * Grade 6 to junior school, Grade 9 to senior school — the transitions a
 * Kenyan family actually needs paperwork for, and the years `sequence` already
 * marks as candidate years (KPSEA and KJSEA). Derived from the sequence rather
 * than stored as a flag, exactly as §5.2 requires.
 *
 * A frozen snapshot, like a report card and for the same reason: a certificate
 * reprinted in 2030 for a child applying somewhere has to say what it said
 * when it was issued, whatever happened to the marks behind it since.
 */
export const transitionCertificates = pgTable("transition_certificates", {
  id: uuid().primaryKey().defaultRandom(),
  schoolId: uuid().notNull().references(() => schools.id),
  enrollmentId: uuid().notNull(),
  termId: uuid().notNull(),

  /** Which milestone. Derived from the grade's sequence at issue time. */
  milestone: text().$type<"grade_6" | "grade_9">().notNull(),

  snapshot: jsonb().notNull(),
  verificationCode: verificationCode().notNull(),

  issuedBy: userRef("issued_by").references(() => user.id),
  issuedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
}, t => [
  // One per child per milestone. A reissue is a reprint of the same frozen
  // document, never a second one saying something different.
  unique().on(t.enrollmentId, t.milestone),
  unique("transition_certificates_verification_code_key").on(t.verificationCode),
  unique("transition_certificates_school_id_id_key").on(t.schoolId, t.id),
  foreignKey({
    columns: [t.schoolId, t.enrollmentId],
    foreignColumns: [enrollments.schoolId, enrollments.id],
    name: "transition_certificates_school_enrollment_fk",
  }),
  foreignKey({
    columns: [t.schoolId, t.termId],
    foreignColumns: [terms.schoolId, terms.id],
    name: "transition_certificates_school_term_fk",
  }),
  index().on(t.schoolId, t.termId),
  oneOf("transition_certificates_milestone_known", t.milestone, ["grade_6", "grade_9"]),
]);

/**
 * Every SMS the school has sent, and what it cost.
 *
 * CLAUDE.md §6 asks for this before v1 because Africa's Talking charges per
 * unit and reports delivery asynchronously, so a school WILL ask what they are
 * spending and whether a message actually arrived. Without a row per message
 * neither question has an answer, and "did the parent get the fee reminder"
 * becomes an argument rather than a lookup.
 */
export const smsMessages = pgTable("sms_messages", {
  id: uuid().primaryKey().defaultRandom(),
  schoolId: uuid().notNull().references(() => schools.id),

  /** Who it concerns. Both nullable: a message may be about neither. */
  guardianId: uuid(),
  studentId: uuid(),

  /** E.164, normalised on write (rule 10) — this is what the provider dials. */
  toPhone: text().notNull(),
  body: text().notNull(),

  /** Groups one broadcast, so a school can see and cost a send as one act. */
  batchId: uuid(),
  kind: text().$type<"results" | "fees" | "announcement">().notNull(),

  /** The provider's id, which is how an async delivery report finds this row. */
  providerMessageId: text(),
  status: text()
    .$type<"queued" | "sent" | "delivered" | "failed" | "rejected">()
    .notNull()
    .default("queued"),
  statusReason: text(),

  /*
   * Cost in cents, and the whole-shilling CHECK deliberately does NOT apply.
   *
   * Rule 3 says money is integer cents, and it is — but an SMS costs a
   * fraction of a shilling (Africa's Talking quotes "KES 0.8000"), so this is
   * one of the few amounts in the system that is genuinely sub-shilling.
   * Applying `wholeShillings` here would reject every real price.
   */
  costCents: integer(),
  /** Long messages bill as several units; a school is charged per unit. */
  segments: integer(),

  requestedBy: userRef("requested_by").references(() => user.id),
  queuedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  sentAt: timestamp({ withTimezone: true }),
}, t => [
  unique("sms_messages_school_id_id_key").on(t.schoolId, t.id),
  foreignKey({
    columns: [t.schoolId, t.guardianId],
    foreignColumns: [guardians.schoolId, guardians.id],
    name: "sms_messages_school_guardian_fk",
  }),
  foreignKey({
    columns: [t.schoolId, t.studentId],
    foreignColumns: [students.schoolId, students.id],
    name: "sms_messages_school_student_fk",
  }),
  index().on(t.schoolId, t.queuedAt),
  index().on(t.schoolId, t.batchId),
  // The provider's id is how a delivery report finds the row it belongs to.
  index().on(t.providerMessageId),
  oneOf("sms_messages_status_known", t.status, [
    "queued",
    "sent",
    "delivered",
    "failed",
    "rejected",
  ]),
  oneOf("sms_messages_kind_known", t.kind, ["results", "fees", "announcement"]),
  check("sms_messages_cost_not_negative", sql`${t.costCents} IS NULL OR ${t.costCents} >= 0`),
]);

/**
 * Who changed a mark, who reversed a payment, who released a report card.
 *
 * CLAUDE.md §6 asks for this and names those three events. It is both a
 * safeguard and a sales point: a product holding children's records and school
 * money should be able to answer "who did this" without a database dump, and a
 * head asked that question by a parent or a board needs the answer in a
 * screen.
 *
 * Append-only at the database level, not by convention — the runtime role gets
 * INSERT and SELECT and nothing else. A log the application can rewrite is
 * evidence of nothing, and the whole value here is that it cannot be tidied
 * after the fact by whoever wishes it were different.
 */
export const auditLog = pgTable("audit_log", {
  id: uuid().primaryKey().defaultRandom(),
  schoolId: uuid().notNull().references(() => schools.id),

  /** Null for something the system did without a person asking. */
  actorId: userRef("actor_id").references(() => user.id),

  /*
   * Written out rather than pointing at a named type.
   *
   * `db/enum-checks.test.ts` reads this file's syntax tree and can only see an
   * inline union — a `$type<AuditAction>()` alias would slip past the guard
   * that makes sure the database says the same thing the type does. The list
   * below and the one in `oneOf` are cross-checked by that test, so the
   * duplication is what keeps them honest rather than an oversight.
   */
  action: text().$type<
    | "assessment.published"
    | "assessment.unpublished"
    | "certificate.issued"
    | "guardian.linked"
    | "invoice.voided"
    | "marks.saved"
    | "membership.granted"
    | "membership.revoked"
    | "mpesa.allocated"
    | "mpesa.rejected"
    | "payment.recorded"
    | "payment.reversed"
    | "report_card.finalised"
    | "report_card.released"
    | "sms.queued"
  >().notNull(),

  /** What it happened to. Not a foreign key: the log outlives what it names. */
  entityType: text().notNull(),
  entityId: uuid(),

  /** One line a human can read without joining anything. */
  summary: text().notNull(),
  /** Whatever the action needs recorded — an old mark, a reversal reason. */
  detail: jsonb(),

  at: timestamp({ withTimezone: true }).defaultNow().notNull(),
}, t => [
  index().on(t.schoolId, t.at),
  index().on(t.schoolId, t.entityType, t.entityId),
  oneOf("audit_log_action_known", t.action, [
    "assessment.published",
    "assessment.unpublished",
    "certificate.issued",
    "guardian.linked",
    "invoice.voided",
    "marks.saved",
    "membership.granted",
    "membership.revoked",
    "mpesa.allocated",
    "mpesa.rejected",
    "payment.recorded",
    "payment.reversed",
    "report_card.finalised",
    "report_card.released",
    "sms.queued",
  ]),
]);

/** What an audit entry may record — taken from the column, never restated. */
export type AuditAction = NonNullable<(typeof auditLog.$inferInsert)["action"]>;

export const TENANT_TABLES = [
  "memberships",
  "academic_years",
  "terms",
  "grade_levels",
  "streams",
  "students",
  "guardians",
  "student_guardians",
  "enrollments",
  "fee_structures",
  "fee_items",
  "invoices",
  "invoice_lines",
  "payments",
  "mpesa_transactions",
  "learning_areas",
  "competencies",
  "assessments",
  "assessment_scores",
  "score_attachments",
  "term_results",
  "report_cards",
  "transition_certificates",
  "sms_messages",
  "audit_log",
] as const;

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

// ALL relations for `user` live here, including the auth-side ones (sessions,
// accounts) that the Better Auth CLI would otherwise emit into auth-schema.ts.
// Drizzle allows only one `relations()` config per table, and db/index.ts
// spreads both modules into a single schema object — so a second definition
// over there would silently clobber this one rather than erroring.
export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
  accounts: many(account),
  memberships: many(memberships),
}));

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, { fields: [session.userId], references: [user.id] }),
}));

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, { fields: [account.userId], references: [user.id] }),
}));

export const schoolsRelations = relations(schools, ({ many }) => ({
  memberships: many(memberships),
  academicYears: many(academicYears),
  gradeLevels: many(gradeLevels),
}));

export const membershipsRelations = relations(memberships, ({ one }) => ({
  user: one(user, { fields: [memberships.userId], references: [user.id] }),
  school: one(schools, { fields: [memberships.schoolId], references: [schools.id] }),
}));

export const academicYearsRelations = relations(academicYears, ({ one, many }) => ({
  school: one(schools, { fields: [academicYears.schoolId], references: [schools.id] }),
  terms: many(terms),
  streams: many(streams),
}));

export const termsRelations = relations(terms, ({ one }) => ({
  school: one(schools, { fields: [terms.schoolId], references: [schools.id] }),
  academicYear: one(academicYears, {
    fields: [terms.academicYearId],
    references: [academicYears.id],
  }),
}));

export const gradeLevelsRelations = relations(gradeLevels, ({ one, many }) => ({
  school: one(schools, { fields: [gradeLevels.schoolId], references: [schools.id] }),
  streams: many(streams),
}));

export const studentsRelations = relations(students, ({ one, many }) => ({
  school: one(schools, { fields: [students.schoolId], references: [schools.id] }),
  enrollments: many(enrollments),
  guardians: many(studentGuardians),
}));

export const guardiansRelations = relations(guardians, ({ one, many }) => ({
  school: one(schools, { fields: [guardians.schoolId], references: [schools.id] }),
  user: one(user, { fields: [guardians.userId], references: [user.id] }),
  students: many(studentGuardians),
}));

export const studentGuardiansRelations = relations(studentGuardians, ({ one }) => ({
  student: one(students, {
    fields: [studentGuardians.studentId],
    references: [students.id],
  }),
  guardian: one(guardians, {
    fields: [studentGuardians.guardianId],
    references: [guardians.id],
  }),
}));

export const feeStructuresRelations = relations(feeStructures, ({ one, many }) => ({
  school: one(schools, { fields: [feeStructures.schoolId], references: [schools.id] }),
  term: one(terms, { fields: [feeStructures.termId], references: [terms.id] }),
  gradeLevel: one(gradeLevels, {
    fields: [feeStructures.gradeLevelId],
    references: [gradeLevels.id],
  }),
  items: many(feeItems),
}));

export const feeItemsRelations = relations(feeItems, ({ one }) => ({
  structure: one(feeStructures, {
    fields: [feeItems.feeStructureId],
    references: [feeStructures.id],
  }),
}));

export const invoicesRelations = relations(invoices, ({ one, many }) => ({
  school: one(schools, { fields: [invoices.schoolId], references: [schools.id] }),
  student: one(students, { fields: [invoices.studentId], references: [students.id] }),
  term: one(terms, { fields: [invoices.termId], references: [terms.id] }),
  lines: many(invoiceLines),
  payments: many(payments),
}));

export const invoiceLinesRelations = relations(invoiceLines, ({ one }) => ({
  invoice: one(invoices, {
    fields: [invoiceLines.invoiceId],
    references: [invoices.id],
  }),
}));

export const paymentsRelations = relations(payments, ({ one }) => ({
  school: one(schools, { fields: [payments.schoolId], references: [schools.id] }),
  student: one(students, { fields: [payments.studentId], references: [students.id] }),
  invoice: one(invoices, { fields: [payments.invoiceId], references: [invoices.id] }),
  recordedByUser: one(user, { fields: [payments.recordedBy], references: [user.id] }),
  mpesaTransaction: one(mpesaTransactions, {
    fields: [payments.mpesaTransactionId],
    references: [mpesaTransactions.id],
  }),
}));

export const learningAreasRelations = relations(learningAreas, ({ one, many }) => ({
  school: one(schools, { fields: [learningAreas.schoolId], references: [schools.id] }),
  gradeLevel: one(gradeLevels, {
    fields: [learningAreas.gradeLevelId],
    references: [gradeLevels.id],
  }),
  competencies: many(competencies),
  assessments: many(assessments),
}));

export const competenciesRelations = relations(competencies, ({ one, many }) => ({
  learningArea: one(learningAreas, {
    fields: [competencies.learningAreaId],
    references: [learningAreas.id],
  }),
  parent: one(competencies, {
    fields: [competencies.parentId],
    references: [competencies.id],
    relationName: "competency_tree",
  }),
  children: many(competencies, { relationName: "competency_tree" }),
}));

export const assessmentsRelations = relations(assessments, ({ one, many }) => ({
  school: one(schools, { fields: [assessments.schoolId], references: [schools.id] }),
  term: one(terms, { fields: [assessments.termId], references: [terms.id] }),
  learningArea: one(learningAreas, {
    fields: [assessments.learningAreaId],
    references: [learningAreas.id],
  }),
  stream: one(streams, { fields: [assessments.streamId], references: [streams.id] }),
  scores: many(assessmentScores),
}));

export const assessmentScoresRelations = relations(assessmentScores, ({ one, many }) => ({
  assessment: one(assessments, {
    fields: [assessmentScores.assessmentId],
    references: [assessments.id],
  }),
  enrollment: one(enrollments, {
    fields: [assessmentScores.enrollmentId],
    references: [enrollments.id],
  }),
  competency: one(competencies, {
    fields: [assessmentScores.competencyId],
    references: [competencies.id],
  }),
  attachments: many(scoreAttachments),
}));

export const scoreAttachmentsRelations = relations(scoreAttachments, ({ one }) => ({
  score: one(assessmentScores, {
    fields: [scoreAttachments.assessmentScoreId],
    references: [assessmentScores.id],
  }),
}));

export const termResultsRelations = relations(termResults, ({ one }) => ({
  school: one(schools, { fields: [termResults.schoolId], references: [schools.id] }),
  enrollment: one(enrollments, {
    fields: [termResults.enrollmentId],
    references: [enrollments.id],
  }),
  term: one(terms, { fields: [termResults.termId], references: [terms.id] }),
  learningArea: one(learningAreas, {
    fields: [termResults.learningAreaId],
    references: [learningAreas.id],
  }),
}));

export const reportCardsRelations = relations(reportCards, ({ one }) => ({
  school: one(schools, { fields: [reportCards.schoolId], references: [schools.id] }),
  enrollment: one(enrollments, {
    fields: [reportCards.enrollmentId],
    references: [enrollments.id],
  }),
  term: one(terms, { fields: [reportCards.termId], references: [terms.id] }),
}));

export const mpesaTransactionsRelations = relations(mpesaTransactions, ({ one }) => ({
  school: one(schools, {
    fields: [mpesaTransactions.schoolId],
    references: [schools.id],
  }),
}));

export const enrollmentsRelations = relations(enrollments, ({ one }) => ({
  school: one(schools, { fields: [enrollments.schoolId], references: [schools.id] }),
  student: one(students, {
    fields: [enrollments.studentId],
    references: [students.id],
  }),
  stream: one(streams, {
    fields: [enrollments.streamId],
    references: [streams.id],
  }),
}));

export const streamsRelations = relations(streams, ({ one, many }) => ({
  enrollments: many(enrollments),
  school: one(schools, { fields: [streams.schoolId], references: [schools.id] }),
  gradeLevel: one(gradeLevels, {
    fields: [streams.gradeLevelId],
    references: [gradeLevels.id],
  }),
  academicYear: one(academicYears, {
    fields: [streams.academicYearId],
    references: [academicYears.id],
  }),
  classTeacher: one(user, {
    fields: [streams.classTeacherId],
    references: [user.id],
  }),
}));
