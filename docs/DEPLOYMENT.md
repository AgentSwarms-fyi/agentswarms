# Production deployment

> Part of the [AgentSwarms docs](../README.md#documentation).

This guide takes you from a clone to a running instance, with a path for every
setup — **trying it on your own laptop**, a **single cloud VM**, an
**autoscaled fleet behind a load balancer**, or **Kubernetes**.

## How the pieces fit (read this first)

AgentSwarms is two things:

- **The app** — a single Node process (TanStack Start) that serves the web UI,
  server-side rendering, and every `/api` route on **port 8080**. It is
  **stateless**: authentication is a Supabase JWT carried on each request, and
  all durable data lives in Supabase — nothing important is written to local
  disk. That's what makes it easy to containerize and to run as many copies of.
- **The backend** — one **Supabase** project (Postgres + Auth + Storage). This
  is the single source of truth all app instances share.

Because the app is stateless, "scaling" just means running more copies of the
same container behind a load balancer, all pointed at the same Supabase project.
There is **one** thing to coordinate when you run more than one copy — the
background scheduler — and it's a two-line setup covered below.

### Which option should I pick?

| You want to… | Use | Section |
| --- | --- | --- |
| Try it on your own machine | **Local desktop (Docker Desktop)** | [A](#a-local-desktop) |
| Run it for a team on one server | **Single cloud VM** — the recommended default | [B](#b-single-cloud-vm-recommended) |
| Handle spiky/high load with autoscaling | **Autoscaled VMs + load balancer** | [C](#c-autoscaled-vms-behind-a-load-balancer) |
| Run on an existing K8s cluster / scale Python notebooks | **Kubernetes** | [D](#d-kubernetes) |

All options share the same two prerequisites.

## Shared prerequisites (all options)

1. **A Supabase project with the schema applied.** Create the project, then
   apply the migrations once. Full walkthrough (keys, extensions, auth config)
   is in [INSTALL.md §3](./INSTALL.md#3-set-up-supabase-the-database-auth-and-storage-layer):

   ```bash
   npx supabase login
   ```
   ```bash
   npx supabase link --project-ref <your-project-id>
   ```
   ```bash
   npx supabase db push
   ```

2. **A filled-in `.env`.** Copy the template and set your Supabase URL/keys and
   the `VITE_` copies, plus the production values called out in
   [INSTALL.md §4](./INSTALL.md#4-configure-environment-variables). The ones
   that matter specifically in production:

   | Variable | Why |
   | --- | --- |
   | `PROVIDER_CREDS_SECRET` | **Required** if anyone uses warehouses, Secrets, or Data Catalog — the AES-256 key encrypting stored credentials. Set once (`openssl rand -hex 32`); rotating it invalidates saved creds. |
   | `SITE_URL` | Your public URL — used in email links and as the default origin for scheduled work. |
   | `RESEND_API_KEY` **or** `SMTP_*` + `EMAIL_FROM` | Outbound app email (welcome, budget alerts, scheduled report digests). Without it, sends are skipped and logged. |
   | `BI_CRON_TOKEN` | Lets an external scheduler drive background jobs — see [Scheduling](#scheduling--background-jobs). |
   | `OPENROUTER_API_KEY` | Optional but recommended — makes the app usable with zero per-user key setup. |
   | `OPENAI_API_KEY` | Optional — real vector embeddings for Knowledge Base search (otherwise keyword search). |

   ```bash
   cp .env.example .env
   ```

   `.env` is git-ignored. **Never** put the service-role key behind a `VITE_`
   prefix — that ships a database-bypassing secret to every browser.

---

## A. Local desktop

The fastest way to run the whole platform on your own machine — macOS, Windows,
or Linux — with [Docker Desktop](https://www.docker.com/products/docker-desktop/)
installed.

```bash
git clone <your-repo-url> agentswarms
```

Fill in `.env` and apply migrations (shared prerequisites above), then:

```bash
docker compose up --build
```

Open **http://localhost:8080**. That's it — one container, your Supabase
project as the backend.

- Set the Supabase **Auth → URL Configuration** Site URL to
  `http://localhost:8080` so email links resolve (INSTALL.md §3.3).
- Prefer a live-reloading dev setup instead of a container? Use
  `npm install && npm run dev` — see [INSTALL.md](./INSTALL.md).
- Want notebooks to run real Python? Add the optional runtime with
  `docker compose --profile notebooks up -d --build` — see
  [Developer-workspace runtime](#developer-workspace-python-runtime).

## B. Single cloud VM (recommended)

One VM on OCI, AWS, GCP, Azure, Hetzner, a Droplet — anything that runs Docker.
This is the recommended production setup for most teams: simple, cheap, and it
comfortably serves a lot of users.

1. **Provision** a small VM (2 vCPU / 4 GB is plenty to start — see
   [System requirements & sizing](./SYSTEM_REQUIREMENTS.md) for scaling
   scenarios and per-cloud/per-region cost tables) and install
   Docker Engine + the Compose plugin.
2. **Clone, configure, migrate** (shared prerequisites above). Set
   `SITE_URL="https://your-domain.com"` and the matching Supabase Auth Site
   URL / Redirect URLs (`https://your-domain.com/**`).
3. **Run it** detached, with automatic restart:

   ```bash
   docker compose up -d --build
   ```

4. **Put HTTPS in front.** Terminate TLS with a reverse proxy so the app is
   reachable on 443. A minimal [Caddy](https://caddyserver.com) config does TLS
   automatically:

   ```caddy
   your-domain.com {
     reverse_proxy localhost:8080
   }
   ```

   (nginx/Traefik/an OCI or cloud load balancer in front of the single VM work
   equally well — point them at `:8080` and use `/api/health` as the health
   check.)

The in-process scheduler runs automatically on a single VM — **no cron setup
needed.** To update: `git pull && docker compose up -d --build`.

## C. Autoscaled VMs behind a load balancer

The app tier scales horizontally: run N identical containers across VMs behind
an L7 load balancer and add/remove instances on demand. **No sticky sessions
required** — any instance can serve any request (auth is a stateless JWT; all
state is in Supabase). Adding instances does **not** multiply database
connections, because the app talks to Supabase over HTTPS, not a raw Postgres
pool.

**Two settings make a fleet correct and healthy:**

1. **Point the load balancer's health check at `GET /api/health`** (returns
   `200 {"status":"ok"}`, no auth, no DB). Unhealthy instances are pulled
   automatically.
2. **Run the scheduler in exactly one place.** The background scheduler (BI
   refreshes, alerts, scheduled reports, swarm schedules, catalog crawls,
   kernel reaping) must not fan out across every replica. Set
   **`DISABLE_INPROCESS_SCHEDULER=1`** on the web tier and drive the work from a
   single external cron hitting `/api/bi/cron` with `BI_CRON_TOKEN` (see
   [Scheduling](#scheduling--background-jobs)). A cross-instance database lease
   already prevents double-firing even if you forget this, but disabling the
   per-replica tick is the clean setup.

**Build once, run many.** The `VITE_*` Supabase values are baked into the
client bundle at image build time, so build the image once with your production
values and push it to a registry; every instance pulls the same image and reads
its runtime secrets (service-role key, provider keys, `PROVIDER_CREDS_SECRET`,
`BI_CRON_TOKEN`) from the instance environment or the cloud's secret manager.

```bash
docker build \
  --build-arg VITE_SUPABASE_URL="$VITE_SUPABASE_URL" \
  --build-arg VITE_SUPABASE_PROJECT_ID="$VITE_SUPABASE_PROJECT_ID" \
  --build-arg VITE_SUPABASE_PUBLISHABLE_KEY="$VITE_SUPABASE_PUBLISHABLE_KEY" \
  --build-arg VITE_ADMIN_EMAIL="$VITE_ADMIN_EMAIL" \
  -t <registry>/agentswarms:latest .
```

The autoscaling primitives on each cloud:

| Cloud | Compute group + autoscaler | Load balancer | Scheduler |
| --- | --- | --- | --- |
| **OCI** | Instance Configuration → **Instance Pool** + **Autoscaling** | **Flexible Load Balancer** (HTTP backend set, health check `/api/health`) | **Resource Scheduler** or an always-on micro instance running cron |
| **AWS** | Launch Template → **Auto Scaling Group** (target tracking on CPU/RPS) | **ALB** (target group health check `/api/health`) | **EventBridge Scheduler** → API destination, or a scheduled Lambda |
| **GCP** | Instance Template → **Managed Instance Group** + autoscaler | **External HTTPS LB** (health check `/api/health`) | **Cloud Scheduler** → HTTP target |

**Load-balancer settings:** disable response buffering and use a generous idle
timeout (≥ 300s) so streamed chat responses (Server-Sent Events) aren't cut
off. No session affinity needed.

**One caveat — the Docker notebook runtime is single-host.** Server-side Python
kernels are addressed by container IP on one Docker host, so a request landing
on a different VM can't reach a kernel created elsewhere. If you enable the
Developer-workspace runtime on an autoscaled fleet, either (a) use the
**Kubernetes** backend (see [E](#e-kubernetes)), (b) point all instances at a
**single dedicated runtime host**, or (c) leave notebooks off the autoscaled
tier. The core web/agent/BI/RAG platform scales regardless.

## D. Kubernetes

Run the app as a normal `Deployment` + `Service` + `Ingress` (health/readiness
probe on `/api/health`), backed by your Supabase project, with the same env as
Docker. Because the app is stateless you can scale the `Deployment` replica
count or attach an HPA freely — apply the [scheduler setting](#c-autoscaled-vms-behind-a-load-balancer)
(`DISABLE_INPROCESS_SCHEDULER=1` + a `CronJob` calling `/api/bi/cron`).

Kubernetes is also the way to scale the **Developer-workspace Python runtime**
across nodes: it launches a pod per notebook session (cluster-addressable,
unlike the single-host Docker backend). Manifests live under
`deploy/k8s/notebooks/`; set `NOTEBOOK_RUNTIME_BACKEND=k8s` and run the app
in-cluster. See [DEVELOPER_WORKSPACE_RUNTIME.md](./DEVELOPER_WORKSPACE_RUNTIME.md).

---

## Production checklist (cross-cutting)

### TLS & domain
Serve over HTTPS (reverse proxy or cloud LB) and set both **`SITE_URL`** and the
Supabase **Auth → URL Configuration** (Site URL + `https://your-domain.com/**`
redirect) to your real domain, or email confirmation and password-reset links
won't resolve.

### Bootstrap the operator
Sign up with the `ADMIN_EMAIL` account — it's the permanent bootstrap
superadmin. Then under **Admin → IAM** create users/groups, set model rules and
resource grants, and (for a private instance) enable **invite-only** to disable
public signup at the database level.

### Scheduling & background jobs
`/api/bi/cron` runs one pass of all scheduled work. It's safe to call from
anywhere and from many callers at once — a cross-instance lease guarantees only
one pass runs at a time (extra callers get `{"skipped": true}`).

- **Single instance (A/B):** nothing to do — the in-process 60s scheduler runs
  automatically.
- **Multi-instance / serverless (C/D/E):** set `DISABLE_INPROCESS_SCHEDULER=1`
  and run one external cron every minute:

  ```bash
  curl -fsS -X POST https://your-domain.com/api/bi/cron \
    -H "Authorization: Bearer $BI_CRON_TOKEN"
  ```

The scheduled pass also **re-validates Integration Hub credentials** (LLM
provider keys, the LLM gateway, n8n, Firecrawl) every 6 hours with the same
cheap live tests used at save time, so a key revoked upstream surfaces as a
"failing health checks" badge, an in-app notification and an audit event
instead of a failed agent run. Tune with `INTEGRATION_HEALTH_HOURS` (default
`6`; set `0` to disable). Checks are bounded (max 10 per pass, short
timeouts) and never auto-disable a connection. Alerts also mirror to any
notification channels (Slack/Teams/Discord/webhook) the user connected on the
Integrations page. The same pass runs a daily sweep that re-encrypts any
legacy plaintext integration secrets in place.

**Data-prep execution** runs on the server (the same code path the interactive
"Run & save" button uses), so prepared datasets reflect the *full* source data
rather than whatever fitted in a browser tab. Two ceilings bound it, both read
per run:

- `PREP_SOURCE_ROWS_CAP` (default `500000`) — rows loaded per source table.
- `PREP_OUTPUT_ROWS_CAP` (default `250000`) — rows materialised to the output
  dataset.

Hitting either is reported in the UI (which source was truncated, how many rows
the flow actually produced) — a prepared dataset is never silently sampled.
Raise them for larger flows, mindful that rows are held in memory during the
run and inserted in batches of 500.

**Local SQL engine (experimental).** Queries over datasets stored in this app
run on AlaSQL by default. Set `LOCAL_ENGINE=duckdb` to use DuckDB instead — a
vectorised columnar engine with real SQL: CTEs, subqueries, window functions
and proper JOINs, none of which AlaSQL or the agent-tool interpreter support.

- `LOCAL_ENGINE` (default unset = AlaSQL) — set to `duckdb` to opt in.
- `LOCAL_ENGINE_MEMORY_MB` (default `512`) — per-query memory ceiling.
- `LOCAL_ENGINE_THREADS` (default `2`).
- `LOCAL_ENGINE_TIMEOUT_MS` (default `30000`) — the query is interrupted past this.

When set, the flag applies to **all three** local paths: scheduled widget
refresh, data-prep execution, and the `sql_query` agent tool. Prep flows are
recompiled for the DuckDB dialect by the same compiler that emits the AlaSQL
one, so switching engines cannot change what a flow means.

Behaviour differences from the default engine are recorded and tested in
`tests/differential/duckdb.test.ts`; all of them are cases where DuckDB follows
standard SQL. Two to know about before flipping it:

- **NULL ordering.** DuckDB sorts NULLs last (as PostgreSQL does); AlaSQL
  places them mid-sequence, so a chart ordered by a column containing NULLs
  will order differently.
- **Time-grain bucket labels.** With DuckDB a `month` grain produces
  `2026-03-01`; AlaSQL produced the numeric `202603`. That is a better label,
  but it means a widget using **incremental refresh** on a grained column
  cannot merge its existing snapshot with newly-computed rows — the bucket
  values no longer match. Run a full refresh on those widgets after switching.

See [TESTING.md](./TESTING.md).

**Columnar mirror (Parquet).** With the DuckDB engine on, each dataset above
`PARQUET_MIN_ROWS` is mirrored to a Parquet object in the private `datasets`
bucket and cached on local disk. Queries then read one compressed columnar file
instead of paging every row out of Postgres — the dominant cost in the old
path, at 1,000 rows per round trip.

It is strictly a **cache**: `user_data_rows` remains the source of truth, and a
mirror is used only when its `parquet_synced_at` is at least as new as the
dataset's `data_loaded_at`. Anything else falls back to reading rows, so a
missing or stale mirror costs speed and never correctness.

- `PARQUET_MIRROR` (default on; set `0` to disable).
- `PARQUET_MIN_ROWS` (default `5000`) — below this the storage round trip
  costs more than it saves.
- `PARQUET_CACHE_DIR` (default the system temp dir) — **give this a real
  volume** on a container host, or the cache is lost on every restart.
- `PARQUET_CACHE_MAX_BYTES` (default `2147483648`, 2 GB) — oldest files evicted.

Browser-side saves (CSV upload, warehouse import) cannot rebuild a mirror, so
theirs goes stale and is ignored until the scheduled sweep heals it. The same
sweep deletes objects whose dataset was removed.

**Warehouse queries** are bounded per process. Every dashboard tile, prep
pushdown, semantic query and agent tool call goes through one driver layer, so
these are the knobs that decide what your warehouse is asked to do:

- `WAREHOUSE_MAX_ROWS` (default `1000`) — rows returned when a caller doesn't
  request a specific number.
- `WAREHOUSE_ABS_MAX_ROWS` (default `5000`) — hard ceiling no caller can
  exceed. Never applied below `WAREHOUSE_MAX_ROWS`.
- `WAREHOUSE_QUERY_TIMEOUT_MS` (default `60000`) — wall-clock budget for one
  query including result polling.
- `WAREHOUSE_MAX_CONCURRENT` (default `8`) — queries in flight per instance.
- `WAREHOUSE_MAX_CONCURRENT_PER_USER` (default `3`) — per tenant, counted
  against the dashboard OWNER for shared dashboards so one popular dashboard
  cannot consume everyone else's budget.
- `WAREHOUSE_QUEUE_TIMEOUT_MS` (default `30000`) — how long a query waits for a
  slot before failing with a message naming the limit.

These are **per process**, like the run limiter: behind a load balancer each
instance enforces its own budget, so multiply by your replica count when sizing
against a warehouse's connection limits.

**Dataset uploads** are parsed on the server. CSV, TSV and NDJSON are streamed
and written in batches, so peak memory is one batch rather than one file; JSON
arrays and `.xlsx` cannot be read incrementally and are buffered under the byte
cap. Rows land in a staging dataset and are re-pointed to the real one only
after the whole file parses, so a failed or cancelled upload leaves the previous
data untouched.

- `UPLOAD_MAX_BYTES` (default `104857600`, 100 MB) — largest accepted file.
- `UPLOAD_MAX_ROWS` (default `500000`) — largest accepted dataset. Breaching
  either **refuses** the upload; it never imports a silent subset.
- `UPLOAD_PER_MINUTE` (default `10`) — per-user upload rate limit, since
  parsing is the most expensive thing an unprivileged user can request.

A staging dataset orphaned by a killed process is swept an hour later by the
same cron pass.

**Data quality checks** run after each prep refresh and on a scheduled sweep in
the same cron pass:

- `DATA_QUALITY_INTERVAL_MINUTES` (default `60`) — how often a dataset with
  enabled checks is re-evaluated. This is the resolution of a freshness SLA:
  a 24h SLA checked hourly alerts within an hour of going stale.
- `DATA_QUALITY_ROW_CAP` (default `200000`) — rows read per check. A capped
  read is reported in the check's detail rather than presented as complete.
  Suites made only of row-count and load-time freshness checks skip the row
  read entirely, so they stay cheap on very large tables.
- `DATA_QUALITY_KEEP_RESULTS` (default `500`) — results retained per dataset.

**Dataset version history** snapshots a dataset before anything overwrites it:

- `DATASET_VERSION_ROW_CAP` (default `20000`) — the largest dataset whose rows
  are actually copied. Above this a version records metadata only and is
  explicitly marked non-restorable; raise it if you want larger datasets
  recoverable, mindful that each snapshot stores a full copy.
- `DATASET_VERSION_KEEP` (default `5`) — versions retained per dataset.

Two related knobs:

- `INTEGRATION_TEST_PER_MINUTE` (default `10`) — per-user rate limit on the
  Integrations page "test connection" endpoints (they fetch user-supplied
  URLs from inside your network; SSRF-guarded, but not a free probe loop).
- `WEBHOOK_SIGNING_SECRET` — when set, outbound n8n post-turn webhooks are
  HMAC-signed: `X-AgentSwarms-Signature: v1=hex(hmac_sha256(secret,
  "<timestamp>.<raw body>"))` plus `X-AgentSwarms-Timestamp` (ms epoch), so
  receivers can verify authenticity and reject replays.

### Health checks
- `GET /api/health` → `200` **liveness** — the process is up and serving. No
  database work, so it stays green even if Postgres is unreachable. Use it for
  the K8s liveness probe and as the LB target-health check.
- `GET /api/health/ready` → `200` when **ready** to serve (database reachable),
  `503` otherwise, with a JSON body (`{ status, checks: { db } }`). The DB check
  has a 3s timeout so a hung database fails fast. Use it for the K8s **readiness**
  probe so a pod that can't reach its database is pulled from rotation rather
  than sent traffic. (Don't point liveness at this — a shared-DB blip would then
  restart every pod at once instead of just draining them.)

### Progressive Web App (PWA)
The app ships an installable PWA: `public/manifest.webmanifest` plus a
conservative service worker (`public/sw.js`) registered from the root. It
caches only same-origin static assets (cache-first) and serves an offline
shell (`public/offline.html`) for navigations when the network is down — it
**never** caches HTML, `/api/*`, auth or cross-origin requests, so there's no
stale-data or auth risk. Nothing extra to configure; it activates once the app
is served over HTTPS. Users get an "Install" prompt in supported browsers.

### Metrics (Prometheus / OpenMetrics)
`GET /api/metrics` exposes fleet-level operational gauges in the Prometheus text
exposition format — run and LLM-call volume over the last 24h broken down by
status (`success`/`error`/`running`), month-to-date AI spend, active users, a
scheduler heartbeat (`agentswarms_scheduler_last_pass_age_seconds` — seconds
since the last scheduled-work pass, in-process or external cron), plus
`agentswarms_up` / `agentswarms_db_up`. It aggregates **all** tenants, so it is
**disabled until you set `METRICS_TOKEN`** (returns `404` when unset); once set,
scrapers must send `Authorization: Bearer <METRICS_TOKEN>`. The payload is cached
~15s per instance, so a tight scrape interval won't add DB load. Point Prometheus,
Grafana Agent, or the Datadog OpenMetrics check at it:

```yaml
scrape_configs:
  - job_name: agentswarms
    metrics_path: /api/metrics
    authorization: { credentials: "<METRICS_TOKEN>" }
    static_configs: [{ targets: ["agentswarms:8080"] }]
```

Counts are gauges derived from the database (a purge/retention run lowers them),
so alert on ratios and rates — e.g. `agentswarms_swarm_runs_24h{status="error"}`
climbing relative to `success` — rather than treating them as monotonic counters.
The one gauge worth a flat threshold is the scheduler heartbeat: a healthy fleet
refreshes it about once a minute, so alert if
`agentswarms_scheduler_last_pass_age_seconds` exceeds a few minutes (that means
BI refreshes, alerts, scheduled reports, swarm schedules and catalog crawls have
all stopped firing). Behind a load balancer each instance reports its own process
view; scrape every instance and aggregate in your monitoring system.

The endpoint also exposes latency percentiles
(`agentswarms_llm_latency_ms{quantile="0.5|0.95|0.99"}`, last 24h of successful
calls) and MCP Builder series (`agentswarms_mcp_calls_total` — counter-like, use
`rate()`; `agentswarms_mcp_servers_live`). A ready-made alert pack covering
process/DB down, scheduler stall, error-rate, p95 latency and MCP call surges
ships at [`deploy/prometheus/alerts.yml`](../deploy/prometheus/alerts.yml) —
load it via `rule_files` and tune the thresholds to your fleet.

### Distributed tracing (OpenTelemetry / OTLP)
Where `/api/metrics` gives aggregate numbers, OTLP export gives per-run
**traces**. Set `OTEL_EXPORTER_OTLP_ENDPOINT` to any OTLP/HTTP collector and a
background job on the scheduler pass streams:

- **swarm runs → distributed traces** — a root span per run and a child span per
  node (nested by sub-swarm), so a multi-agent run renders as a waterfall you
  can drill into for latency and errors.
- **LLM calls → spans** — one per `execution_traces` row (playground, saved
  agents, BI agent, KB, memory), tagged with OpenTelemetry GenAI
  `gen_ai.*` attributes (`gen_ai.system`, `gen_ai.request.model`,
  `gen_ai.usage.input_tokens`/`output_tokens`) plus cost, so LLM-observability
  backends (e.g. Datadog LLM Observability) light up automatically.

```bash
# point at an in-cluster collector or the Datadog Agent's OTLP receiver
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
# hosted collectors: pass an API key as a header
OTEL_EXPORTER_OTLP_HEADERS="dd-api-key=xxxxx"
```

Properties that make it safe to leave on: it's **off until an endpoint is set**;
it runs **off the request path** (a slow/broken collector never affects a live
call); it exports **metadata only** — model, tokens, cost, status, timing, node
graph, never prompt or response text — so no user content leaves the app
regardless of `PERSIST_PROMPT_BODIES`. Span/trace IDs are derived
deterministically from row IDs, so delivery is **at-least-once** and a collector
can dedupe on `(trace_id, span_id)`; a large backlog drains over several
scheduler passes rather than one long tick. Because it rides the scheduler
lease, exactly one instance exports across the fleet — no duplication behind a
load balancer.

### Required secret for stored credentials
If anyone connects a warehouse, saves a Secret, or adds a Data Catalog source,
`PROVIDER_CREDS_SECRET` **must** be set (no default) — it encrypts those
credentials at rest.

### Database backups
Supabase provides automated backups / point-in-time recovery on paid plans —
enable and verify them; this is your system of record.

### Pin image digests
`docker-compose.yml` uses `:latest` for the third-party runtime images
(`tecnativa/docker-socket-proxy`, `ubuntu/squid`) and flags this inline — pin
them to digests in production for reproducibility.

### Developer-workspace Python runtime
Optional, off by default. Enable the containers, then flip it on in
**Admin → Developer runtime**:

```bash
docker compose --profile notebooks up -d --build
```

Validate the whole chain end-to-end:

```bash
bash deploy/notebooks/test/verify-runtime.sh
```

Security model, scaling (Docker single-host vs. K8s pod-per-session), and the
full test matrix: [DEVELOPER_WORKSPACE_RUNTIME.md](./DEVELOPER_WORKSPACE_RUNTIME.md).

### Upgrades
Docker: `git pull && docker compose up -d --build`. Apply any new migrations
with `npx supabase db push` (already-applied migrations are skipped; it's safe
to re-run).
