#!/bin/sh
# The egress proxy's entrypoint (R478): squid in the foreground, and a loop
# that pulls the allow-list from the app and has squid re-read it on change.
#
#   EGRESS_PULL_URL       the app's list endpoint, e.g.
#                         http://app.internal/api/notebook/runtime/egress
#                         (…/domains and …/ips are fetched under it)
#   EGRESS_PULL_TOKEN     the bearer token the app expects (NOTEBOOK_EGRESS_PULL_TOKEN there)
#   EGRESS_PULL_INTERVAL  seconds between pulls; 30 unless set
#
# Fails closed: until a first list arrives, and whenever a pull fails, squid
# keeps what it has, which at start is nothing (every request refused).
set -eu

LISTS=/var/lib/egress
INTERVAL="${EGRESS_PULL_INTERVAL:-30}"
: "${EGRESS_PULL_URL:?EGRESS_PULL_URL is required: the egress list endpoint of the app, /api/notebook/runtime/egress}"

log() { echo "[egress-pull] $*" >&2; }

fetch() {
  curl -fsS --max-time 15 --noproxy '*' \
    ${EGRESS_PULL_TOKEN:+-H "Authorization: Bearer $EGRESS_PULL_TOKEN"} \
    -o "$LISTS/.$1.new" "$EGRESS_PULL_URL/$1"
}

# Both lists, or neither: a domains file from this pull beside an ips file
# from the last would be a list nobody saved. 0 = changed, 1 = the same,
# 2 = a fetch failed and nothing moved.
pull() {
  for name in allowed_domains allowed_ips; do
    if ! fetch "$name"; then
      rm -f "$LISTS/.allowed_domains.new" "$LISTS/.allowed_ips.new"
      log "could not fetch $name from $EGRESS_PULL_URL; keeping the list it has"
      return 2
    fi
  done
  changed=1
  for name in allowed_domains allowed_ips; do
    if cmp -s "$LISTS/.$name.new" "$LISTS/$name"; then
      rm -f "$LISTS/.$name.new"
    else
      mv -f "$LISTS/.$name.new" "$LISTS/$name"
      changed=0
    fi
  done
  return "$changed"
}

: >"$LISTS/allowed_domains"
: >"$LISTS/allowed_ips"
# A first list before squid starts, if the app is there to give one: up to a
# minute, then start refusing everything and keep trying.
for _ in $(seq 1 12); do
  set +e
  pull
  rc=$?
  set -e
  [ "$rc" -ne 2 ] && break
  sleep 5
done
[ "$rc" -eq 2 ] && log "starting with an empty list: every request is refused until a pull succeeds"

(
  while sleep "$INTERVAL"; do
    set +e
    pull
    rc=$?
    set -e
    if [ "$rc" -eq 0 ]; then
      log "list changed: $(grep -cv '^#' "$LISTS/allowed_domains") domains, $(grep -cv '^#' "$LISTS/allowed_ips") addresses"
      squid -k reconfigure -f /etc/squid/squid.conf || log "squid -k reconfigure failed"
    fi
  done
) &

exec squid -N -f /etc/squid/squid.conf
