#!/usr/bin/env bash
# The egress proxy image (R478): it pulls its allow-list, lets through only
# what is listed, refuses the metadata address even when listed, refuses a
# private address unless it is listed by IP, and picks up a changed list
# without a restart. The list is served as files (file://), which curl in the
# image fetches the same way it fetches the app's endpoint.
. "$(dirname "$0")/lib.sh"

NET="smoke-egress-net-$$"
WEB="smoke-egress-web-$$"
CLIENT="smoke-egress-client-$$"
LISTS="$(mktemp -d)"
command -v cygpath >/dev/null 2>&1 && LISTS="$(cygpath -m "$LISTS")"
cleanup_more() {
  docker rm -f "$WEB" "$CLIENT" >/dev/null 2>&1
  docker network rm "$NET" >/dev/null 2>&1
  rm -rf "$LISTS"
  cleanup
}
trap cleanup_more EXIT

echo "== $IMAGE"
docker network create "$NET" >/dev/null || fail "docker network create"
# A private address to reach: busybox httpd on 9000 (a port squid allows).
docker run -d --name "$WEB" --network "$NET" busybox:1.37.0 \
  sh -c 'mkdir -p /www && echo private-ok > /www/index.html && httpd -f -p 9000 -h /www' >/dev/null \
  || fail "the private web server did not start"
WEB_IP="$(docker inspect -f "{{(index .NetworkSettings.Networks \"$NET\").IPAddress}}" "$WEB")"

printf '.example.com\n' >"$LISTS/allowed_domains"
# The metadata address is listed on purpose: it must stay refused.
printf '169.254.169.254\n' >"$LISTS/allowed_ips"

start --network "$NET" -v "$LISTS:/lists:ro" \
  -e EGRESS_PULL_URL=file:///lists -e EGRESS_PULL_INTERVAL=2 "$IMAGE"

# Ask through the proxy from a client on the same network, as a sandbox
# would: the HTTP status squid gives (a refusal is its 403). One client
# container, asked by exec: a container per request takes seconds each on a
# loaded host.
docker run -d --name "$CLIENT" --network "$NET" --entrypoint sleep curlimages/curl:8.17.0 600 \
  >/dev/null || fail "the client container did not start"
via() {
  docker exec "$CLIENT" curl -s -o /dev/null -w '%{http_code}' --max-time 15 \
    -x "http://$NAME:3128" "$@" 2>/dev/null || true
}

for _ in $(seq 1 15); do
  [ "$(via http://example.com/)" = "200" ] && break
  sleep 2
done
[ "$(via http://example.com/)" = "200" ] || fail "a listed domain was not let through"
ok "a listed domain is let through"
[ "$(via http://example.org/)" = "403" ] || fail "an unlisted domain was not refused"
ok "an unlisted domain is refused"
[ "$(via http://169.254.169.254/latest/meta-data/)" = "403" ] \
  || fail "the metadata address was let through although blocked"
ok "the metadata address is refused even when listed"
[ "$(via "http://$WEB_IP:9000/")" = "403" ] || fail "an unlisted private address was let through"
ok "an unlisted private address is refused"

printf '.example.com\n.example.org\n' >"$LISTS/allowed_domains"
printf '169.254.169.254\n%s\n' "$WEB_IP" >"$LISTS/allowed_ips"
for _ in $(seq 1 15); do
  [ "$(via "http://$WEB_IP:9000/")" = "200" ] && break
  sleep 2
done
[ "$(via "http://$WEB_IP:9000/")" = "200" ] || fail "a private address listed by IP was not let through after the change"
[ "$(via http://example.org/)" = "200" ] || fail "a newly listed domain was not let through"
ok "a changed list is picked up without a restart"
not_root
echo "PASSED"
