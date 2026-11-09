-- What a plain PostgreSQL needs before Supabase's services and AgentSwarms'
-- migrations can install on it (R467, Phase 2 of the AWS plan).
--
-- The supabase/postgres image does this in its own init scripts, as a
-- superuser. A managed Postgres (Amazon RDS, Aurora, Cloud SQL, Azure) has no
-- superuser to give: its admin can create roles, databases and the extensions
-- the provider allows, and nothing more. This is the subset of those init
-- scripts such an admin can run, and that the services actually use:
--
--   roles     anon, authenticated, service_role (the API roles PostgREST
--             switches into), authenticator (the one PostgREST logs in as),
--             supabase_auth_admin (GoTrue), supabase_storage_admin (storage)
--   schemas   extensions, auth (GoTrue installs into it), storage (likewise)
--   other     the supabase_realtime publication four migrations add tables to,
--             default privileges so tables the admin creates are visible to
--             the API roles as on Supabase
--
-- Run it once, as the database admin, before GoTrue, storage-api and the
-- migrations (docker/db-migrate does all three in order):
--
--   psql "$ADMIN_URL" -v ON_ERROR_STOP=1 \
--     -v authenticator_password=... -v auth_admin_password=... \
--     -v storage_admin_password=... -f rds-bootstrap.sql
--
-- It is safe to run again: every statement checks before it creates.
--
-- service_role is created BYPASSRLS, as on Supabase: the app's server-side
-- client relies on it. A managed Postgres decides whether its admin may grant
-- that attribute. Where it may not, this stops on that statement with the
-- server's own error rather than installing a stack that would fail later.

\set ON_ERROR_STOP on

-- ── The publication Realtime reads (and four migrations add tables to) ──────
SELECT 'CREATE PUBLICATION supabase_realtime'
WHERE NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
\gexec

-- ── Roles ───────────────────────────────────────────────────────────────────
-- NOLOGIN NOINHERIT: nobody signs in as these; PostgREST SET ROLEs into them.
SELECT format('CREATE ROLE %I NOLOGIN NOINHERIT', r)
FROM unnest(ARRAY['anon', 'authenticated']) AS r
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r)
\gexec

SELECT 'CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role')
\gexec

-- Login roles: created without a password, given one right after, so that a
-- second run sets the password it was given.
SELECT format('CREATE ROLE %I LOGIN NOINHERIT', r)
FROM unnest(ARRAY['authenticator', 'supabase_auth_admin', 'supabase_storage_admin']) AS r
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r)
\gexec

ALTER ROLE authenticator WITH PASSWORD :'authenticator_password';
ALTER ROLE supabase_auth_admin WITH PASSWORD :'auth_admin_password';
ALTER ROLE supabase_storage_admin WITH PASSWORD :'storage_admin_password';

-- PostgREST logs in as authenticator and switches to whichever API role the
-- request's JWT names.
GRANT anon, authenticated, service_role TO authenticator;
-- storage-api switches into the API roles itself, to apply storage RLS as the
-- caller (the supabase image grants the same).
GRANT anon, authenticated, service_role TO supabase_storage_admin;

ALTER ROLE anon SET statement_timeout = '3s';
ALTER ROLE authenticated SET statement_timeout = '8s';
ALTER ROLE authenticator SET statement_timeout = '8s';
ALTER ROLE supabase_auth_admin SET search_path = auth;
ALTER ROLE supabase_storage_admin SET search_path = storage;

-- ── Schemas ─────────────────────────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS extensions;
GRANT USAGE ON SCHEMA extensions TO anon, authenticated, service_role;

-- The admin becomes a member of the two service roles first. Since
-- PostgreSQL 16 a role's creator holds it WITH ADMIN but is not a member, and
-- giving a schema to a role needs SET ROLE to it ("must be able to SET ROLE",
-- measured). The membership also lets the app's migrations, run as the admin,
-- reference auth.users and storage.objects (foreign keys, policies).
GRANT supabase_auth_admin, supabase_storage_admin TO CURRENT_USER;

-- GoTrue and storage-api own their schemas and create everything in them.
CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION supabase_auth_admin;
CREATE SCHEMA IF NOT EXISTS storage AUTHORIZATION supabase_storage_admin;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA storage TO anon, authenticated, service_role;

-- ── The public schema, as Supabase sets it up ───────────────────────────────
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;

-- ── Extensions every install needs ─────────────────────────────────────────
-- pgvector (knowledge-base embeddings) and the two the API roles' defaults
-- use. Each is on every managed Postgres's allowed list.
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS vector;
