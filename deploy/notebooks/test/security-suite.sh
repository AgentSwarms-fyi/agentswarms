#!/usr/bin/env bash
# Automated hardening + functional checks for the notebook kernel image
# (docs/DEVELOPER_WORKSPACE_RUNTIME.md §13.3, the container-level subset).
#
# Builds the image, runs a container with the SAME Tier-A hardening the Docker
# orchestrator applies (non-root, read-only rootfs, all caps dropped,
# no-new-privileges, pids/memory limits, writable tmpfs only), and asserts each
# control. Also imports the real frameworks to prove the image works.
#
# Egress-allowlist (S1–S3) and cross-tenant (S12) checks need the full compose
# stack + app and are covered by the §13.5 manual matrix, not this script.
#
# Usage:  bash deploy/notebooks/test/security-suite.sh
#   DOCKER=/path/to/docker  bash ...     # if docker isn't on PATH
set -uo pipefail

DOCKER="${DOCKER:-docker}"
IMAGE="agentswarms/notebook-runtime:test"
NAME="nb-sec-$$"
MEM_MB=2048

pass=0; fail=0
# Bash-native case-insensitive substring test. (Deliberately NOT `grep -q` in a
# pipeline: under MSYS/Git-Bash that aborts on SIGPIPE and every check "fails".)
shopt -s nocasematch
check() { # name  expected-substring  actual
  if [[ "$3" == *"$2"* ]]; then
    echo "  ok   $1"; pass=$((pass+1))
  else
    echo "  FAIL $1 — expected '$2', got: $3"; fail=$((fail+1))
  fi
}

check_any() { # name  actual  expected1 [expected2...]
  local name="$1" actual="$2"; shift 2
  local e
  for e in "$@"; do
    if [[ "$actual" == *"$e"* ]]; then echo "  ok   $name"; pass=$((pass+1)); return; fi
  done
  echo "  FAIL $name — expected one of [$*], got: $actual"; fail=$((fail+1))
}

echo "== Building kernel image (first run pulls the frameworks; slow) =="
"$DOCKER" build -t "$IMAGE" docker/notebook-runtime || { echo "build failed"; exit 1; }

echo "== Launching hardened container =="
"$DOCKER" rm -f "$NAME" >/dev/null 2>&1 || true
"$DOCKER" run -d --name "$NAME" \
  --user 1000:1000 \
  --read-only \
  --cap-drop=ALL \
  --security-opt=no-new-privileges \
  --pids-limit=256 \
  --memory=${MEM_MB}m --memory-swap=${MEM_MB}m \
  --tmpfs /home/runner/work:rw,exec,size=512m,mode=1777 \
  --tmpfs /home/runner/.local:rw,exec,size=512m,mode=1777 \
  --tmpfs /tmp:rw,size=256m,mode=1777 \
  --entrypoint sleep "$IMAGE" 3600 >/dev/null || { echo "run failed"; exit 1; }

ex() { "$DOCKER" exec "$NAME" sh -lc "$1" 2>&1; }
insp() { "$DOCKER" inspect --format "$1" "$NAME" 2>&1; }

echo "== Checks =="
check "S6 non-root uid"           "1000"    "$(ex 'id -u')"
check "S4 read-only rootfs"       "only"    "$(ex 'echo x > /etc/pwn 2>&1 || true')"
check "S5 work dir writable"      "ok"      "$(ex 'echo ok > /home/runner/work/t && cat /home/runner/work/t')"
# Blocked either by non-root (Permission denied) or the read-only rootfs —
# accept whichever control fires first.
check_any "S7 apt blocked as non-root" "$(ex 'apt-get update 2>&1 | tail -1')" "denied" "read-only"
check "S9 no docker socket"       "ABSENT"  "$(ex 'test -e /var/run/docker.sock && echo PRESENT || echo ABSENT')"
check "S8 no provider secrets"    "NONE"    "$(ex "env | grep -Ei 'OPENAI_API_KEY|SERVICE_ROLE|OPENROUTER_API_KEY|SUPABASE' || echo NONE")"
check "S13 all caps dropped"      "0000000000000000" "$(ex 'grep CapEff /proc/self/status')"
check "S10 pids-limit set"        "256"     "$(insp '{{.HostConfig.PidsLimit}}')"
check "S11 memory limit set"      "$((MEM_MB*1024*1024))" "$(insp '{{.HostConfig.Memory}}')"
check "no-new-privileges set"     "no-new-privileges" "$(insp '{{index .HostConfig.SecurityOpt 0}}')"

echo "== Functional: real frameworks + runtime pip =="
check "frameworks import"         "frameworks-ok" \
  "$(ex 'python -c "import langchain, langgraph; from llama_index.core import Document; print(\"frameworks-ok\")"')"
# Proves PIP_USER writes land in the writable ~/.local tmpfs (needs mode=1777).
check "runtime pip install"       "cowsay" \
  "$(ex "pip install -q cowsay && python -c 'import cowsay; print(cowsay.__name__)'")"

echo "== Cleanup =="
"$DOCKER" rm -f "$NAME" >/dev/null 2>&1 || true

echo ""
echo "$pass passed, $fail failed"
exit $((fail > 0 ? 1 : 0))
