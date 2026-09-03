CREATE TABLE "enrollments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"stream_id" uuid NOT NULL,
	"boarding_status" text NOT NULL,
	"started_on" date NOT NULL,
	"ended_on" date,
	CONSTRAINT "enrollments_school_id_id_key" UNIQUE("school_id","id"),
	CONSTRAINT "enrollments_dates_ordered" CHECK ("enrollments"."ended_on" IS NULL OR "enrollments"."ended_on" >= "enrollments"."started_on")
);
--> statement-breakpoint
CREATE TABLE "guardians" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"user_id" text,
	"name" text NOT NULL,
	"phone" text NOT NULL,
	"alt_phone" text,
	"email" text,
	"national_id" text,
	"occupation" text,
	CONSTRAINT "guardians_school_id_id_key" UNIQUE("school_id","id")
);
--> statement-breakpoint
CREATE TABLE "student_guardians" (
	"school_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"guardian_id" uuid NOT NULL,
	"relationship" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	"receives_invoices" boolean DEFAULT true NOT NULL,
	"can_collect" boolean DEFAULT true NOT NULL,
	CONSTRAINT "student_guardians_student_id_guardian_id_pk" PRIMARY KEY("student_id","guardian_id")
);
--> statement-breakpoint
CREATE TABLE "students" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"admission_number" text NOT NULL,
	"upi_number" text,
	"birth_cert_number" text,
	"given_name" text NOT NULL,
	"middle_names" text,
	"family_name" text NOT NULL,
	"preferred_name" text,
	"date_of_birth" date,
	"sex" text,
	"photo_url" text,
	"user_id" text,
	"status" text DEFAULT 'active' NOT NULL,
	"admitted_on" date NOT NULL,
	"exited_on" date,
	"previous_school" text,
	CONSTRAINT "students_schoolId_admissionNumber_unique" UNIQUE("school_id","admission_number"),
	CONSTRAINT "students_schoolId_upiNumber_unique" UNIQUE("school_id","upi_number"),
	CONSTRAINT "students_school_id_id_key" UNIQUE("school_id","id"),
	CONSTRAINT "students_exit_after_admission" CHECK ("students"."exited_on" IS NULL OR "students"."exited_on" >= "students"."admitted_on"),
	CONSTRAINT "students_exit_matches_status" CHECK (("students"."status" = 'active') = ("students"."exited_on" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_school_student_fk" FOREIGN KEY ("school_id","student_id") REFERENCES "public"."students"("school_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_school_stream_fk" FOREIGN KEY ("school_id","stream_id") REFERENCES "public"."streams"("school_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guardians" ADD CONSTRAINT "guardians_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guardians" ADD CONSTRAINT "guardians_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_guardians" ADD CONSTRAINT "student_guardians_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_guardians" ADD CONSTRAINT "student_guardians_school_student_fk" FOREIGN KEY ("school_id","student_id") REFERENCES "public"."students"("school_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_guardians" ADD CONSTRAINT "student_guardians_school_guardian_fk" FOREIGN KEY ("school_id","guardian_id") REFERENCES "public"."guardians"("school_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "students" ADD CONSTRAINT "students_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "students" ADD CONSTRAINT "students_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "enrollments_school_id_stream_id_index" ON "enrollments" USING btree ("school_id","stream_id");--> statement-breakpoint
CREATE INDEX "enrollments_school_id_student_id_index" ON "enrollments" USING btree ("school_id","student_id");--> statement-breakpoint
CREATE INDEX "guardians_school_id_phone_index" ON "guardians" USING btree ("school_id","phone");--> statement-breakpoint
CREATE INDEX "student_guardians_school_id_guardian_id_index" ON "student_guardians" USING btree ("school_id","guardian_id");--> statement-breakpoint
CREATE INDEX "students_school_id_family_name_index" ON "students" USING btree ("school_id","family_name");--> statement-breakpoint

-- A child cannot be in two classes at once.
--
-- The partial-unique alternative ("at most one row with ended_on IS NULL")
-- only catches the live case. This catches the historical one too: correcting
-- last term's records by re-opening a closed enrollment that overlaps another
-- would otherwise succeed, and then every mark in the overlap has two
-- enrollments it could belong to. Scores hang off enrollment_id (CLAUDE.md §3
-- rule 6), so that ambiguity is not recoverable by inspection — you cannot
-- tell from a score row which class the child was actually in.
--
-- `[]` makes both bounds inclusive: ended_on is the last day of the
-- enrollment, which is how a school reads it. A NULL upper bound stays
-- unbounded regardless, so an open enrollment overlaps anything after it.
CREATE EXTENSION IF NOT EXISTS btree_gist;--> statement-breakpoint

ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_no_overlap"
  EXCLUDE USING gist (
    student_id WITH =,
    daterange(started_on, ended_on, '[]') WITH &&
  );
--> statement-breakpoint

-- RLS for the tables this migration adds. Same shape as 0002: USING and WITH
-- CHECK both, ENABLE and FORCE both. See that file for why each is needed.
ALTER TABLE "students" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "students" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "students"
  FOR ALL
  USING ("school_id" = app_current_school())
  WITH CHECK ("school_id" = app_current_school());
--> statement-breakpoint

ALTER TABLE "guardians" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "guardians" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "guardians"
  FOR ALL
  USING ("school_id" = app_current_school())
  WITH CHECK ("school_id" = app_current_school());
--> statement-breakpoint

ALTER TABLE "student_guardians" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "student_guardians" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "student_guardians"
  FOR ALL
  USING ("school_id" = app_current_school())
  WITH CHECK ("school_id" = app_current_school());
--> statement-breakpoint

ALTER TABLE "enrollments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "enrollments" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "enrollments"
  FOR ALL
  USING ("school_id" = app_current_school())
  WITH CHECK ("school_id" = app_current_school());
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON
  "students", "guardians", "student_guardians", "enrollments"
  TO school_app;
--> statement-breakpoint

-- The one exception to "no DELETE" (CLAUDE.md §3 rule 5), and it is a
-- safeguarding decision rather than a data one.
--
-- Rule 5 exists so history stays queryable: a withdrawn student, a voided
-- invoice, a reversed payment. `student_guardians` is not history — it is a
-- statement about who may collect a child from school *right now*. A wrong row
-- there is the kind of mistake that has to actually disappear, from every
-- query, including one that forgot to filter on a soft-delete flag.
--
-- Nothing else gains DELETE. The student, the guardian and every mark survive
-- unlinking; only the claim that they are connected goes.
GRANT DELETE ON "student_guardians" TO school_app;
