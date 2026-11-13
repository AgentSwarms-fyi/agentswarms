#!/usr/bin/env bash
# The JS sandbox image: it starts, answers its health check, and refuses to
# run code for a caller without the internal secret.
. "$(dirname "$0")/lib.sh"
PORT=18091

echo "== $IMAGE"
not_root
if docker run --rm --entrypoint sh "$IMAGE" -c 'command -v npm' >/dev/null 2>&1; then
  fail "npm is in the image"
fi
ok "no npm"

start -p 127.0.0.1:$PORT:8091 -e INTERNAL_RUN_SECRET=smoke-run-secret "$IMAGE"
wait_for_status "http://127.0.0.1:$PORT/health" 60
ok "/health answers"
code=$(status_of -X POST -H "Content-Type: application/json" --data '{"code":"return 1"}' "http://127.0.0.1:$PORT/run")
case "$code" in
  401 | 403) ok "/run without the secret is refused ($code)" ;;
  *) fail "/run without the secret answered $code" ;;
esac
code=$(status_of -X POST -H "Content-Type: application/json" -H "x-internal-run-secret: smoke-run-secret" \
  --data '{"code":"return 6 * 7"}' "http://127.0.0.1:$PORT/run")
[ "$code" = "200" ] || fail "/run with the secret answered $code: $(head -c 200 "$BODY_FILE")"
grep -q '42' "$BODY_FILE" || fail "/run did not compute 6 * 7: $(head -c 200 "$BODY_FILE")"
ok "/run with the secret runs a snippet (6 * 7 = 42)"
echo "PASSED"
