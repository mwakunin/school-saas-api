CREATE TYPE "public"."performance_level" AS ENUM('below_expectation', 'approaching', 'meeting', 'exceeding');--> statement-breakpoint
CREATE TABLE "assessment_scores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"assessment_id" uuid NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"competency_id" uuid,
	"raw_score" numeric(6, 2),
	"level" "performance_level",
	"is_absent" boolean DEFAULT false NOT NULL,
	"comment" text,
	"entered_by" text,
	"entered_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assessment_scores_school_id_id_key" UNIQUE("school_id","id"),
	CONSTRAINT "assessment_scores_unique_entry" UNIQUE NULLS NOT DISTINCT("assessment_id","enrollment_id","competency_id"),
	CONSTRAINT "assessment_scores_raw_score_positive" CHECK ("assessment_scores"."raw_score" IS NULL OR "assessment_scores"."raw_score" >= 0),
	CONSTRAINT "assessment_scores_absent_has_no_result" CHECK (NOT "assessment_scores"."is_absent" OR ("assessment_scores"."raw_score" IS NULL AND "assessment_scores"."level" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "assessments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"term_id" uuid NOT NULL,
	"learning_area_id" uuid NOT NULL,
	"stream_id" uuid,
	"title" text NOT NULL,
	"kind" text NOT NULL,
	"max_score" integer,
	"weight" numeric(5, 2),
	"administered_on" date,
	"created_by" text,
	"published_at" timestamp with time zone,
	CONSTRAINT "assessments_school_id_id_key" UNIQUE("school_id","id"),
	CONSTRAINT "assessments_max_score_positive" CHECK ("assessments"."max_score" IS NULL OR "assessments"."max_score" > 0),
	CONSTRAINT "assessments_weight_positive" CHECK ("assessments"."weight" IS NULL OR "assessments"."weight" > 0)
);
--> statement-breakpoint
CREATE TABLE "competencies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"learning_area_id" uuid NOT NULL,
	"parent_id" uuid,
	"code" text,
	"title" text NOT NULL,
	"sequence" integer NOT NULL,
	CONSTRAINT "competencies_school_id_id_key" UNIQUE("school_id","id")
);
--> statement-breakpoint
CREATE TABLE "learning_areas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"grade_level_id" uuid,
	"name" text NOT NULL,
	"code" text,
	"is_core" boolean DEFAULT true NOT NULL,
	"sequence" integer NOT NULL,
	CONSTRAINT "learning_areas_school_id_id_key" UNIQUE("school_id","id")
);
--> statement-breakpoint
CREATE TABLE "report_cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"term_id" uuid NOT NULL,
	"snapshot" jsonb NOT NULL,
	"pdf_url" text,
	"class_teacher_comment" text,
	"head_comment" text,
	"attendance_present" integer,
	"attendance_total" integer,
	"finalised_by" text,
	"finalised_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	CONSTRAINT "report_cards_enrollmentId_termId_unique" UNIQUE("enrollment_id","term_id"),
	CONSTRAINT "report_cards_school_id_id_key" UNIQUE("school_id","id"),
	CONSTRAINT "report_cards_attendance_sane" CHECK (
    ("report_cards"."attendance_present" IS NULL AND "report_cards"."attendance_total" IS NULL)
    OR ("report_cards"."attendance_present" >= 0 AND "report_cards"."attendance_total" >= "report_cards"."attendance_present")
  ),
	CONSTRAINT "report_cards_released_after_finalised" CHECK ("report_cards"."released_at" IS NULL OR "report_cards"."finalised_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "score_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"assessment_score_id" uuid NOT NULL,
	"url" text NOT NULL,
	"kind" text NOT NULL,
	"caption" text,
	"uploaded_by" text,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "term_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"term_id" uuid NOT NULL,
	"learning_area_id" uuid NOT NULL,
	"mean_score" numeric(5, 2),
	"stream_position" integer,
	"grade_position" integer,
	"out_of" integer,
	"overall_level" "performance_level",
	"teacher_comment" text,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "term_results_enrollmentId_termId_learningAreaId_unique" UNIQUE("enrollment_id","term_id","learning_area_id"),
	CONSTRAINT "term_results_school_id_id_key" UNIQUE("school_id","id")
);
--> statement-breakpoint
ALTER TABLE "assessment_scores" ADD CONSTRAINT "assessment_scores_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_scores" ADD CONSTRAINT "assessment_scores_entered_by_user_id_fk" FOREIGN KEY ("entered_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_scores" ADD CONSTRAINT "assessment_scores_school_assessment_fk" FOREIGN KEY ("school_id","assessment_id") REFERENCES "public"."assessments"("school_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_scores" ADD CONSTRAINT "assessment_scores_school_enrollment_fk" FOREIGN KEY ("school_id","enrollment_id") REFERENCES "public"."enrollments"("school_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_scores" ADD CONSTRAINT "assessment_scores_school_competency_fk" FOREIGN KEY ("school_id","competency_id") REFERENCES "public"."competencies"("school_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_school_term_fk" FOREIGN KEY ("school_id","term_id") REFERENCES "public"."terms"("school_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_school_learning_area_fk" FOREIGN KEY ("school_id","learning_area_id") REFERENCES "public"."learning_areas"("school_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_school_stream_fk" FOREIGN KEY ("school_id","stream_id") REFERENCES "public"."streams"("school_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competencies" ADD CONSTRAINT "competencies_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competencies" ADD CONSTRAINT "competencies_school_learning_area_fk" FOREIGN KEY ("school_id","learning_area_id") REFERENCES "public"."learning_areas"("school_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competencies" ADD CONSTRAINT "competencies_school_parent_fk" FOREIGN KEY ("school_id","parent_id") REFERENCES "public"."competencies"("school_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_areas" ADD CONSTRAINT "learning_areas_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_areas" ADD CONSTRAINT "learning_areas_school_grade_level_fk" FOREIGN KEY ("school_id","grade_level_id") REFERENCES "public"."grade_levels"("school_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_cards" ADD CONSTRAINT "report_cards_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_cards" ADD CONSTRAINT "report_cards_finalised_by_user_id_fk" FOREIGN KEY ("finalised_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_cards" ADD CONSTRAINT "report_cards_school_enrollment_fk" FOREIGN KEY ("school_id","enrollment_id") REFERENCES "public"."enrollments"("school_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_cards" ADD CONSTRAINT "report_cards_school_term_fk" FOREIGN KEY ("school_id","term_id") REFERENCES "public"."terms"("school_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "score_attachments" ADD CONSTRAINT "score_attachments_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "score_attachments" ADD CONSTRAINT "score_attachments_uploaded_by_user_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "score_attachments" ADD CONSTRAINT "score_attachments_school_score_fk" FOREIGN KEY ("school_id","assessment_score_id") REFERENCES "public"."assessment_scores"("school_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "term_results" ADD CONSTRAINT "term_results_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "term_results" ADD CONSTRAINT "term_results_school_enrollment_fk" FOREIGN KEY ("school_id","enrollment_id") REFERENCES "public"."enrollments"("school_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "term_results" ADD CONSTRAINT "term_results_school_term_fk" FOREIGN KEY ("school_id","term_id") REFERENCES "public"."terms"("school_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "term_results" ADD CONSTRAINT "term_results_school_learning_area_fk" FOREIGN KEY ("school_id","learning_area_id") REFERENCES "public"."learning_areas"("school_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assessment_scores_school_id_assessment_id_index" ON "assessment_scores" USING btree ("school_id","assessment_id");--> statement-breakpoint
CREATE INDEX "assessment_scores_school_id_enrollment_id_index" ON "assessment_scores" USING btree ("school_id","enrollment_id");--> statement-breakpoint
CREATE INDEX "assessments_school_id_term_id_index" ON "assessments" USING btree ("school_id","term_id");--> statement-breakpoint
CREATE INDEX "competencies_school_id_learning_area_id_index" ON "competencies" USING btree ("school_id","learning_area_id");--> statement-breakpoint
CREATE INDEX "learning_areas_school_id_grade_level_id_index" ON "learning_areas" USING btree ("school_id","grade_level_id");--> statement-breakpoint
CREATE INDEX "report_cards_school_id_term_id_index" ON "report_cards" USING btree ("school_id","term_id");--> statement-breakpoint
CREATE INDEX "score_attachments_school_id_assessment_score_id_index" ON "score_attachments" USING btree ("school_id","assessment_score_id");--> statement-breakpoint
CREATE INDEX "term_results_school_id_term_id_index" ON "term_results" USING btree ("school_id","term_id");--> statement-breakpoint

-- RLS for the curriculum, assessment and report-card tables.
ALTER TABLE "learning_areas" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "learning_areas" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "learning_areas"
  FOR ALL USING ("school_id" = app_current_school())
  WITH CHECK ("school_id" = app_current_school());
--> statement-breakpoint

ALTER TABLE "competencies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "competencies" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "competencies"
  FOR ALL USING ("school_id" = app_current_school())
  WITH CHECK ("school_id" = app_current_school());
--> statement-breakpoint

ALTER TABLE "assessments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "assessments" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "assessments"
  FOR ALL USING ("school_id" = app_current_school())
  WITH CHECK ("school_id" = app_current_school());
--> statement-breakpoint

ALTER TABLE "assessment_scores" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "assessment_scores" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "assessment_scores"
  FOR ALL USING ("school_id" = app_current_school())
  WITH CHECK ("school_id" = app_current_school());
--> statement-breakpoint

ALTER TABLE "score_attachments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "score_attachments" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "score_attachments"
  FOR ALL USING ("school_id" = app_current_school())
  WITH CHECK ("school_id" = app_current_school());
--> statement-breakpoint

ALTER TABLE "term_results" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "term_results" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "term_results"
  FOR ALL USING ("school_id" = app_current_school())
  WITH CHECK ("school_id" = app_current_school());
--> statement-breakpoint

ALTER TABLE "report_cards" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "report_cards" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "report_cards"
  FOR ALL USING ("school_id" = app_current_school())
  WITH CHECK ("school_id" = app_current_school());
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON
  "learning_areas", "competencies", "assessments", "assessment_scores",
  "score_attachments", "term_results", "report_cards"
  TO school_app;
--> statement-breakpoint

-- DELETE on the curriculum tables and on portfolio attachments, and only those.
--
-- CLAUDE.md §3 rule 5 names what it protects: "students, invoices, payments,
-- and scores". A learning area or a strand is the CURRICULUM a school copied
-- at onboarding and then edited to match how it actually teaches — removing a
-- subject it does not offer changes no record of anything. Once a score exists
-- against a competency the foreign key holds it, so the delete that would
-- destroy history is refused by the database rather than by a convention.
--
-- `score_attachments` is a file reference, not a judgement: a teacher who
-- uploads the wrong photograph to a child's portfolio must be able to remove
-- it, and the score it hung off is untouched.
--
-- Scores, term results and report cards gain no DELETE.
GRANT DELETE ON "learning_areas", "competencies", "score_attachments" TO school_app;
--> statement-breakpoint

-- Once finalised, a report card is the printed document (rule 7).
--
-- The snapshot is what makes reprinting a 2026 report card in 2028 produce the
-- same page, so it must not change after the fact. Comments and release remain
-- editable: releasing is the act that follows finalisation, and a head adding
-- a remark before release is ordinary. The snapshot, the enrolment and the
-- term are not.
CREATE FUNCTION report_cards_snapshot_frozen() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF OLD.finalised_at IS NOT NULL AND (
       NEW.snapshot IS DISTINCT FROM OLD.snapshot
    OR NEW.enrollment_id IS DISTINCT FROM OLD.enrollment_id
    OR NEW.term_id IS DISTINCT FROM OLD.term_id
    OR NEW.school_id IS DISTINCT FROM OLD.school_id
    OR NEW.finalised_at IS DISTINCT FROM OLD.finalised_at
  ) THEN
    RAISE EXCEPTION
      'a finalised report card is frozen: its snapshot cannot be rewritten'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER report_cards_snapshot_frozen
  BEFORE UPDATE ON "report_cards"
  FOR EACH ROW EXECUTE FUNCTION report_cards_snapshot_frozen();
