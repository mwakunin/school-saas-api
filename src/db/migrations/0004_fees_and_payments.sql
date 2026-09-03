CREATE TABLE "fee_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"fee_structure_id" uuid NOT NULL,
	"name" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"is_optional" boolean DEFAULT false NOT NULL,
	CONSTRAINT "fee_items_school_id_id_key" UNIQUE("school_id","id"),
	CONSTRAINT "fee_items_amount_whole" CHECK ("fee_items"."amount_cents" % 100 = 0 AND "fee_items"."amount_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "fee_structures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"term_id" uuid NOT NULL,
	"grade_level_id" uuid NOT NULL,
	"boarding_status" text NOT NULL,
	CONSTRAINT "fee_structures_termId_gradeLevelId_boardingStatus_unique" UNIQUE("term_id","grade_level_id","boarding_status"),
	CONSTRAINT "fee_structures_school_id_id_key" UNIQUE("school_id","id")
);
--> statement-breakpoint
CREATE TABLE "invoice_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"description" text NOT NULL,
	"amount_cents" integer NOT NULL,
	CONSTRAINT "invoice_lines_amount_whole" CHECK ("invoice_lines"."amount_cents" % 100 = 0)
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"term_id" uuid NOT NULL,
	"total_cents" integer NOT NULL,
	"issued_on" date NOT NULL,
	"due_on" date,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	CONSTRAINT "invoices_studentId_termId_unique" UNIQUE("student_id","term_id"),
	CONSTRAINT "invoices_school_id_id_key" UNIQUE("school_id","id"),
	CONSTRAINT "invoices_total_whole" CHECK ("invoices"."total_cents" % 100 = 0),
	CONSTRAINT "invoices_void_has_reason" CHECK (("invoices"."voided_at" IS NULL) = ("invoices"."void_reason" IS NULL)),
	CONSTRAINT "invoices_due_after_issue" CHECK ("invoices"."due_on" IS NULL OR "invoices"."due_on" >= "invoices"."issued_on")
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"invoice_id" uuid,
	"method" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"reference" text,
	"recorded_by" text,
	"received_at" timestamp with time zone NOT NULL,
	"reversed_at" timestamp with time zone,
	"reversal_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_school_id_id_key" UNIQUE("school_id","id"),
	CONSTRAINT "payments_amount_whole" CHECK ("payments"."amount_cents" % 100 = 0 AND "payments"."amount_cents" > 0),
	CONSTRAINT "payments_reversal_has_reason" CHECK (("payments"."reversed_at" IS NULL) = ("payments"."reversal_reason" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "fee_items" ADD CONSTRAINT "fee_items_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_items" ADD CONSTRAINT "fee_items_school_structure_fk" FOREIGN KEY ("school_id","fee_structure_id") REFERENCES "public"."fee_structures"("school_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_structures" ADD CONSTRAINT "fee_structures_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_structures" ADD CONSTRAINT "fee_structures_school_term_fk" FOREIGN KEY ("school_id","term_id") REFERENCES "public"."terms"("school_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_structures" ADD CONSTRAINT "fee_structures_school_grade_level_fk" FOREIGN KEY ("school_id","grade_level_id") REFERENCES "public"."grade_levels"("school_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_school_invoice_fk" FOREIGN KEY ("school_id","invoice_id") REFERENCES "public"."invoices"("school_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_school_student_fk" FOREIGN KEY ("school_id","student_id") REFERENCES "public"."students"("school_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_school_term_fk" FOREIGN KEY ("school_id","term_id") REFERENCES "public"."terms"("school_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_recorded_by_user_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_school_student_fk" FOREIGN KEY ("school_id","student_id") REFERENCES "public"."students"("school_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_school_invoice_fk" FOREIGN KEY ("school_id","invoice_id") REFERENCES "public"."invoices"("school_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fee_items_school_id_fee_structure_id_index" ON "fee_items" USING btree ("school_id","fee_structure_id");--> statement-breakpoint
CREATE INDEX "invoice_lines_school_id_invoice_id_index" ON "invoice_lines" USING btree ("school_id","invoice_id");--> statement-breakpoint
CREATE INDEX "invoices_school_id_student_id_index" ON "invoices" USING btree ("school_id","student_id");--> statement-breakpoint
CREATE INDEX "invoices_school_id_term_id_index" ON "invoices" USING btree ("school_id","term_id");--> statement-breakpoint
CREATE INDEX "payments_school_id_student_id_index" ON "payments" USING btree ("school_id","student_id");--> statement-breakpoint
CREATE INDEX "payments_school_id_invoice_id_index" ON "payments" USING btree ("school_id","invoice_id");--> statement-breakpoint

-- RLS for the fee and payment tables. Same shape as 0002 and 0003.
ALTER TABLE "fee_structures" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "fee_structures" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "fee_structures"
  FOR ALL USING ("school_id" = app_current_school())
  WITH CHECK ("school_id" = app_current_school());
--> statement-breakpoint

ALTER TABLE "fee_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "fee_items" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "fee_items"
  FOR ALL USING ("school_id" = app_current_school())
  WITH CHECK ("school_id" = app_current_school());
--> statement-breakpoint

ALTER TABLE "invoices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "invoices" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "invoices"
  FOR ALL USING ("school_id" = app_current_school())
  WITH CHECK ("school_id" = app_current_school());
--> statement-breakpoint

ALTER TABLE "invoice_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "invoice_lines" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "invoice_lines"
  FOR ALL USING ("school_id" = app_current_school())
  WITH CHECK ("school_id" = app_current_school());
--> statement-breakpoint

ALTER TABLE "payments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payments" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "payments"
  FOR ALL USING ("school_id" = app_current_school())
  WITH CHECK ("school_id" = app_current_school());
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON
  "fee_structures", "fee_items", "invoices", "invoice_lines", "payments"
  TO school_app;
--> statement-breakpoint

-- DELETE on the two template tables, and only those.
--
-- CLAUDE.md §3 rule 5 names what it protects: "students, invoices, payments,
-- and scores". Those are records of fact — what happened, and what a school
-- may be asked to account for years later. `fee_structures` and `fee_items`
-- are neither: they are the configuration an invoice is generated FROM, and
-- once generated the invoice carries its own copied lines (§5.7). Deleting a
-- fee item that was mistyped before any invoicing changes no record of
-- anything, while forcing a soft-delete would leave a bursar picking the
-- right "Tuition" out of three.
--
-- The invoices themselves are void-only, and payments reverse-only. Neither
-- gains DELETE.
GRANT DELETE ON "fee_structures", "fee_items" TO school_app;
