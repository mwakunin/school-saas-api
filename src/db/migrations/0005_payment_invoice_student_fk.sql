-- A payment could name one child and settle another child's invoice.
--
-- `payments` referenced students and invoices through two separate composite
-- keys — (school_id, student_id) and (school_id, invoice_id). Each is true on
-- its own, so a row naming child A while pointing at child B's invoice
-- satisfied both and was accepted. The money then reads as credited to A on
-- the ledger and as settling B's bill on the invoice, and nothing in the
-- database disagrees.
--
-- The fix is the same one the rest of the schema already uses: put the thing
-- that must match into the reference itself. A payment's invoice is now
-- resolved by (school_id, invoice_id, student_id), so the pair cannot
-- disagree.
--
-- `invoice_id` stays nullable for a credit on account. Under the default MATCH
-- SIMPLE a NULL in any referencing column disables the constraint for that
-- row, which is exactly what an unallocated payment needs.
--
-- Ordered deliberately: the unique key has to exist before the foreign key
-- that references it. drizzle-kit generated these the other way round, which
-- fails.

ALTER TABLE "invoices"
  ADD CONSTRAINT "invoices_school_id_id_student_id_key"
  UNIQUE ("school_id", "id", "student_id");
--> statement-breakpoint

ALTER TABLE "payments" DROP CONSTRAINT "payments_school_invoice_fk";
--> statement-breakpoint

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_school_invoice_student_fk"
  FOREIGN KEY ("school_id", "invoice_id", "student_id")
  REFERENCES "public"."invoices" ("school_id", "id", "student_id")
  ON DELETE no action ON UPDATE no action;
