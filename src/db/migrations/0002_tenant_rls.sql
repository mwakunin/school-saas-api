-- Row-level security for the tenant tables.
--
-- CLAUDE.md §4 treats the scoped client as the isolation mechanism and RLS as
-- optional hardening "layered underneath later". This inverts that. A scoped
-- client is a convention, and the failure mode of a convention is a single
-- forgotten `where` clause in a product holding children's records — silent,
-- invisible in review, and indistinguishable from correct code until a parent
-- at one school sees another school's pupils.
--
-- Applied now, while every table is empty. Retrofitting policies across 22
-- tables and live tenants is the same work, done later, with data to migrate
-- and outages to schedule.
--
-- Three things have to be true for this to be real rather than decorative:
--
--   1. The policies exist                      (this file)
--   2. They apply to the table's owner         (FORCE, below)
--   3. The app does not connect as a superuser (db/roles.sql + APP_DATABASE_URL)
--
-- Miss any one and the other two still look correct in `pg_policies`. There is
-- a test for each.

-- The tenant of the current transaction, or NULL if none was set.
--
-- NULLIF guards the empty string: `current_setting(..., true)` returns NULL for
-- a setting that was never assigned, but '' for one explicitly set to empty,
-- and ''::uuid raises rather than returning NULL. Without it a request that set
-- the variable to '' would 500 instead of simply seeing no rows.
--
-- A NULL result makes every `school_id = app_current_school()` comparison NULL,
-- which is not TRUE, so the row is filtered. Forgetting to set the tenant
-- therefore yields zero rows — never everything.
CREATE FUNCTION app_current_school() RETURNS uuid
  LANGUAGE sql
  STABLE
  AS $$ SELECT NULLIF(current_setting('app.school_id', true), '')::uuid $$;
--> statement-breakpoint

-- `schools` is scoped by its own primary key: a tenant may read its own row and
-- nothing else. Onboarding a school, listing every school and suspending a
-- non-payer all happen on the superadmin plane, which uses the owner
-- connection and is not subject to this.
ALTER TABLE "schools" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "schools" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "schools"
  FOR ALL
  USING ("id" = app_current_school())
  WITH CHECK ("id" = app_current_school());
--> statement-breakpoint

-- The rest are scoped by their school_id discriminator, which CLAUDE.md §3
-- rule 1 puts on every domain table for exactly this reason — including where
-- it is derivable through a foreign key, so that the policy is uniform and a
-- join is never required to evaluate it.
--
-- WITH CHECK matters as much as USING: without it a handler could still INSERT
-- or UPDATE a row into another school, which is the more damaging direction.
ALTER TABLE "memberships" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "memberships" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "memberships"
  FOR ALL
  USING ("school_id" = app_current_school())
  WITH CHECK ("school_id" = app_current_school());
--> statement-breakpoint

ALTER TABLE "academic_years" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "academic_years" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "academic_years"
  FOR ALL
  USING ("school_id" = app_current_school())
  WITH CHECK ("school_id" = app_current_school());
--> statement-breakpoint

ALTER TABLE "terms" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "terms" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "terms"
  FOR ALL
  USING ("school_id" = app_current_school())
  WITH CHECK ("school_id" = app_current_school());
--> statement-breakpoint

ALTER TABLE "grade_levels" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "grade_levels" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "grade_levels"
  FOR ALL
  USING ("school_id" = app_current_school())
  WITH CHECK ("school_id" = app_current_school());
--> statement-breakpoint

ALTER TABLE "streams" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "streams" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "streams"
  FOR ALL
  USING ("school_id" = app_current_school())
  WITH CHECK ("school_id" = app_current_school());
--> statement-breakpoint

-- Privileges for the runtime role.
--
-- SELECT, INSERT and UPDATE — deliberately NOT DELETE. CLAUDE.md §3 rule 5
-- says nothing hard-deletes: students, invoices, payments and scores are only
-- ever status-transitioned, and a withdrawn student must stay fully
-- queryable. Withholding the privilege turns that from a rule people have to
-- remember into one the database enforces, and a `DELETE` that slips through
-- review fails loudly in test rather than quietly destroying history.
--
-- The superadmin plane keeps the owner connection, so genuinely removing a
-- mistakenly-created row remains possible — but only from the plane built for
-- it, which is the right amount of friction.
GRANT SELECT, INSERT, UPDATE ON
  "schools", "memberships", "academic_years", "terms", "grade_levels", "streams"
  TO school_app;
--> statement-breakpoint

-- Better Auth owns these and needs full DML: signing out deletes a session,
-- and expired verification rows are cleaned up in place. They carry no
-- policies because identity is global, not tenant-scoped — one person may work
-- at two schools, and CLAUDE.md §5.1 makes that explicit.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "user", "session", "account", "verification"
  TO school_app;
