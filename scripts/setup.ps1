<#
  AgentSwarms one-command setup (Windows PowerShell).

    powershell -ExecutionPolicy Bypass -File scripts\setup.ps1            # Docker stack
    powershell -ExecutionPolicy Bypass -File scripts\setup.ps1 -Dev       # local dev server
    powershell -ExecutionPolicy Bypass -File scripts\setup.ps1 -All       # EVERY service (recommended for a full install)
    powershell -ExecutionPolicy Bypass -File scripts\setup.ps1 -Docgen    # + server-side PPTX/Word/Excel renderer
    powershell -ExecutionPolicy Bypass -File scripts\setup.ps1 -Notebooks # + Developer-workspace runtime
    powershell -ExecutionPolicy Bypass -File scripts\setup.ps1 -Sandbox   # + JS sandbox (custom code in deployed runs)
    powershell -ExecutionPolicy Bypass -File scripts\setup.ps1 -SkipMigrations

  Scaffolds .env, generates the encryption secrets, installs deps (dev mode),
  applies DB migrations, and starts the stack. You still fill your Supabase keys
  in .env once (it tells you which).
#>
param(
  [switch]$Dev,
  # -All is the whole product; the individual switches exist because each
  # optional profile costs something (LibreOffice image size, Docker socket
  # access for notebook kernels). See docs/DEPLOYMENT.md.
  [switch]$All,
  [switch]$Docgen,
  [switch]$Notebooks,
  [switch]$Sandbox,
  [switch]$SkipMigrations
)
if ($All) { $Docgen = $true; $Notebooks = $true; $Sandbox = $true }
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
if ($Dev) {
  Say "Starting dev server (Ctrl+C to stop). Open http://localhost:8080"
  npm run dev
} else {
  $profiles = @()
  if ($Docgen)    { $profiles += @("--profile","docgen") }
  if ($Notebooks) { $profiles += @("--profile","notebooks") }
  if ($Sandbox)   { $profiles += @("--profile","sandbox") }
  Say "Starting Docker stack"
  docker compose @profiles up -d --build
  Say "Up. Open http://localhost:8080"
  Write-Host "  Verify every service: sign in as the admin and open Observability -> Monitoring."
  if ($Notebooks) {
    Write-Host "  Developer-workspace runtime: containers are up, but the feature stays OFF until"
    Write-Host "    an admin flips it on in Admin -> Developer runtime (then 'Run preflight')."
  }
  if ($Sandbox) {
    Write-Host "  JS sandbox: custom-code nodes now run in DEPLOYED and SCHEDULED swarm runs too."
    # Report what the service actually says rather than assuming it is healthy.
    try {
      $null = Invoke-WebRequest -Uri "http://127.0.0.1:8091/health" -TimeoutSec 5 -UseBasicParsing
      Write-Host "    health: OK (http://127.0.0.1:8091/health)"
    } catch {
      Write-Host "    health: not answering yet - give it a few seconds, then: curl http://127.0.0.1:8091/health"
    }
    Write-Host "    Running the app with 'npm run dev' instead of in Compose? Set JS_SANDBOX_URL=""http://127.0.0.1:8091"" in .env."
  }
}
