CREATE TABLE "allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"amount_cents" integer NOT NULL,
	"allocated_by" text,
	"allocated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reversed_at" timestamp with time zone,
	"reversal_reason" text,
	CONSTRAINT "allocations_school_id_id_key" UNIQUE("school_id","id"),
	CONSTRAINT "allocations_amount_whole" CHECK ("allocations"."amount_cents" % 100 = 0 AND "allocations"."amount_cents" > 0),
	CONSTRAINT "allocations_reversal_has_reason" CHECK (("allocations"."reversed_at" IS NULL) = ("allocations"."reversal_reason" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_action_known";--> statement-breakpoint
ALTER TABLE "payments" DROP CONSTRAINT "payments_school_invoice_student_fk";
--> statement-breakpoint
DROP INDEX "payments_school_id_invoice_id_index";--> statement-breakpoint
-- Before the three-column FK below: Postgres refuses a composite foreign key
-- whose referenced columns have no UNIQUE index to match.
ALTER TABLE "payments" ADD CONSTRAINT "payments_school_id_id_student_id_key" UNIQUE("school_id","id","student_id");--> statement-breakpoint
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_allocated_by_user_id_fk" FOREIGN KEY ("allocated_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_school_payment_student_fk" FOREIGN KEY ("school_id","payment_id","student_id") REFERENCES "public"."payments"("school_id","id","student_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_school_invoice_student_fk" FOREIGN KEY ("school_id","invoice_id","student_id") REFERENCES "public"."invoices"("school_id","id","student_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "allocations_school_id_payment_id_index" ON "allocations" USING btree ("school_id","payment_id");--> statement-breakpoint
CREATE INDEX "allocations_school_id_invoice_id_index" ON "allocations" USING btree ("school_id","invoice_id");--> statement-breakpoint

-- Backfill: one allocation per payment that named an invoice, before the
-- column is dropped. Amount = the whole payment (the old model could only
-- point a payment at one invoice, so that is what it meant); allocated_by and
-- allocated_at inherit the payment's recorder and timestamp so the audit
-- story does not change for money that moved before this table existed.
-- Reversed payments backfill too — their allocations stay live rows, and the
-- liveness rule (`payments.reversed_at IS NULL`) is what keeps them out of
-- every balance, same as it does for the payment itself.
--
-- The row id is left to the column's default. Migrations run as the owner, so
-- RLS (below) does not apply here.
INSERT INTO "allocations" ("school_id", "student_id", "payment_id", "invoice_id", "amount_cents", "allocated_by", "allocated_at")
SELECT p."school_id", p."student_id", p."id", p."invoice_id", p."amount_cents", p."recorded_by", p."created_at"
FROM "payments" p
WHERE p."invoice_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "payments" DROP COLUMN "invoice_id";--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_action_known" CHECK ("audit_log"."action" IN ('allocation.recorded', 'allocation.reversed', 'assessment.published', 'assessment.unpublished', 'certificate.issued', 'guardian.linked', 'invoice.voided', 'marks.saved', 'membership.granted', 'membership.revoked', 'mpesa.allocated', 'mpesa.rejected', 'payment.recorded', 'payment.reversed', 'report_card.finalised', 'report_card.released', 'sms.queued'));--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Isolation and grants, on the same terms as every other tenant table
-- (CLAUDE.md §4): USING and WITH CHECK both, ENABLE and FORCE both.
-- ---------------------------------------------------------------------------

ALTER TABLE "allocations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "allocations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "allocations"
  FOR ALL USING ("school_id" = app_current_school())
  WITH CHECK ("school_id" = app_current_school());
--> statement-breakpoint

-- UPDATE is for the reversal path only — a correction un-applies an
-- allocation by stamping reversed_at/reversal_reason. DELETE is granted to
-- nobody (rule 5), and an allocation is never re-amounted, only reversed and
-- re-recorded.
GRANT SELECT, INSERT, UPDATE ON "allocations" TO school_app;