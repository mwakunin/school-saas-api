# CLAUDE.md

Project context for AI assistants working in this repository. Read this before writing code.

---

## 1. What this is

A multi-tenant school management SaaS for Kenyan schools covering **Grade 1 to Grade 9** (primary + junior school), running the **Competency-Based Education (CBE)** curriculum.

Sold to many schools. Each school is a tenant.

**In scope for v1:**

- Student records and enrollment
- Guardians and parent portal
- CBE assessment (competencies + percentage exams) and report cards
- Fees, invoicing, and M-Pesa payment reconciliation

**Explicitly out of scope for v1** — do not build these unless asked:

- 8-4-4 / KCSE / mean grades / subject clusters (curriculum ends 2027; irrelevant to Grade 1–9)
- Senior school (Grade 10–12) pathways and subject selection
- Pre-primary (PP1/PP2)
- Timetabling, transport, library, payroll, inventory
- Direct KNEC/NEMIS API integration (record results manually; no integration)

---

## 2. Stack

| Layer | Choice |
|---|---|
| Backend | Hono + `@hono/zod-openapi` |
| ORM | Drizzle (postgres) |
| Database | Neon (serverless Postgres) |
| Frontend | Next.js |
| Auth | Better Auth |
| Email | Resend |
| SMS | Africa's Talking |
| Rate limiting | `rate-limiter-flexible` backed by Redis |
| Images / files | ImageKit |
| Payments | Safaricom Daraja (M-Pesa C2B), per-tenant shortcode |
| Local dev | Docker Postgres (separate dev and test databases) + Redis |
| Runtime | Node 26, pnpm |

Tenant routing is **subdomain-based**: `stmarys.example.co.ke`. Requires wildcard DNS + wildcard TLS.

---

## 3. Non-negotiable conventions

These are load-bearing. Do not deviate without discussion.

1. **`schoolId` on every domain table.** Even where it is derivable through a foreign key. The RLS policies and the uniform tenant guard depend on it.
2. **Never query the raw `db` export from a route handler.** Use `c.get('db')` (§4). One forgotten `where` clause in a product holding children's records is a business-ending bug. Enforced by `db/db-access.test.ts`, which fails the build on a stray import.
3. **Money is integer cents.** Never floats, never `numeric` for money. Field names end in `Cents`.
4. **Balances are derived**, never stored. `sum(invoices) - sum(payments)`. Materialize later only if measured to be slow.
5. **Nothing hard-deletes.** Students, invoices, payments, and scores are only ever status-transitioned. Withdrawn students must remain fully queryable. The runtime role holds no `DELETE` privilege on domain tables, so this is a database guarantee rather than a habit.
6. **Scores hang off `enrollmentId`, never `studentId`.** A mark is "this child, in this stream, in this year".
7. **Snapshot anything printed.** Report cards and invoices freeze their content at finalisation. Regenerating a 2026 report card in 2028 must not produce different output.
8. **Say CBE, not CBC**, in table names, code, and all UI copy. The rename came out of the Presidential Working Party on Education Reform.
9. **Dates are `date`; instants are `timestamp`.** Term boundaries are dates. Payment receipt is a timestamp.
10. **Phone numbers stored E.164** (`+2547...`). Normalise on write.
11. **A `.$type<"a" | "b">()` column carries a matching `CHECK`.** The type constrains this codebase and nothing else — the column is `text`, and a seed, a backfill or a hand-run correction can put anything in it. The resulting failure is silent rather than loud: an unrecognised value is not a crash, it is a row that stops matching filters, so a pupil whose status is neither `active` nor `withdrawn` is missing from the register and the leavers' list at once. Declare it with `oneOf(...)` in the table's extras; `db/enum-checks.test.ts` fails the build on a column that has the union and not the constraint, on a constraint whose values have drifted from it, and on one declared in `schema.ts` that no migration ever applied.

---

## 4. Multi-tenancy

Shared schema, shared database, `school_id` discriminator. Not schema-per-tenant — migrations across dozens of tenants are not worth it at this scale.

**Isolation lives in Postgres, not in application discipline.** An earlier draft of this document put a hand-written `forSchool()` namespace-per-aggregate here and deferred RLS to "later, as defence in depth". That is inverted: a scoped client is a convention, and the failure mode of a convention is one forgotten `where` clause — silent, invisible in review, and indistinguishable from correct code until a parent at one school sees another school's pupils.

Four layers, strongest first.

**1. Two database connections.** `db` connects as the table owner; `appDb` connects as `school_app`, an unprivileged role (`db/roles.sql`). Postgres exempts a table's owner from RLS and a superuser from it outright, so the app must not connect as either — otherwise the policies exist, appear in `pg_policies`, and do nothing. The owner connection is confined to migrations, the test harness, the subdomain→school bootstrap, and the superadmin plane; `db/db-access.test.ts` enforces that allowlist.

**2. A transaction per tenant request.** `withTenant` resolves the subdomain, opens a transaction on `appDb`, and sets `app.school_id` with `set_config(..., true)` — transaction-scoped, so it cannot outlive the request and leak onto the next borrower of a pooled connection. Handlers use `c.get('db')`, which is that transaction. Requests are therefore atomic: an error status rolls the whole thing back.

**3. Policies on every tenant table**, `USING` and `WITH CHECK` both, so a write attributed to another school is refused as firmly as a read. `ENABLE` plus `FORCE ROW LEVEL SECURITY`. With no tenant set, every query returns zero rows — never everything.

**4. Composite foreign keys.** RLS does **not** constrain foreign keys: Postgres validates a reference internally, bypassing policies. So child rows reference `(school_id, id)`, not `(id)`, which makes a cross-tenant pointer fail the constraint. Without this a stream at one school could legally reference another school's grade level, and every policy would allow it. Any new tenant table referencing another must do the same; `rls.test.ts` fails the build otherwise.

Roles come from `memberships` via `withMembership`, and `requireMembershipRole(...)` guards routes. The global `user.role` is **only** `'user' | 'superadmin'` — it cannot express "bursar at St Mary's".

**Superadmin plane** is a separate app/route namespace, not a role inside a tenant. It onboards schools (seeding Grade 1–9, the academic year and its three terms), and suspends non-payers. It is the one plane that legitimately works across tenants, so it keeps the owner connection. Build it early and ugly — the alternative is onboarding schools with SQL scripts.

---

## 5. Schema

### 5.1 Tenancy and identity

```ts
export const schools = pgTable('schools', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  subdomain: text('subdomain').notNull().unique(),

  county: text('county'),
  postalAddress: text('postal_address'),
  phone: text('phone'),
  email: text('email'),
  logoUrl: text('logo_url'),

  // per-tenant M-Pesa. money NEVER routes through our account.
  mpesaShortcode: text('mpesa_shortcode'),
  mpesaCredentials: text('mpesa_credentials'),      // encrypted at rest

  // percentage -> performance level cut points; schools differ
  levelThresholds: jsonb('level_thresholds')
    .$type<{ approaching: number; meeting: number; exceeding: number }>()
    .default({ approaching: 40, meeting: 60, exceeding: 80 })
    .notNull(),

  showsPositions: boolean('shows_positions').default(true).notNull(),

  status: text('status')
    .$type<'trial' | 'active' | 'suspended' | 'demo'>()
    .notNull(),

  createdAt: timestamp('created_at').defaultNow().notNull(),
});
```

`user` is Better Auth's table — **global**, not tenant-scoped, and singular. A person may work at two schools, or be both a teacher and a parent at one.

**Its `id` is `text`, not `uuid`.** Better Auth generates its own string ids, so every foreign key into it is `text(...)`. Domain-to-domain keys stay `uuid`. An earlier draft of this document had `uuid` throughout; the constraint simply fails to create.

```ts
export const memberships = pgTable('memberships', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: text('user_id').notNull().references(() => user.id),
  schoolId: uuid('school_id').notNull().references(() => schools.id),
  role: text('role')
    .$type<'admin' | 'bursar' | 'teacher' | 'guardian'>()
    .notNull(),
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => [unique().on(t.userId, t.schoolId, t.role)]);
```

Role lives on the membership, not the user — so one login covers a teacher who is also a parent at the same school.

### 5.2 Academic spine

```ts
export const academicYears = pgTable('academic_years', {
  id: uuid('id').primaryKey().defaultRandom(),
  schoolId: uuid('school_id').notNull().references(() => schools.id),
  year: integer('year').notNull(),                  // 2026
  isCurrent: boolean('is_current').default(false).notNull(),
}, (t) => [unique().on(t.schoolId, t.year)]);

export const terms = pgTable('terms', {
  id: uuid('id').primaryKey().defaultRandom(),
  schoolId: uuid('school_id').notNull(),
  academicYearId: uuid('academic_year_id')
    .notNull().references(() => academicYears.id),
  number: integer('number').notNull(),              // 1 | 2 | 3
  startsOn: date('starts_on').notNull(),
  endsOn: date('ends_on').notNull(),
  isCurrent: boolean('is_current').default(false).notNull(),
}, (t) => [unique().on(t.academicYearId, t.number)]);

// stable definition: "Grade 4". persists across years.
export const gradeLevels = pgTable('grade_levels', {
  id: uuid('id').primaryKey().defaultRandom(),
  schoolId: uuid('school_id').notNull(),
  name: text('name').notNull(),                     // 'Grade 1' ... 'Grade 9'
  sequence: integer('sequence').notNull(),          // 1..9, drives progression
  phase: text('phase').$type<'primary' | 'junior'>().notNull(),
}, (t) => [unique().on(t.schoolId, t.sequence)]);

// yearly instance: "Grade 4 Blue, 2026". holds actual children.
export const streams = pgTable('streams', {
  id: uuid('id').primaryKey().defaultRandom(),
  schoolId: uuid('school_id').notNull(),
  gradeLevelId: uuid('grade_level_id').notNull().references(() => gradeLevels.id),
  academicYearId: uuid('academic_year_id').notNull().references(() => academicYears.id),
  name: text('name').notNull(),                     // 'Blue', 'East', 'A'
  classTeacherId: text('class_teacher_id').references(() => user.id),
}, (t) => [unique().on(t.gradeLevelId, t.academicYearId, t.name)]);
```

`phase` distinguishes primary (Grade 1–6) from junior school (Grade 7–9). Junior school has additional learning areas. Filter on `phase`, never on hardcoded grade numbers.

Grade 6 and Grade 9 are candidate years (KPSEA and KJSEA respectively) — derive this from `sequence`, do not store a flag.

### 5.3 Students, guardians, enrollment

```ts
export const students = pgTable('students', {
  id: uuid('id').primaryKey().defaultRandom(),
  schoolId: uuid('school_id').notNull().references(() => schools.id),

  // school-scoped, human-facing, doubles as M-Pesa account reference
  admissionNumber: text('admission_number').notNull(),

  // ministry-issued; follows the child between schools
  upiNumber: text('upi_number'),
  birthCertNumber: text('birth_cert_number'),

  givenName: text('given_name').notNull(),
  middleNames: text('middle_names'),
  familyName: text('family_name').notNull(),
  preferredName: text('preferred_name'),

  dateOfBirth: date('date_of_birth'),
  sex: text('sex').$type<'male' | 'female'>(),
  photoUrl: text('photo_url'),

  // optional portal login; most Grade 1-9 pupils will never have one
  userId: text('user_id').references(() => user.id),

  status: text('status')
    .$type<'active' | 'transferred_out' | 'graduated' | 'withdrawn' | 'deceased'>()
    .notNull(),

  admittedOn: date('admitted_on').notNull(),
  exitedOn: date('exited_on'),
  previousSchool: text('previous_school'),
}, (t) => [
  unique().on(t.schoolId, t.admissionNumber),
  unique().on(t.schoolId, t.upiNumber),      // per school, NOT globally
  index().on(t.schoolId, t.familyName),
]);
```

Notes:

- **A student is not a user.** `userId` is nullable and usually null.
- **UPI is unique per school, not globally.** A globally unique UPI would need one row readable by two tenants, which puts a hole in the isolation model. Transfers create a fresh row at the receiving school.
- **Name parts, not `firstName`/`lastName`.** Kenyan names do not split reliably into a fixed given/surname order.
- Index on `familyName` — "find all the Wanjikus" is a query bursars run constantly.

```ts
export const enrollments = pgTable('enrollments', {
  id: uuid('id').primaryKey().defaultRandom(),
  schoolId: uuid('school_id').notNull(),
  studentId: uuid('student_id').notNull().references(() => students.id),
  streamId: uuid('stream_id').notNull().references(() => streams.id),
  boardingStatus: text('boarding_status').$type<'day' | 'boarder'>().notNull(),
  startedOn: date('started_on').notNull(),
  endedOn: date('ended_on'),                        // null = current
}, (t) => [index().on(t.schoolId, t.streamId)]);
```

**There is deliberately no `streamId` on `students`.** "Which class is this child in" is the open enrollment row. This is what keeps last year's marks and invoices pointing at the correct class after progression or a stream switch.

An `EXCLUDE` constraint forbids overlapping enrollments per student, so a child can never be in two classes on one day. Scores hang off `enrollmentId`, so an overlap would make a mark's class genuinely ambiguous — and unrecoverable by inspection.

```ts
export const guardians = pgTable('guardians', {
  id: uuid('id').primaryKey().defaultRandom(),
  schoolId: uuid('school_id').notNull(),
  userId: text('user_id').references(() => user.id),  // null until they sign up
  name: text('name').notNull(),
  phone: text('phone').notNull(),                      // E.164; the SMS target
  altPhone: text('alt_phone'),
  email: text('email'),
  nationalId: text('national_id'),
  occupation: text('occupation'),
}, (t) => [index().on(t.schoolId, t.phone)]);

export const studentGuardians = pgTable('student_guardians', {
  schoolId: uuid('school_id').notNull(),
  studentId: uuid('student_id').notNull().references(() => students.id),
  guardianId: uuid('guardian_id').notNull().references(() => guardians.id),
  relationship: text('relationship'),                  // 'mother', 'uncle', ...
  isPrimary: boolean('is_primary').default(false).notNull(),
  receivesInvoices: boolean('receives_invoices').default(true).notNull(),
  canCollect: boolean('can_collect').default(true).notNull(),
}, (t) => [primaryKey({ columns: [t.studentId, t.guardianId] })]);
```

Guardians are a table, not columns on the student, because siblings share a parent. Without this you send the same fee reminder three times and store the phone number three ways.

`student_guardians` is the **one** table the runtime role may `DELETE` from. Rule 5 exists so history stays queryable; a guardian link is not history, it is a live claim about who may collect a child. A wrong one has to disappear from every query, including one that forgot a soft-delete filter.

### 5.4 Curriculum

```ts
export const learningAreas = pgTable('learning_areas', {
  id: uuid('id').primaryKey().defaultRandom(),
  schoolId: uuid('school_id').notNull(),
  gradeLevelId: uuid('grade_level_id').references(() => gradeLevels.id),
  name: text('name').notNull(),            // 'Mathematics', 'Integrated Science'
  code: text('code'),
  isCore: boolean('is_core').default(true).notNull(),
  sequence: integer('sequence').notNull(), // report card ordering
});

// strand -> sub-strand. self-referencing so depth stays flexible.
export const competencies = pgTable('competencies', {
  id: uuid('id').primaryKey().defaultRandom(),
  schoolId: uuid('school_id').notNull(),
  learningAreaId: uuid('learning_area_id')
    .notNull().references(() => learningAreas.id),
  parentId: uuid('parent_id').references((): AnyPgColumn => competencies.id),
  code: text('code'),                      // '1.2', '1.2.3'
  title: text('title').notNull(),
  sequence: integer('sequence').notNull(),
});
```

**Seed KICD curriculum designs as reference data** that tenants copy on onboarding. A school that opens the app and finds Grade 4 Mathematics already broken into its strands believes you know their world. A school that finds empty forms closes the tab.

### 5.5 Assessment

```ts
export const performanceLevel = pgEnum('performance_level', [
  'below_expectation',   // 1
  'approaching',         // 2
  'meeting',             // 3
  'exceeding',           // 4
]);

export const assessments = pgTable('assessments', {
  id: uuid('id').primaryKey().defaultRandom(),
  schoolId: uuid('school_id').notNull(),
  termId: uuid('term_id').notNull().references(() => terms.id),
  learningAreaId: uuid('learning_area_id').notNull().references(() => learningAreas.id),
  streamId: uuid('stream_id').references(() => streams.id),   // null = whole grade

  title: text('title').notNull(),          // 'Opener Exam', 'Project 2'
  kind: text('kind').$type<
    'exam' | 'cat' | 'project' | 'practical' | 'observation' | 'national'
  >().notNull(),

  maxScore: integer('max_score'),          // null for pure observation
  weight: numeric('weight', { precision: 5, scale: 2 }),

  administeredOn: date('administered_on'),
  createdBy: text('created_by').references(() => user.id),
  publishedAt: timestamp('published_at'),  // null = teachers still entering
});

export const assessmentScores = pgTable('assessment_scores', {
  id: uuid('id').primaryKey().defaultRandom(),
  schoolId: uuid('school_id').notNull(),
  assessmentId: uuid('assessment_id').notNull().references(() => assessments.id),
  enrollmentId: uuid('enrollment_id').notNull().references(() => enrollments.id),
  competencyId: uuid('competency_id').references(() => competencies.id),

  rawScore: numeric('raw_score', { precision: 6, scale: 2 }),
  level: performanceLevel('level'),
  isAbsent: boolean('is_absent').default(false).notNull(),
  comment: text('comment'),

  enteredBy: text('entered_by').references(() => user.id),
  enteredAt: timestamp('entered_at').defaultNow().notNull(),
}, (t) => [unique().on(t.assessmentId, t.enrollmentId, t.competencyId)]);
```

**`competencyId` nullable is what lets both grading systems coexist in one table.** Null = one overall result for the assessment (the percentage exam path). Populated = one row per sub-strand (the competency path). CBE schools run both: national assessment is competency-based, but internal opener/midterm/end-term exams are still marked out of 100, and parents still expect a mark and a position. A system that refuses to store a percentage gets rejected.

`publishedAt` gates parent visibility. Teachers enter marks over days and correct mistakes; parents must not see a half-entered exam.

```ts
// CBE assessment is partly observational. teachers keep artefacts.
export const scoreAttachments = pgTable('score_attachments', {
  id: uuid('id').primaryKey().defaultRandom(),
  schoolId: uuid('school_id').notNull(),
  assessmentScoreId: uuid('assessment_score_id')
    .notNull().references(() => assessmentScores.id),
  url: text('url').notNull(),              // ImageKit
  kind: text('kind').$type<'image' | 'audio' | 'video' | 'document'>().notNull(),
  caption: text('caption'),
  uploadedBy: text('uploaded_by').references(() => user.id),
  uploadedAt: timestamp('uploaded_at').defaultNow().notNull(),
});
```

Portfolio evidence is a genuine selling point — teachers currently keep this on their phones and lose it.

### 5.6 Results and report cards

```ts
export const termResults = pgTable('term_results', {
  id: uuid('id').primaryKey().defaultRandom(),
  schoolId: uuid('school_id').notNull(),
  enrollmentId: uuid('enrollment_id').notNull().references(() => enrollments.id),
  termId: uuid('term_id').notNull().references(() => terms.id),
  learningAreaId: uuid('learning_area_id').notNull(),

  // exam side: weighted mean of scored assessments
  meanScore: numeric('mean_score', { precision: 5, scale: 2 }),
  streamPosition: integer('stream_position'),
  gradePosition: integer('grade_position'),
  outOf: integer('out_of'),

  // competency side: modal level across sub-strands
  overallLevel: performanceLevel('overall_level'),

  teacherComment: text('teacher_comment'),
  computedAt: timestamp('computed_at').defaultNow().notNull(),
}, (t) => [unique().on(t.enrollmentId, t.termId, t.learningAreaId)]);

export const reportCards = pgTable('report_cards', {
  id: uuid('id').primaryKey().defaultRandom(),
  schoolId: uuid('school_id').notNull(),
  enrollmentId: uuid('enrollment_id').notNull(),
  termId: uuid('term_id').notNull(),

  snapshot: jsonb('snapshot').notNull(),   // frozen computed content
  pdfUrl: text('pdf_url'),

  classTeacherComment: text('class_teacher_comment'),
  headComment: text('head_comment'),
  attendancePresent: integer('attendance_present'),
  attendanceTotal: integer('attendance_total'),

  finalisedBy: text('finalised_by').references(() => user.id),
  finalisedAt: timestamp('finalised_at'),
  releasedAt: timestamp('released_at'),    // null = not visible to guardians
}, (t) => [unique().on(t.enrollmentId, t.termId)]);
```

**Do not average performance levels.** A student who is `exceeding` in one sub-strand and `below_expectation` in another is not `meeting` — that is a mean of ordinals masquerading as a competency judgement, and it hides exactly what the level system exists to surface. Take the mode. Show the per-sub-strand breakdown underneath. Any reduction rule must be explicit and configurable, never silently arithmetic.

`lib/assessment.ts` implements this. Three rules are offered — `mode_ties_low` (the default), `mode_ties_high`, `lowest` — and there is deliberately no `mean`. Ties resolve **down**: overstating is the direction that costs a family a conversation they should have had earlier. The rule is stored on each `term_results` row and copied into the snapshot from there, so a printed document says which policy actually produced its levels — and a school that changes the rule between terms does not have last term's levels relabelled under the new one.

`term_results` is the one table in this group the runtime role may `DELETE` from. It is a computation over `assessment_scores`, reconstructible at any time — and recomputing has to be able to remove a result nothing published stands behind any more, because stale reads as fact while absent reads as "not marked yet". Scores, report cards and everything rule 5 names keep no `DELETE`.

**Term results cover everyone enrolled *during* the term**, not everyone enrolled now — a child who transferred out mid-term was taught, sat what they sat, and needs a report for it.

**An absence is not a zero.** A CHECK forbids a mark or a level on an absent row, and the term mean skips them — counting a missed paper as zero drags a child's mean down for something they never sat, and afterwards the two are indistinguishable.

**Position is derived and derived late.** Class rank is the most contested number on a Kenyan report card. Compute at finalisation, store in the snapshot, never recompute. Gate on `schools.showsPositions` — some schools have moved away from publishing positions under CBE, and where they have, the rank is **absent from the snapshot entirely** rather than hidden one query away from a screen that decides to show it.

A trigger freezes a finalised snapshot: it cannot be rewritten, only commented on and released. Reprinting a 2026 report card in 2028 produces the same page.

Report card layout that works: competency breakdown as the body, exam mean and position in a summary strip. Both audiences get what they came for.

### 5.7 Fees

```ts
export const feeStructures = pgTable('fee_structures', {
  id: uuid('id').primaryKey().defaultRandom(),
  schoolId: uuid('school_id').notNull(),
  termId: uuid('term_id').notNull().references(() => terms.id),
  gradeLevelId: uuid('grade_level_id').notNull().references(() => gradeLevels.id),
  boardingStatus: text('boarding_status').$type<'day' | 'boarder'>().notNull(),
}, (t) => [unique().on(t.termId, t.gradeLevelId, t.boardingStatus)]);

export const feeItems = pgTable('fee_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  schoolId: uuid('school_id').notNull(),
  feeStructureId: uuid('fee_structure_id')
    .notNull().references(() => feeStructures.id),
  name: text('name').notNull(),            // 'Tuition', 'Lunch', 'Transport'
  amountCents: integer('amount_cents').notNull(),
  isOptional: boolean('is_optional').default(false).notNull(),
});

export const invoices = pgTable('invoices', {
  id: uuid('id').primaryKey().defaultRandom(),
  schoolId: uuid('school_id').notNull(),
  studentId: uuid('student_id').notNull().references(() => students.id),
  termId: uuid('term_id').notNull().references(() => terms.id),
  totalCents: integer('total_cents').notNull(),
  issuedOn: date('issued_on').notNull(),
  dueOn: date('due_on'),
  voidedAt: timestamp('voided_at'),
}, (t) => [unique().on(t.studentId, t.termId)]);

export const invoiceLines = pgTable('invoice_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  schoolId: uuid('school_id').notNull(),
  invoiceId: uuid('invoice_id').notNull().references(() => invoices.id),
  description: text('description').notNull(),
  amountCents: integer('amount_cents').notNull(),   // negative = bursary/discount
});
```

**Copy line items onto the invoice at generation time.** Do not join back to the fee structure at read time — when the school raises tuition mid-year, historical invoices must not silently change.

`invoices.total_cents` is stored rather than derived, because an invoice is a printed document (rule 7). It is recomputed from its lines inside the same transaction as any line change, so "stored" never means "stale". Balances, by contrast, are always derived — see `lib/balances.ts`, which is the only place the formula is written.

**Optional fee items are not billed in bulk.** Transport and lunch are real charges but only for the families that take them; invoicing every child for a bus they do not ride costs more trust than it collects. They are added per student.

**Rule 5 protects records, not configuration.** `fee_structures` and `fee_items` are templates an invoice is generated *from*, and the invoice carries its own copies — so those two are the only fee tables the runtime role may `DELETE` from. Invoices void; payments reverse; neither deletes.

### 5.8 Payments and M-Pesa reconciliation

Two tables, and the separation is the entire feature.

```ts
// raw, append-only. everything Daraja sends. never edited.
export const mpesaTransactions = pgTable('mpesa_transactions', {
  id: uuid('id').primaryKey().defaultRandom(),
  schoolId: uuid('school_id').notNull(),
  transactionId: text('transaction_id').notNull().unique(),  // Safaricom receipt
  shortcode: text('shortcode').notNull(),
  accountReference: text('account_reference'),               // what the parent typed
  msisdn: text('msisdn').notNull(),
  payerName: text('payer_name'),
  amountCents: integer('amount_cents').notNull(),
  transactedAt: timestamp('transacted_at').notNull(),
  rawPayload: jsonb('raw_payload').notNull(),
  status: text('status')
    .$type<'unmatched' | 'allocated' | 'rejected'>()
    .notNull(),
  // why a bursar set it aside, or why the system refused it
  statusReason: text('status_reason'),
  receivedAt: timestamp('received_at').defaultNow().notNull(),
});

// ledger entry against a student. created when a transaction is matched.
export const payments = pgTable('payments', {
  id: uuid('id').primaryKey().defaultRandom(),
  schoolId: uuid('school_id').notNull(),
  studentId: uuid('student_id').notNull().references(() => students.id),
  invoiceId: uuid('invoice_id').references(() => invoices.id),  // null = credit on account
  mpesaTransactionId: uuid('mpesa_transaction_id')
    .references(() => mpesaTransactions.id),
  method: text('method')
    .$type<'mpesa' | 'bank' | 'cash' | 'cheque'>().notNull(),
  amountCents: integer('amount_cents').notNull(),
  reference: text('reference'),
  recordedBy: text('recorded_by').references(() => user.id),
  receivedAt: timestamp('received_at').notNull(),
  reversedAt: timestamp('reversed_at'),
  reversalReason: text('reversal_reason'),
}, (t) => [index().on(t.schoolId, t.studentId)]);
```

Rules:

- **The webhook's only job is to write an `mpesa_transactions` row and return 200.** It never guesses, never allocates, never fails on an unrecognised reference. A duplicate receipt is a Safaricom retry and is acknowledged, not stored twice; an unparseable body is acknowledged too, because a retry will not make it parse. The body is deliberately not schema-validated — rejecting a payload we do not control could only turn a real payment into a retry loop.
- **The one exception is an unknown callback token, which returns 404.** That is our own misconfiguration — a URL registered with Safaricom that no longer resolves — not a transient fault, and answering 200 would swallow it silently while real payments went nowhere. Safaricom's retries are what make it visible.
- **The tenant comes from an unguessable token in the callback path, NOT from `shortcode`.** An earlier draft of this section resolved it from the payload — but the endpoint is unauthenticated and the shortcode is a public field the caller supplies, so anyone could file fabricated payments against any school. Each school gets its own 256-bit callback URL (`schools.mpesa_callback_token`); a payload whose shortcode disagrees with the school's is stored `rejected` as evidence rather than believed.
- The matcher then matches `accountReference` against `admissionNumber`. Hits become a `payment`. Misses stay `unmatched`.
- **Matching is deliberately strict**: exact, or exact once separators and case are ignored. No fuzzy fallback — `ADM 118` for `2026/118` is meant to stay unmatched. A wrong automatic allocation is worse than none, because the money lands on another family's account and nobody is looking for it. The queue offers near misses as *suggestions* instead, with each candidate's balance.
- **Build the manual reconciliation queue from day one.** A meaningful share of payments arrive unmatched — parents type the reference wrong constantly. This is not an edge case, it is the core bursar workflow.
- Because the raw row is never mutated, mis-allocation is always reversible and "where did this KES 15,000 go" is always answerable. **A trigger enforces this** — only `status` and `status_reason` may change — because a claim this load-bearing cannot rest on a comment. Reversing an M-Pesa payment returns its confirmation to the queue, which is the other half of that promise; a partial unique index allows exactly one *live* payment per confirmation, so a reversed one releases it without leaving the record.
- **Credentials are encrypted at rest** with AES-256-GCM (`lib/crypto.ts`), versioned so the algorithm can change without guessing at the old format, and never returned by any endpoint — only whether they are set.
- Each school uses **its own paybill/till**. Money must never route through our account — licensing problem and an instant trust objection.

---

## 6. Table inventory

```
schools, user, memberships
academic_years, terms
grade_levels, streams, enrollments
students, guardians, student_guardians
learning_areas, competencies
assessments, assessment_scores, score_attachments
term_results, report_cards, transition_certificates
fee_structures, fee_items, invoices, invoice_lines
mpesa_transactions, payments
sms_messages, audit_log
```

~25 tables. Everything deferred (attendance, timetables, transport, library, SMS templates) hangs off `enrollments` and `terms` without disturbing this.

Three more, all now **built**:

- **`sms_messages`** — Africa's Talking charges per unit and reports delivery asynchronously, so schools ask what they are spending. A row per message with recipient, body, provider id, status, cost and the guardian or student it concerns. Sends are **dry-run by default** (`POST /sms/fee-reminders`, `/sms/results-notice`): every other write here does what you ask, but four hundred delivered messages cost money and cannot be recalled, so the preview is the default and sending is the thing you opt into. Families skipped are returned with a reason, because a guardian with no phone number is otherwise invisible and "we texted everyone" quietly means "everyone we had a number for". One message per child, never one per linked guardian.
- **`audit_log`** — who changed a mark, who reversed a payment, who released a report card. Written inside the same transaction as the action, so an entry cannot outlive a rolled-back change or go missing from one that stood. The runtime role holds `INSERT` and `SELECT` and neither `UPDATE` nor `DELETE`: this is the one table protected from *editing* as well as deletion, because a log the application can rewrite is evidence of nothing. Admin-only to read — the people it is a check on are not its audience.
- **`transition_certificates`** — the two points a CBE learner moves on, Grade 6 → junior and Grade 9 → senior. Derived from `sequence`, never stored as a flag. Frozen at issue like a report card (rule 7), one per child per milestone; a reissue is a reprint, never a second document saying something different.

**Documents verify themselves.** Report cards, fee receipts and transition certificates carry a 160-bit code and a QR (`lib/verification.ts`), and `GET /verify/{code}` is public and unauthenticated — the person handed a report card at admission has no account here and should not need one. It shows no more than the paper does, and there is no parameter that could widen a result set, so its reach is exactly the documents a caller already holds. A reversed receipt answers `withdrawn` rather than merely "authentic": the paper is real, the money is not on the account, and that is usually why somebody is checking. This is nearly free because the content is already frozen — the snapshots exist for rule 7, and all that was missing was a code and somewhere to check it.

**No parent portal exists.** `guardians.user_id` is in the schema and no route writes it; no route reads it either, because there are no guardian-scoped endpoints. A guardian who signs in reaches `/school`, `/terms`, `/grade-levels` and `/streams` — the four that admit `anyMember` — and nothing about their own children. CLAUDE.md §9 calls the parent portal a v1 surface and §8 calls the parent view the thing that convinces a head; neither is demonstrable today, and the demo seed says so in its own running order rather than promising it.

A third gap, found by building the demo seed and **now closed**: onboarding a school left nobody able to sign into it. `POST /superadmin/schools/{id}/memberships` grants the first role from outside the tenant, because the tenant-side equivalent would be guarded by `admin` — a role that does not exist yet at a school that has just been created. Still missing, and wanted before a real school runs itself: the tenant-side version, so a head can add their own bursar without the platform operator.

---

## 7. Build order

1. ~~Fork the existing scaffold. Strip domain, keep auth, rate limiting, Docker dev/test databases, CI.~~ **Done.**
2. ~~Tenancy + academic spine + RLS + superadmin plane (§4, §5.1, §5.2).~~ **Done.**
3. ~~Students, guardians, enrollment (§5.3).~~ **Done.**
4. ~~Fees: structures → invoice generation for one term (§5.7).~~ **Done.**
5. ~~C2B webhook, matcher and reconciliation queue (§5.8).~~ **Done.** — but **`registerC2bUrls` has never been run against Daraja's sandbox.** It is written and wired; exercising it needs real credentials and a publicly reachable tunnel, and until that happens no school's callbacks are actually registered with Safaricom. Everything downstream of a delivered confirmation is tested.
6. Bursar dashboard: outstanding balances per class. — **API done** (`GET /balances/by-class`). The dashboard *screen* is the first piece of the Next app, which has not started.
7. **Put it in front of one real school before writing anything else.**
8. ~~Curriculum seed + assessment + report cards (§5.4–5.6).~~ **Done.** — the learning areas are real; the strands are marked `(placeholder)` rather than transcribed from KICD's published designs. Replacing them is a data change and nothing else.

~~The demo seed (§8) is **not** a phase-8 activity. Grow `seed/01…06` alongside steps 3–6.~~ **Built** — as `seed/`, run by `pnpm seed:demo` and by `seed/seed.test.ts` in CI. It arrived late rather than alongside, which cost the thing it was meant to give: every step from 3 to 8 was tested against two or three hand-made rows, and the first run against three hundred children found real gaps within minutes.

Fees ships first because it is what a bursar will pay for — someone is currently matching M-Pesa messages to a ledger by hand. It also forces the spine into existence, since you cannot invoice a student without terms, classes, and enrollment.

---

## 8. Demo tenant

Treat as a product surface, not throwaway fixtures. It closes sales and doubles as an integration test.

- **A real tenant**, `status: 'demo'`, at `demo.<domain>`, seeded through the actual API. Never a special code path — it will drift and embarrass you mid-presentation. **One write is not through the API and cannot be**: promoting the operator account to `superadmin`. No endpoint grants that role, correctly — an endpoint that promoted its own caller would undo the isolation model. Everything downstream of it is HTTP.
- **Nightly reset.** Drop and reseed.
- **Deterministic.** Fixed random seed, dates relative to today. A demo whose current term expired in March is worse than no demo — so the three terms are built *around* today rather than on the calendar year, which is the only arrangement that holds in every month.
  **Not fixed UUIDs.** That requirement and "through the actual API" cannot both hold: fixing ids means every create endpoint accepting a client-supplied primary key, which is a special code path and a security smell, and §8 is explicit that the no-special-path rule is the load-bearing one. Deep links use the admission number instead — school-scoped, human-facing, stable across resets, and already the M-Pesa account reference.
- **Scale:** one school, Grades 1–9, two streams in lower grades, one in junior. ~320 students.

Realism details that matter:

- Kenyan names with the right regional spread — Wanjiku, Otieno, Achieng', Kiplagat, Mwikali, Njoroge, Hassan, Chebet. Not Faker defaults.
- Admission numbers formatted by intake year: `2023/041`, `2026/118`.
- Fee amounts matching the tier being sold to (modest private primary ≈ KES 12,000–25,000/term).
- Two completed terms of history plus the current one in progress, so trends and "last term's position" have data.

**Seed the mess deliberately** — this is the part that sells:

- Outstanding balances of varying age, including one alarming one.
- 5–6 unmatched M-Pesa transactions: one who typed `ADM 118` instead of `2026/118`, one who used a sibling's number, one truncated. Reconcile one live during the pitch.
- One assessment with `publishedAt` null, to show parents don't see half-entered marks.
- One `transferred_out` student mid-term with history intact.
- Two guardians linked to two children each, to show sibling handling.

Seed layout:

```
seed/
  01-school.ts        school, terms, grade levels, streams, staff
  02-curriculum.ts    learning areas + KICD strands
  03-students.ts      students, guardians, enrollments
  04-history.ts       past two terms: assessments, scores, term results
  05-fees.ts          structures, invoices, payments, unmatched queue
  06-current.ts       in-progress term state
  07-leavers.ts       last year, its results, and transition certificates
  08-messaging.ts     one fee-reminder batch
```

**The demo needs a previous year, and the reason is a real constraint.** A transition certificate cannot be issued before its term 3 has ended, and this demo's term 3 is deliberately in progress — so nothing in the current year can ever be certified. `01-school.ts` therefore builds last year too: Grade 7's children are enrolled in last year's Grade 6 and walked up through it (forwards, because `POST /enrollments` closes the old placement and opens a new one — history cannot be back-dated), and last year's Grade 9 cohort are certified and then `graduated`.

Two endpoints were missing and were found by building this: **`POST /terms`**, without which a school reaching its second year had no way to make a calendar at all, and an **`academicYearId` filter on `GET /terms`** — with more than one year on file, "term 3" no longer names one term, and anything matching on the number picks whichever sorts first.

**The seed never sends real SMS.** Guardian numbers are fabricated, and a fabricated Kenyan number is not necessarily an unassigned one. The fee-reminder batch is scoped to one class and stays a dry run unless a provider is configured; a deployment that wants a populated ledger configures Africa's Talking **against the sandbox**, which delivers to a simulator and nowhere else.

Run the seed in CI against Docker Postgres — if it breaks, a migration broke something real.

Four demo logins: head, bursar, class teacher, parent. The parent view is what convinces a head that fee follow-up gets easier.

The seed prints a **running order** alongside the data it describes — which reference to reconcile, which assessment is unpublished — because those are exactly the details nobody remembers under pressure, and keeping them next to the generator is what stops the script and the database drifting apart.

---

## 9. UX constraints worth knowing

- **Marks entry decides whether teachers like the product.** Thirty students × six sub-strands through a web form is miserable. Grid with keyboard navigation, offline tolerance, and spreadsheet paste/import. Most schools already keep marks in Excel.
- **Guardians are on phones, on patchy data.** Parent portal must be light and SMS must carry the important things.
- **Rehearse presentations offline-capable.** Live SaaS over Kenyan school wifi has ruined better products.

---

## 10. Open questions

- Which market tier and region are we pitching first? Drives fee amounts and name distribution in the demo.
- Do target schools run combined primary + junior on one compound, or separate registers?
- What are competitors doing badly? Worth an afternoon of asking schools what they hate about their current system before committing months.
