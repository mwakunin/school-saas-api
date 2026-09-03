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

export const streamsRelations = relations(streams, ({ one }) => ({
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
