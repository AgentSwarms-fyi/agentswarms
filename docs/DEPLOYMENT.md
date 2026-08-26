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

| You want to…                                            | Use                                           | Section                                                               |
| ------------------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------- |
| Try it on your own machine                              | **Local desktop (Docker Desktop)**            | [A](#a-local-desktop)                                                 |
| Run it for a team on one server                         | **Single cloud VM** — the recommended default | [B](#b-single-cloud-vm-recommended)                                   |
| Handle spiky/high load with autoscaling                 | **Autoscaled VMs + load balancer**            | [C](#c-autoscaled-vms-behind-a-load-balancer)                         |
| Run on an existing K8s cluster / scale Python notebooks | **Kubernetes**                                | [D](#d-kubernetes)                                                    |
| Keep **all** data on infrastructure you control         | **Self-hosted Supabase** (with any of A–D)    | [Self-hosted Supabase](#self-hosted-supabase-complete-data-residency) |

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

   | Variable                                        | Why                                                                                                                                                                                                                                           |
   | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `PROVIDER_CREDS_SECRET`                         | **Required** if anyone uses warehouses, Secrets, or Data Catalog — the AES-256 key encrypting stored credentials. Set once (`openssl rand -hex 32`); rotation is supported — see SECURITY.md#rotating-the-credential-key.                     |
   | `PROVIDER_CREDS_SECRET_OLD`                     | Optional. Previous credential keys, comma-separated, accepted for decryption only while you rotate. Remove once the re-encrypt sweep reports nothing left on them.                                                                            |
   | `SITE_URL`                                      | Your public URL — used in email links and as the default origin for scheduled work.                                                                                                                                                           |
   | `RESEND_API_KEY` **or** `SMTP_*` + `EMAIL_FROM` | Outbound app email (welcome, budget alerts, BI alerts, scheduled reports, approvals, contact form). `EMAIL_FROM` must be on a **verified** domain — see [Email delivery](#email-delivery). Without a transport, sends are skipped and logged. |
   | `BI_CRON_TOKEN`                                 | Lets an external scheduler drive background jobs — see [Scheduling](#scheduling--background-jobs).                                                                                                                                            |
   | `OPENROUTER_API_KEY`                            | Optional but recommended — makes the app usable with zero per-user key setup.                                                                                                                                                                 |
   | `OPENAI_API_KEY`                                | Optional — real vector embeddings for Knowledge Base search (otherwise keyword search).                                                                                                                                                       |

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

The setup script is the shortest path — it scaffolds `.env`, generates the
encryption secrets, applies the migrations and starts **every** service:

```bash
bash scripts/setup.sh --all
```

On Windows:

```bash
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1 -All
```

It cannot create your Supabase project or guess its keys: it writes the `.env`
and tells you which values to fill in, then you re-run it. Open
**http://localhost:8080** when it finishes.

`--all` turns on the three optional profiles described below. Plain
`docker compose up --build` starts the app alone — enough to try it, but
notebooks, Deep-mode documents and headless custom code stay unavailable.

- Set the Supabase **Auth → URL Configuration** Site URL to
  `http://localhost:8080` so email links resolve (INSTALL.md §3.3).
- Prefer a live-reloading dev setup instead of a container? Use
  `npm install && npm run dev` — see [INSTALL.md](./INSTALL.md).
- Want notebooks to run real Python? Add the optional runtime with
  `docker compose --profile notebooks up -d --build` — see
  [Developer-workspace runtime](#developer-workspace-python-runtime).
- Want **Deep-mode** document generation? Add the renderer with
  `docker compose --profile docgen up -d --build` — see
  [Document renderer](#document-renderer-deep-mode-office-exports).
- Want **Function / custom-component nodes to run in deployed and scheduled
  swarms** (not just on the canvas)? Add the sandbox with
  `docker compose --profile sandbox up -d --build` — see
  [JS sandbox](#js-sandbox-custom-code-in-deployed-runs).

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
  --build-arg VITE_SUPABASE_PUBLISHABLE_KEY="$VITE_SUPABASE_PUBLISHABLE_KEY" \
  --build-arg VITE_ADMIN_EMAIL="$VITE_ADMIN_EMAIL" \
  -t <registry>/agentswarms:latest .
```

The autoscaling primitives on each cloud:

| Cloud   | Compute group + autoscaler                                            | Load balancer                                                             | Scheduler                                                          |
| ------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| **OCI** | Instance Configuration → **Instance Pool** + **Autoscaling**          | **Flexible Load Balancer** (HTTP backend set, health check `/api/health`) | **Resource Scheduler** or an always-on micro instance running cron |
| **AWS** | Launch Template → **Auto Scaling Group** (target tracking on CPU/RPS) | **ALB** (target group health check `/api/health`)                         | **EventBridge Scheduler** → API destination, or a scheduled Lambda |
| **GCP** | Instance Template → **Managed Instance Group** + autoscaler           | **External HTTPS LB** (health check `/api/health`)                        | **Cloud Scheduler** → HTTP target                                  |

**Load-balancer settings:** disable response buffering and use a generous idle
timeout (≥ 300s) so streamed chat responses (Server-Sent Events) aren't cut
off. No session affinity needed.

**One caveat — the Docker notebook runtime is single-host.** Server-side Python
kernels are addressed by container IP on one Docker host, so a request landing
on a different VM can't reach a kernel created elsewhere. If you enable the
Developer-workspace runtime on an autoscaled fleet, either (a) use the
**Kubernetes** backend (see [D](#d-kubernetes)), (b) point all instances at a
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

## Self-hosted Supabase (complete data residency)

Everything above assumes **Supabase Cloud**, which is the fastest path and is
fine for most teams. If your requirement is that **no data leaves
infrastructure you control** — data residency, data localisation, sovereignty
rules, or a genuinely air-gapped network — run Supabase yourself. The app does
not care which one it talks to: it needs a URL and two keys.

> [!TIP]
> **Every step in this section is scripted.** `bash scripts/setup-selfhosted.sh --all`
> downloads and starts the stack, generates all secrets and keys, waits out the
> storage-boot caveat below, runs the extension preflight, applies the schema,
> creates your admin user, writes the app's `.env`, and starts the app — see
> [INSTALL.md § Option B](./INSTALL.md#option-b--self-hosted-supabase-docker-no-account-needed).
> The manual walkthrough that follows is the same procedure, explained — read
> it anyway before production, especially
> ["Before you call it production"](#6-before-you-call-it-production).

> **What this does and does not buy you.** Self-hosting Supabase removes the
> last managed dependency for _your data_. It does **not** by itself make the
> deployment air-gapped: model calls still leave your network unless you also
> run a local model server (see [Air-gapped](#air-gapped-no-outbound-internet)
> below).

### 1. What you are running

Supabase self-hosted is a Docker Compose stack: Postgres, GoTrue (auth),
PostgREST, Realtime, Storage, Kong (the API gateway that fronts them), and
Studio. AgentSwarms talks to the **Kong** endpoint, exactly as it talks to a
cloud project's URL.

Budget roughly **+2 vCPU / +4 GB RAM / +20 GB disk** on top of the app's own
requirements — see [SYSTEM_REQUIREMENTS.md](./SYSTEM_REQUIREMENTS.md).

### 2. Bring up the stack

```bash
git clone --depth 1 https://github.com/supabase/supabase
```

```bash
cd supabase/docker && cp .env.example .env
```

Now edit that `.env` **before first start** — these are the ones that matter:

| Setting                                    | Why it matters                                                                                                                          |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `POSTGRES_PASSWORD`                        | Superuser password. Generate it; never keep the sample.                                                                                 |
| `JWT_SECRET`                               | Signs every token. **`ANON_KEY` and `SERVICE_ROLE_KEY` must be generated from this secret** — if they do not match, every request 401s. |
| `ANON_KEY`, `SERVICE_ROLE_KEY`             | The two keys AgentSwarms needs. Generate them from your `JWT_SECRET`.                                                                   |
| `SITE_URL`, `API_EXTERNAL_URL`             | Your AgentSwarms origin and your Supabase origin. Wrong values break auth redirects and email links.                                    |
| `DASHBOARD_USERNAME`, `DASHBOARD_PASSWORD` | Studio login. Do not expose Studio publicly.                                                                                            |
| `SMTP_*`                                   | Auth emails (confirmation, password reset). Supabase sends these, not AgentSwarms.                                                      |

```bash
docker compose up -d
```

Kong now listens on `:8000` (HTTP) — that is your `SUPABASE_URL`.

### 3. Check the extensions before you migrate

The migrations use five Postgres extensions. Recent `supabase/postgres` images
ship all of them, but **verify rather than assume** — a missing one fails the
migration halfway. Run this against your instance:

```sql
select e.name,
       case when x.extname is null then 'MISSING' else 'ok' end as status
from (values ('vector'),('pg_net'),('pg_cron'),('pgmq'),('supabase_vault')) as e(name)
left join pg_extension x on x.extname = e.name
order by status desc, e.name;
```

Anything `MISSING` needs `CREATE EXTENSION IF NOT EXISTS <name>;` as a
superuser first. What each is for:

| Extension        | Used for                                                         |
| ---------------- | ---------------------------------------------------------------- |
| `vector`         | Knowledge Base embeddings (pgvector, HNSW cosine index)          |
| `pg_net`         | Database-initiated HTTP used by scheduled work                   |
| `pg_cron`        | The in-database purge of runs/traces past their retention window |
| `pgmq`           | Queue tables behind background jobs                              |
| `supabase_vault` | Supabase's own secret storage                                    |

### 4. Apply the schema

> [!IMPORTANT]
> **Start the whole stack first, and let it settle, before you push the
> schema.** Three of our migrations write to `storage.buckets`, and the
> `public` column they use is created by the **storage-api service's own
> migrations**, not by the Postgres image. Push against a database whose
> storage service has never booted and those three fail with
> `column "public" of relation "buckets" does not exist` — verified by running
> the full migration set against a bare `supabase/postgres` container. On
> Supabase Cloud this is invisible because storage is always already
> provisioned.

`supabase link` is for Cloud projects. Against a self-hosted instance, point
the CLI at the database directly:

```bash
npx supabase db push --db-url "postgresql://postgres:<POSTGRES_PASSWORD>@<db-host>:5432/postgres?sslmode=disable"
```

`?sslmode=disable` is not optional: the CLI negotiates TLS by default, and a
stock self-hosted Postgres serves plaintext, so without it the push fails with
`tls error (The server does not support SSL connections)` before running
anything.

Note also which service answers on `5432`. Current stacks publish the
**supavisor pooler** there and never expose the `db` container's own port to the
host, so the pooler username (`postgres.<POOLER_TENANT_ID>`) is the one that
authenticates. A URL with the bare `postgres` user reaches the same pooler, not
Postgres directly.

Storage buckets and their RLS policies are created by the migrations, so there
is nothing to click in Studio afterwards.


**Verified, at the 146-migration mark.** The whole set was applied to a stock
`supabase/postgres:15.8.1.060` container: 146 applied, 0 failed, producing 98
tables with RLS enabled on all 98, the pgvector HNSW index, 2 `pg_cron` jobs
and 3 storage buckets. All five required extensions were present in that image.

The set has grown since that run (**154 migrations, 100 tables** as of this
writing) and the bare-container test has not been repeated, so treat the
numbers above as the last full verification rather than a current guarantee.
Run the extension preflight regardless — it is what actually protects you, and
the image you pull may differ from the one tested.

### 5. Point AgentSwarms at it

In the AgentSwarms `.env`:

```bash
SUPABASE_URL="https://supabase.your-domain.internal"
SUPABASE_PUBLISHABLE_KEY="<ANON_KEY>"
SUPABASE_SERVICE_ROLE_KEY="<SERVICE_ROLE_KEY>"
VITE_SUPABASE_URL="https://supabase.your-domain.internal"
VITE_SUPABASE_PUBLISHABLE_KEY="<ANON_KEY>"
```

`VITE_SUPABASE_URL` is **baked into the browser bundle at build time**, so it
must be the URL a _browser_ can reach — not a Docker-internal hostname like
`http://kong:8000`. If the app and Supabase share a Compose network, the server
half may use the internal name while the `VITE_` copy uses the external one.

Then rebuild (the `VITE_` values are build-time) and start:

```bash
docker compose up -d --build
```

### 6. Before you call it production

- **Put TLS in front of Kong.** Auth cookies and the service-role key travel
  this path. The same reverse proxy that terminates TLS for AgentSwarms can
  front Supabase on a second hostname.
- **Do not publish Studio or Postgres.** Bind them to the internal network;
  reach Studio over your VPN or an SSH tunnel.
- **Back up Postgres yourself.** There is no managed backup now — this is the
  single stateful component, and `PROVIDER_CREDS_SECRET` must be backed up
  _separately_ or credentials in a restored database cannot be decrypted.
- **Keep `JWT_SECRET` stable.** Rotating it invalidates every issued token and
  both keys.
- **Watch disk.** Traces, audit events and KB vectors grow — see
  [storage growth](./SYSTEM_REQUIREMENTS.md#storage-growth) and set the
  retention windows.

### Air-gapped (no outbound internet)

Self-hosted Supabase removes the data dependency; three things still reach out
by default, and each has a local answer:

| Reaches out          | Local answer                                                                                                                                             |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Model providers**  | Run **Ollama** or **vLLM** inside the network and connect it on the Integrations page. Everything else — agents, swarms, RAG, BI — is provider-agnostic. |
| **Email**            | Point `SMTP_*` at an internal relay, or leave email unset: sends are skipped and logged.                                                                 |
| **Container images** | Mirror `agentswarms/*`, `supabase/*` and any model image into your internal registry.                                                                    |

Nothing else phones home: there is no telemetry, no licence check and no usage
reporting, fonts and the SQL engine (DuckDB-Wasm) are served from the app
itself, and analytics exist only if you set `VITE_GA_ID`. See
[/architecture](./ARCHITECTURE.md) and [/security](../src/routes/security.tsx).

## Production checklist (cross-cutting)

### TLS & domain

Serve over HTTPS (reverse proxy or cloud LB) and set both **`SITE_URL`** and the
Supabase **Auth → URL Configuration** (Site URL + `https://your-domain.com/**`
redirect) to your real domain, or email confirmation and password-reset links
won't resolve.

### Bootstrap the operator

> **Do this before announcing the URL.** `ADMIN_EMAIL` names the permanent
> bootstrap superadmin, and the account is identified by its email address —
> which is a claim, not a credential. `allow_public_signup` defaults to `true`,
> so between deploying and registering that address, **anyone who guesses it can
> claim it** and receive superadmin that the IAM page then refuses to revoke.
> `admin@your-domain.com` is not a hard guess.

1. **Confirm that Supabase verifies email addresses** — Auth → Providers →
   Email → _Confirm email_ **on**. The server refuses the bootstrap grant to an
   unconfirmed address, so this is what actually stops someone who does not
   control the mailbox from claiming it. With confirmations disabled Supabase
   marks every address confirmed at signup, and the server has no way left to
   tell the operator from a squatter.
2. **Register the `ADMIN_EMAIL` account** and confirm the address.
3. Under **Admin → IAM**, enable **invite-only** to disable public signup at the
   database level, then create users/groups, model rules and resource grants.

If you are deploying somewhere publicly reachable before step 2, set
`allow_public_signup = false` in `iam_settings` first and invite yourself.

### Scheduling & background jobs

`/api/bi/cron` runs one pass of all scheduled work. It's safe to call from
anywhere and from many callers at once — a cross-instance lease guarantees only
one pass runs at a time (extra callers get `{"skipped": true}`).

- **Single instance (A/B):** nothing to do — the in-process 60s scheduler runs
  automatically.
- **Multi-instance / serverless (C/D):** set `DISABLE_INPROCESS_SCHEDULER=1`
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
"Run & save" button uses), so prepared datasets reflect the _full_ source data
rather than whatever fitted in a browser tab. Two ceilings bound it, both read
per run:

- `PREP_SOURCE_ROWS_CAP` (default `500000`) — rows loaded per source table.
- `PREP_OUTPUT_ROWS_CAP` (default `250000`) — rows materialised to the output
  dataset.

Hitting either is reported in the UI (which source was truncated, how many rows
the flow actually produced) — a prepared dataset is never silently sampled.
Raise them for larger flows, mindful that rows are held in memory during the
run and inserted in batches of 500.

**Local SQL engine.** Queries over datasets stored in this app run on **DuckDB**
— a vectorised columnar engine with real SQL: CTEs, subqueries, window
functions and proper JOINs, none of which AlaSQL supports. You do not need to
configure anything.

- `LOCAL_ENGINE` (default unset = DuckDB) — set to `alasql` **only** as an
  escape hatch, if the native module will not install on your platform. Any
  other value is treated as the default, so a typo cannot silently downgrade
  the engine.
- `LOCAL_ENGINE_MEMORY_MB` (default `512`) — per-query memory ceiling.
- `LOCAL_ENGINE_THREADS` (default `2`).
- `LOCAL_ENGINE_TIMEOUT_MS` (default `30000`) — the query is interrupted past this.

The engine applies to **all three** local paths: scheduled widget refresh,
data-prep execution, and the `sql_query` agent tool. Prep flows are recompiled
for each dialect by the same compiler, so switching engines cannot change what
a flow means.

**Taking the AlaSQL escape hatch costs you features**, not just speed: no
window functions means the semantic layer's period-over-period comparisons
(YoY, MoM, prior period) are unavailable. Differences are recorded and tested
in `tests/differential/duckdb.test.ts`; all are cases where DuckDB follows
standard SQL. Two to know about if you switch **to** AlaSQL, or are upgrading
from a release where it was the default:

- **NULL ordering.** DuckDB sorts NULLs last (as PostgreSQL does); AlaSQL
  places them mid-sequence, so a chart ordered by a column containing NULLs
  will order differently.
- **Time-grain bucket labels.** With DuckDB a `month` grain produces
  `2026-03-01`; AlaSQL produced the numeric `202603`. That is a better label,
  but it means a widget using **incremental refresh** on a grained column
  cannot merge its existing snapshot with newly-computed rows — the bucket
  values no longer match. **Upgrading from a release where AlaSQL was the
  default, run one full refresh on those widgets.**

See [TESTING.md](./TESTING.md).

**Columnar mirror (Parquet).** Each dataset above `PARQUET_MIN_ROWS` is
mirrored to a Parquet object in the private `datasets` bucket and cached on
local disk. Queries then read one compressed columnar file instead of paging
every row out of Postgres — the dominant cost in the old path, at 1,000 rows
per round trip.

It is strictly a **cache**: `user_data_rows` remains the source of truth, and a
mirror is used only when its `parquet_synced_at` is at least as new as the
dataset's `data_loaded_at`. Anything else falls back to reading rows, so a
missing or stale mirror costs speed and never correctness.

**SHARED datasets are never mirrored**, and this is deliberate. A mirror holds
the full table with no row filter and no column mask, so a per-grantee mirror
would be a cache of an access-control decision — and a stale one would serve
rows to someone whose grant had since been narrowed or revoked. Shared datasets
always read their rows through `shared_dataset_rows()`. That path is fast
enough that the safe choice is cheap: loading rows into DuckDB costs about
20 ms per 5,000 rows.

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

### Connection pooling

PostgreSQL- and MySQL-family connections are **pooled**. Measured against a
local Postgres, opening a connection cost 24.9ms of a 27.1ms `SELECT 1` — 92%
of the query — and that is the best case, a loopback socket with no TLS. A
managed database over the internet with `ssl=require` pays a TCP handshake, a
TLS handshake and SCRAM auth before the first byte of SQL. End to end the
driver went from **30.7ms to 2.9ms per query**. Reproduce it on your own
database with `npx vite-node scripts/bench-pool.ts`.

- `WAREHOUSE_POOL` (default on) — set `off` to go back to a connection per
  query.
- `WAREHOUSE_POOL_MAX` (default `4`) — sockets per distinct credential set.
  **Multiply by `WAREHOUSE_POOL_MAX_KEYS` and by your replica count** when
  sizing against a database's `max_connections`.
- `WAREHOUSE_POOL_IDLE_MS` (default `30000`) — before an unused socket closes.
- `WAREHOUSE_POOL_TTL_MS` (default `300000`) — before a whole unused pool is
  dropped, releasing its cached credentials.
- `WAREHOUSE_POOL_MAX_KEYS` (default `64`) — distinct credential sets held;
  least-recently-used is evicted past this.

Pools are keyed by a hash of **every** connection parameter including the
password, so two tenants on the same database never share a session and
rotating a password builds a fresh pool rather than reusing one authenticated
with the old secret. HTTP-based warehouses (Snowflake, BigQuery, Databricks…)
need none of this — `fetch` keeps sockets alive underneath.

### Outbound HTTP: proxies and retries

Every warehouse HTTP driver and app-source connector goes through one client.

**Corporate proxy.** Many enterprises have no direct egress; if that is you,
set the conventional variables and the connectors will use them:

- `HTTPS_PROXY` / `HTTP_PROXY` (or `ALL_PROXY`) — lower-case spellings also
  accepted.
- `NO_PROXY` — comma-separated bypass list. `*` bypasses everything;
  `internal.corp` matches that host and its subdomains; `db.corp:5432` matches
  only that port.

Without this the product cannot reach Snowflake or Stripe from inside such a
network, and the failure looks like a timeout rather than a missing setting.

**Retries.** Transient failures (`408`, `429`, `502`, `503`, `504`, and
transport errors) are retried with exponential backoff and full jitter,
honouring `Retry-After` when the server sends one.

- `CONNECTOR_MAX_RETRIES` (default `2`, max `5`; `0` disables).
- `CONNECTOR_RETRY_BASE_MS` (default `400`) and `CONNECTOR_RETRY_MAX_MS`
  (default `8000`) — the backoff curve and the cap on any single wait,
  including a server-supplied `Retry-After`.
- `CONNECTOR_RETRY_500` (default off) — `500` is **not** retried by default
  because it usually means the query reached the backend and failed there, so
  a retry pays for the same scan twice. Enable it for a provider that returns
  `500` for throttling.

A retried request is always a read — every driver enforces read-only SQL — so
a duplicate cannot corrupt anything. The cost of a double-send is money, which
is why the default is deliberately low.

### Data connection health and credential age

The scheduled pass also re-validates **data connections** (warehouses and app
sources), not just Integration Hub keys, using the product's own probes: a
`SELECT 1` through the real driver, or the same stream listing the "test"
button makes. A warehouse password expiring on the customer's rotation policy
otherwise surfaces as a dashboard erroring in front of someone.

- `CONNECTION_HEALTH_HOURS` (default `12`; `0` disables).
- `CREDENTIAL_MAX_AGE_DAYS` (default `90`) — age at which a credential is
  badged as old in the Integrations UI.

Both are advisory. Nothing expires, nothing is auto-disabled, and a failing
check notifies **once per transition** rather than on every pass. Credential
age is measured from when the secret was last entered — re-saving a connection
resets it; a health check does not.

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

### Email delivery

App email — welcome, budget alerts, BI alerts, scheduled reports, approval
requests, contact form — goes through Resend or SMTP. Supabase sends the auth
emails (confirmation, password reset) separately, and they are configured in the
Supabase dashboard, not here.

**Resend, with your own domain:**

1. _API Keys_ → _Create_, and put it in `RESEND_API_KEY`.
2. _Domains_ → _Add Domain_ (`your-company.com`, or a subdomain such as
   `mail.your-company.com` to keep sending reputation separate from your main
   domain).
3. Publish the MX and TXT records Resend shows — SPF and DKIM — at your DNS
   host, then press _Verify_.
4. Set `EMAIL_FROM` to an address on that verified domain.

```bash
RESEND_API_KEY="re_..."
EMAIL_FROM="AgentSwarms <noreply@your-company.com>"
SITE_URL="https://your-domain.com"
```

Two failure modes are worth knowing because neither looks like a failure:

- **`EMAIL_FROM` empty** falls back to `noreply@example.com`, which Resend
  rejects. Every app email fails while the app carries on normally.
- **Domain not yet verified** means Resend accepts only `onboarding@resend.dev`
  as the sender and delivers only to the address that owns the Resend account.
  Mail to anyone else is accepted by the API and never arrives — useful for a
  smoke test, useless in production.

Either way the outcome is recorded in the `email_send_log` table, which is the
first place to look when mail stops arriving. `SITE_URL` builds every link in
every email, so a production instance left on `http://localhost:8080` sends
users links to their own machine.

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

### Document renderer (Deep-mode Office exports)

Agent Chat can generate PowerPoint, Word and Excel files two ways. **Browser ·
fast** builds them in the browser and works on every deployment with nothing
extra installed. **Deep · slow** uses a server-side renderer for native Office
output — editable charts, real tables — plus an AI visual review pass.

The renderer is an optional Compose profile:

```bash
docker compose --profile docgen up -d --build
```

It listens on `8099`, published to loopback only (`127.0.0.1:8099`). The app
probes both the in-network address (`docgen:8099`) and the published one, so
the same `.env` works whether you run the app in Compose or with `npm run dev`
— there is deliberately no address to configure.

**Without this profile, Deep mode still works**: it silently falls back to the
browser build, producing a file identical to Fast. The UI disables the Deep
option and states the reason rather than leaving a control that does nothing.

### Checking what is running (Observability → Monitoring)

Every optional piece below is a Compose profile you may or may not have
started, which makes "is this deployment complete?" a real question. The
in-app **Observability → Monitoring** page answers it: one row per service
with its status, response time and the address that answered, plus live CPU,
memory and disk for the machine running the app.

Two behaviours worth knowing before you rely on it:

- **Optional services that were never started read "Not running" in grey**, with
  the `docker compose --profile … up -d` command that would start them. They are
  not counted as problems — only a required service failing, or any service
  answering incorrectly, is.
- **Memory reports the container's limit when there is one** (read from cgroups),
  not the host's RAM. If you set `mem_limit`, that is the number you see.

The page is **superadmin-only**: it exposes hostnames, container limits and the
internal service topology.

### JS sandbox (custom code in deployed runs)

Optional, off by default. **Function** nodes and **custom components** run
user-authored JavaScript. On the canvas that code runs in the browser, in a
Worker with the dangerous globals removed. A deployed run has no browser, and
the app process holds the service-role key and every provider credential — so
without this service, headless runs (API keys and schedules) refuse custom code
rather than executing it next to those secrets.

Enable it and those nodes work unattended too:

```bash
docker compose --profile sandbox up -d --build
```

No address to configure inside Compose: the app defaults to `js-sandbox:8091`.

Running the app on the host with `npm run dev` instead? The container is **not
reachable from the host**. It sits only on `js-internal`, and Docker publishes
no host port from an `internal: true` network — the `127.0.0.1:8091` mapping in
`docker-compose.yml` is kept as a safety net for a future routable network, but
while the network is internal it binds nothing (`NetworkSettings.Ports` reports
`"8091/tcp":[]`). Run the service on the host instead; it is dependency-free
Node, so there is nothing to install:

```bash
INTERNAL_RUN_SECRET="<same value as your .env>" node services/js-sandbox/server.mjs
```

```bash
JS_SANDBOX_URL="http://127.0.0.1:8091"
```

A host process has none of the container's isolation — no read-only root, no
dropped capabilities, no blocked egress — so keep that to local development and
let Compose run it everywhere else.

**How it is isolated.** Every layer here is deliberate, and stricter than the
notebook runtime because a snippet needs nothing at all:

| Layer                                                   | What it does                                                                                                          |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Separate container                                      | The snippet never shares a process with the service-role key or provider credentials                                  |
| `js-internal` network                                   | `internal: true` — no route to the internet, and none back to the app                                                 |
| `read_only: true`, `cap_drop: ALL`, `no-new-privileges` | Nothing writable, no privileged syscalls, no setuid escalation                                                        |
| `pids_limit`, `mem_limit`, `cpus`                       | A runaway snippet cannot starve the host                                                                              |
| Fresh V8 realm per call                                 | Built with `vm.createContext` — `require`, `process`, `fetch` and `Buffer` do not exist inside it                     |
| Worker thread per call, terminated after                | Kills even a synchronous infinite loop                                                                                |
| Shared secret                                           | The service refuses to start without `INTERNAL_RUN_SECRET`, so an exposed port is not an open code-execution endpoint |

Nothing from the host realm is placed in the sandbox — not even a `console`
shim. That rule exists because a host object's prototype chain carries the host
`Function` constructor: with a host console in scope,
`console.log.constructor("return process")()` returns the real `process`, and
with it this container's environment. The service builds `console` and `ctx`
_inside_ the sandbox realm and passes only JSON strings across the boundary.

**Verify it after deploying:**

```bash
docker compose --profile sandbox exec -T js-sandbox \
  node -e "fetch('http://127.0.0.1:8091/health').then(r=>r.text()).then(console.log)"
```

Ask the container, not the host: with no published port there is nothing on the
host's `8091` to curl, and the image carries no `curl` or `wget` — it is
dependency-free by design, so `node` is the client it has. Expect `{"ok":true}`.

Then deploy a swarm with a Function node and run it through its API key. The
Deploy dialog also reports the sandbox's state: it warns only when custom-code
nodes are present _and_ the sandbox is missing or unreachable on this instance.

**Without this profile nothing breaks** — Function and component nodes keep
working on the canvas, and the Deploy dialog says plainly that they will fail
in deployed and scheduled runs until the sandbox is up.

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
