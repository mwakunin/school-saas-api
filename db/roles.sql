-- The unprivileged role the application serves traffic as.
--
-- Why this exists at all: Postgres row-level security does not apply to a
-- table's OWNER, and is bypassed outright by a SUPERUSER. The local Docker
-- role `school` is both — it owns the tables because it runs the migrations,
-- and POSTGRES_USER is a superuser. If the app connected as `school`, every
-- RLS policy would be silently inert and the tenant isolation in CLAUDE.md §4
-- would be decoration that tests could not tell apart from the real thing.
--
-- `ALTER TABLE ... FORCE ROW LEVEL SECURITY` (see the RLS migration) closes
-- the owner half. It does NOT close the superuser half. Only connecting as a
-- different, unprivileged role does that — which is why both exist.
--
-- NOBYPASSRLS and NOSUPERUSER are already the defaults. They are stated so a
-- future edit has to actively remove them.
--
-- Run this once per database, as a superuser:
--
--   local dev   mounted into /docker-entrypoint-initdb.d (docker-compose.yml)
--   CI          an explicit psql step (.github/workflows/ci.yml)
--   Neon        psql "$ADMIN_URL" -f db/roles.sql
--
-- The password here is a local-development default. Production must set its
-- own out of band:  ALTER ROLE school_app PASSWORD '...';
--
-- ---------------------------------------------------------------------------
-- DEPLOYMENT REQUIREMENT for the OTHER connection (DATABASE_URL)
--
-- `FORCE ROW LEVEL SECURITY` subjects even a table's owner to the policies.
-- That is deliberate — it closes the owner-exemption half of the problem — but
-- it means the owner connection keeps its cross-tenant reach only if its role
-- is a SUPERUSER or holds BYPASSRLS.
--
-- Locally and in CI it is a superuser, because Docker's POSTGRES_USER is one.
-- On a managed provider it usually is not: Neon's default role owns the tables
-- and is not a superuser, so `db` would quietly fall under the policies —
-- migrations still apply, but the superadmin plane lists zero schools and the
-- test harness truncates nothing.
--
-- So provision DATABASE_URL from a role that can bypass. On Neon that is
-- `neon_superuser`; elsewhere:  ALTER ROLE <owner> BYPASSRLS;
--
-- `rls.test.ts` asserts this, so a deployment that gets it wrong fails a test
-- rather than behaving strangely in production.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'school_app') THEN
    CREATE ROLE school_app
      LOGIN PASSWORD 'school_app'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;

-- Lets the role reach the schema at all. Table privileges are granted by the
-- migration that creates the tables, alongside the policies that constrain
-- them — a grant written here would drift out of step with the schema.
GRANT USAGE ON SCHEMA public TO school_app;
