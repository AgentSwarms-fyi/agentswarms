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
check() { # name  expected-substring  actual
  if printf '%s' "$3" | grep -qiF "$2"; then
    echo "  ok   $1"; pass=$((pass+1))
  else
    echo "  FAIL $1 — expected '$2', got: $3"; fail=$((fail+1))
  fi
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
  --tmpfs /home/runner/work:rw,exec,size=512m \
  --tmpfs /home/runner/.local:rw,exec,size=512m \
  --tmpfs /tmp:rw,size=256m \
  --entrypoint sleep "$IMAGE" 3600 >/dev/null || { echo "run failed"; exit 1; }

ex() { "$DOCKER" exec "$NAME" sh -lc "$1" 2>&1; }
insp() { "$DOCKER" inspect --format "$1" "$NAME" 2>&1; }

echo "== Checks =="
check "S6 non-root uid"           "1000"    "$(ex 'id -u')"
check "S4 read-only rootfs"       "only"    "$(ex 'echo x > /etc/pwn 2>&1 || true')"
check "S5 work dir writable"      "ok"      "$(ex 'echo ok > /home/runner/work/t && cat /home/runner/work/t')"
check "S7 cannot apt as non-root" "denied"  "$(ex 'apt-get update 2>&1 | tail -1')"
check "S9 no docker socket"       "ABSENT"  "$(ex 'test -e /var/run/docker.sock && echo PRESENT || echo ABSENT')"
check "S8 no provider secrets"    "NONE"    "$(ex 'env | grep -Ei \"OPENAI_API_KEY|SERVICE_ROLE|OPENROUTER_API_KEY|SUPABASE\" || echo NONE')"
check "S13 all caps dropped"      "0000000000000000" "$(ex 'grep CapEff /proc/self/status')"
check "S10 pids-limit set"        "256"     "$(insp '{{.HostConfig.PidsLimit}}')"
check "S11 memory limit set"      "$((MEM_MB*1024*1024))" "$(insp '{{.HostConfig.Memory}}')"
check "no-new-privileges set"     "no-new-privileges" "$(insp '{{join .HostConfig.SecurityOpt \",\"}}')"

echo "== Functional: real frameworks import =="
check "frameworks import"         "frameworks-ok" \
  "$(ex 'python -c "import langchain, langgraph; from llama_index.core import Document; print(\"frameworks-ok\")"')"

echo "== Cleanup =="
"$DOCKER" rm -f "$NAME" >/dev/null 2>&1 || true

echo ""
echo "$pass passed, $fail failed"
exit $((fail > 0 ? 1 : 0))
