#!/usr/bin/env bash
#
# AgentSwarms fully self-contained setup: self-hosted Supabase (Docker) + the app.
# (macOS / Linux / WSL / Git Bash — Windows users run this under WSL or Git Bash
#  with Docker Desktop running.)
#
#   bash scripts/setup-selfhosted.sh              # Supabase + core app  → :8080
#   bash scripts/setup-selfhosted.sh --all        # Supabase + EVERY service
#   bash scripts/setup-selfhosted.sh --dev        # Supabase + local dev server
#   bash scripts/setup-selfhosted.sh --yes        # unattended: nobody to confirm migrations
#   ADMIN_EMAIL=you@corp.com ADMIN_PASSWORD='...' bash scripts/setup-selfhosted.sh --all
#
# What it does, in order — the scripted version of
# docs/DEPLOYMENT.md § "Self-hosted Supabase":
#   1. downloads the official Supabase Docker stack (Postgres, GoTrue auth,
#      PostgREST, Storage, Realtime, the API gateway, Studio)
#   2. generates every secret — Postgres password, JWT secret, the ANON and
#      SERVICE_ROLE keys signed from it, Studio dashboard login, vault keys
#   3. starts the stack and WAITS for auth + storage to be genuinely ready
#      (pushing the schema before the storage service has booted once fails
#      three migrations — see DEPLOYMENT.md)
#   4. verifies/creates the Postgres extensions the migrations use
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
SB_URL="${SUPABASE_PUBLIC_URL:-http://localhost:8000}"   # the API gateway
APP_URL="${SITE_URL:-http://localhost:8080}"
WAIT_SECS="${SUPABASE_WAIT_SECS:-240}"

# The versions this script was last proved against. Both move upstream and have
# changed shape under it, so a new install takes these rather than "latest".
# docs/INSTALL.md says how to move them.
SUPABASE_STACK_REF="${SUPABASE_STACK_REF:-9eecc75e017c587641cf04db66408a96a2f37d53}"
SUPABASE_CLI_VERSION="${SUPABASE_CLI_VERSION:-3.0.0}"

ASSUME_YES=0
APP_FLAGS=()
for arg in "$@"; do
  case "$arg" in
    -h|--help) sed -n '2,/^set -euo pipefail/p' "$0" | sed '$d'; exit 0 ;;
    -y|--yes) ASSUME_YES=1 ;;
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
# A key the stack's .env does not have reads as empty, and never fails: under
# pipefail, grep's "no match" made `X="$(sb_get X)"` end the script silently,
# before the default on the next line could apply (R470, as in setup.sh).
sb_get() { { grep -E "^$1=" "$SB_DIR/docker/.env" 2>/dev/null || true; } | head -1 | cut -d= -f2-; }
sb_set() {
  local k="$1" v="$2" f="$SB_DIR/docker/.env" tmp
  grep -qE "^$k=" "$f" || return 0
  tmp="$(mktemp)"; sed -E "s|^$k=.*|$k=$v|" "$f" > "$tmp" && mv "$tmp" "$f"
}

# ── 2. download the Supabase stack ───────────────────────────────────────────
if [ ! -d "$SB_DIR/docker" ]; then
  say "Downloading the official Supabase Docker stack → $SB_DIR"
  # Only its docker folder, at the proved commit: the whole repository is far
  # bigger and nothing else in it is used. core.autocrlf stays off because these
  # files are mounted into Linux containers, and Git's default on Windows would
  # give the init SQL and shell scripts CRLF line endings.
  git init --quiet "$SB_DIR"
  git -C "$SB_DIR" config core.autocrlf false
  git -C "$SB_DIR" remote get-url origin >/dev/null 2>&1 \
    || git -C "$SB_DIR" remote add origin https://github.com/supabase/supabase
  git -C "$SB_DIR" sparse-checkout set docker
  git -C "$SB_DIR" fetch --quiet --depth 1 --filter=blob:none origin "$SUPABASE_STACK_REF"
  git -C "$SB_DIR" checkout --quiet FETCH_HEAD
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

# ── 3b. keep Postgres off a Windows folder ──────────────────────────────────
# The stack bind-mounts ./volumes/db/data. From a Windows folder every fsync goes
# through Docker Desktop's file sharing, and first-time init stalls for good: the
# directory sat at 5 KB after nine minutes. A Docker volume has no such layer.
windows_folder() {
  case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) return 0 ;; esac
  case "$SB_DIR" in /mnt/[a-zA-Z]/*) grep -qi microsoft /proc/version 2>/dev/null ;; *) return 1 ;; esac
}
OVERRIDE="$SB_DIR/docker/docker-compose.override.yml"
if [ ! -f "$OVERRIDE" ] && windows_folder; then
  if [ -f "$SB_DIR/docker/volumes/db/data/PG_VERSION" ]; then
    # Moving it would silently start an empty database in place of this one.
    warn "Postgres already has data in $SB_DIR/docker/volumes/db/data - leaving it there."
    warn "If first start stalls, delete $SB_DIR and rerun: a new install uses a Docker volume."
  else
    say "Keeping Postgres in a Docker volume (a Windows folder is too slow for it)"
    cat > "$OVERRIDE" <<'YAML'
# Written by scripts/setup-selfhosted.sh: Postgres cannot run from a Windows folder.
# `docker compose down -v` deletes this volume, and the database with it.
services:
  db:
    volumes:
      - db-data:/var/lib/postgresql/data

volumes:
  db-data:
YAML
  fi
fi
# The stack's .env pins COMPOSE_FILE, which turns off Compose's automatic pick-up
# of an override file. The separator is ":" here, and ";" by default on Windows.
if [ -f "$OVERRIDE" ]; then
  compose_files="$(sb_get COMPOSE_FILE)"
  case ":$compose_files:" in
    ::|*:docker-compose.override.yml:*) : ;;
    *) sb_set COMPOSE_FILE "$compose_files:docker-compose.override.yml" ;;
  esac
  grep -qE '^COMPOSE_PATH_SEPARATOR=' "$SB_DIR/docker/.env" \
    || printf 'COMPOSE_PATH_SEPARATOR=:\n' >> "$SB_DIR/docker/.env"
fi

# ── 4. start the stack and wait until it is REALLY ready ────────────────────
say "Starting Supabase (docker compose up -d) — first pull downloads ~2 GB of images"
# First boot initialises Postgres (bootstrap migrations, the extra databases,
# the pg_graphql migrations). On slower volume I/O that outlasts the health wait
# Compose gives the services depending on it, and they abort in "created" while
# Postgres itself goes healthy minutes later. Starting again at once only runs
# into the same wait, so let what is running settle first, then start the ones
# that gave up. A genuinely broken database fails every attempt and stops here.
# Five, because a real first install on a busy Windows machine took three: Studio
# and the gateway each outlasted Compose's wait once, and that left no margin.
start_stack() { ( cd "$SB_DIR/docker" && docker compose up -d ); }
stack_settled() {
  ! ( cd "$SB_DIR/docker" && docker compose ps --format '{{.Health}}' 2>/dev/null ) \
    | grep -qE 'starting|unhealthy'
}
start_attempts=1
until start_stack; do
  [ "$start_attempts" -ge 5 ] && die "Supabase stack failed to start - check: (cd $SB_DIR/docker && docker compose ps && docker compose logs db)"
  start_attempts=$(( start_attempts + 1 ))
  warn "Still initialising - this is normal on a first start. Waiting up to ${WAIT_SECS}s, then trying again"
  settle_deadline=$(( $(date +%s) + WAIT_SECS ))
  until stack_settled || [ "$(date +%s)" -ge "$settle_deadline" ]; do sleep 5; done
done

say "Waiting for the auth service (up to ${WAIT_SECS}s)"
deadline=$(( $(date +%s) + WAIT_SECS ))
until curl -fsS --max-time 4 "$SB_URL/auth/v1/health" -H "apikey: $ANON_KEY" >/dev/null 2>&1; do
  [ "$(date +%s)" -ge "$deadline" ] && die "Supabase auth never became healthy — check: (cd $SB_DIR/docker && docker compose ps && docker compose logs auth)"
  sleep 3
done

# The storage service runs its own migrations when it boots, and three of OUR
# migrations write to what they create (storage.buckets.public). Pushing the
# schema before storage has finished fails those three, or deadlocks with it
# (docs/DEPLOYMENT.md § "Apply the schema"). Storage serves only once its
# migrations are done, so wait until it SERVES. Until R468 this waited for the
# buckets.public column, which storage adds partway through: R467 measured our
# migrations then locking storage.buckets while storage was still altering it,
# and one died with "deadlock detected".
say "Waiting for the storage service to finish its own migrations"
psql_db() { ( cd "$SB_DIR/docker" && docker compose exec -T db psql -U postgres -d postgres -tAc "$1" 2>/dev/null ); }
storage_serving() {
  ( cd "$SB_DIR/docker" && docker compose exec -T storage wget -q -O /dev/null http://127.0.0.1:5000/status ) >/dev/null 2>&1
}
until storage_serving; do
  [ "$(date +%s)" -ge "$deadline" ] && die "The storage service never finished starting — check: (cd $SB_DIR/docker && docker compose logs storage)"
  sleep 3
done

# ── 5. extension preflight (verify, then create what is missing) ────────────
# vector is the one the schema requires. pg_net, pg_cron, pgmq and
# supabase_vault are used where the database has them and skipped where it
# does not (R467); this stack has all five.
say "Ensuring the Postgres extensions exist (vector is required)"
for ext in vector pg_net pg_cron pgmq supabase_vault; do
  psql_db "CREATE EXTENSION IF NOT EXISTS \"$ext\";" >/dev/null \
    || warn "Could not create extension '$ext' — the migration that needs it will say so"
done

# ── 6. apply the AgentSwarms schema ──────────────────────────────────────────
# supabase link is for Cloud projects; against self-hosted we point the CLI at
# the database directly. Port 5432 is the session pooler on stacks that run one,
# which needs the tenant in the user name, and Postgres itself on older ones.
if ( cd "$SB_DIR/docker" && docker compose ps --services --status running ) | grep -qx supavisor; then
  DB_URL="postgresql://postgres.${TENANT}:${PG_PW}@127.0.0.1:5432/postgres?sslmode=disable"
else
  DB_URL="postgresql://postgres:${PG_PW}@127.0.0.1:5432/postgres?sslmode=disable"
fi

# The CLI asks before it applies migrations, and refuses where it cannot ask. Say
# so here, rather than after it fails: a rerun with nothing to apply needs no answer.
migration_files=(supabase/migrations/*.sql)
migrations_applied="$(psql_db "select count(*) from supabase_migrations.schema_migrations" || true)"
migrations_pending=$(( ${#migration_files[@]} - ${migrations_applied:-0} ))
if [ "$migrations_pending" -gt 0 ] && [ "$ASSUME_YES" -eq 0 ] && [ ! -t 0 ]; then
  die "$migrations_pending migrations to apply and no terminal to confirm them. Rerun with --yes to apply them: bash scripts/setup-selfhosted.sh --yes"
fi
PUSH_FLAGS=()
[ "$ASSUME_YES" -eq 1 ] && PUSH_FLAGS+=(--yes)

say "Applying database migrations (supabase db push, CLI $SUPABASE_CLI_VERSION)"
npx --yes "supabase@$SUPABASE_CLI_VERSION" db push --remote="$DB_URL" "${PUSH_FLAGS[@]+"${PUSH_FLAGS[@]}"}" \
  || die "Migrations failed - see the output above. If the CLI asked for a confirmation it could not get, rerun with --yes"

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
# Built by node so a quote or backslash in the password stays part of the password.
admin_json="$(ADMIN_EMAIL="$ADMIN_EMAIL" ADMIN_PASSWORD="$ADMIN_PASSWORD" node -e '
  const { ADMIN_EMAIL: email, ADMIN_PASSWORD: password } = process.env;
  console.log(JSON.stringify({ email, password, email_confirm: true }));
')"
create_out="$(curl -fsS --max-time 15 -X POST "$SB_URL/auth/v1/admin/users" \
  -H "apikey: $SERVICE_KEY" -H "Authorization: Bearer $SERVICE_KEY" \
  -H "Content-Type: application/json" \
  -d "$admin_json" 2>&1)" \
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
# container. localhost:8000 is the gateway from the host and a browser, but
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
if [ -f "$OVERRIDE" ]; then
  echo "  Database:         the Docker volume supabase_db-data (docker compose down -v deletes it)"
fi
echo
warn "Before production: put TLS in front of both origins, keep Studio and Postgres"
warn "off the public network, and back up Postgres AND your PROVIDER_CREDS_SECRET —"
warn "see docs/DEPLOYMENT.md § 'Self-hosted Supabase' → 'Before you call it production'."
