#!/usr/bin/env bash
#
# AgentSwarms fully self-contained setup: self-hosted Supabase (Docker) + the app.
# (macOS / Linux / WSL / Git Bash — Windows users run this under WSL or Git Bash
#  with Docker Desktop running.)
#
#   bash scripts/setup-selfhosted.sh              # Supabase + core app  → :8080
#   bash scripts/setup-selfhosted.sh --all        # Supabase + EVERY service
#   bash scripts/setup-selfhosted.sh --dev        # Supabase + local dev server
#   ADMIN_EMAIL=you@corp.com ADMIN_PASSWORD='...' bash scripts/setup-selfhosted.sh --all
#
# What it does, in order — the scripted version of
# docs/DEPLOYMENT.md § "Self-hosted Supabase":
#   1. downloads the official Supabase Docker stack (Postgres, GoTrue auth,
#      PostgREST, Storage, Realtime, Kong, Studio)
#   2. generates every secret — Postgres password, JWT secret, the ANON and
#      SERVICE_ROLE keys signed from it, Studio dashboard login, vault keys
#   3. starts the stack and WAITS for auth + storage to be genuinely ready
#      (pushing the schema before the storage service has booted once fails
#      three migrations — see DEPLOYMENT.md)
#   4. verifies/creates the five Postgres extensions the migrations need
#   5. applies the full AgentSwarms schema
#   6. creates your admin user (confirmed, ready to sign in)
#   7. writes every URL and key into the app's .env automatically
#   8. hands over to scripts/setup.sh to build and start the app itself
#
# Self-hosted Supabase has no dashboard "organisation/project" — the whole
# stack IS one project. Where the cloud flow says "create a project and copy
# its keys", this script generates those keys and wires them in for you.
#
# Re-runnable: an existing supabase-docker/.env is REUSED, never regenerated —
# regenerating JWT_SECRET would invalidate every issued key and token.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

say()  { printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*"; exit 1; }

# Where the Supabase stack lives (git-ignored; delete it + its volumes to reset).
SB_DIR="${SUPABASE_DIR:-$ROOT/supabase-docker}"
SB_URL="${SUPABASE_PUBLIC_URL:-http://localhost:8000}"   # Kong, the API gateway
APP_URL="${SITE_URL:-http://localhost:8080}"
WAIT_SECS="${SUPABASE_WAIT_SECS:-240}"

APP_FLAGS=()
for arg in "$@"; do
  case "$arg" in
    -h|--help) sed -n '2,31p' "$0"; exit 0 ;;
    *) APP_FLAGS+=("$arg") ;;    # everything else is forwarded to setup.sh
  esac
done

# ── 1. prerequisites ─────────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || die "Docker is required — https://docs.docker.com/get-docker/"
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required ('docker compose')"
docker info >/dev/null 2>&1 || die "Docker daemon is not running — start Docker Desktop / dockerd first"
command -v git  >/dev/null 2>&1 || die "git is required"
command -v node >/dev/null 2>&1 || die "Node.js 20.19+ is required — https://nodejs.org"
command -v curl >/dev/null 2>&1 || die "curl is required"

gen_hex() {
  if command -v openssl >/dev/null 2>&1; then openssl rand -hex "${1:-32}"
  else node -e "console.log(require('crypto').randomBytes(${1:-32}).toString('hex'))"; fi
}

# HS256-sign the two API keys from the JWT secret — the same thing the
# Supabase self-hosting docs' key generator does, without leaving your machine.
sign_key() { # $1 = role (anon | service_role), $2 = jwt secret
  node -e '
    const [role, secret] = process.argv.slice(1);
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const head = b64({ alg: "HS256", typ: "JWT" });
    const body = b64({ role, iss: "supabase", iat: now, exp: now + 10 * 365 * 24 * 3600 });
    const sig = require("crypto").createHmac("sha256", secret)
      .update(head + "." + body).digest("base64url");
    console.log(head + "." + body + "." + sig);
  ' "$1" "$2"
}

# Read/replace KEY=value in an env file, only if the key exists there —
# supabase/docker's .env.example evolves, so we substitute what is present
# rather than assuming a fixed shape.
sb_get() { grep -E "^$1=" "$SB_DIR/docker/.env" 2>/dev/null | head -1 | cut -d= -f2-; }
sb_set() {
  local k="$1" v="$2" f="$SB_DIR/docker/.env" tmp
  grep -qE "^$k=" "$f" || return 0
  tmp="$(mktemp)"; sed -E "s|^$k=.*|$k=$v|" "$f" > "$tmp" && mv "$tmp" "$f"
}

# ── 2. download the Supabase stack ───────────────────────────────────────────
if [ ! -d "$SB_DIR/docker" ]; then
  say "Downloading the official Supabase Docker stack → $SB_DIR"
  git clone --depth 1 https://github.com/supabase/supabase "$SB_DIR"
else
  say "Reusing the Supabase stack already in $SB_DIR"
fi
[ -f "$SB_DIR/docker/docker-compose.yml" ] || die "Unexpected layout in $SB_DIR — expected docker/docker-compose.yml"

# ── 3. secrets: generate once, reuse for ever ────────────────────────────────
if [ ! -f "$SB_DIR/docker/.env" ]; then
  say "Generating Supabase secrets (Postgres password, JWT secret, API keys, Studio login)"
  cp "$SB_DIR/docker/.env.example" "$SB_DIR/docker/.env"

  PG_PW="$(gen_hex 24)"
  JWT_SECRET="$(gen_hex 32)"
  ANON_KEY="$(sign_key anon "$JWT_SECRET")"
  SERVICE_KEY="$(sign_key service_role "$JWT_SECRET")"
  DASH_PW="$(gen_hex 12)"

  sb_set POSTGRES_PASSWORD    "$PG_PW"
  sb_set JWT_SECRET           "$JWT_SECRET"
  sb_set ANON_KEY             "$ANON_KEY"
  sb_set SERVICE_ROLE_KEY     "$SERVICE_KEY"
  sb_set DASHBOARD_USERNAME   "supabase"
  sb_set DASHBOARD_PASSWORD   "$DASH_PW"
  sb_set SITE_URL             "$APP_URL"
  sb_set API_EXTERNAL_URL     "$SB_URL"
  sb_set SUPABASE_PUBLIC_URL  "$SB_URL"
  sb_set POOLER_TENANT_ID     "agentswarms"
  # Present in newer stacks; harmless no-ops on older ones (sb_set skips
  # keys that do not exist in the file).
  sb_set SECRET_KEY_BASE      "$(gen_hex 32)"
  sb_set VAULT_ENC_KEY        "$(gen_hex 16)"
  sb_set LOGFLARE_PUBLIC_ACCESS_TOKEN  "$(gen_hex 16)"
  sb_set LOGFLARE_PRIVATE_ACCESS_TOKEN "$(gen_hex 16)"
else
  say "Reusing existing Supabase secrets from $SB_DIR/docker/.env"
  PG_PW="$(sb_get POSTGRES_PASSWORD)"
  JWT_SECRET="$(sb_get JWT_SECRET)"
  ANON_KEY="$(sb_get ANON_KEY)"
  SERVICE_KEY="$(sb_get SERVICE_ROLE_KEY)"
  DASH_PW="$(sb_get DASHBOARD_PASSWORD)"
  [ -n "$PG_PW" ] && [ -n "$ANON_KEY" ] && [ -n "$SERVICE_KEY" ] || \
    die "Existing $SB_DIR/docker/.env is missing keys — delete the directory to start fresh"
fi
TENANT="$(sb_get POOLER_TENANT_ID)"; TENANT="${TENANT:-agentswarms}"

# ── 4. start the stack and wait until it is REALLY ready ────────────────────
say "Starting Supabase (docker compose up -d) — first pull downloads ~2 GB of images"
# First boot initialises Postgres (bootstrap migrations, the extra databases,
# the pg_graphql migrations). On slower volume I/O that outlasts the health wait
# Compose gives the services depending on it, and they abort in "created" while
# Postgres itself goes healthy moments later. Retrying starts the ones that gave
# up; it is not a fix for a genuinely broken database, which fails again here.
start_stack() { ( cd "$SB_DIR/docker" && docker compose up -d ); }
if ! start_stack; then
  warn "Services gave up waiting on Postgres first-boot init - retrying once"
  start_stack || die "Supabase stack failed to start - check: (cd $SB_DIR/docker && docker compose ps && docker compose logs db)"
fi

say "Waiting for the auth service (up to ${WAIT_SECS}s)"
deadline=$(( $(date +%s) + WAIT_SECS ))
until curl -fsS --max-time 4 "$SB_URL/auth/v1/health" -H "apikey: $ANON_KEY" >/dev/null 2>&1; do
  [ "$(date +%s)" -ge "$deadline" ] && die "Supabase auth never became healthy — check: (cd $SB_DIR/docker && docker compose ps && docker compose logs auth kong)"
  sleep 3
done

# The storage service's own boot migrations create columns three of OUR
# migrations write to (storage.buckets.public). Pushing the schema before
# storage has booted once fails those three — measured, and documented in
# docs/DEPLOYMENT.md § "Apply the schema". So wait for the COLUMN, not a port.
say "Waiting for the storage service to finish its own migrations"
psql_db() { ( cd "$SB_DIR/docker" && docker compose exec -T db psql -U postgres -d postgres -tAc "$1" 2>/dev/null ); }
until [ "$(psql_db "select 1 from information_schema.columns where table_schema='storage' and table_name='buckets' and column_name='public'")" = "1" ]; do
  [ "$(date +%s)" -ge "$deadline" ] && die "Storage schema never appeared — check: (cd $SB_DIR/docker && docker compose logs storage)"
  sleep 3
done

# ── 5. extension preflight (verify, then create what is missing) ────────────
say "Ensuring the five required Postgres extensions exist"
for ext in vector pg_net pg_cron pgmq supabase_vault; do
  psql_db "CREATE EXTENSION IF NOT EXISTS \"$ext\";" >/dev/null \
    || warn "Could not create extension '$ext' — the migration that needs it will say so"
done

# ── 6. apply the AgentSwarms schema ──────────────────────────────────────────
# supabase link is for Cloud projects; against self-hosted we point the CLI at
# the database directly, through the session pooler the stack publishes on 5432.
DB_URL="postgresql://postgres.${TENANT}:${PG_PW}@127.0.0.1:5432/postgres?sslmode=disable"
say "Applying database migrations (npx supabase db push)"
if ! npx --yes supabase db push --db-url "$DB_URL"; then
  # Older stacks publish Postgres directly instead of through the pooler.
  warn "Push via the pooler failed — retrying against Postgres directly"
  DB_URL="postgresql://postgres:${PG_PW}@127.0.0.1:5432/postgres?sslmode=disable"
  npx --yes supabase db push --db-url "$DB_URL" || die "Migrations failed — see output above"
fi

# ── 7. create the admin user ─────────────────────────────────────────────────
ADMIN_EMAIL="${ADMIN_EMAIL:-}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
if [ -z "$ADMIN_EMAIL" ]; then
  if [ -t 0 ]; then read -r -p "Admin email (you will sign in with this): " ADMIN_EMAIL
  else ADMIN_EMAIL="admin@localhost.local"; warn "No ADMIN_EMAIL set and no terminal — defaulting to $ADMIN_EMAIL"; fi
fi
GENERATED_PW=0
if [ -z "$ADMIN_PASSWORD" ]; then
  if [ -t 0 ]; then
    read -r -s -p "Admin password (min 8 chars; leave empty to generate): " ADMIN_PASSWORD; echo
  fi
  if [ -z "$ADMIN_PASSWORD" ]; then ADMIN_PASSWORD="$(gen_hex 12)"; GENERATED_PW=1; fi
fi

say "Creating the admin user ($ADMIN_EMAIL)"
create_out="$(curl -fsS --max-time 15 -X POST "$SB_URL/auth/v1/admin/users" \
  -H "apikey: $SERVICE_KEY" -H "Authorization: Bearer $SERVICE_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\",\"email_confirm\":true}" 2>&1)" \
  && say "Admin user created and confirmed" \
  || {
    case "$create_out" in
      *already*|*registered*|*422*) warn "User $ADMIN_EMAIL already exists — keeping it (password NOT changed)"; GENERATED_PW=0 ;;
      *) die "Could not create the admin user: $create_out" ;;
    esac
  }

# ── 8. wire everything into the app's .env ───────────────────────────────────
say "Writing the app's .env (Supabase URL, keys, admin email)"
[ -f .env ] || cp .env.example .env
setenv() {
  local k="$1" v="$2" tmp
  if grep -qE "^$k=" .env; then
    tmp="$(mktemp)"; sed -E "s|^$k=.*|$k=\"$v\"|" .env > "$tmp" && mv "$tmp" .env
  else
    printf '%s="%s"\n' "$k" "$v" >> .env
  fi
}
# The browser and the SERVER HALF need DIFFERENT URLs when the app runs in a
# container. localhost:8000 is Kong from the host and from a browser, but
# inside the app container localhost is that container -- the fetch simply
# fails, and the app reports it as an auth error because every server-side
# Supabase call goes through it. Supabase self-hosted is its own compose
# project here, not a shared network, so the app reaches it across the host
# gateway. With --dev the app runs ON the host and the plain URL is right.
SB_URL_SERVER="$SB_URL"
case " ${APP_FLAGS[*]-} " in
  *" --dev "*) : ;;
  *) SB_URL_SERVER="$(printf '%s' "$SB_URL" | sed -E 's#//(localhost|127\.0\.0\.1)(:|/|$)#//host.docker.internal\2#')" ;;
esac
[ "$SB_URL_SERVER" = "$SB_URL" ] || say "Server-side Supabase URL for the container: $SB_URL_SERVER"
setenv SUPABASE_URL                 "$SB_URL_SERVER"
setenv SUPABASE_PUBLISHABLE_KEY     "$ANON_KEY"
setenv SUPABASE_SERVICE_ROLE_KEY    "$SERVICE_KEY"
setenv VITE_SUPABASE_URL            "$SB_URL"
setenv VITE_SUPABASE_PUBLISHABLE_KEY "$ANON_KEY"
setenv ADMIN_EMAIL                  "$ADMIN_EMAIL"
setenv VITE_ADMIN_EMAIL             "$ADMIN_EMAIL"
setenv SITE_URL                     "$APP_URL"

# ── 9. hand over to the standard setup (deps, remaining secrets, app stack) ──
say "Handing over to scripts/setup.sh ${APP_FLAGS[*]:-} --skip-migrations"
bash scripts/setup.sh "${APP_FLAGS[@]+"${APP_FLAGS[@]}"}" --skip-migrations

echo
say "Self-contained deployment complete"
echo "  App:              $APP_URL          (sign in as $ADMIN_EMAIL)"
if [ "$GENERATED_PW" -eq 1 ]; then
  echo "  Admin password:   $ADMIN_PASSWORD   ← generated; change it after first sign-in"
fi
echo "  Supabase API:     $SB_URL"
echo "  Supabase Studio:  http://localhost:8000  (user: supabase / password in $SB_DIR/docker/.env)"
echo "  Stack lives in:   $SB_DIR/docker    (docker compose ps / logs / down)"
echo
warn "Before production: put TLS in front of both origins, keep Studio and Postgres"
warn "off the public network, and back up Postgres AND your PROVIDER_CREDS_SECRET —"
warn "see docs/DEPLOYMENT.md § 'Self-hosted Supabase' → 'Before you call it production'."
