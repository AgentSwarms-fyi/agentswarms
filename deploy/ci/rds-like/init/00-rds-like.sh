#!/bin/bash
# An RDS-shaped server: the superuser (rdsadmin) is the provider's, and the
# admin the customer gets (postgres) can create roles and databases but is
# not a superuser. RDS_BYPASSRLS=yes gives that admin BYPASSRLS, so it may
# grant it to service_role; whether RDS's master user has it is Phase 0's
# question (docs/DEPLOYMENT.md, "Plain PostgreSQL").
set -euo pipefail
attrs="LOGIN CREATEROLE CREATEDB"
[ "${RDS_BYPASSRLS:-no}" = "yes" ] && attrs="$attrs BYPASSRLS"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<SQL
CREATE ROLE postgres $attrs PASSWORD '${MASTER_PASSWORD}';
ALTER DATABASE postgres OWNER TO postgres;
-- RDS lets its admin create the extensions on its allowed list, trusted or
-- not; a plain Postgres lets only a superuser create an untrusted one.
-- pgvector is on RDS's list and untrusted here (measured), so the provider's
-- superuser creates it, standing in for that allowance. The bootstrap's own
-- CREATE EXTENSION then finds it.
CREATE EXTENSION IF NOT EXISTS vector;
SQL
echo "rds-like: admin 'postgres' created with: $attrs"
