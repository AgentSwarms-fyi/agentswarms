#!/usr/bin/env bash
# The app image: it starts with nothing but runtime environment, serves the
# browser's settings from that environment (none were built in, R469), and
# carries no build toolchain.
. "$(dirname "$0")/lib.sh"
PORT=18080
URL="https://smoke-supabase.invalid"

echo "== $IMAGE"
not_root

# Which release it is: in a file Compose's .env cannot override (R470).
rel=$(docker run --rm --entrypoint cat "$IMAGE" /app/release.json) || fail "no /app/release.json"
if [ -n "${EXPECT_VERSION:-}" ]; then
  case "$rel" in
    *"\"version\":\"$EXPECT_VERSION\""*) ok "release.json says $EXPECT_VERSION" ;;
    *) fail "release.json says $rel, not $EXPECT_VERSION" ;;
  esac
fi

if docker run --rm --entrypoint sh "$IMAGE" -c 'command -v npm' >/dev/null 2>&1; then
  fail "npm is in the image"
fi
ok "no npm"
for dev in vite typescript eslint vitest; do
  if docker run --rm --entrypoint node "$IMAGE" -e "require.resolve('$dev/package.json')" >/dev/null 2>&1; then
    fail "dev dependency $dev is installed"
  fi
done
ok "no dev dependencies (vite, typescript, eslint, vitest)"
docker run --rm --entrypoint sh "$IMAGE" -c 'test ! -e /app/src && test ! -e /app/tests' \
  || fail "the source tree is in the image"
ok "no source tree"

# The lakehouse engine: DuckDB's native module for this architecture, and the
# extensions the build baked in, loaded with no network at all.
duck=$(docker run --rm --network none --entrypoint node "$IMAGE" --input-type=module -e '
import { DuckDBInstance } from "@duckdb/node-api";
const c = await (await DuckDBInstance.create(":memory:")).connect();
for (const e of ["httpfs", "ducklake", "postgres", "iceberg"]) await c.run(`LOAD ${e}`);
const [r] = await (await c.run("select version() as v, 6 * 7 as a")).getRowObjects();
console.log(`${r.v} ${r.a}`);
' 2>&1) || fail "DuckDB: $duck"
case "$duck" in *" 42") ok "DuckDB ${duck% 42} loads httpfs, ducklake, postgres and iceberg offline" ;; *) fail "DuckDB: $duck" ;; esac

# No Supabase behind it: the server must still start and serve its pages.
start -p 127.0.0.1:$PORT:8080 \
  -e PUBLIC_SUPABASE_URL="$URL" -e PUBLIC_SUPABASE_PUBLISHABLE_KEY=smoke-anon-key \
  -e SUPABASE_URL="$URL" -e SUPABASE_PUBLISHABLE_KEY=smoke-anon-key \
  -e SUPABASE_SERVICE_ROLE_KEY=smoke-service-key \
  -e DISABLE_INPROCESS_SCHEDULER=1 -e WEB_CONCURRENCY=1 \
  "$IMAGE"
wait_for_status "http://127.0.0.1:$PORT/api/health" 180
grep -q '"status":"ok"' "$BODY_FILE" || fail "/api/health: $(head -c 200 "$BODY_FILE")"
ok "/api/health answers ok"

code=$(status_of "http://127.0.0.1:$PORT/login")
[ "$code" = "200" ] || fail "/login answered $code"
grep -q 'id="as-public-config"' "$BODY_FILE" || fail "/login has no as-public-config block"
grep -q "$URL" "$BODY_FILE" || fail "/login does not carry the runtime Supabase URL"
ok "/login renders, with the Supabase URL it was given at runtime"
echo "PASSED"
