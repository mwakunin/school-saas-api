CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid,
	"summary" text NOT NULL,
	"detail" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_log_action_known" CHECK ("audit_log"."action" IN ('assessment.published', 'assessment.unpublished', 'certificate.issued', 'invoice.voided', 'marks.saved', 'mpesa.allocated', 'mpesa.rejected', 'payment.recorded', 'payment.reversed', 'report_card.finalised', 'report_card.released', 'sms.queued'))
);
--> statement-breakpoint
CREATE TABLE "sms_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"guardian_id" uuid,
	"student_id" uuid,
	"to_phone" text NOT NULL,
	"body" text NOT NULL,
	"batch_id" uuid,
	"kind" text NOT NULL,
	"provider_message_id" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"status_reason" text,
	"cost_cents" integer,
	"segments" integer,
	"requested_by" text,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "sms_messages_school_id_id_key" UNIQUE("school_id","id"),
	CONSTRAINT "sms_messages_status_known" CHECK ("sms_messages"."status" IN ('queued', 'sent', 'delivered', 'failed', 'rejected')),
	CONSTRAINT "sms_messages_kind_known" CHECK ("sms_messages"."kind" IN ('results', 'fees', 'announcement')),
	CONSTRAINT "sms_messages_cost_not_negative" CHECK ("sms_messages"."cost_cents" IS NULL OR "sms_messages"."cost_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "transition_certificates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"term_id" uuid NOT NULL,
	"milestone" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"verification_code" text NOT NULL,
	"issued_by" text,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transition_certificates_enrollmentId_milestone_unique" UNIQUE("enrollment_id","milestone"),
	CONSTRAINT "transition_certificates_verification_code_key" UNIQUE("verification_code"),
	CONSTRAINT "transition_certificates_school_id_id_key" UNIQUE("school_id","id"),
	CONSTRAINT "transition_certificates_milestone_known" CHECK ("transition_certificates"."milestone" IN ('grade_6', 'grade_9'))
);
--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "verification_code" text;--> statement-breakpoint
ALTER TABLE "report_cards" ADD COLUMN "verification_code" text;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_messages" ADD CONSTRAINT "sms_messages_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_messages" ADD CONSTRAINT "sms_messages_requested_by_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_messages" ADD CONSTRAINT "sms_messages_school_guardian_fk" FOREIGN KEY ("school_id","guardian_id") REFERENCES "public"."guardians"("school_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_messages" ADD CONSTRAINT "sms_messages_school_student_fk" FOREIGN KEY ("school_id","student_id") REFERENCES "public"."students"("school_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transition_certificates" ADD CONSTRAINT "transition_certificates_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transition_certificates" ADD CONSTRAINT "transition_certificates_issued_by_user_id_fk" FOREIGN KEY ("issued_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transition_certificates" ADD CONSTRAINT "transition_certificates_school_enrollment_fk" FOREIGN KEY ("school_id","enrollment_id") REFERENCES "public"."enrollments"("school_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transition_certificates" ADD CONSTRAINT "transition_certificates_school_term_fk" FOREIGN KEY ("school_id","term_id") REFERENCES "public"."terms"("school_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_school_id_at_index" ON "audit_log" USING btree ("school_id","at");--> statement-breakpoint
CREATE INDEX "audit_log_school_id_entity_type_entity_id_index" ON "audit_log" USING btree ("school_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "sms_messages_school_id_queued_at_index" ON "sms_messages" USING btree ("school_id","queued_at");--> statement-breakpoint
CREATE INDEX "sms_messages_school_id_batch_id_index" ON "sms_messages" USING btree ("school_id","batch_id");--> statement-breakpoint
CREATE INDEX "sms_messages_provider_message_id_index" ON "sms_messages" USING btree ("provider_message_id");--> statement-breakpoint
CREATE INDEX "transition_certificates_school_id_term_id_index" ON "transition_certificates" USING btree ("school_id","term_id");--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_verification_code_key" UNIQUE("verification_code");--> statement-breakpoint
ALTER TABLE "report_cards" ADD CONSTRAINT "report_cards_verification_code_key" UNIQUE("verification_code");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Isolation, on the same terms as every other tenant table (CLAUDE.md §4).
--
-- USING and WITH CHECK both, ENABLE and FORCE both. `rls.test.ts` fails the
-- build for a tenant table that arrives without these, which is what makes the
-- rule survive somebody adding a table on a Friday.
-- ---------------------------------------------------------------------------

ALTER TABLE "transition_certificates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "transition_certificates" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "transition_certificates"
  FOR ALL USING ("school_id" = app_current_school())
  WITH CHECK ("school_id" = app_current_school());
--> statement-breakpoint

ALTER TABLE "sms_messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sms_messages" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "sms_messages"
  FOR ALL USING ("school_id" = app_current_school())
  WITH CHECK ("school_id" = app_current_school());
--> statement-breakpoint

ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "audit_log" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "audit_log"
  FOR ALL USING ("school_id" = app_current_school())
  WITH CHECK ("school_id" = app_current_school());
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON "transition_certificates", "sms_messages" TO school_app;--> statement-breakpoint

-- The audit log gets INSERT and SELECT, and deliberately NOT UPDATE or DELETE.
--
-- Everything else in this schema is protected from deletion by rule 5; this is
-- the one table also protected from EDITING, and the distinction is the whole
-- point. A log the application can rewrite is evidence of nothing. Whoever
-- wishes an entry said something different — the person who changed the mark,
-- the person who reversed the payment — is exactly who must not be able to
-- change it, and no application bug or compromised handler can either, because
-- the privilege is not there to use.
GRANT SELECT, INSERT ON "audit_log" TO school_app;
