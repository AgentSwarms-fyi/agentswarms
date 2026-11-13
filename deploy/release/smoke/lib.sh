#!/usr/bin/env bash
# Shared by the release smoke tests (R469). Each test is
#
#   bash deploy/release/smoke/<image>.sh <image reference>
#
# and starts the image the way a deploy does, asks it something it can only
# answer if it really works, and exits non-zero on the first wrong answer.
# Throwaway containers, removed at the end; ports on 127.0.0.1 only.
# pipefail: a check piped into sed for display must still fail when it fails.
set -uo pipefail
export MSYS_NO_PATHCONV=1
IMAGE="${1:?usage: $0 <image reference>}"
NAME="smoke-$(basename "$0" .sh)-$$"
STARTED=""

BODY_FILE="$(mktemp)"
# Git Bash on Windows: curl there is a native Windows program, and with path
# conversion off it cannot open /tmp/...; C:/... works for it and for bash.
command -v cygpath >/dev/null 2>&1 && BODY_FILE="$(cygpath -m "$BODY_FILE")"
cleanup() {
  [ -n "$STARTED" ] && docker rm -f "$NAME" >/dev/null 2>&1
  rm -f "$BODY_FILE"
  true
}
trap cleanup EXIT

ok() { echo "  ok   $*"; }
fail() {
  echo "  FAIL $*"
  if [ -n "$STARTED" ]; then
    echo "  --- last log lines of $NAME"
    docker logs --tail 25 "$NAME" 2>&1 | sed 's/^/  | /'
  fi
  exit 1
}

# docker run -d with the test's own name; arguments as for docker run.
start() {
  docker run -d --name "$NAME" "$@" >/dev/null || fail "docker run $*"
  STARTED=1
}

# The HTTP status of a URL, or 000 when nothing answers within MAX_TIME
# seconds (10 unless set). Body to $BODY_FILE.
status_of() { curl -s -o "$BODY_FILE" -w '%{http_code}' --max-time "${MAX_TIME:-10}" "$@" 2>/dev/null || true; }

# Wait up to <seconds> for <url> to answer <code> (200 unless given).
wait_for_status() {
  local url=$1 seconds=$2 want=${3:-200} got=000
  for _ in $(seq 1 $((seconds / 2))); do
    got=$(status_of "$url")
    [ "$got" = "$want" ] && return 0
    if [ -n "$STARTED" ] && [ "$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null)" != "true" ]; then
      fail "$NAME stopped while waiting for $url"
    fi
    sleep 2
  done
  fail "$url answered $got, not $want, within ${seconds}s"
}

# The image does not run as root.
not_root() {
  local user
  user=$(docker image inspect -f '{{.Config.User}}' "$IMAGE")
  case "$user" in
    "" | root | 0 | 0:*) fail "runs as root (USER is '${user:-unset}')" ;;
    *) ok "runs as $user, not root" ;;
  esac
}

# When EXPECT_VERSION is set (the release workflow sets it), the image says so.
says_version() {
  [ -z "${EXPECT_VERSION:-}" ] && return 0
  docker image inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$IMAGE" \
    | grep -qx "AGENTSWARMS_VERSION=$EXPECT_VERSION" \
    || fail "AGENTSWARMS_VERSION is not $EXPECT_VERSION"
  ok "AGENTSWARMS_VERSION=$EXPECT_VERSION"
}
