#!/usr/bin/env bash
# The Docker API proxy image: its entrypoint renders HAProxy's configuration
# from the environment (into /tmp/haproxy.cfg), HAProxy accepts it, and it
# stays up. It runs as root on purpose (it opens the Docker socket), so
# not_root is not asked of it.
. "$(dirname "$0")/lib.sh"

echo "== $IMAGE"
start -e CONTAINERS=1 -e POST=0 "$IMAGE"
sleep 5
[ "$(docker inspect -f '{{.State.Running}}' "$NAME")" = "true" ] || fail "it stopped"
ok "starts and stays up"
docker exec "$NAME" haproxy -c -f /tmp/haproxy.cfg >/dev/null 2>&1 \
  || fail "haproxy rejects the configuration its entrypoint rendered"
ok "haproxy accepts the configuration its entrypoint rendered"
echo "PASSED"
