CREATE TABLE "mpesa_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_id" uuid NOT NULL,
	"transaction_id" text NOT NULL,
	"shortcode" text NOT NULL,
	"account_reference" text,
	"msisdn" text NOT NULL,
	"payer_name" text,
	"amount_cents" integer NOT NULL,
	"transacted_at" timestamp with time zone NOT NULL,
	"raw_payload" jsonb NOT NULL,
	"status" text DEFAULT 'unmatched' NOT NULL,
	"status_reason" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mpesa_transactions_transactionId_unique" UNIQUE("transaction_id"),
	CONSTRAINT "mpesa_transactions_school_id_id_key" UNIQUE("school_id","id"),
	CONSTRAINT "mpesa_transactions_amount_whole" CHECK ("mpesa_transactions"."amount_cents" % 100 = 0 AND "mpesa_transactions"."amount_cents" > 0)
);
--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "mpesa_transaction_id" uuid;--> statement-breakpoint
ALTER TABLE "schools" ADD COLUMN "mpesa_callback_token" text;--> statement-breakpoint
ALTER TABLE "mpesa_transactions" ADD CONSTRAINT "mpesa_transactions_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mpesa_transactions_school_id_status_index" ON "mpesa_transactions" USING btree ("school_id","status");--> statement-breakpoint
CREATE INDEX "mpesa_transactions_school_id_account_reference_index" ON "mpesa_transactions" USING btree ("school_id","account_reference");--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_school_mpesa_transaction_fk" FOREIGN KEY ("school_id","mpesa_transaction_id") REFERENCES "public"."mpesa_transactions"("school_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payments_one_live_per_mpesa_transaction" ON "payments" USING btree ("mpesa_transaction_id") WHERE "payments"."reversed_at" IS NULL;--> statement-breakpoint
ALTER TABLE "schools" ADD CONSTRAINT "schools_mpesaCallbackToken_unique" UNIQUE("mpesa_callback_token");--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_mpesa_has_transaction" CHECK (("payments"."method" = 'mpesa') = ("payments"."mpesa_transaction_id" IS NOT NULL));--> statement-breakpoint

-- The raw confirmation is append-only, enforced rather than promised.
--
-- CLAUDE.md §5.8 rests a load-bearing claim on this: "because the raw row is
-- never mutated, mis-allocation is always reversible and 'where did this KES
-- 15,000 go' is always answerable". A comment cannot make that true. A handler
-- that helpfully "corrected" an amount or a reference would destroy the only
-- independent record of what Safaricom actually said, and the corruption would
-- be undetectable afterwards precisely because the evidence is the thing that
-- changed.
--
-- Status and its reason are the exception: matching a transaction is a
-- decision ABOUT the row, not a revision of it.
CREATE FUNCTION mpesa_transactions_immutable() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.school_id IS DISTINCT FROM OLD.school_id
    OR NEW.transaction_id IS DISTINCT FROM OLD.transaction_id
    OR NEW.shortcode IS DISTINCT FROM OLD.shortcode
    OR NEW.account_reference IS DISTINCT FROM OLD.account_reference
    OR NEW.msisdn IS DISTINCT FROM OLD.msisdn
    OR NEW.payer_name IS DISTINCT FROM OLD.payer_name
    OR NEW.amount_cents IS DISTINCT FROM OLD.amount_cents
    OR NEW.transacted_at IS DISTINCT FROM OLD.transacted_at
    OR NEW.raw_payload IS DISTINCT FROM OLD.raw_payload
    OR NEW.received_at IS DISTINCT FROM OLD.received_at
  THEN
    RAISE EXCEPTION
      'mpesa_transactions is append-only: only status and status_reason may change'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER mpesa_transactions_immutable
  BEFORE UPDATE ON "mpesa_transactions"
  FOR EACH ROW EXECUTE FUNCTION mpesa_transactions_immutable();
--> statement-breakpoint

-- RLS, same shape as every other tenant table.
--
-- Note what this does NOT protect: the webhook resolves its school from an
-- unguessable token in the path and writes on the owner connection, because at
-- that point there is no session and no subdomain to scope by. The policy
-- still governs every read and every allocation afterwards.
ALTER TABLE "mpesa_transactions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "mpesa_transactions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "mpesa_transactions"
  FOR ALL USING ("school_id" = app_current_school())
  WITH CHECK ("school_id" = app_current_school());
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON "mpesa_transactions" TO school_app;
