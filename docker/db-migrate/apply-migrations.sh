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

# One runner at a time (R480). Two deploy tasks starting together would each
# find the same migration missing and both run it. The lock is a session
# advisory lock held by a psql left open beside this script for as long as it
# runs; when this script exits for any reason, that psql's input closes, it
# ends, and the lock goes with it. A second runner waits here, then finds
# everything applied. MIGRATE_LOCK_TIMEOUT: seconds to wait (default 900).
LOCK_KEY=7465730480
coproc LOCK { "${P[@]}" -tA 2>&1; }
# Kept now: bash unsets LOCK and LOCK_PID once the coprocess ends, which it
# does at once when it cannot connect.
LOCK_OUT=${LOCK[0]}
LOCK_IN=${LOCK[1]}
LOCK_HOLDER=$LOCK_PID
trap 'eval "exec $LOCK_IN>&-" 2>/dev/null; wait "$LOCK_HOLDER" 2>/dev/null' EXIT
echo "select pg_advisory_lock($LOCK_KEY); select 'locked';" >&"$LOCK_IN" 2>/dev/null
got=""
while IFS= read -r -t "${MIGRATE_LOCK_TIMEOUT:-900}" line <&"$LOCK_OUT" 2>/dev/null; do
  [ "$line" = "locked" ] && { got=1; break; }
  # Anything else but the empty row pg_advisory_lock returns is an error.
  [ -n "$line" ] && echo "could not take the migration lock: $line" >&2
done
if [ -z "$got" ]; then
  echo "no migration lock after ${MIGRATE_LOCK_TIMEOUT:-900} s: another runner still holds it, or the database did not answer" >&2
  exit 1
fi

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
