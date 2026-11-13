-- The lakehouse catalog's own role and database on the same PostgreSQL
-- (R479). Compose runs the catalog as a container of its own; on RDS it is a
-- second database beside Supabase's, owned by its own login role, so the
-- app's DuckLake connection can touch nothing else.
--
-- Run by db-migrate's `bootstrap` when LAKEHOUSE_CATALOG_PASSWORD is set, as
-- the database admin (not a superuser on RDS), with
--   psql -v lakehouse_password=...
-- Safe to run again: it creates what is missing and sets the password.

SELECT 'CREATE ROLE lakehouse LOGIN NOINHERIT'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lakehouse')
\gexec

ALTER ROLE lakehouse WITH PASSWORD :'lakehouse_password';

-- The admin may create a database owned by a role only as a member of it
-- (PostgreSQL 16 and later: with SET, which a plain GRANT gives). Left in
-- place: the admin can do what lakehouse can anyway, and revoking it could
-- take the ADMIN option a second run needs to set the password.
GRANT lakehouse TO CURRENT_USER;

SELECT 'CREATE DATABASE lakehouse_catalog OWNER lakehouse'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'lakehouse_catalog')
\gexec

-- Nobody else may connect to it.
REVOKE ALL ON DATABASE lakehouse_catalog FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE lakehouse_catalog TO lakehouse;
