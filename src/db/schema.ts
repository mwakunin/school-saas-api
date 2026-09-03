import { relations, sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
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
  // collects on its own paybill (CLAUDE.md §5.8). Credentials are encrypted
  // at rest — the encryption lands with the C2B work in step 5.
  mpesaShortcode: text(),
  mpesaCredentials: text(),

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
});

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

/**
 * Every tenant-scoped table, for the migration that puts RLS on them.
 *
 * Kept as a list so adding a table and forgetting to protect it is a visible
 * omission rather than an invisible one — `rls.test.ts` asserts that every
 * table carrying a `school_id` column appears here with a policy.
 */
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
