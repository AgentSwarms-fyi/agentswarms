#!/usr/bin/env bash
# Apply AgentSwarms' migrations to any PostgreSQL, as its admin (R467).
#
#   DATABASE_URL=postgres://admin:...@host:5432/postgres?sslmode=require \
#     bash docker/db-migrate/apply-migrations.sh [migrations dir]
#
# For a database the Supabase CLI cannot push to: a managed Postgres whose
# admin is not a superuser (Amazon RDS among them), or a deploy that runs
# migrations as a one-off task. Each file runs in its own transaction, in
# order, and is recorded in supabase_migrations.schema_migrations exactly as
# the CLI records it, so the CLI and this script can take turns on the same
# database: whichever runs next applies only what is missing.
#
# Prints the optional extensions a migration skipped (pg_net, pgmq,
# supabase_vault, pg_cron: absent on RDS) and stops at the first failure,
# with the server's own error. Safe to run again.
#
# Order on a plain Postgres (docs/DEPLOYMENT.md, "Plain PostgreSQL"):
#   deploy/aws/spec/bootstrap/rds-bootstrap.sql, then GoTrue and storage-api
#   start once (each installs its own schema), then this.
set -uo pipefail
DIR="${1:-${MIGRATIONS_DIR:-$(cd "$(dirname "$0")/../.." && pwd)/supabase/migrations}}"
: "${DATABASE_URL:?set DATABASE_URL to the connection string of the database admin}"
P=(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -X)

"${P[@]}" -c "SET client_min_messages = warning;
  CREATE SCHEMA IF NOT EXISTS supabase_migrations;
  CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (
    version text PRIMARY KEY, statements text[], name text
  );" >/dev/null || exit 1

applied=0
already=0
for f in "$DIR"/*.sql; do
  base=$(basename "$f" .sql)
  version=${base%%_*}
  name=${base#*_}
  if [ "$("${P[@]}" -tAc "select 1 from supabase_migrations.schema_migrations where version = '$version'")" = "1" ]; then
    already=$((already + 1))
    continue
  fi
  if ! out=$("${P[@]}" -1 -f "$f" 2>&1); then
    echo "FAILED at $base ($applied applied before it)"
    echo "$out" | grep -E "ERROR|LINE|DETAIL|HINT|CONTEXT" | head -8
    exit 1
  fi
  echo "$out" | grep -E "NOTICE:.*(not available|skipped)" | sed -E "s/^.*NOTICE: +/  $version: /" || true
  "${P[@]}" -c "insert into supabase_migrations.schema_migrations (version, name) values ('$version', '$name')" >/dev/null
  applied=$((applied + 1))
done
echo "applied $applied migrations ($already already applied)"
