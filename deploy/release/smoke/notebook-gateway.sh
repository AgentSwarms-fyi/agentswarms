#!/usr/bin/env bash
# The notebook gateway image: it starts and answers on its port.
. "$(dirname "$0")/lib.sh"
PORT=18090

echo "== $IMAGE"
not_root
if docker run --rm --entrypoint sh "$IMAGE" -c 'command -v npm' >/dev/null 2>&1; then
  fail "npm is in the image"
fi
ok "no npm"

start -p 127.0.0.1:$PORT:8090 \
  -e SUPABASE_URL=https://smoke-supabase.invalid -e SUPABASE_SERVICE_ROLE_KEY=smoke-service-key \
  -e NOTEBOOK_RUNTIME_SECRET=smoke-runtime-secret \
  "$IMAGE"
wait_for_status "http://127.0.0.1:$PORT/" 60
grep -q "agentswarms-notebook-gateway" "$BODY_FILE" || fail "/ answered: $(head -c 120 "$BODY_FILE")"
ok "answers on 8090"
echo "PASSED"
