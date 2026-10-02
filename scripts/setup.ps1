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

# The lakehouse catalog's password lives in TWO places that must agree: the
# container reads LAKEHOUSE_CATALOG_PASSWORD, the app reads it inside
# LAKEHOUSE_CATALOG_URL. Replace both together, once, on a fresh .env — halves
# that disagree authenticate nobody and read as a lakehouse outage.
$lhPw = Get-EnvVar "LAKEHOUSE_CATALOG_PASSWORD"
if ([string]::IsNullOrEmpty($lhPw) -or $lhPw -eq "change-me") {
  Say "Generating the lakehouse catalog password"
  $lhPw = New-Secret
  Set-EnvVar "LAKEHOUSE_CATALOG_PASSWORD" $lhPw
  Set-EnvVar "LAKEHOUSE_CATALOG_URL" "postgres://lakehouse:$lhPw@lakehouse-catalog:5432/lakehouse_catalog"
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
  Say "Applying database migrations (npx supabase db push)"
  npx --yes supabase db push
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

# ── 5. run ────────────────────────────────────────────────────────────────────
Say "Starting every service (first run builds images and pulls ~5 GB)"
docker compose up -d --build

if ($Dev) { Say "Services up. Starting the dev server (Ctrl+C to stop). Open http://localhost:8080" }
else { Say "Up. Open http://localhost:8080" }
Write-Host "  Verify every service: sign in as the admin and open Observability -> Monitoring."
Write-Host "  Office renderer (PPTX/Word/Excel): set OPENROUTER_API_KEY in .env for its verify loop."
Write-Host "  Lakehouse: the catalog and MinIO are wired in .env; the console is http://localhost:9001"
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

if ($Dev) { npm run dev }
