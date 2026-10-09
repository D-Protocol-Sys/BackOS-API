-- =============================================================================
-- ONE-OFF UPGRADE for an EXISTING PostgreSQL volume (the init scripts only run on an empty one).
--
-- Run it ONCE, as the superuser (POSTGRES_USER), connected to POSTGRES_DB, BEFORE starting the
-- new orchestrator version, e.g.:
--
--   docker exec -i <project>-prod-postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
--     -v app_role="$POSTGRES_APP_USER" -v app_password="$POSTGRES_APP_PASSWORD" \
--     -v provision_role="$POSTGRES_PROVISIONING_ROLE" -v app_db="$POSTGRES_DB" \
--     -v ON_ERROR_STOP=1 < docker/upgrade/2026-09-30-least-privilege.sql
--
-- What it does (same end state as docker/postgres-init/02-app-role.sh):
--   1. creates the non-superuser application role (or resets its password);
--   2. transfers ownership of POSTGRES_DB, schema public and every object in it to that role;
--   3. revokes CONNECT from PUBLIC on POSTGRES_DB and on the `postgres` maintenance database.
-- It does NOT touch the tenant databases of generated platforms.
-- =============================================================================

SELECT format('CREATE ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE', :'app_role')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app_role') \gexec

SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L', :'app_role', :'app_password') \gexec

SELECT format('ALTER DATABASE %I OWNER TO %I', :'app_db', :'app_role') \gexec
SELECT format('ALTER SCHEMA public OWNER TO %I', :'app_role') \gexec

-- Tables (incl. partitioned), sequences not owned by a column, views, materialized views.
SELECT format('ALTER TABLE public.%I OWNER TO %I', c.relname, :'app_role')
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') \gexec

SELECT format('ALTER SEQUENCE public.%I OWNER TO %I', c.relname, :'app_role')
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'S'
  AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'a') \gexec

SELECT format('ALTER VIEW public.%I OWNER TO %I', c.relname, :'app_role')
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'v' \gexec

SELECT format('ALTER MATERIALIZED VIEW public.%I OWNER TO %I', c.relname, :'app_role')
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'm' \gexec

-- Enum / composite / domain types created by Prisma migrations.
SELECT format('ALTER TYPE public.%I OWNER TO %I', t.typname, :'app_role')
FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
WHERE n.nspname = 'public' AND t.typtype IN ('e', 'c', 'd')
  AND NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.reltype = t.oid AND c.relkind <> 'c') \gexec

-- Functions / procedures, if any.
SELECT format('ALTER ROUTINE public.%I(%s) OWNER TO %I', p.proname, pg_get_function_identity_arguments(p.oid), :'app_role')
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' \gexec

SELECT format('REVOKE CONNECT, TEMPORARY ON DATABASE %I FROM PUBLIC', :'app_db') \gexec
SELECT format('GRANT CONNECT, TEMPORARY ON DATABASE %I TO %I', :'app_db', :'app_role') \gexec
REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;
SELECT format('GRANT CONNECT ON DATABASE postgres TO %I', :'provision_role') \gexec
