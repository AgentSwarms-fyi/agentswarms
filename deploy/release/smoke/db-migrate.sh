#!/usr/bin/env bash
# The db-migrate image: it carries this checkout's migrations and its psql
# runs. Applying them for real is deploy/ci/rds-like/run.sh with
# MIGRATOR_IMAGE set, which the release workflow runs as well.
. "$(dirname "$0")/lib.sh"

echo "== $IMAGE"
not_root
says_version

out=$(docker run --rm "$IMAGE" version) || fail "version: $out"
echo "$out" | sed 's/^/  | /'
want=$(ls supabase/migrations/*.sql | wc -l | tr -d ' ')
newest=$(ls supabase/migrations/*.sql | sed 's#.*/##; s/_.*//' | sort | tail -1)
echo "$out" | grep -q "^$want migrations, newest $newest$" \
  || fail "the image does not carry this checkout's $want migrations (newest $newest)"
ok "carries all $want migrations, newest $newest"
echo "$out" | grep -q "psql (PostgreSQL) 17\." || fail "psql is not PostgreSQL 17's"
ok "psql 17"

if docker run --rm "$IMAGE" migrate >/dev/null 2>&1; then
  fail "migrate ran without DATABASE_URL"
fi
ok "refuses to run without DATABASE_URL"
# Nothing but what it copies: the build context is the repository root.
docker run --rm --entrypoint sh "$IMAGE" -c 'test ! -e /db-migrate/node_modules && test ! -e /db-migrate/src && test -f /db-migrate/bootstrap/rds-bootstrap.sql && test -f /db-migrate/bootstrap/lakehouse-catalog.sql' \
  || fail "the image holds more, or less, than its paths"
ok "holds only the runner, the bootstraps and the migrations"
docker run --rm --entrypoint sh "$IMAGE" -c 'curl --version >/dev/null' || fail "no curl for create-admin"
out=$(docker run --rm "$IMAGE" create-admin 2>&1) && fail "create-admin ran without its settings"
echo "$out" | grep -q "create-admin needs: ADMIN_EMAIL ADMIN_PASSWORD GOTRUE_URL SERVICE_ROLE_KEY" \
  || fail "create-admin did not name what it needs: $out"
ok "create-admin names the settings it is missing"
echo "PASSED"
