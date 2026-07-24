# Production deployment

> Part of the [AgentSwarms docs](../README.md#documentation).

This guide takes you from a clone to a running instance, with a path for every
setup — **trying it on your own laptop**, a **single cloud VM**, an
**autoscaled fleet behind a load balancer**, **serverless** (Cloudflare), or
**Kubernetes**.

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
| Zero servers to manage | **Cloudflare Workers** | [D](#d-cloudflare-workers-serverless) |
| Run on an existing K8s cluster / scale Python notebooks | **Kubernetes** | [E](#e-kubernetes) |

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
   | `RESEND_API_KEY` **or** `SMTP_*` + `EMAIL_FROM` | Outbound app email (welcome, budget alerts, scheduled report digests). Without it, sends are skipped and logged. On Cloudflare use Resend — SMTP can't run there. |
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

1. **Provision** a small VM (2 vCPU / 4 GB is plenty to start) and install
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

## D. Cloudflare Workers (serverless)

The repo keeps a Workers config (`wrangler.jsonc`); the default `npm run build`
(without `DEPLOY_TARGET=node`) produces a Workers build.

```bash
npm run build
```
```bash
npx wrangler deploy
```

Before deploying, set each non-`VITE_` variable from `.env.example` as a Worker
secret (`npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY`, etc.). Notes:

- Use **`RESEND_API_KEY`** for email — the SMTP mailer needs raw TCP and can't
  run on Workers.
- There's no long-running process, so the scheduler **must** be external: add a
  **Cloudflare Cron Trigger** (a scheduled Worker) or any cron that POSTs
  `/api/bi/cron` with `BI_CRON_TOKEN` every minute.

## E. Kubernetes

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
