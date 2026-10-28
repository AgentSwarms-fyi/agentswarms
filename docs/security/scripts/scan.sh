#!/usr/bin/env bash
# Automated half of a security assessment: dependency and image scanning.
#
# Writes a timestamped directory of reports under docs/security/reports/ (which
# is git-ignored — the dated assessment under assessments/ is the committed
# summary, not these raw dumps). It NEVER exits non-zero on findings: it is a
# report generator, not a CI gate. Read the output, then write it up in
# assessments/<YYYY-MM-DD>.md.
#
# Every scanner runs as a pinned container image, so nothing is installed on the
# host and the exact version is recorded. Override a pin with the matching
# environment variable when a newer one is wanted; the script prints the digest
# it actually resolved.
#
#   bash docs/security/scripts/scan.sh            # scan everything
#   SKIP_IMAGES=1 bash docs/security/scripts/scan.sh   # deps + secrets only
#
# Requirements: docker (for the scanners and for image scanning) and npm.
#
# On Windows Git-Bash, MSYS rewrites a container-side path like `/src` or
# `/var/run/docker.sock` into a Windows path before docker sees it, so mounts
# and in-container arguments break. These exports turn that off; they are
# ignored on Linux/macOS. (The image scan is still most reliable on a Linux
# runner, where grype reads the daemon's images directly and its vulnerability
# DB downloads without stalling.)
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'
set -u

# ── Pinned scanner images ────────────────────────────────────────────────────
OSV_IMAGE="${OSV_IMAGE:-ghcr.io/google/osv-scanner:v2.6.0}"
GRYPE_IMAGE="${GRYPE_IMAGE:-anchore/grype:v0.120.1}"
GITLEAKS_IMAGE="${GITLEAKS_IMAGE:-zricethezav/gitleaks:v8.30.1}"
HADOLINT_IMAGE="${HADOLINT_IMAGE:-hadolint/hadolint:v2.15.1}"

# ── Where we are, and where output goes ──────────────────────────────────────
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
STAMP="$(date +%Y-%m-%d-%H%M%S)"
OUT="$REPO/docs/security/reports/$STAMP"
mkdir -p "$OUT"
echo "Repo:    $REPO"
echo "Reports: $OUT"
echo

have() { command -v "$1" >/dev/null 2>&1; }
digest() { # print the RepoDigests of a local image, for the record
  docker image inspect "$1" --format '{{range .RepoDigests}}{{.}}{{end}}' 2>/dev/null || true
}
pull() { # pull quietly; keep going if offline and the image is already local
  docker pull -q "$1" >/dev/null 2>&1 || true
}

# ── 1. npm audit (dependencies) ──────────────────────────────────────────────
if have npm; then
  echo "[1/5] npm audit"
  ( cd "$REPO" && npm audit --json ) > "$OUT/npm-audit-all.json" 2>/dev/null || true
  ( cd "$REPO" && npm audit --omit=dev --json ) > "$OUT/npm-audit-prod.json" 2>/dev/null || true
  ( cd "$REPO" && npm audit ) > "$OUT/npm-audit.txt" 2>&1 || true
else
  echo "[1/5] npm audit — SKIPPED (npm not found)"
fi

if ! have docker; then
  echo "docker not found — skipping the container-based scanners."
  echo "Done (partial): $OUT"
  exit 0
fi

# ── 2. osv-scanner (lockfiles across ecosystems) ─────────────────────────────
echo "[2/5] osv-scanner  $OSV_IMAGE"
pull "$OSV_IMAGE"
digest "$OSV_IMAGE" > "$OUT/_versions.txt"
# scan source walks the tree for every lockfile it recognises (npm, PyPI,
# GitHub Actions). node_modules is excluded by osv-scanner's own defaults.
docker run --rm -v "$REPO:/src:ro" "$OSV_IMAGE" \
  scan source --recursive /src --format json > "$OUT/osv.json" 2>"$OUT/osv.err" || true
docker run --rm -v "$REPO:/src:ro" "$OSV_IMAGE" \
  scan source --recursive /src > "$OUT/osv.txt" 2>>"$OUT/osv.err" || true

# ── 3. Grype (image CVEs) ────────────────────────────────────────────────────
if [ "${SKIP_IMAGES:-0}" = "1" ]; then
  echo "[3/5] grype — SKIPPED (SKIP_IMAGES=1)"
else
  echo "[3/5] grype  $GRYPE_IMAGE"
  pull "$GRYPE_IMAGE"
  digest "$GRYPE_IMAGE" >> "$OUT/_versions.txt"
  # First-party images this repo builds and their bases, plus every
  # third-party image the compose stack runs — read from docker-compose.yml,
  # pinned digests included, so the scan covers exactly what runs.
  THIRD_PARTY="$(sed -n 's/^ *image: *\([^ #]*\).*/\1/p' "$REPO/docker-compose.yml" | grep -v '^agentswarms/')"
  IMAGES="
    agentswarms-share-agentswarms:latest
    agentswarms/notebook-runtime:latest
    agentswarms/notebook-gateway:latest
    agentswarms/docgen:latest
    agentswarms/js-sandbox:latest
    node:22-slim
    python:3.12-slim
    $THIRD_PARTY
  "
  mkdir -p "$OUT/grype"
  # Persist grype's vulnerability DB across images and runs: it is ~1 GB and
  # re-downloading it per image (a --rm container has no cache) is what makes
  # grype appear to hang. The named volume is downloaded into once.
  docker volume create agentswarms-grype-db >/dev/null 2>&1 || true
  GRYPE_RUN="docker run --rm -e GRYPE_DB_CACHE_DIR=/cache
    -v agentswarms-grype-db:/cache
    -v /var/run/docker.sock:/var/run/docker.sock $GRYPE_IMAGE"
  # Grype reads the host's images through the docker socket (Linux); on Docker
  # Desktop the socket mount still works, but see the DB-cache note above.
  for img in $IMAGES; do
    safe="$(echo "$img" | tr '/:' '__')"
    if ! docker image inspect "$img" >/dev/null 2>&1; then
      echo "   - $img — not present locally, skipped" | tee -a "$OUT/grype/_skipped.txt"
      continue
    fi
    echo "   - $img"
    $GRYPE_RUN "docker:$img" -o json > "$OUT/grype/$safe.json" 2>/dev/null || true
    $GRYPE_RUN "docker:$img" -o table > "$OUT/grype/$safe.txt" 2>/dev/null || true
  done
fi

# ── 4. gitleaks (committed secrets) ──────────────────────────────────────────
echo "[4/5] gitleaks  $GITLEAKS_IMAGE"
pull "$GITLEAKS_IMAGE"
digest "$GITLEAKS_IMAGE" >> "$OUT/_versions.txt"
# The repo is mounted READ-ONLY, so gitleaks writes its report to a SEPARATE
# writable mount (/out) — writing into the :ro repo is what silently produced no
# report the first time. Git history is the authoritative "committed secrets"
# scan: it covers exactly the tracked files across every commit and so skips the
# git-ignored node_modules and the local .env by construction. (A filesystem
# `dir` scan would also walk node_modules — thousands of third-party files — so
# it is intentionally not run here; add one with an exclude config if a
# working-tree sweep of untracked files is ever needed.)
if [ -d "$REPO/.git" ]; then
  docker run --rm -v "$REPO:/repo:ro" -v "$OUT:/out" "$GITLEAKS_IMAGE" \
    git /repo --no-banner --report-format json --report-path /out/gitleaks-history.json \
    >/dev/null 2>&1 || true
fi

# ── 5. hadolint (Dockerfile hardening) ───────────────────────────────────────
echo "[5/5] hadolint  $HADOLINT_IMAGE"
pull "$HADOLINT_IMAGE"
digest "$HADOLINT_IMAGE" >> "$OUT/_versions.txt"
mkdir -p "$OUT/hadolint"
for df in Dockerfile docgen-service/Dockerfile docker/notebook-runtime/Dockerfile \
          services/js-sandbox/Dockerfile services/notebook-gateway/Dockerfile; do
  [ -f "$REPO/$df" ] || continue
  safe="$(echo "$df" | tr '/' '_')"
  docker run --rm -i "$HADOLINT_IMAGE" hadolint - < "$REPO/$df" \
    > "$OUT/hadolint/$safe.txt" 2>&1 || true
done

echo
echo "Scanner versions (digests): $OUT/_versions.txt"
echo "Done: $OUT"
echo "Summarise findings in docs/security/assessments/$(date +%Y-%m-%d).md"
