#!/usr/bin/env bash
# End-to-end verification for the Developer-workspace server runtime.
#
# Run this ONCE after installing on any host — laptop, data centre, cloud VM —
# to get a definitive pass/fail across the whole chain instead of discovering
# breakage by clicking around the UI:
#
#   bash deploy/notebooks/test/verify-runtime.sh
#   DOCKER=/path/to/docker  APP_URL=http://127.0.0.1:8080  bash ...
#
# Tiers (later ones are skipped, not failed, when prerequisites are absent):
#   1 infrastructure — docker, socket-proxy, kernel image, network, services
#   2 kernel         — hardened container boots, Jupyter serves, frameworks import
#   3 protocol       — the gateway can create a kernel and execute a real cell
#   4 governance     — a kernel calls back for a model completion and is traced
#
# Deep container-hardening assertions live in ./security-suite.sh; this script
# repeats only the critical few so a deployment check is self-contained.
set -uo pipefail

DOCKER="${DOCKER:-docker}"
APP_URL="${APP_URL:-http://127.0.0.1:8080}"
IMAGE="${NOTEBOOK_RUNTIME_IMAGE:-agentswarms/notebook-runtime:latest}"
KERNEL="verify-nb-$$"
pass=0; fail=0; skip=0
shopt -s nocasematch

ok()   { echo "  PASS  $1"; pass=$((pass+1)); }
bad()  { echo "  FAIL  $1${2:+ — $2}"; fail=$((fail+1)); }
skipd(){ echo "  SKIP  $1${2:+ — $2}"; skip=$((skip+1)); }
has()  { [[ "$1" == *"$2"* ]]; }

cleanup() { "$DOCKER" rm -f "$KERNEL" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "== 1. Infrastructure =="

if ! "$DOCKER" info >/dev/null 2>&1; then
  bad "Docker engine reachable" "is Docker running?"
  echo ""; echo "$pass passed, $fail failed, $skip skipped"; exit 1
fi
ok "Docker engine reachable"

# Socket-proxy: same candidate order the orchestrator uses.
PROXY=""
for c in "${DOCKER_PROXY_URL:-}" "http://127.0.0.1:2375" "http://notebook-docker-proxy:2375"; do
  [ -z "$c" ] && continue
  if curl -s -m 4 -o /dev/null "${c%/}/_ping" 2>/dev/null; then PROXY="${c%/}"; break; fi
done
if [ -n "$PROXY" ]; then ok "Docker socket-proxy ($PROXY)"
else bad "Docker socket-proxy" "start it: docker compose --profile notebooks up -d"; fi

if "$DOCKER" image inspect "$IMAGE" >/dev/null 2>&1; then ok "Kernel image present ($IMAGE)"
else bad "Kernel image present" "build it: docker compose --profile notebooks up -d --build"; fi

# The network must match what the ORCHESTRATOR would pick, which depends on where
# the app runs: containerised apps use the isolated network (kernels reach the app
# by service name); a host-run app needs the dev network (an `internal` network has
# no route back to the host, so callbacks would fail).
APP_IN_DOCKER=$("$DOCKER" ps --format '{{.Names}}' 2>/dev/null | grep -E 'agentswarms' | grep -v notebook | head -1)
if [ -n "$APP_IN_DOCKER" ]; then
  NET_ORDER="agentswarms_nb-internal agentswarms_nb-dev"
  echo "  ..    app runs in Docker ($APP_IN_DOCKER) — expecting the isolated network"
else
  NET_ORDER="agentswarms_nb-dev agentswarms_nb-internal"
  echo "  ..    app runs on the host — expecting the dev network (weaker egress isolation)"
fi
NET=""
for n in "${NOTEBOOK_NETWORK:-}" $NET_ORDER; do
  [ -z "$n" ] && continue
  if "$DOCKER" network inspect "$n" >/dev/null 2>&1; then NET="$n"; break; fi
done
if [ -n "$NET" ]; then ok "Kernel network ($NET)"; else bad "Kernel network" "not created"; fi

GW=$("$DOCKER" ps --filter "name=notebook-gateway" --format '{{.Names}}' 2>/dev/null | head -1)
if [ -n "$GW" ]; then ok "Gateway running ($GW)"; else bad "Gateway running" "not started"; fi
EG=$("$DOCKER" ps --filter "name=notebook-egress" --format '{{.Names}}' 2>/dev/null | head -1)
if [ -n "$EG" ]; then ok "Egress proxy running"; else skipd "Egress proxy running" "not started (kernels would have unrestricted egress)"; fi

echo ""
echo "== 2. Kernel =="
if [ -z "$NET" ] || ! "$DOCKER" image inspect "$IMAGE" >/dev/null 2>&1; then
  skipd "Kernel lifecycle" "needs the image and network above"
else
  "$DOCKER" rm -f "$KERNEL" >/dev/null 2>&1
  # Launch with the SAME hardening the orchestrator applies.
  "$DOCKER" run -d --name "$KERNEL" --network "$NET" \
    --user 1000:1000 --read-only --cap-drop=ALL --security-opt=no-new-privileges \
    --pids-limit=256 --memory=2048m --memory-swap=2048m \
    --tmpfs /home/runner/work:rw,exec,size=512m,mode=1777 \
    --tmpfs /home/runner/.local:rw,exec,size=512m,mode=1777 \
    --tmpfs /tmp:rw,size=256m,mode=1777 \
    -e NB_MODE=interactive -e KG_IP=0.0.0.0 -e KG_PORT=8888 \
    -p 127.0.0.1::8888 "$IMAGE" >/dev/null 2>&1 \
    && ok "Hardened kernel starts" || bad "Hardened kernel starts"

  MAPPED=$("$DOCKER" inspect -f '{{(index (index .NetworkSettings.Ports "8888/tcp") 0).HostPort}}' "$KERNEL" 2>/dev/null)
  KIP=$("$DOCKER" inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$KERNEL" 2>/dev/null)

  # Ports CANNOT be published on an `internal` network, and on Docker Desktop the
  # host cannot route to container IPs — so try the published port first and fall
  # back to probing from a container on the same network.
  probe_kernel() {
    if [ -n "$MAPPED" ] && curl -s -m 3 -o /dev/null "http://127.0.0.1:$MAPPED/api" 2>/dev/null; then return 0; fi
    if [ -n "$KIP" ] && "$DOCKER" run --rm --network "$NET" curlimages/curl:latest         -s -m 3 -o /dev/null "http://$KIP:8888/api" >/dev/null 2>&1; then return 0; fi
    return 1
  }

  # Jupyter needs a few seconds after the container is up.
  SERVING=""
  for _ in $(seq 1 20); do
    if probe_kernel; then SERVING=1; break; fi
    sleep 2
  done
  if [ -n "$SERVING" ]; then
    ok "Jupyter Kernel Gateway serving${MAPPED:+ (127.0.0.1:$MAPPED)}"
  else
    bad "Jupyter Kernel Gateway serving" "no response via published port or $KIP:8888"
  fi

  ex() { "$DOCKER" exec "$KERNEL" sh -lc "$1" 2>&1; }
  has "$(ex 'id -u')" "1000" && ok "Runs as non-root" || bad "Runs as non-root"
  has "$(ex 'echo x > /etc/pwn 2>&1 || true')" "only" && ok "Root filesystem read-only" || bad "Root filesystem read-only"
  has "$(ex 'echo ok > /home/runner/work/t && cat /home/runner/work/t')" "ok" && ok "Work dir writable" || bad "Work dir writable"
  has "$(ex 'grep CapEff /proc/self/status')" "0000000000000000" && ok "All capabilities dropped" || bad "All capabilities dropped"
  has "$(ex "env | grep -Ei 'OPENAI_API_KEY|SERVICE_ROLE|OPENROUTER_API_KEY|SUPABASE' || echo NONE")" "NONE" \
    && ok "No provider secrets in sandbox" || bad "No provider secrets in sandbox"
  has "$(ex 'python -c "import langchain, langgraph; from llama_index.core import Document; print(\"FW-OK\")"')" "FW-OK" \
    && ok "Real frameworks import (langchain/langgraph/llama_index)" || bad "Real frameworks import"
fi

echo ""
echo "== 3. Gateway protocol =="
if [ -z "$GW" ] || [ -z "${SERVING:-}" ]; then
  skipd "Gateway executes a cell" "needs a running gateway and kernel"
else
  OUT=$("$DOCKER" exec "$GW" node -e "
const {WebSocket}=require('ws');const {randomUUID}=require('crypto');
(async()=>{
 const base='http://$KIP:8888';
 const r=await fetch(base+'/api/kernels',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
 const k=await r.json(); const s=randomUUID();
 const ws=new WebSocket(base.replace('http','ws')+'/api/kernels/'+k.id+'/channels?session_id='+s);
 const out=[];
 ws.on('open',()=>{const id=randomUUID();
  ws.send(JSON.stringify({header:{msg_id:id,username:'v',session:s,date:new Date().toISOString(),msg_type:'execute_request',version:'5.3'},parent_header:{},metadata:{},content:{code:'print(6*7)',silent:false,store_history:true,user_expressions:{},allow_stdin:false,stop_on_error:true},channel:'shell',buffers:[]}));});
 ws.on('message',m=>{const j=JSON.parse(m.toString());const t=j.header&&j.header.msg_type;
  if(t==='stream')out.push(j.content.text.trim());
  if(t==='status'&&j.content.execution_state==='idle'&&out.length){console.log('CELL:'+out.join(''));process.exit(0);}});
 ws.on('error',e=>{console.log('WSERR '+e.message);process.exit(1)});
 setTimeout(()=>{console.log('TIMEOUT');process.exit(1)},45000);})();" 2>&1 | tail -1)
  has "$OUT" "CELL:42" && ok "Gateway creates a kernel and executes a cell" || bad "Gateway executes a cell" "$OUT"
fi

echo ""
echo "== 4. Governed callback =="
ENVF="$(dirname "$0")/../../../.env"
SB_URL=""; SB_KEY=""
[ -f "$ENVF" ] && { SB_URL=$(grep -E '^SUPABASE_URL=' "$ENVF" | cut -d'"' -f2); SB_KEY=$(grep -E '^SUPABASE_SERVICE_ROLE_KEY=' "$ENVF" | cut -d'"' -f2); }
APP_OK=$(curl -s -m 5 -o /dev/null -w "%{http_code}" "$APP_URL/" 2>/dev/null)

if [ -z "$SB_URL" ] || [ -z "$SB_KEY" ]; then
  skipd "Kernel model callback" "no SUPABASE_URL/SERVICE_ROLE_KEY in .env"
elif [ "$APP_OK" != "200" ]; then
  skipd "Kernel model callback" "app not reachable at $APP_URL (HTTP $APP_OK)"
elif [ -z "${SERVING:-}" ]; then
  skipd "Kernel model callback" "needs a running kernel"
else
  SECRET=$(curl -s "$SB_URL/rest/v1/notebook_runtime_secrets?select=signing_secret&id=eq.true" \
    -H "apikey: $SB_KEY" -H "Authorization: Bearer $SB_KEY" | sed -E 's/.*"signing_secret":"([^"]+)".*/\1/')
  USER_ID=$(curl -s "$SB_URL/rest/v1/notebook_runtime_sessions?select=user_id&limit=1" \
    -H "apikey: $SB_KEY" -H "Authorization: Bearer $SB_KEY" | sed -E 's/.*"user_id":"([^"]+)".*/\1/')
  if [ -z "$SECRET" ] || [[ "$SECRET" == *"["* ]] || [ -z "$USER_ID" ] || [[ "$USER_ID" == *"["* ]]; then
    skipd "Kernel model callback" "runtime not enabled yet (no signing secret / no prior session)"
  else
    SID=$(curl -s -X POST "$SB_URL/rest/v1/notebook_runtime_sessions" -H "apikey: $SB_KEY" \
      -H "Authorization: Bearer $SB_KEY" -H "Content-Type: application/json" -H "Prefer: return=representation" \
      -d "{\"user_id\":\"$USER_ID\",\"kind\":\"interactive\",\"status\":\"ready\",\"backend\":\"docker\"}" \
      | sed -E 's/.*"id":"([^"]+)".*/\1/')
    TOKEN=$(node -e "
const {createHmac}=require('crypto');const n=Math.floor(Date.now()/1000);
const h=Buffer.from(JSON.stringify({alg:'HS256',typ:'nbr'})).toString('base64url');
const p=Buffer.from(JSON.stringify({sub:'$USER_ID',sid:'$SID',scope:'notebook-runtime',iat:n,exp:n+900})).toString('base64url');
process.stdout.write(h+'.'+p+'.'+createHmac('sha256','$SECRET').update(h+'.'+p).digest('base64url'));" 2>/dev/null)
    # Kernels reach a host-run app through the Docker host gateway.
    ORIGIN="$APP_URL"; [[ "$APP_URL" == *"127.0.0.1"* || "$APP_URL" == *"localhost"* ]] && ORIGIN="http://host.docker.internal:${APP_URL##*:}"
    "$DOCKER" rm -f "$KERNEL-cb" >/dev/null 2>&1
    "$DOCKER" run -d --name "$KERNEL-cb" --network "$NET" --add-host=host.docker.internal:host-gateway \
      --user 1000:1000 --read-only --cap-drop=ALL \
      --tmpfs /home/runner/work:rw,exec,size=256m,mode=1777 --tmpfs /home/runner/.local:rw,exec,size=256m,mode=1777 --tmpfs /tmp:rw,size=128m,mode=1777 \
      -e AGENTSWARMS_ORIGIN="$ORIGIN" -e AGENTSWARMS_TOKEN="$TOKEN" \
      --entrypoint sleep "$IMAGE" 120 >/dev/null 2>&1
    KBOUT=$("$DOCKER" exec "$KERNEL-cb" python -c "
import asyncio, agentswarms
async def m():
    try:
        print('KB:'+str(len(await agentswarms.list_knowledge_bases())))
    except Exception as e:
        print('KBERR:'+str(e)[:120])
asyncio.run(m())" 2>&1 | tail -1)
    has "$KBOUT" "KB:" && ok "Kernel reaches the platform (knowledge bases: ${KBOUT#KB:})" \
      || bad "Kernel reaches the platform" "$KBOUT"
    "$DOCKER" rm -f "$KERNEL-cb" >/dev/null 2>&1
    curl -s -X PATCH "$SB_URL/rest/v1/notebook_runtime_sessions?id=eq.$SID" -H "apikey: $SB_KEY" \
      -H "Authorization: Bearer $SB_KEY" -H "Content-Type: application/json" -d '{"status":"stopped"}' >/dev/null
  fi
fi

echo ""
echo "$pass passed, $fail failed, $skip skipped"
[ "$fail" -eq 0 ] && echo "Runtime looks healthy." || echo "Runtime is NOT ready — see failures above."
exit $((fail > 0 ? 1 : 0))
