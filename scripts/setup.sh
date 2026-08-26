#!/usr/bin/env bash
#
# AgentSwarms one-command setup (macOS / Linux / WSL / Git Bash).
#
#   bash scripts/setup.sh                 # core stack (app only)  → :8080
#   bash scripts/setup.sh --all           # EVERY service (recommended for a full install)
#   bash scripts/setup.sh --dev           # local dev server (npm run dev)
#   bash scripts/setup.sh --docgen        # + server-side PPTX/Word/Excel renderer
#   bash scripts/setup.sh --notebooks     # + Developer-workspace Python runtime
#   bash scripts/setup.sh --sandbox       # + JS sandbox (custom code in deployed runs)
#   bash scripts/setup.sh --skip-migrations
#
# --all is the whole product. The optional profiles are separate because each
# costs something: the renderer pulls LibreOffice (~1 GB), and the notebook
# runtime mounts the Docker socket into a least-privilege proxy so it can start
# kernel containers. Both are documented in docs/DEPLOYMENT.md.
#
# It scaffolds .env, generates the encryption secrets, installs deps (dev mode),
# applies the DB migrations, and starts the stack. It CANNOT create your Supabase
# project or know its keys — you fill those in .env once (it tells you which).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

MODE="docker"
PROFILE_FLAGS=""
DOCGEN=0
SANDBOX=0
NOTEBOOKS=0
SKIP_MIGRATIONS=0

add_profile() {
  case "$PROFILE_FLAGS" in
    *"--profile $1"*) return 0 ;;  # already requested (e.g. --all --docgen)
  esac
  PROFILE_FLAGS="$PROFILE_FLAGS --profile $1"
}
for arg in "$@"; do
  case "$arg" in
    --docker) MODE="docker" ;;
    --dev) MODE="dev" ;;
    --all)
      DOCGEN=1; SANDBOX=1; NOTEBOOKS=1
      add_profile docgen; add_profile notebooks; add_profile sandbox ;;
    --docgen) DOCGEN=1; add_profile docgen ;;
    --notebooks) NOTEBOOKS=1; add_profile notebooks ;;
    --sandbox) SANDBOX=1; add_profile sandbox ;;
    --skip-migrations) SKIP_MIGRATIONS=1 ;;
    -h|--help) sed -n '2,21p' "$0"; exit 0 ;;
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
if [ "$MODE" = "docker" ]; then
  say "Starting Docker stack${PROFILE_FLAGS:+ (}${PROFILE_FLAGS}${PROFILE_FLAGS:+ )}"
  # shellcheck disable=SC2086
  docker compose $PROFILE_FLAGS up -d --build
  say "Up. Open http://localhost:8080"
  echo "  Verify every service: sign in as the admin and open Observability -> Monitoring."
  [ "$DOCGEN" -eq 1 ] && echo "  Server-side PPTX/Word/Excel renderer: http://docgen:8099 in-cluster, http://localhost:8099 from the host (set OPENROUTER_API_KEY in .env for the PPT verify loop)"
  if [ "$NOTEBOOKS" -eq 1 ]; then
    echo "  Developer-workspace runtime: containers are up, but the feature stays OFF until"
    echo "    an admin flips it on in Admin -> Developer runtime (then 'Run preflight')."
  fi
  if [ "$SANDBOX" -eq 1 ]; then
    echo "  JS sandbox: custom-code nodes now run in DEPLOYED and SCHEDULED swarm runs too."
    # Report what the service actually says, rather than assuming the build
    # that just started is healthy. Ask the container itself: js-sandbox sits on
    # an internal network, which publishes no host port, so curl'ing a loopback
    # port here would report "unhealthy" for a service that is perfectly fine.
    # Its image is dependency-free Node, so node is the client it has.
    SANDBOX_PROBE="fetch('http://127.0.0.1:8091/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
    if docker compose $PROFILE_FLAGS exec -T js-sandbox node -e "$SANDBOX_PROBE" >/dev/null 2>&1; then
      echo "    health: OK (reached in-network at js-sandbox:8091)"
    else
      echo "    health: not answering yet - give it a few seconds, then:"
      echo "      docker compose --profile sandbox exec -T js-sandbox \\"
      echo "        node -e \"fetch('http://127.0.0.1:8091/health').then(r=>r.text()).then(console.log)\""
    fi
    echo "    Running the app with 'npm run dev' instead of in Compose? The container"
    echo "      publishes no host port (its network is internal: true), so run the"
    echo "      service on the host instead - it is dependency-free Node:"
    echo "        INTERNAL_RUN_SECRET=\"<same value as .env>\" node services/js-sandbox/server.mjs"
    echo "      then set JS_SANDBOX_URL=\"http://127.0.0.1:8091\" in .env. Note a host"
    echo "      process has none of the container's isolation - keep it to dev."
  fi
else
  say "Starting dev server (Ctrl+C to stop). Open http://localhost:8080"
  npm run dev
fi
