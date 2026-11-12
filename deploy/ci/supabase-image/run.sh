#!/usr/bin/env bash
# The schema on the pinned supabase/postgres image: the database a hosted or
# self-hosted Supabase install has (R468, Phase 2 of the AWS plan). Its
# sibling deploy/ci/rds-like/run.sh covers a plain PostgreSQL.
#
#   bash deploy/ci/supabase-image/run.sh
#       A new install. Every migration applies, none of the optional
#       extensions is skipped (this image has them all), no pg_cron job of
#       ours is left scheduled, every public table has RLS, PostgREST serves
#       it, and a second run applies nothing.
#
#   bash deploy/ci/supabase-image/run.sh --upgrade-from v1.6.0
#       An existing install. The migrations as they were at that git ref
#       (a release tag), two users signed up through GoTrue, then this
#       checkout's migrations on top: only the new ones may apply, none of
#       the released ones may be missing, and the schema afterwards must
#       still have everything the older release reads, writes and calls
#       (deploy/ci/migrations/schema-compat.mjs). That is what makes rolling
#       the app back one release safe: the older image runs on the newer
#       schema.
#
# Needs docker, git, node and openssl. Throwaway containers on a throwaway
# network, removed at the end; PostgREST and GoTrue listen on 127.0.0.1 only.
# Exits non-zero on the first wrong answer.
set -u
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/../../.." || exit 1
ROOT="$(pwd -W 2>/dev/null || pwd)"
LIB="$ROOT/deploy/ci/rds-like" # jwt.mjs, api-checks.mjs
FROM=""
case "${1:-}" in
  --upgrade-from) FROM="${2:?--upgrade-from needs a git ref, such as a release tag}" ;;
  "") ;;
  *) echo "usage: $0 [--upgrade-from <git ref>]"; exit 2 ;;
esac

# Pinned as the self-hosted stack pins them (scripts/setup-selfhosted.sh).
PG=supabase/postgres:17.6.1.136
GOTRUE=supabase/gotrue:v2.197.0
STORAGE=supabase/storage-api:v1.89.12
REST=postgrest/postgrest:v14.18

NET=sbimg-net
ALL="sbimg-db sbimg-auth sbimg-storage sbimg-rest"
PW="pw-$(openssl rand -hex 12)"
JWT_SECRET="$(openssl rand -hex 32)"
cleanup() { docker rm -f $ALL >/dev/null 2>&1; docker network rm $NET >/dev/null 2>&1; }
trap cleanup EXIT
cleanup
docker network create $NET >/dev/null

step() { echo; echo "== $*"; }
fail() { echo "FAILED: $*"; exit 1; }
# Checks run as the image's superuser; migrations run as postgres, as the
# Supabase CLI runs them.
sql() {
  docker exec -i -e PGPASSWORD="$PW" sbimg-db \
    psql -h 127.0.0.1 -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -tAX "$@"
}
migrate() { # migrations directory inside the container
  docker exec -e DATABASE_URL="postgres://postgres:$PW@127.0.0.1:5432/postgres" \
    sbimg-db bash /db-migrate/apply-migrations.sh "$1"
}
snapshot() { sql <"deploy/ci/migrations/schema-snapshot.sql"; }
wait_for() { # seconds, then a command that succeeds when ready
  local n=$1; shift
  for _ in $(seq 1 $((n / 2))); do "$@" >/dev/null 2>&1 && return 0; sleep 2; done
  return 1
}
rls_check() {
  sql -c "select count(*) || ' public tables, ' || count(*) filter (where c.relrowsecurity) || ' with RLS' from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r'"
  [ "$(sql -c "select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity")" = "0" ] \
    || fail "a public table without RLS: $(sql -c "select string_agg(c.relname, ', ') from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity")"
}
api_check() {
  docker restart sbimg-rest >/dev/null # its schema cache predates the migrations
  rest_ready() { [ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3468/)" = "200" ]; }
  wait_for 60 rest_ready || fail "PostgREST did not answer"
  node "$LIB/api-checks.mjs" http://127.0.0.1:3468 "$JWT_SECRET" || fail "API checks"
}

if [ -n "$FROM" ]; then
  git rev-parse --verify --quiet "$FROM^{commit}" >/dev/null \
    || fail "$FROM is not a commit here (in CI, check out with fetch-depth: 0 so tags are there)"
  BASE_VERSIONS=$(git ls-tree --name-only "$FROM" supabase/migrations/ \
    | sed -n 's#^supabase/migrations/\([0-9][0-9]*\)_.*\.sql$#\1#p' | sort)
  # No process per file: three hundred of them take a minute on Windows.
  HEAD_VERSIONS=$(for f in supabase/migrations/*.sql; do v=${f##*/}; echo "${v%%_*}"; done | sort)
  NEW_VERSIONS=$'\n'$(comm -13 <(echo "$BASE_VERSIONS") <(echo "$HEAD_VERSIONS"))$'\n'
  NEW_FILES=()
  for f in supabase/migrations/*.sql; do
    v=${f##*/}; v=${v%%_*}
    case "$NEW_VERSIONS" in *$'\n'"$v"$'\n'*) NEW_FILES+=("$f") ;; esac
  done
  MISSING=$(comm -23 <(echo "$BASE_VERSIONS") <(echo "$HEAD_VERSIONS"))
  [ -z "$MISSING" ] || fail "migrations released in $FROM are gone from this checkout: $MISSING. A released migration is never deleted or renumbered; add a new one instead."
  echo "upgrade from $FROM: $(echo "$BASE_VERSIONS" | grep -c .) released migrations, ${#NEW_FILES[@]} new"
fi

step "1. supabase/postgres, as a Supabase install runs it"
docker run -d --name sbimg-db --network $NET \
  -e POSTGRES_PASSWORD="$PW" -e JWT_SECRET="$JWT_SECRET" -e JWT_EXP=3600 \
  -v "$ROOT/docker/db-migrate:/db-migrate:ro" \
  -v "$ROOT/supabase/migrations:/migrations:ro" \
  "$PG" >/dev/null
# The first boot runs the image's own init (roles, extensions, pg_graphql),
# which takes a while on a busy machine.
wait_for 300 sql -c "select 1" || fail "postgres did not start: $(docker logs sbimg-db 2>&1 | tail -4)"
sql -c "select 'PostgreSQL ' || current_setting('server_version') || ', preloaded: ' || current_setting('shared_preload_libraries')"
# The stack's roles.sql gives the service roles the database password; so do we.
sql -q -c "alter role authenticator with password '$PW'; alter role supabase_auth_admin with password '$PW'; alter role supabase_storage_admin with password '$PW'; alter role postgres with password '$PW'" \
  || fail "setting the service roles' passwords"

step "2. GoTrue and storage-api install their own schemas"
docker run -d --name sbimg-auth --network $NET -p 127.0.0.1:3469:9999 \
  -e GOTRUE_API_HOST=0.0.0.0 -e GOTRUE_API_PORT=9999 -e API_EXTERNAL_URL=http://localhost:9999 \
  -e GOTRUE_DB_DRIVER=postgres \
  -e GOTRUE_DB_DATABASE_URL="postgres://supabase_auth_admin:$PW@sbimg-db:5432/postgres" \
  -e GOTRUE_SITE_URL=http://localhost:3000 -e GOTRUE_JWT_SECRET="$JWT_SECRET" \
  -e GOTRUE_JWT_AUD=authenticated -e GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated \
  -e GOTRUE_JWT_ADMIN_ROLES=service_role -e GOTRUE_JWT_EXP=3600 \
  -e GOTRUE_EXTERNAL_EMAIL_ENABLED=true -e GOTRUE_MAILER_AUTOCONFIRM=true \
  "$GOTRUE" >/dev/null
ANON=$(node "$LIB/jwt.mjs" "$JWT_SECRET" anon)
SERVICE=$(node "$LIB/jwt.mjs" "$JWT_SECRET" service_role)
docker run -d --name sbimg-rest --network $NET -p 127.0.0.1:3468:3000 \
  -e PGRST_DB_URI="postgres://authenticator:$PW@sbimg-db:5432/postgres" \
  -e PGRST_DB_SCHEMAS=public,storage -e PGRST_DB_ANON_ROLE=anon -e PGRST_JWT_SECRET="$JWT_SECRET" \
  "$REST" >/dev/null
docker run -d --name sbimg-storage --network $NET \
  -e ANON_KEY="$ANON" -e SERVICE_KEY="$SERVICE" -e POSTGREST_URL=http://sbimg-rest:3000 \
  -e AUTH_JWT_SECRET="$JWT_SECRET" \
  -e DATABASE_URL="postgres://supabase_storage_admin:$PW@sbimg-db:5432/postgres" \
  -e STORAGE_BACKEND=file -e FILE_STORAGE_BACKEND_PATH=/tmp/storage -e FILE_SIZE_LIMIT=52428800 \
  -e GLOBAL_S3_BUCKET=stub -e TENANT_ID=stub -e REGION=local \
  "$STORAGE" >/dev/null
# Ready means SERVING: each answers only once its own migrations are done
# (R467 measured a deadlock when ours started while storage-api's ran).
auth_ready() { docker logs sbimg-auth 2>&1 | grep -q "API started"; }
storage_ready() { docker exec sbimg-storage wget -q -O /dev/null http://127.0.0.1:5000/status; }
wait_for 180 auth_ready || fail "GoTrue: $(docker logs sbimg-auth 2>&1 | grep -E 'fatal|error' | tail -2 | cut -c1-240)"
wait_for 180 storage_ready || fail "storage-api: $(docker logs sbimg-storage 2>&1 | tail -3 | cut -c1-240)"
sql -c "select (select count(*) from auth.schema_migrations) || ' auth and ' || (select count(*) from storage.migrations) || ' storage migrations'"

if [ -z "$FROM" ]; then
  step "3. every migration, as postgres"
  out=$(migrate /migrations) || { echo "$out"; fail "migrations"; }
  echo "$out" | tail -3
  # The guards' own words (20260419112322, 20260510...): any other notice that
  # says "skipped" is about something else.
  echo "$out" | grep -q "is not available on this server" && fail "a migration skipped an extension this image has"

  step "4. what the migrations left behind"
  echo "  extensions: $(sql -c "select string_agg(extname, ', ' order by extname) from pg_extension where extname in ('vector','pg_net','pg_cron','pgmq','supabase_vault')")"
  [ "$(sql -c "select count(*) from pg_extension where extname in ('vector','pg_net','pg_cron','pgmq','supabase_vault')")" = "5" ] \
    || fail "an extension the migrations create on Supabase is missing"
  # Retention is the app's (trace_retention_days, provenance_retention_days),
  # never a fixed pg_cron purge (R467).
  jobs=$(sql -c "select coalesce(string_agg(jobname || ' [' || schedule || ']', ', '), '') from cron.job")
  [ -z "$jobs" ] || fail "pg_cron jobs left scheduled: $jobs"
  echo "  pg_cron jobs: none"
  rls_check

  step "5. PostgREST serves it"
  api_check

  step "6. again: an existing database changes nothing"
  again=$(migrate /migrations) || fail "migrations, second run"
  echo "$again" | tail -1
  echo "$again" | grep -q "^applied 0 migrations" || fail "a migration ran twice"
else
  step "3. the migrations released in $FROM"
  docker exec sbimg-db mkdir -p /tmp/released || fail "scratch directory"
  git archive "$FROM" supabase/migrations | docker exec -i sbimg-db tar -x -C /tmp/released \
    || fail "copying $FROM's migrations"
  out=$(migrate /tmp/released/supabase/migrations) || { echo "$out"; fail "the released migrations"; }
  echo "$out" | tail -1

  step "4. two users sign up, as on a database in use"
  for who in alice bob; do
    code=$(curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:3469/admin/users \
      -H "Authorization: Bearer $SERVICE" -H "Content-Type: application/json" \
      -d "{\"email\":\"$who-$(openssl rand -hex 4)@upgrade.test\",\"password\":\"$(openssl rand -hex 16)\",\"email_confirm\":true}")
    [ "$code" = "200" ] || fail "GoTrue refused to create $who: HTTP $code"
  done
  echo "  $(sql -c "select count(*) from auth.users") users, $(sql -c "select count(*) from public.profiles") profiles"
  BEFORE=$(snapshot) || fail "schema snapshot before"

  step "5. this checkout's migrations on top"
  out=$(migrate /migrations) || { echo "$out"; fail "upgrading from $FROM"; }
  echo "$out" | tail -1
  echo "$out" | grep -q "^applied ${#NEW_FILES[@]} migrations" \
    || fail "expected exactly the ${#NEW_FILES[@]} new migrations to apply"
  AFTER=$(snapshot) || fail "schema snapshot after"

  step "6. can $FROM still run on it?"
  printf '%s\n%s\n' "$BEFORE" "$AFTER" \
    | node deploy/ci/migrations/schema-compat.mjs "${NEW_FILES[@]+"${NEW_FILES[@]}"}" \
    || fail "the schema no longer has everything $FROM uses"
  rls_check

  step "7. PostgREST serves it"
  api_check
fi
echo
echo "PASSED"
