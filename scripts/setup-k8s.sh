#!/usr/bin/env bash
#
# AgentSwarms on Kubernetes, fully self-hosted — Supabase included.
#
#   bash scripts/setup-k8s.sh
#
# Everything runs in your cluster and nothing phones home: Postgres, auth, the
# REST and Realtime APIs, storage, Studio, the app, the Office renderer, the JS
# sandbox and the lakehouse catalog. The Kubernetes twin of
# scripts/setup-selfhosted.sh.
#
# WHY HELM FOR SUPABASE, AND HAND-WRITTEN MANIFESTS FOR OURS.
#
# Supabase is a dozen services (Kong, Studio, Postgres, PostgREST, Realtime,
# Storage, Meta, GoTrue, Edge Functions, Logflare, Vector, Imgproxy, MinIO)
# whose wiring — bootstrap SQL, roles, per-service env — changes between
# versions. A hand-maintained copy of that is a copy that silently falls behind:
# an earlier draft of this script shipped its own manifests and needed five
# fixes before Postgres would even start, the last being the role bootstrap
# (`authenticator`, `anon`, `supabase_auth_admin` …) that a bare image does not
# create. The community chart tracks upstream; we should not.
#
# Our own components stay as plain manifests under deploy/k8s/app/ because they
# are four Deployments we control and understand.
#
# WHAT THIS DOES, in order — each step exists because skipping it breaks a later
# one:
#   1. preflight: kubectl, helm, a reachable cluster, the app image
#   2. generates every secret — including the anon and service-role keys SIGNED
#      from the JWT secret, because they are JWTs, not random strings
#   3. installs the Supabase chart and waits for Postgres and the API gateway
#   4. applies the AgentSwarms schema
#   5. creates your admin user, confirmed and ready to sign in
#   6. starts the app and its services, pointed at the in-cluster Supabase
#
# Re-running is safe: secrets are generated once and reused, `helm upgrade
# --install` is idempotent, and the schema applies cleanly a second time.
set -euo pipefail

NS="${NAMESPACE:-agentswarms}"
RELEASE="${RELEASE:-supabase}"
CHART_VERSION="${SUPABASE_CHART_VERSION:-0.7.2}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${AGENTSWARMS_IMAGE:-agentswarms:latest}"
ADMIN_EMAIL="${ADMIN_EMAIL:-}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"

say() { printf '\n\033[1;36m==>\033[0m %s\n' "$1"; }
die() { printf '\n\033[1;31mERROR:\033[0m %s\n' "$1" >&2; exit 1; }

# ── 1. preflight ────────────────────────────────────────────────────────────
say "Checking prerequisites"
command -v kubectl >/dev/null || die "kubectl is not installed."
command -v helm >/dev/null || die "helm is not installed — see https://helm.sh/docs/intro/install/"
command -v openssl >/dev/null || die "openssl is required to generate keys."
kubectl cluster-info >/dev/null 2>&1 || die "No reachable Kubernetes cluster. On Docker Desktop: Settings -> Kubernetes -> Enable Kubernetes."
echo "    cluster: $(kubectl config current-context)"

if [ -z "${SKIP_IMAGE_CHECK:-}" ] && command -v docker >/dev/null 2>&1; then
  docker image inspect "$IMAGE" >/dev/null 2>&1 || {
    say "Building the app image ($IMAGE)"
    ( cd "$REPO_ROOT" && docker build -t "$IMAGE" . )
  }
fi

kubectl get namespace "$NS" >/dev/null 2>&1 || kubectl create namespace "$NS" >/dev/null

# ── 2. secrets ──────────────────────────────────────────────────────────────
b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

# A signed HS256 JWT for one Supabase role. The anon and service-role "keys" ARE
# tokens: every service verifies them against the JWT secret, so a random string
# here yields a stack that starts and then rejects every request.
sign_key() { # $1 = role, $2 = jwt secret
  local header payload unsigned sig
  header=$(printf '{"alg":"HS256","typ":"JWT"}' | b64url)
  payload=$(printf '{"role":"%s","iss":"supabase","iat":%s,"exp":%s}' \
    "$1" "$(date +%s)" "$(( $(date +%s) + 60*60*24*365*10 ))" | b64url)
  unsigned="${header}.${payload}"
  sig=$(printf '%s' "$unsigned" | openssl dgst -binary -sha256 -hmac "$2" | b64url)
  printf '%s.%s' "$unsigned" "$sig"
}
gen() { openssl rand -hex "${1:-24}"; }

# Secrets live in a Secret of our own so a re-run reuses them. Regenerating the
# JWT secret would invalidate every key and session already issued.
if kubectl -n "$NS" get secret agentswarms-bootstrap >/dev/null 2>&1; then
  say "Reusing the existing secrets"
  get() { kubectl -n "$NS" get secret agentswarms-bootstrap -o jsonpath="{.data.$1}" | base64 -d; }
  JWT_SECRET=$(get JWT_SECRET); ANON_KEY=$(get ANON_KEY); SERVICE_KEY=$(get SERVICE_ROLE_KEY)
  PG_PW=$(get POSTGRES_PASSWORD); DASHBOARD_PW=$(get DASHBOARD_PASSWORD)
  REALTIME_BASE=$(get REALTIME_SECRET_KEY_BASE); META_KEY=$(get META_CRYPTO_KEY)
  REALTIME_ENC_KEY=$(get REALTIME_ENC_KEY)
  S3_KEY_ID=$(get S3_KEY_ID); S3_ACCESS_KEY=$(get S3_ACCESS_KEY)
  MINIO_PW=$(get MINIO_PASSWORD); LOGFLARE_PUB=$(get LOGFLARE_PUBLIC); LOGFLARE_PRIV=$(get LOGFLARE_PRIVATE)
  INTERNAL_RUN_SECRET=$(get INTERNAL_RUN_SECRET); PROVIDER_CREDS_SECRET=$(get PROVIDER_CREDS_SECRET)
  BI_CRON_TOKEN=$(get BI_CRON_TOKEN); LAKEHOUSE_PW=$(get LAKEHOUSE_CATALOG_PASSWORD)
else
  say "Generating secrets"
  JWT_SECRET=$(openssl rand -hex 32)
  ANON_KEY=$(sign_key anon "$JWT_SECRET")
  SERVICE_KEY=$(sign_key service_role "$JWT_SECRET")
  PG_PW=$(gen); DASHBOARD_PW=$(gen 16)
  # Three length rules here, and they are NOT interchangeable:
  #   secretKeyBase   Phoenix, long
  #   dbEncKey        AES-128-ECB, so EXACTLY 16 bytes. Realtime crash-looped on
  #                   a 32-char key, raising from its own seeds.exs at
  #                   `:crypto.crypto_one_time(:aes_128_ecb, ...)`. The chart's
  #                   default is the 16-character "supabaserealtime", which is
  #                   the clue: it is a length, not a placeholder.
  #   meta cryptoKey  at least 32 chars
  REALTIME_BASE=$(openssl rand -hex 32)
  REALTIME_ENC_KEY=$(openssl rand -hex 8)
  META_KEY=$(openssl rand -hex 16)
  S3_KEY_ID=$(gen 16); S3_ACCESS_KEY=$(openssl rand -hex 32); MINIO_PW=$(gen)
  LOGFLARE_PUB=$(gen); LOGFLARE_PRIV=$(gen)
  INTERNAL_RUN_SECRET="${INTERNAL_RUN_SECRET:-$(openssl rand -hex 32)}"
  PROVIDER_CREDS_SECRET="${PROVIDER_CREDS_SECRET:-$(openssl rand -hex 32)}"
  BI_CRON_TOKEN="${BI_CRON_TOKEN:-$(gen)}"
  LAKEHOUSE_PW=$(gen)
  kubectl -n "$NS" create secret generic agentswarms-bootstrap \
    --from-literal=JWT_SECRET="$JWT_SECRET" \
    --from-literal=ANON_KEY="$ANON_KEY" \
    --from-literal=SERVICE_ROLE_KEY="$SERVICE_KEY" \
    --from-literal=POSTGRES_PASSWORD="$PG_PW" \
    --from-literal=DASHBOARD_PASSWORD="$DASHBOARD_PW" \
    --from-literal=REALTIME_SECRET_KEY_BASE="$REALTIME_BASE" \
    --from-literal=META_CRYPTO_KEY="$META_KEY" \
    --from-literal=REALTIME_ENC_KEY="$REALTIME_ENC_KEY" \
    --from-literal=S3_KEY_ID="$S3_KEY_ID" \
    --from-literal=S3_ACCESS_KEY="$S3_ACCESS_KEY" \
    --from-literal=MINIO_PASSWORD="$MINIO_PW" \
    --from-literal=LOGFLARE_PUBLIC="$LOGFLARE_PUB" \
    --from-literal=LOGFLARE_PRIVATE="$LOGFLARE_PRIV" \
    --from-literal=INTERNAL_RUN_SECRET="$INTERNAL_RUN_SECRET" \
    --from-literal=PROVIDER_CREDS_SECRET="$PROVIDER_CREDS_SECRET" \
    --from-literal=BI_CRON_TOKEN="$BI_CRON_TOKEN" \
    --from-literal=LAKEHOUSE_CATALOG_PASSWORD="$LAKEHOUSE_PW" >/dev/null
fi

# ── 3. Supabase, via the community chart ────────────────────────────────────
say "Installing Supabase (chart $CHART_VERSION)"
helm repo add supabase https://supabase-community.github.io/supabase-kubernetes >/dev/null 2>&1 || true
helm repo update supabase >/dev/null

VALUES="$(mktemp)"
trap 'rm -f "$VALUES"' EXIT
# Written to a temp file, never to the repo: it carries every secret.
cat >"$VALUES" <<EOF
secret:
  jwt:
    anonKey: "$ANON_KEY"
    serviceKey: "$SERVICE_KEY"
    secret: "$JWT_SECRET"
  db:
    password: "$PG_PW"
    database: "postgres"
  analytics:
    publicAccessToken: "$LOGFLARE_PUB"
    privateAccessToken: "$LOGFLARE_PRIV"
  dashboard:
    username: "supabase"
    password: "$DASHBOARD_PW"
  s3:
    keyId: "$S3_KEY_ID"
    accessKey: "$S3_ACCESS_KEY"
  realtime:
    secretKeyBase: "$REALTIME_BASE"
    dbEncKey: "$REALTIME_ENC_KEY"
  meta:
    cryptoKey: "$META_KEY"
  minio:
    user: "supa-storage"
    password: "$MINIO_PW"
EOF

helm upgrade --install "$RELEASE" supabase/supabase \
  --namespace "$NS" --version "$CHART_VERSION" \
  --values "$VALUES" --timeout 15m --wait=false

say "Waiting for Postgres"
DB_POD=""
for _ in $(seq 1 90); do
  DB_POD=$(kubectl -n "$NS" get pods -l app.kubernetes.io/name=supabase-db -o name 2>/dev/null | head -1)
  [ -z "$DB_POD" ] && DB_POD=$(kubectl -n "$NS" get pods -o name 2>/dev/null | grep -- '-db-' | head -1)
  if [ -n "$DB_POD" ] && kubectl -n "$NS" get "$DB_POD" -o jsonpath='{.status.containerStatuses[0].ready}' 2>/dev/null | grep -q true; then
    break
  fi
  sleep 10
done
[ -n "$DB_POD" ] || die "Could not find the Supabase database pod. 'kubectl -n $NS get pods' will show what came up."
echo "    $DB_POD"

# ── 4. schema ───────────────────────────────────────────────────────────────
# supabase_admin is the superuser the image creates; the chart's own bootstrap
# adds the rest of the roles the services log in as.
psql_db() { kubectl -n "$NS" exec -i "$DB_POD" -- env PGPASSWORD="$PG_PW" psql -U supabase_admin -d postgres "$@"; }

echo "    waiting for the storage schema"
# Three AgentSwarms migrations write to storage.buckets.public, a column the
# storage service creates on ITS first boot. Pushing before it exists fails
# those three and leaves uploads silently broken.
for _ in $(seq 1 90); do
  [ "$(psql_db -tAc "select 1 from information_schema.columns where table_schema='storage' and table_name='buckets' and column_name='public'" 2>/dev/null)" = "1" ] && break
  sleep 5
done

say "Applying the AgentSwarms schema"
# RECORD WHAT HAS BEEN APPLIED, the way `supabase db push` does.
#
# The migrations are ordinary CREATE TABLE, not CREATE TABLE IF NOT EXISTS, so
# replaying them fails on the second file with `relation "profiles" already
# exists` -- which is what a re-run of this script did before this table
# existed, despite the header promising re-runs were safe. Tracking them also
# makes the script incremental: add a migration, run it again, only the new one
# is applied.
psql_db -q >/dev/null <<'EOSQL'
CREATE TABLE IF NOT EXISTS public._agentswarms_migrations (
  name        text PRIMARY KEY,
  applied_at  timestamptz NOT NULL DEFAULT now()
);
EOSQL

count=0
skipped=0
for f in "$REPO_ROOT"/supabase/migrations/*.sql; do
  [ -e "$f" ] || continue
  name="$(basename "$f")"
  if [ "$(psql_db -tAc "select 1 from public._agentswarms_migrations where name = '$name'" 2>/dev/null)" = "1" ]; then
    skipped=$((skipped + 1))
    continue
  fi
  psql_db -v ON_ERROR_STOP=1 -q >/dev/null <"$f" || die "Migration failed: $name"
  psql_db -q -c "insert into public._agentswarms_migrations (name) values ('$name')" >/dev/null
  count=$((count + 1))
done
echo "    applied $count migrations ($skipped already applied)"

# ── 5. admin user ───────────────────────────────────────────────────────────
KONG_SVC=$(kubectl -n "$NS" get svc -o name | grep -- '-kong' | head -1 | cut -d/ -f2)
[ -n "$KONG_SVC" ] || die "Could not find the Supabase API gateway service."
SUPABASE_URL="http://${KONG_SVC}:8000"
echo "    API gateway: $SUPABASE_URL"

if [ -n "$ADMIN_EMAIL" ] && [ -n "$ADMIN_PASSWORD" ]; then
  say "Creating the admin user"
  kubectl -n "$NS" run as-admin-setup --rm -i --restart=Never --image=curlimages/curl:8.11.1 --command -- \
    curl -sS -X POST "${SUPABASE_URL}/auth/v1/admin/users" \
      -H "apikey: $SERVICE_KEY" -H "Authorization: Bearer $SERVICE_KEY" \
      -H "Content-Type: application/json" \
      -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\",\"email_confirm\":true}" \
    >/dev/null && echo "    $ADMIN_EMAIL is ready to sign in"
else
  say "No ADMIN_EMAIL / ADMIN_PASSWORD given — sign up in the app instead"
fi

# ── 6. the app and its services ─────────────────────────────────────────────
say "Configuring and starting AgentSwarms"
kubectl -n "$NS" create secret generic agentswarms-env \
  --from-literal=SUPABASE_URL="$SUPABASE_URL" \
  --from-literal=SUPABASE_PUBLISHABLE_KEY="$ANON_KEY" \
  --from-literal=SUPABASE_SERVICE_ROLE_KEY="$SERVICE_KEY" \
  --from-literal=ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.com}" \
  --from-literal=INTERNAL_RUN_SECRET="$INTERNAL_RUN_SECRET" \
  --from-literal=PROVIDER_CREDS_SECRET="$PROVIDER_CREDS_SECRET" \
  --from-literal=BI_CRON_TOKEN="$BI_CRON_TOKEN" \
  --from-literal=DOCGEN_TOKEN="$(gen 16)" \
  --from-literal=LAKEHOUSE_CATALOG_PASSWORD="$LAKEHOUSE_PW" \
  --from-literal=LAKEHOUSE_CATALOG_URL="postgres://lakehouse:${LAKEHOUSE_PW}@lakehouse-catalog:5432/lakehouse_catalog" \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null

kubectl apply -f "$REPO_ROOT/deploy/k8s/app/agentswarms.yaml" >/dev/null
kubectl apply -f "$REPO_ROOT/deploy/k8s/app/services.yaml" >/dev/null
kubectl -n "$NS" rollout status deployment/agentswarms-web --timeout=600s

cat <<EOF

  AgentSwarms is running in namespace "$NS".

  Open it:
      kubectl -n $NS port-forward svc/agentswarms 8080:80
      then http://localhost:8080

  Supabase Studio:
      kubectl -n $NS port-forward svc/${KONG_SVC} 8000:8000
      then http://localhost:8000  (user "supabase")

  For a real address, point an Ingress at the "agentswarms" Service.

  Keep PROVIDER_CREDS_SECRET safe — it encrypts every stored credential and is
  not recoverable:
      kubectl -n $NS get secret agentswarms-bootstrap -o jsonpath='{.data.PROVIDER_CREDS_SECRET}' | base64 -d

EOF
