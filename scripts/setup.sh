#!/usr/bin/env bash
#
# AgentSwarms one-command setup (macOS / Linux / WSL / Git Bash).
#
#   bash scripts/setup.sh                 # Docker stack (default)
#   bash scripts/setup.sh --dev           # local dev server (npm run dev)
#   bash scripts/setup.sh --docgen        # + server-side PPTX renderer
#   bash scripts/setup.sh --notebooks     # + Developer-workspace Python runtime
#   bash scripts/setup.sh --skip-migrations
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
SKIP_MIGRATIONS=0
for arg in "$@"; do
  case "$arg" in
    --docker) MODE="docker" ;;
    --dev) MODE="dev" ;;
    --docgen) DOCGEN=1; PROFILE_FLAGS="$PROFILE_FLAGS --profile docgen" ;;
    --notebooks) PROFILE_FLAGS="$PROFILE_FLAGS --profile notebooks" ;;
    --skip-migrations) SKIP_MIGRATIONS=1 ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
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

# docgen wiring
if [ "$DOCGEN" -eq 1 ] && [ -z "$(getenv DOCGEN_SERVICE_URL)" ]; then
  setenv DOCGEN_SERVICE_URL "http://docgen:8099"
fi

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
    echo "    npx supabase link --project-ref $(getenv SUPABASE_PROJECT_ID)"
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
  [ "$DOCGEN" -eq 1 ] && echo "  Server-side PPTX renderer: http://docgen:8099 (set OPENROUTER_API_KEY in .env for the verify loop)"
else
  say "Starting dev server (Ctrl+C to stop). Open http://localhost:8080"
  npm run dev
fi
