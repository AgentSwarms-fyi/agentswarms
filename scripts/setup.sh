#!/usr/bin/env bash
#
# AgentSwarms one-command setup (macOS / Linux / WSL / Git Bash).
#
#   bash scripts/setup.sh              # everything, in Docker  → :8080
#   bash scripts/setup.sh --dev        # everything, with the app on the host
#   bash scripts/setup.sh --skip-migrations
#
# EVERY SERVICE IS INSTALLED AND WIRED. There is nothing to opt into: the
# Developer-workspace Python runtime and its egress proxy, the lakehouse catalog
# and its object store, the vector store, the feature store, the Spark cluster,
# the Office renderer and the JS sandbox all start, and this script points .env
# at every one of them. The old per-service flags (--all, --docgen, --notebooks,
# --sandbox, --lakehouse, --spark, --vectors, --featurestore) are still accepted
# and now do nothing: a product whose features depend on which flag an installer
# was given is a product most installs never see.
#
# What that costs: about 5 GB of images and roughly 8 GB of RAM
# (docs/SYSTEM_REQUIREMENTS.md). --dev runs the app on the host with `npm run
# dev` and starts the same services beside it, reached on loopback.
#
# It scaffolds .env, generates the encryption secrets and the catalog password,
# applies the DB migrations, and starts the stack. It CANNOT create your Supabase
# project or know its keys — you fill those in .env once (it tells you which).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

MODE="docker"
SKIP_MIGRATIONS=0

for arg in "$@"; do
  case "$arg" in
    --docker) MODE="docker" ;;
    --dev) MODE="dev" ;;
    # Accepted and ignored: every service installs either way. Kept so the
    # commands in older docs, scripts and muscle memory still work.
    --all|--docgen|--notebooks|--sandbox|--lakehouse|--spark|--vectors|--featurestore) ;;
    --skip-migrations) SKIP_MIGRATIONS=1 ;;
    -h|--help) sed -n '2,/^set -euo pipefail/p' "$0" | sed '$d'; exit 0 ;;
    *) echo "Unknown option: $arg (try --help)"; exit 1 ;;
  esac
done

say()  { printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*"; exit 1; }

# ── 1. prerequisites ─────────────────────────────────────────────────────────
command -v node >/dev/null 2>&1 || die "Node.js 20.19+ is required — https://nodejs.org"
if [ "$MODE" = "docker" ]; then
  command -v docker >/dev/null 2>&1 || die "Docker is required for --docker mode (or use --dev)"
  docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required ('docker compose')"
fi

# ── 2. .env ──────────────────────────────────────────────────────────────────
if [ ! -f .env ]; then say "Creating .env from .env.example"; cp .env.example .env; fi

# ── 2a. egress allow-list ────────────────────────────────────────────────────
# The live pair is generated (the app rewrites it on every admin save) and so is
# not tracked; the .default files are. Seed BEFORE compose runs: docker-compose
# bind-mounts these two paths as files, and Docker silently creates a DIRECTORY
# at a bind-mount source that does not exist — after which squid fails to start
# with "allowed_domains: Is a directory" and the fix is no longer obvious.
for f in allowed_domains allowed_ips; do
  if [ ! -f "deploy/notebooks/egress/$f" ]; then
    say "Creating deploy/notebooks/egress/$f from $f.default"
    cp "deploy/notebooks/egress/$f.default" "deploy/notebooks/egress/$f"
  fi
done

getenv() { grep -E "^$1=" .env | head -1 | sed -E "s/^$1=\"?([^\"]*)\"?$/\1/"; }
setenv() {
  local k="$1" v="$2" tmp
  if grep -qE "^$k=" .env; then
    tmp="$(mktemp)"; sed -E "s|^$k=.*|$k=\"$v\"|" .env > "$tmp" && mv "$tmp" .env
  else
    printf '%s="%s"\n' "$k" "$v" >> .env
  fi
}
gen_secret() {
  if command -v openssl >/dev/null 2>&1; then openssl rand -hex 32
  else node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"; fi
}

# Auto-generate the at-rest encryption + internal secrets if blank.
[ -z "$(getenv PROVIDER_CREDS_SECRET)" ] && { say "Generating PROVIDER_CREDS_SECRET"; setenv PROVIDER_CREDS_SECRET "$(gen_secret)"; }
[ -z "$(getenv INTERNAL_RUN_SECRET)" ]   && setenv INTERNAL_RUN_SECRET "$(gen_secret)"

# The lakehouse catalog's password lives in TWO places that must agree: the
# container reads LAKEHOUSE_CATALOG_PASSWORD, the app reads it inside
# LAKEHOUSE_CATALOG_URL. .env.example ships "change-me" in both; replace both
# together, once, on a fresh .env. A catalog whose halves disagree authenticates
# nobody and reports it as a lakehouse outage.
if [ "$(getenv LAKEHOUSE_CATALOG_PASSWORD)" = "change-me" ] || [ -z "$(getenv LAKEHOUSE_CATALOG_PASSWORD)" ]; then
  say "Generating the lakehouse catalog password"
  LH_PW="$(gen_secret)"
  setenv LAKEHOUSE_CATALOG_PASSWORD "$LH_PW"
  setenv LAKEHOUSE_CATALOG_URL "postgres://lakehouse:${LH_PW}@lakehouse-catalog:5432/lakehouse_catalog"
fi

# The app runs on the HOST in --dev, where compose service names do not resolve.
# Every service publishes its port on loopback for exactly this, so dev gets the
# same product rather than a subset.
if [ "$MODE" = "dev" ]; then
  say "Pointing .env at the services on loopback (the app runs on this host)"
  setenv QDRANT_URL "http://127.0.0.1:6333"
  setenv FEATURE_STORE_URL "redis://127.0.0.1:6379"
  setenv SPARK_CONNECT_URL "sc://127.0.0.1:15002"
  setenv LAKEHOUSE_S3_ENDPOINT "127.0.0.1:9000"
  setenv JS_SANDBOX_URL "http://127.0.0.1:8091"
  LH_PW="$(getenv LAKEHOUSE_CATALOG_PASSWORD)"
  setenv LAKEHOUSE_CATALOG_URL "postgres://lakehouse:${LH_PW}@127.0.0.1:55432/lakehouse_catalog"
fi

# DOCGEN_SERVICE_URL is deliberately NOT set here: the app probes both the
# in-network (`docgen:8099`) and published-loopback (`localhost:8099`) addresses,
# so the renderer is found in either run mode without a mode-specific value that
# would be wrong after switching.

# Required Supabase values must be filled by the user.
MISSING=""
for k in SUPABASE_URL SUPABASE_PUBLISHABLE_KEY SUPABASE_SERVICE_ROLE_KEY \
         VITE_SUPABASE_URL VITE_SUPABASE_PUBLISHABLE_KEY ADMIN_EMAIL VITE_ADMIN_EMAIL; do
  [ -z "$(getenv "$k")" ] && MISSING="$MISSING $k"
done
if [ -n "$MISSING" ]; then
  warn "Fill these required values in .env, then re-run this script:"
  for k in $MISSING; do echo "    - $k"; done
  echo "  Get them from your Supabase project → Settings → API."
  echo "  Full walkthrough: docs/INSTALL.md"
  exit 1
fi

# ── 3. dependencies (dev mode only; Docker builds them in-image) ──────────────
if [ "$MODE" = "dev" ]; then say "Installing dependencies"; npm install; fi

# ── 4. database migrations ───────────────────────────────────────────────────
if [ "$SKIP_MIGRATIONS" -eq 0 ]; then
  say "Applying database migrations (npx supabase db push)"
  if ! npx --yes supabase db push; then
    warn "Could not push migrations — link the project first, then re-run:"
    echo "    npx supabase login"
    # The project ref is NOT an env var (nothing at runtime reads one).
    # On Supabase Cloud it is the subdomain of SUPABASE_URL.
    ref="$(getenv SUPABASE_URL | sed -E 's#^https?://([^.]+)\.supabase\.(co|in).*#\1#')"
    case "$ref" in
      http*|"") ref="<your-project-ref>" ;;
    esac
    echo "    npx supabase link --project-ref $ref"
    echo "  (or re-run with --skip-migrations if already applied)"
    exit 1
  fi
fi

# ── 5. run ───────────────────────────────────────────────────────────────────
say "Starting every service (first run builds images and pulls ~5 GB)"
docker compose up -d --build

if [ "$MODE" = "docker" ]; then
  say "Up. Open http://localhost:8080"
else
  say "Services up. Starting the dev server (Ctrl+C to stop). Open http://localhost:8080"
fi
echo "  Verify every service: sign in as the admin and open Observability -> Monitoring."
echo "  Office renderer (PPTX/Word/Excel): set OPENROUTER_API_KEY in .env for its verify loop."
echo "  Lakehouse: catalog + MinIO are wired in .env; its console is http://localhost:9001"
echo "  Developer-workspace runtime: the containers are up, but running people's code"
echo "    stays OFF until an admin turns it on in Admin -> Developer runtime ('Run preflight')."
echo "  Spark: the first pipeline run downloads the connector jars. See docs/ETL_PIPELINES.md."

# Report what the sandbox says rather than assuming the build that just started
# is healthy. It sits on an internal network with no published port, so ask the
# container itself; its image is dependency-free Node, so node is the client.
SANDBOX_PROBE="fetch('http://127.0.0.1:8091/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
if docker compose exec -T js-sandbox node -e "$SANDBOX_PROBE" >/dev/null 2>&1; then
  echo "  JS sandbox health: OK (reached in-network at js-sandbox:8091)"
else
  echo "  JS sandbox health: not answering yet - give it a few seconds, then:"
  echo "    docker compose exec -T js-sandbox \\"
  echo "      node -e \"fetch('http://127.0.0.1:8091/health').then(r=>r.text()).then(console.log)\""
fi

if [ "$MODE" = "dev" ]; then
  npm run dev
fi
