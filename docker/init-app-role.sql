-- The unprivileged role the application connects as.
--
-- Why this exists at all: Postgres row-level security does not apply to a
-- table's OWNER. `school` owns every table (it runs the migrations), so if the
-- app also connected as `school`, every RLS policy would be silently inert and
-- the tenant isolation in CLAUDE.md §4 would be decoration. `ALTER TABLE ...
-- FORCE ROW LEVEL SECURITY` closes that too, and the first domain migration
-- sets it — but two independent guards is the right number for the one bug
-- that would leak one school's children's records to another.
--
-- Deliberately created with no privileges. The GRANTs, and the policies they
-- operate under, arrive with the first domain migration (step 2: tenancy +
-- academic spine) — a role granted access to tables that do not exist yet is
-- not a useful thing to write, and granting broadly "for now" is how an
-- unprivileged role stops being unprivileged.
--
-- NOBYPASSRLS and NOSUPERUSER are the defaults, but stated so that a future
-- edit has to actively remove them.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'school_app') THEN
    CREATE ROLE school_app
      LOGIN PASSWORD 'school_app'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;

-- Lets the role see the schema. It still cannot read a single row until the
-- first domain migration grants table privileges.
GRANT USAGE ON SCHEMA public TO school_app;
