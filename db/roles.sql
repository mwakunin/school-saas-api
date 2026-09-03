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
