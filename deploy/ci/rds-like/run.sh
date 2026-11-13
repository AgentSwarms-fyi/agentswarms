#!/usr/bin/env bash
# The whole schema on an RDS-shaped PostgreSQL, the way a managed database's
# admin installs it (R467, Phase 2 of the AWS plan; docs/DEPLOYMENT.md,
# "Plain PostgreSQL"):
#
#   1. PostgreSQL 17 + pgvector, no Supabase init scripts, whose admin
#      ("postgres") can create roles and databases but is not a superuser
#   2. deploy/aws/spec/bootstrap/rds-bootstrap.sql, as that admin
#   3. GoTrue (the pinned version) installs auth, as supabase_auth_admin
#   4. storage-api (pinned) installs storage, as supabase_storage_admin
#   5. docker/db-migrate/apply-migrations.sh: every migration, as the admin
#   6. PostgREST (pinned) serves it: RLS between two users, service_role
#      (BYPASSRLS) sees both
#   7. migrations and bootstrap again: nothing re-applies, nothing fails
#
#   bash deploy/ci/rds-like/run.sh            # the admin may grant BYPASSRLS
#   MIGRATOR_IMAGE=ghcr.io/agentswarms-fyi/db-migrate:1.7.0 bash deploy/ci/rds-like/run.sh
#                                             # steps 2, 5 and 7 from a db-migrate
#                                             # image instead of this checkout
#   RDS_BYPASSRLS=no bash deploy/ci/rds-like/run.sh
#                                             # it may not: the bootstrap must
#                                             # stop, with the server's reason
#
# Needs docker, node and openssl. Throwaway containers on a throwaway
# network, removed at the end; nothing is published but PostgREST on
# 127.0.0.1:3467. Exits non-zero on the first wrong answer.
set -u
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/../../.." || exit 1
ROOT="$(pwd -W 2>/dev/null || pwd)"
HERE="$ROOT/deploy/ci/rds-like"
BYPASS="${RDS_BYPASSRLS:-yes}"

# Pinned as the self-hosted stack pins them (scripts/setup-selfhosted.sh).
PG=pgvector/pgvector:0.8.1-pg17@sha256:3e8b3adfd27b5707128f60956f62a793c3c9326ea8cfaf0eab7adccb5d700b21
GOTRUE=supabase/gotrue:v2.197.0
STORAGE=supabase/storage-api:v1.89.12
REST=postgrest/postgrest:v14.18

NET=rdslike-net
ALL="rdslike-db rdslike-auth rdslike-storage rdslike-rest"
MASTER_PASSWORD="master-$(openssl rand -hex 12)"
SVC_PASSWORD="svc-$(openssl rand -hex 12)"
JWT_SECRET="$(openssl rand -hex 32)"
cleanup() { docker rm -f $ALL >/dev/null 2>&1; docker network rm $NET >/dev/null 2>&1; }
trap cleanup EXIT
cleanup
docker network create $NET >/dev/null

step() { echo; echo "== $*"; }
fail() { echo "FAILED: $*"; exit 1; }
sql() {
  docker exec -e PGPASSWORD="$MASTER_PASSWORD" rdslike-db \
    psql -h 127.0.0.1 -U postgres -d postgres -v ON_ERROR_STOP=1 -tAc "$1"
}
# MIGRATOR_IMAGE=<a built db-migrate image> runs the bootstrap and the
# migrations from that image, as a deploy's one-off task does (R469), instead
# of from this checkout.
MIGRATOR_IMAGE="${MIGRATOR_IMAGE:-}"
ADMIN_URL_IN_NET="postgres://postgres:$MASTER_PASSWORD@rdslike-db:5432/postgres"
bootstrap() { # authenticator, auth admin and storage admin passwords
  if [ -n "$MIGRATOR_IMAGE" ]; then
    docker run --rm --network $NET -e DATABASE_URL="$ADMIN_URL_IN_NET" \
      -e AUTHENTICATOR_PASSWORD="$1" -e AUTH_ADMIN_PASSWORD="$2" -e STORAGE_ADMIN_PASSWORD="$3" \
      "$MIGRATOR_IMAGE" bootstrap 2>&1
    return
  fi
  docker exec -e PGPASSWORD="$MASTER_PASSWORD" rdslike-db psql -h 127.0.0.1 -U postgres -d postgres -q \
    -v authenticator_password="$1" -v auth_admin_password="$2" -v storage_admin_password="$3" \
    -f /bootstrap/rds-bootstrap.sql 2>&1
}
migrate() {
  if [ -n "$MIGRATOR_IMAGE" ]; then
    docker run --rm --network $NET -e DATABASE_URL="$ADMIN_URL_IN_NET" "$MIGRATOR_IMAGE" migrate
    return
  fi
  docker exec -e DATABASE_URL="postgres://postgres:$MASTER_PASSWORD@127.0.0.1:5432/postgres" \
    rdslike-db bash /db-migrate/apply-migrations.sh /migrations
}
wait_for() { # seconds, then a command that succeeds when ready
  local n=$1; shift
  for _ in $(seq 1 $((n / 2))); do "$@" >/dev/null 2>&1 && return 0; sleep 2; done
  return 1
}

step "1. PostgreSQL 17 + pgvector; the admin is not a superuser (BYPASSRLS: $BYPASS)"
docker run -d --name rdslike-db --network $NET \
  -e POSTGRES_USER=rdsadmin -e POSTGRES_PASSWORD="$(openssl rand -hex 12)" -e POSTGRES_DB=postgres \
  -e MASTER_PASSWORD="$MASTER_PASSWORD" -e RDS_BYPASSRLS="$BYPASS" \
  -v "$HERE/init:/docker-entrypoint-initdb.d:ro" \
  -v "$ROOT/deploy/aws/spec/bootstrap:/bootstrap:ro" \
  -v "$ROOT/docker/db-migrate:/db-migrate:ro" \
  -v "$ROOT/supabase/migrations:/migrations:ro" \
  "$PG" >/dev/null
wait_for 180 sql "select 1" || fail "postgres did not start: $(docker logs rdslike-db 2>&1 | tail -3)"
sql "select current_user || ': superuser=' || rolsuper || ', bypassrls=' || rolbypassrls || ', PostgreSQL ' || current_setting('server_version') from pg_roles where rolname = current_user"

step "2. rds-bootstrap.sql, as the admin"
if ! out=$(bootstrap "$SVC_PASSWORD" "$SVC_PASSWORD" "$SVC_PASSWORD"); then
  echo "$out" | grep -E "ERROR|DETAIL|HINT" | head -4
  if [ "$BYPASS" = "no" ] && echo "$out" | grep -q "BYPASSRLS"; then
    echo "  as expected: an admin without BYPASSRLS cannot create service_role, and the bootstrap stops before installing anything"
    exit 0
  fi
  fail "bootstrap"
fi
[ "$BYPASS" = "no" ] && fail "the bootstrap succeeded although the admin may not grant BYPASSRLS"
sql "select string_agg(rolname || case when rolbypassrls then ' (bypassrls)' else '' end, ', ' order by rolname) from pg_roles where rolname in ('anon','authenticated','service_role','authenticator','supabase_auth_admin','supabase_storage_admin')"

step "3. GoTrue installs auth"
docker run -d --name rdslike-auth --network $NET \
  -e GOTRUE_API_HOST=0.0.0.0 -e GOTRUE_API_PORT=9999 -e API_EXTERNAL_URL=http://localhost:9999 \
  -e GOTRUE_DB_DRIVER=postgres \
  -e GOTRUE_DB_DATABASE_URL="postgres://supabase_auth_admin:$SVC_PASSWORD@rdslike-db:5432/postgres" \
  -e GOTRUE_SITE_URL=http://localhost:3000 -e GOTRUE_JWT_SECRET="$JWT_SECRET" \
  -e GOTRUE_JWT_AUD=authenticated -e GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated \
  -e GOTRUE_JWT_ADMIN_ROLES=service_role -e GOTRUE_JWT_EXP=3600 \
  "$GOTRUE" >/dev/null
auth_ready() { docker logs rdslike-auth 2>&1 | grep -q "API started"; }
wait_for 180 auth_ready || fail "GoTrue: $(docker logs rdslike-auth 2>&1 | grep -E 'fatal|error' | tail -2 | cut -c1-240)"
sql "select count(*) || ' auth migrations; auth.uid() ' || (to_regprocedure('auth.uid()') is not null) || ', auth.jwt() ' || (to_regprocedure('auth.jwt()') is not null) from auth.schema_migrations"

step "4. storage-api installs storage"
ANON=$(node "$HERE/jwt.mjs" "$JWT_SECRET" anon)
SERVICE=$(node "$HERE/jwt.mjs" "$JWT_SECRET" service_role)
docker run -d --name rdslike-rest --network $NET -p 127.0.0.1:3467:3000 \
  -e PGRST_DB_URI="postgres://authenticator:$SVC_PASSWORD@rdslike-db:5432/postgres" \
  -e PGRST_DB_SCHEMAS=public,storage -e PGRST_DB_ANON_ROLE=anon -e PGRST_JWT_SECRET="$JWT_SECRET" \
  "$REST" >/dev/null
docker run -d --name rdslike-storage --network $NET \
  -e ANON_KEY="$ANON" -e SERVICE_KEY="$SERVICE" -e POSTGREST_URL=http://rdslike-rest:3000 \
  -e AUTH_JWT_SECRET="$JWT_SECRET" \
  -e DATABASE_URL="postgres://supabase_storage_admin:$SVC_PASSWORD@rdslike-db:5432/postgres" \
  -e STORAGE_BACKEND=file -e FILE_STORAGE_BACKEND_PATH=/tmp/storage -e FILE_SIZE_LIMIT=52428800 \
  -e GLOBAL_S3_BUCKET=stub -e TENANT_ID=stub -e REGION=local \
  "$STORAGE" >/dev/null
# Ready means SERVING, which storage-api only does once its own migrations are
# done. A column it adds partway (buckets.public) is not enough: measured, the
# app's migrations then locked storage.buckets while storage-api was still
# altering it, and one of them died with "deadlock detected".
storage_ready() {
  docker exec rdslike-storage wget -q -O /dev/null http://127.0.0.1:5000/status
}
wait_for 180 storage_ready || fail "storage-api: $(docker logs rdslike-storage 2>&1 | tail -3 | cut -c1-240)"
sql "select count(*) || ' storage migrations' from storage.migrations"

step "5. every migration, as the admin"
migrate || fail "migrations"

step "6. PostgREST serves it"
docker restart rdslike-rest >/dev/null # its schema cache predates the migrations
rest_ready() { [ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3467/)" = "200" ]; }
wait_for 60 rest_ready || fail "PostgREST did not answer"
node "$HERE/api-checks.mjs" http://127.0.0.1:3467 "$JWT_SECRET" || fail "API checks"
sql "select count(*) || ' public tables, ' || count(*) filter (where c.relrowsecurity) || ' with RLS' from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r'"
[ "$(sql "select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity")" = "0" ] \
  || fail "a public table without RLS"

step "7. everything again: an existing database changes nothing"
again=$(migrate) || fail "migrations, second run"
echo "$again" | tail -1
echo "$again" | grep -q "^applied 0 migrations" || fail "a migration ran twice"
bootstrap again-1 again-2 again-3 >/dev/null || fail "bootstrap, second run"
echo "  bootstrap again: ok"
if [ -n "$MIGRATOR_IMAGE" ]; then
  st=$(docker run --rm --network $NET -e DATABASE_URL="$ADMIN_URL_IN_NET" "$MIGRATOR_IMAGE" status) \
    || fail "db-migrate status"
  echo "  $st" | head -1
  echo "$st" | grep -q ", 0 pending$" || fail "db-migrate status: $st"
fi
echo
echo "PASSED"
