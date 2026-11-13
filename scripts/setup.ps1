<#
  AgentSwarms one-command setup (Windows PowerShell).

    powershell -ExecutionPolicy Bypass -File scripts\setup.ps1         # everything, in Docker
    powershell -ExecutionPolicy Bypass -File scripts\setup.ps1 -Dev    # everything, app on the host
    powershell -ExecutionPolicy Bypass -File scripts\setup.ps1 -SkipMigrations

  EVERY SERVICE IS INSTALLED AND WIRED. There is nothing to opt into: the
  Developer-workspace Python runtime and its egress proxy, the lakehouse catalog
  and its object store, the vector store, the feature store, the Spark cluster,
  the Office renderer and the JS sandbox all start, and this script points .env
  at every one of them. The old per-service switches (-All, -Docgen, -Notebooks,
  -Sandbox, -Lakehouse, -Spark, -Vectors, -Featurestore) are still accepted and
  now do nothing: a product whose features depend on which flag an installer was
  given is a product most installs never see.

  What that costs: about 5 GB of images and roughly 8 GB of RAM
  (docs/SYSTEM_REQUIREMENTS.md). -Dev runs the app on this host with npm run dev
  and starts the same services beside it, reached on loopback.

  Scaffolds .env, generates the encryption secrets and the catalog password,
  applies DB migrations, and starts the stack. You still fill your Supabase keys
  in .env once (it tells you which).
#>
param(
  [switch]$Dev,
  [switch]$SkipMigrations,
  [switch]$Help,
  # Accepted and ignored: every service installs either way. Kept so the
  # commands in older docs and muscle memory still work.
  [switch]$All, [switch]$Docgen, [switch]$Notebooks, [switch]$Sandbox,
  [switch]$Lakehouse, [switch]$Spark, [switch]$Vectors, [switch]$Featurestore
)
if ($Help) { Get-Content $PSCommandPath | Select-Object -Skip 1 -First 22; exit 0 }
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$envFile = Join-Path $root ".env"

function Say($m)  { Write-Host "`n> $m" -ForegroundColor Cyan }
function Warn($m) { Write-Host "! $m" -ForegroundColor Yellow }
function Die($m)  { Write-Host "x $m" -ForegroundColor Red; exit 1 }

# ── 1. prerequisites ──────────────────────────────────────────────────────────
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Die "Node.js 20.19+ is required - https://nodejs.org" }
if (-not $Dev) {
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Die "Docker is required (or use -Dev)" }
}

# ── 2. .env ───────────────────────────────────────────────────────────────────
if (-not (Test-Path $envFile)) { Say "Creating .env from .env.example"; Copy-Item ".env.example" $envFile }

# ── 2a. egress allow-list ─────────────────────────────────────────────────────
# The live pair is generated (the app rewrites it on every admin save) and so is
# not tracked; the .default files are. Seed BEFORE compose runs: docker-compose
# bind-mounts these two paths as files, and Docker silently creates a DIRECTORY
# at a bind-mount source that does not exist — after which squid fails to start
# with "allowed_domains: Is a directory" and the fix is no longer obvious.
foreach ($f in @("allowed_domains", "allowed_ips")) {
  $live = "deploy/notebooks/egress/$f"
  if (-not (Test-Path $live)) {
    Say "Creating $live from $f.default"
    Copy-Item "$live.default" $live
  }
}

function Get-EnvVar($k) {
  $line = Select-String -Path $envFile -Pattern "^$k=" | Select-Object -First 1
  if (-not $line) { return "" }
  return ($line.Line -replace "^$k=`"?([^`"]*)`"?$", '$1')
}
function Set-EnvVar($k, $v) {
  $content = Get-Content $envFile
  if ($content -match "^$k=") {
    $content = $content -replace "^$k=.*", "$k=`"$v`""
  } else {
    $content += "$k=`"$v`""
  }
  Set-Content -Path $envFile -Value $content -Encoding utf8
}
function New-Secret {
  $bytes = New-Object 'System.Byte[]' 32
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  return -join ($bytes | ForEach-Object { $_.ToString("x2") })
}

if ([string]::IsNullOrEmpty((Get-EnvVar "PROVIDER_CREDS_SECRET"))) { Say "Generating PROVIDER_CREDS_SECRET"; Set-EnvVar "PROVIDER_CREDS_SECRET" (New-Secret) }
if ([string]::IsNullOrEmpty((Get-EnvVar "INTERNAL_RUN_SECRET")))   { Set-EnvVar "INTERNAL_RUN_SECRET" (New-Secret) }
# The Spark Connect pre-shared token (VA-23). The server enforces it and the app
# sends it to every run, so a kernel cannot drive the Spark driver unauthenticated.
# A fresh install gets one; left blank, the server runs without auth.
if ([string]::IsNullOrEmpty((Get-EnvVar "SPARK_CONNECT_TOKEN")))   { Say "Generating SPARK_CONNECT_TOKEN"; Set-EnvVar "SPARK_CONNECT_TOKEN" (New-Secret) }
# The online feature store and the vector store take a password (VA-41). Both
# sit on the Compose network with spark-connect, where pipelines' Python UDFs
# run. valkey reads VALKEY_PASSWORD and so does the app. Qdrant's server key and
# the key the app sends are two settings (an external Qdrant has only the
# second), so the bundled one gets the same value in both.
if ([string]::IsNullOrEmpty((Get-EnvVar "VALKEY_PASSWORD")))       { Say "Generating VALKEY_PASSWORD"; Set-EnvVar "VALKEY_PASSWORD" (New-Secret) }
# The renderer's bearer token (R413), as setup-k8s.sh already generates: without
# it anything on the Compose network can make LibreOffice render a document.
if ([string]::IsNullOrEmpty((Get-EnvVar "DOCGEN_TOKEN")))          { Say "Generating DOCGEN_TOKEN"; Set-EnvVar "DOCGEN_TOKEN" (New-Secret) }
if ([string]::IsNullOrEmpty((Get-EnvVar "QDRANT__SERVICE__API_KEY"))) {
  $qKey = Get-EnvVar "QDRANT_API_KEY"
  if ([string]::IsNullOrEmpty($qKey)) { $qKey = New-Secret; Set-EnvVar "QDRANT_API_KEY" $qKey }
  Say "Generating the vector store's API key"
  Set-EnvVar "QDRANT__SERVICE__API_KEY" $qKey
}

# The lake's object-store secret (VA-44, R414). .env.example ships
# agentswarms-lake-dev, which on the bundled store is the ROOT password, open to
# anything on the Compose network. Replaced on an existing install too: the
# store (SILO since R418, MinIO before; both behave so) takes new root
# credentials at its next start and keeps its data (measured: the bucket and an
# object were still there, and the old pair was refused), and the store,
# minio-init and the app all read this one variable.
$s3Secret = Get-EnvVar "LAKEHOUSE_S3_SECRET"
if ([string]::IsNullOrEmpty($s3Secret) -or $s3Secret -eq "agentswarms-lake-dev") {
  Say "Generating LAKEHOUSE_S3_SECRET (the lake's object-store password)"
  Set-EnvVar "LAKEHOUSE_S3_SECRET" (New-Secret)
}

# The lakehouse catalog's password lives in TWO places that must agree: the
# container reads LAKEHOUSE_CATALOG_PASSWORD, the app reads it inside
# LAKEHOUSE_CATALOG_URL. Replace both together, once, on a fresh .env — halves
# that disagree authenticate nobody and read as a lakehouse outage.
#
# Only while the catalog has no data volume (R415). Postgres takes
# POSTGRES_PASSWORD when it creates its volume and never again, so a catalog
# that started on change-me keeps it, and a new value in .env alone would be
# exactly that outage. There the password is changed inside Postgres first.
# 0 = the volume exists, 1 = it does not, 2 = Docker can't say.
function Get-CatalogVolumeState {
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { return 2 }
  # Local to this function: under "Stop", Windows PowerShell turns a native
  # command's stderr into a terminating error even when it is discarded.
  $ErrorActionPreference = "Continue"
  try {
    # Captured whole first: a Select-Object -First downstream stops docker
    # mid-output, and $LASTEXITCODE is then -1 rather than docker's answer.
    $config = docker compose config 2>$null
    if ($LASTEXITCODE -ne 0) { return 2 }
    $line = $config | Select-String -Pattern '^name: (.+)$' | Select-Object -First 1
    if (-not $line) { return 2 }
    $project = $line.Matches[0].Groups[1].Value.Trim()
    $vols = docker volume ls -q --filter "label=com.docker.compose.project=$project" --filter "label=com.docker.compose.volume=lakehouse-catalog-data" 2>$null
    if ($LASTEXITCODE -ne 0) { return 2 }
    if ([string]::IsNullOrWhiteSpace(($vols | Out-String))) { return 1 }
    return 0
  } catch { return 2 }
}
$lhPw = Get-EnvVar "LAKEHOUSE_CATALOG_PASSWORD"
if ([string]::IsNullOrEmpty($lhPw) -or $lhPw -eq "change-me") {
  $catalogVolume = Get-CatalogVolumeState
  if ($catalogVolume -eq 1) {
    Say "Generating the lakehouse catalog password"
    $lhPw = New-Secret
    Set-EnvVar "LAKEHOUSE_CATALOG_PASSWORD" $lhPw
    Set-EnvVar "LAKEHOUSE_CATALOG_URL" "postgres://lakehouse:$lhPw@lakehouse-catalog:5432/lakehouse_catalog"
  } elseif ($catalogVolume -eq 0) {
    Warn "The lakehouse catalog runs on the published password change-me, and it already holds"
    Warn "data, so .env keeps it: Postgres would not follow a new one. Change it inside the catalog:"
    Write-Host '    docker compose exec lakehouse-catalog psql -U lakehouse -d lakehouse_catalog `'
    Write-Host "      -c `"ALTER USER lakehouse PASSWORD 'NEW_PASSWORD'`""
    Write-Host "  then put it in LAKEHOUSE_CATALOG_PASSWORD and in LAKEHOUSE_CATALOG_URL, and run"
    Write-Host "    docker compose up -d agentswarms        (docs/LAKEHOUSE.md)"
  } else {
    Warn "The lakehouse catalog password is change-me, and Docker could not say whether the catalog"
    Warn "already holds data, so .env keeps it. Start Docker and run this script again."
  }
}
# An empty password is Compose's change-me (R415: an existing catalog keeps it).
if ([string]::IsNullOrEmpty($lhPw)) { $lhPw = "change-me" }

# The vector store, wired on an install that predates the wiring (R417).
# .env.example has pointed a fresh install at the bundled Qdrant since
# 2026-09-15; an .env made before that has neither line, so the Qdrant this
# stack starts searched nothing and RAG Settings called it "not configured".
# Added only when ABSENT: a value already there, VECTOR_STORE="pgvector" or an
# empty QDRANT_URL included, is somebody's choice. Existing vectors are copied
# from Postgres by the app itself, which searches Postgres's copy until they are.
if (-not (Select-String -Path $envFile -Pattern '^QDRANT_URL=' -Quiet)) {
  Say "Wiring the bundled vector store into .env (QDRANT_URL)"
  Set-EnvVar "QDRANT_URL" "http://qdrant:6333"
}
if (-not (Select-String -Path $envFile -Pattern '^VECTOR_STORE=' -Quiet) -and
    -not [string]::IsNullOrEmpty((Get-EnvVar "QDRANT_URL"))) {
  Say "Knowledge bases now search the bundled Qdrant (VECTOR_STORE=qdrant)"
  Write-Host "  The app copies their vectors from Postgres on its first scheduler pass, and searches"
  Write-Host "  Postgres until it has. To keep searching Postgres, set VECTOR_STORE=`"pgvector`" in .env."
  Set-EnvVar "VECTOR_STORE" "qdrant"
}

# The app runs on the HOST in -Dev, where compose service names do not resolve.
# Every service publishes its port on loopback for exactly this, so development
# gets the same product rather than a subset of it.
if ($Dev) {
  Say "Pointing .env at the services on loopback (the app runs on this host)"
  Set-EnvVar "QDRANT_URL" "http://127.0.0.1:6333"
  Set-EnvVar "FEATURE_STORE_URL" "redis://127.0.0.1:6379"
  Set-EnvVar "SPARK_CONNECT_URL" "sc://127.0.0.1:15002"
  Set-EnvVar "LAKEHOUSE_S3_ENDPOINT" "127.0.0.1:9000"
  Set-EnvVar "JS_SANDBOX_URL" "http://127.0.0.1:8091"
  Set-EnvVar "LAKEHOUSE_CATALOG_URL" "postgres://lakehouse:$lhPw@127.0.0.1:55432/lakehouse_catalog"
}
# DOCGEN_SERVICE_URL is deliberately NOT set here: the app probes both the
# in-network (`docgen:8099`) and published-loopback (`localhost:8099`) addresses,
# so the renderer is found in either run mode without a mode-specific value that
# would be wrong after switching.

$required = @("SUPABASE_URL","SUPABASE_PUBLISHABLE_KEY","SUPABASE_SERVICE_ROLE_KEY","VITE_SUPABASE_URL","VITE_SUPABASE_PUBLISHABLE_KEY","ADMIN_EMAIL","VITE_ADMIN_EMAIL")
$missing = $required | Where-Object { [string]::IsNullOrEmpty((Get-EnvVar $_)) }
if ($missing.Count -gt 0) {
  Warn "Fill these required values in .env, then re-run this script:"
  $missing | ForEach-Object { Write-Host "    - $_" }
  Write-Host "  Get them from your Supabase project -> Settings -> API. See docs/INSTALL.md"
  exit 1
}

# ── 3. dependencies (dev mode only) ───────────────────────────────────────────
if ($Dev) { Say "Installing dependencies"; npm install }

# ── 4. database migrations ────────────────────────────────────────────────────
if (-not $SkipMigrations) {
  # The CLI this script was last proved against. 3.0.0 changed what a bare
  # `db push` targets, so a new install takes this rather than "latest".
  $supabaseCli = if ($env:SUPABASE_CLI_VERSION) { $env:SUPABASE_CLI_VERSION } else { "3.0.0" }
  Say "Applying database migrations (supabase db push, CLI $supabaseCli)"
  npx --yes "supabase@$supabaseCli" db push --remote
  if ($LASTEXITCODE -ne 0) {
    Warn "Could not push migrations - link the project first, then re-run:"
    Write-Host "    npx supabase login"
    # The project ref is NOT an env var (nothing at runtime reads one).
    # On Supabase Cloud it is the subdomain of SUPABASE_URL.
    $ref = "<your-project-ref>"
    $supaUrl = Get-EnvVar "SUPABASE_URL"
    if ($supaUrl -match "^https?://([^.]+)\.supabase\.(co|in)") { $ref = $Matches[1] }
    Write-Host ("    npx supabase link --project-ref " + $ref)
    Write-Host "  (or re-run with -SkipMigrations if already applied)"
    exit 1
  }
}

# ── 4a. the vector store's volume (VA-38, R416) ───────────────────────────────
# Qdrant opens storage from the previous minor release only, and its pin moved
# from 1.12.4 to 1.20.0. Started on an older volume, the new pin would leave
# the vector store down, so the releases in between open it first. A fresh
# install, or one already a minor away, has nothing to do.
node scripts/upgrade-qdrant.mjs
if ($LASTEXITCODE -ne 0) { Die "The vector store's volume was not upgraded (see above); nothing was started." }

# ── 5. run ────────────────────────────────────────────────────────────────────
# The sandbox image used to be agentswarms/notebook-runtime:latest, a Docker
# Hub name nobody here owns; an .env still holding that old default would keep
# pulling by it. Compose names it under ghcr.io/agentswarms-fyi now (R470).
if ((Get-EnvVar "NOTEBOOK_RUNTIME_IMAGE") -eq "agentswarms/notebook-runtime:latest") {
  Say "Clearing NOTEBOOK_RUNTIME_IMAGE: its old default is a Docker Hub name nobody here owns"
  Set-EnvVar "NOTEBOOK_RUNTIME_IMAGE" ""
}

# AGENTSWARMS_VERSION in .env picks a published release; empty builds this
# checkout. A release is pulled and never built: a missing or mistyped version
# stops here rather than building this checkout under the release's name.
$Release = Get-EnvVar "AGENTSWARMS_VERSION"
$Registry = Get-EnvVar "AGENTSWARMS_REGISTRY"
if ([string]::IsNullOrEmpty($Registry)) { $Registry = "ghcr.io/agentswarms-fyi" }
if (-not [string]::IsNullOrEmpty($Release) -and $Release -ne "local") {
  Say "Starting release ${Release}: pulling its signed images from $Registry (nothing is built)"
  docker compose pull
  if ($LASTEXITCODE -ne 0) { Die "Could not pull release $Release. Check AGENTSWARMS_VERSION (and AGENTSWARMS_REGISTRY) in .env; leave it empty to build from this checkout." }
  docker compose up -d --no-build
  if ($LASTEXITCODE -ne 0) { Die "Release $Release did not start (see above)." }
} else {
  Say "Starting every service (first run builds images and pulls ~5 GB)"
  docker compose up -d --build
}

if ($Dev) { Say "Services up. Starting the dev server (Ctrl+C to stop). Open http://localhost:8080" }
else { Say "Up. Open http://localhost:8080" }
Write-Host "  Verify every service: sign in as the admin and open Observability -> Monitoring."
Write-Host "  Office renderer (PPTX/Word/Excel): set OPENROUTER_API_KEY in .env for its verify loop."
Write-Host "  Lakehouse: the catalog and its object store (SILO) are wired in .env; the store's console is http://localhost:9001"
Write-Host "  Developer-workspace runtime: the containers are up, but running people-authored code"
Write-Host "    stays OFF until an admin turns it on in Admin -> Developer runtime ('Run preflight')."
Write-Host "  Spark: the first pipeline run downloads the connector jars. See docs/ETL_PIPELINES.md."

# Ask the sandbox container itself: it sits on an internal network with no
# published port, and its image is dependency-free Node.
$probe = "fetch('http://127.0.0.1:8091/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
docker compose exec -T js-sandbox node -e $probe *> $null
if ($LASTEXITCODE -eq 0) { Write-Host "  JS sandbox health: OK (reached in-network at js-sandbox:8091)" }
else {
  Write-Host "  JS sandbox health: not answering yet - give it a few seconds, then:"
  Write-Host '    docker compose exec -T js-sandbox node -e "fetch(''http://127.0.0.1:8091/health'').then(r=>r.text()).then(console.log)"'
}

if ($Dev) {
  # The Docker socket proxy is reachable by the containerised app only (VA-40,
  # R408): whoever reaches it can start any container. An app on this host
  # needs its own proxy on loopback to start notebook kernels; that one is
  # reachable from containers on routable networks while it runs, so it is
  # the developer's choice, not this script's.
  Write-Host "  Notebook kernels with the app on this host: start a Docker proxy on loopback"
  Write-Host "    (development machines only; docs/DEPLOYMENT.md says what it exposes):"
  Write-Host "    docker run -d --name agentswarms-dev-docker-proxy -p 127.0.0.1:2375:2375 ``"
  Write-Host "      -v /var/run/docker.sock:/var/run/docker.sock:ro ``"
  Write-Host "      -e CONTAINERS=1 -e IMAGES=1 -e NETWORKS=1 -e POST=1 ``"
  $ProxyTag = if ([string]::IsNullOrEmpty($Release)) { "local" } else { $Release }
  Write-Host "      $Registry/docker-socket-proxy:$ProxyTag"
  npm run dev
}
