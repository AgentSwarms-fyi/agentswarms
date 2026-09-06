# Production deployment

> Part of the [AgentSwarms docs](../README.md#documentation).

This guide takes you from a clone to a running instance, with a path for every
setup — **trying it on your own laptop**, a **single cloud VM**, an
**autoscaled fleet behind a load balancer**, or **Kubernetes**.

> **Sizing note for ETL:** pipeline runs are single-container pandas
> processes — the working set of one run must fit in a kernel's RAM
> (default 4 GB). See "Data-size limits and machine sizing" and
> "Horizontal scaling" in [ETL_PIPELINES.md](./ETL_PIPELINES.md) before
> choosing instance sizes; app replicas behind a load balancer are
> supported (scheduler decisions are atomic claims).

## How the pieces fit (read this first)

AgentSwarms is two things:

- **The app** — a Node service (TanStack Start) that serves the web UI,
  server-side rendering, and every `/api` route on **port 8080**, forking one
  worker per available CPU so a big host is used without configuration. It is
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
| Own everything, on a cluster, in one command            | **Kubernetes + Supabase in-cluster**          | [D1](#d1-fully-self-hosted-one-command)                               |
| Run on EKS, GKE, AKS or OKE, step by step               | **Managed Kubernetes, cloud by cloud**        | [D3](#d3-managed-clusters-aws-gcp-azure-oci)                          |
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
   | _(no embeddings key)_                           | Knowledge Base vector search uses whichever model provider is connected; `OPENROUTER_API_KEY` covers it with no per-user setup.                                                                                                               |

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

`--all` turns on the three optional profiles described below; the Compose
equivalent is `docker compose --profile all up -d --build`. Plain
`docker compose up --build` starts the app alone — enough to try it, but
notebooks, Deep-mode documents and headless custom code stay unavailable.

- Set the Supabase **Auth → URL Configuration** Site URL to
  `http://localhost:8080` so email links resolve (INSTALL.md §3.3).
- Prefer a live-reloading dev setup instead of a container? Use
  `npm install && npm run dev` — see [INSTALL.md](./INSTALL.md).
- Want notebooks to run real Python (and ETL pipelines to run at all)? Add
  the optional runtime with
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

### Scale up before you scale out

One instance already uses the whole machine. `server.mjs` (the container's
entrypoint, also `npm start`) forks **one worker per available CPU**, all
accepting on the same port, so a 16- or 64-core box is used without any
configuration. Rendering a page is the expensive part — roughly 30 ms of CPU —
and that is what the extra workers buy you; static assets were never the
bottleneck. Measured numbers are in
[System requirements § 3b](./SYSTEM_REQUIREMENTS.md#3b-one-big-host-measured).

**"Available" means the CPU quota, not the host.** In a container the worker
count is capped by the cgroup CPU limit, so `--cpus=2` forks 2 regardless of how
large the machine underneath is. You only need `WEB_CONCURRENCY` to override the
default deliberately:

| Situation                              | Setting                                   |
| -------------------------------------- | ----------------------------------------- |
| One big VM or bare-metal host          | leave unset — every core is used          |
| Container with a CPU limit             | leave unset — the quota is detected       |
| Many small containers, one core each   | `WEB_CONCURRENCY=1` (no primary, no fork) |
| Deliberately capping a noisy neighbour | `WEB_CONCURRENCY=<n>`                     |

The count is logged at startup (`primary … forking N workers`), so check the
container's first log line if the number surprises you.

**Two things behave differently under clustering.** The **scheduler** does not
multiply — it holds a fleet-wide lease, so exactly one sweep runs however many
workers or replicas exist. The **lakehouse query engine** does: it lives in each
_process_, so its memory limit applies per worker. A 16-core host with
`LAKEHOUSE_MEMORY_LIMIT=16GB` is 256 GB of intent, not 16. Size that limit
against `host RAM ÷ workers` — it is a ceiling rather than a reservation, so
idle workers hold nothing, but the worst case is what an OOM kill needs. See
[Lakehouse](./LAKEHOUSE.md).

### Analytics-only nodes

A heavy lakehouse query and a page render share one Node process, so a
thirty-second `GROUP BY` can stall interactive traffic on the node running it.
Set **`APP_ROLE=analytics`** on the nodes you want to keep out of the request
path:

```bash
APP_ROLE=analytics
LAKEHOUSE_MEMORY_LIMIT=64GB
```

That node reports **not ready** at `/api/health/ready` (HTTP 503) while staying
**alive** at `/api/health` (HTTP 200). Every load balancer and orchestrator
already understands that pair — readiness decides routing, liveness decides
restarts — so the node drains itself out of the interactive pool with no
LB-specific configuration, and nothing restarts it. Point your readiness/health
check at `/api/health/ready` for this to work; a pool checking only
`/api/health` will keep sending it traffic.

It also **defaults to a single worker**, because the engine is per process:
forking would split the large memory limit you just set into N independent
copies, each able to claim the whole figure. `WEB_CONCURRENCY` still overrides
if you want otherwise.

What still reaches an analytics node: the in-process scheduler (BI refreshes,
materialized-view rebuilds — the analytical work you want there), and anything
addressed to it directly. The role is a routing declaration, not access control,
so pointing a browser at one still works, which is what you want when
investigating it. `curl /api/health` reports `role` and `workers`.

The complementary setting on the interactive tier is
`DISABLE_INPROCESS_SCHEDULER=1`, so scheduled work lands on the analytics nodes
rather than competing with page renders.

### Then scale out

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

Two ways in. **Fully self-hosted** — Supabase in your cluster too, one command —
or **bring your own Supabase** (Cloud or existing) and deploy just the app.

### D1. Fully self-hosted, one command

```bash
ADMIN_EMAIL=you@corp.com ADMIN_PASSWORD='...' bash scripts/setup-k8s.sh
```

```bash
kubectl -n agentswarms port-forward svc/agentswarms 8080:80   # then http://localhost:8080
```

Needs `kubectl`, `helm` and a reachable cluster. It generates every secret —
including the anon and service-role keys **signed** from the JWT secret, because
they are JWTs and a random string there yields a stack that starts and then
rejects every request — installs Supabase, applies the schema, creates your
admin user, and starts the app with the Office renderer, the JS sandbox and the
lakehouse catalog. Re-running is safe: secrets are reused, `helm upgrade
--install` is idempotent.

**Supabase comes from the community Helm chart**
([supabase-community/supabase-kubernetes](https://github.com/supabase-community/supabase-kubernetes)),
pinned by `SUPABASE_CHART_VERSION`. That is a deliberate choice. Self-hosted
Supabase is a dozen services — Kong, Studio, Postgres, PostgREST, Realtime,
Storage, Meta, GoTrue, Edge Functions, Logflare, Vector, Imgproxy, MinIO — whose
bootstrap SQL, roles and per-service environment move between versions. An
earlier version of this guide shipped hand-written manifests for them; it needed
five fixes before Postgres would start, the last being the role bootstrap
(`authenticator`, `anon`, `supabase_auth_admin` …) that a bare `supabase/postgres`
image does not create. All of it was upstream's wiring, re-derived by hand and
certain to fall behind. The chart tracks upstream; we track the chart version.

Our own components stay as plain manifests below, because they are four
Deployments we control.

### D1a. Going to a cloud cluster: push the images first

The command above defaults to the three images this repo builds locally —
`agentswarms:latest`, `agentswarms/docgen:latest`, `agentswarms/js-sandbox:latest`.
A **local** cluster (Docker Desktop, kind, minikube, k3d, Rancher Desktop) shares
the machine's image store and runs them as they are. **No other cluster can**:
its nodes pull from a registry, and an image that exists only on your laptop
ends in `ImagePullBackOff`. Push all three, then name them:

```bash
AGENTSWARMS_IMAGE=ghcr.io/you/agentswarms:1.2.3 DOCGEN_IMAGE=ghcr.io/you/docgen:1.2.3 JS_SANDBOX_IMAGE=ghcr.io/you/js-sandbox:1.2.3 ADMIN_EMAIL=you@corp.com ADMIN_PASSWORD='...' bash scripts/setup-k8s.sh
```

The installer substitutes all three as it applies the manifests, and warns
before it starts if the current context does not look local while the images
still do. If your registry needs credentials, create the pull secret first and
add it to the namespace's `default` ServiceAccount, or set `imagePullSecrets` on
the Deployments.

**What actually varies between clouds.** The manifests use only core APIs and
name no StorageClass, so each `PersistentVolumeClaim` takes the cluster's
default. Four things still need a decision:

| Concern                    | What to know                                                                                                                                                                                                                                                                                                     |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Ingress and TLS**        | `port-forward` is for checking the install. Put an Ingress or a `LoadBalancer` Service in front of `svc/agentswarms` and the chart's Kong service, and set `PUBLIC_APP_URL` to the resulting hostname.                                                                                                           |
| **NetworkPolicy**          | The `NetworkPolicy` that denies the JS sandbox all egress needs a CNI that enforces policy — Calico, Cilium, GKE Dataplane V2, AKS with Azure or Calico policy, EKS with VPC CNI policy enabled. Without one it applies and does nothing.                                                                        |
| **Pod Security Standards** | Everything meets `restricted` except the Office renderer, whose image runs as root. See below.                                                                                                                                                                                                                   |
| **Node capacity**          | Requests total roughly 3 CPU and 6 GiB for our pods (web ×2, analytics), plus the Supabase chart's own. A single 2-vCPU node will not schedule it. ML training and ETL runs add one batch pod each (default 8 GiB for a training) in the notebook namespace — size that pool for the trainings you want at once. |

**The Office renderer and `restricted`.** On a cluster that enforces the
`restricted` Pod Security Standard namespace-wide, `agentswarms-docgen` is
refused at admission: its image runs as root, so it cannot set
`runAsNonRoot: true`. The way this presents is worth knowing, because it is
quiet — `kubectl apply` prints a _warning_, the Deployment is created
successfully, and then no pod ever appears:

```
Error creating: pods "agentswarms-docgen-…" is forbidden: violates PodSecurity "restricted:latest": runAsNonRoot != true
```

Until the image is fixed, either run that one Deployment in a namespace labelled
`pod-security.kubernetes.io/enforce=baseline`, or drop it and lose Office export
(everything else keeps working). The other five workloads — web, analytics, the
JS sandbox, the lakehouse catalog and the BI CronJob — were each applied to a
namespace enforcing `restricted` and admitted; the sandbox reached Ready, the
catalog ran as uid 999 and the cron pod as uid 100 with writes to `/` refused.

### D2. Bring your own Supabase

A reference manifest ships in **`deploy/k8s/app/agentswarms.yaml`** — namespace,
web `Deployment`, optional analytics `Deployment`, `Service`, `HorizontalPodAutoscaler`
and the cron `CronJob`. It has been applied to a real cluster; the notes below
are things that failed there, not hypotheticals.

**Create the Secret with the quotes stripped.** Docker Compose removes the
quotes around a value in `.env`; `kubectl create secret --from-env-file` keeps
them. Passing your working `.env` straight in yields
`SUPABASE_URL='"https://…"'`, every pod fails readiness with
`Invalid supabaseUrl: Must be a valid HTTP or HTTPS URL`, and the Service ends
up with no endpoints at all:

```bash
sed -E 's/^([A-Za-z_][A-Za-z0-9_]*)="(.*)"$/\1=\2/' .env > .env.k8s
```

```bash
kubectl create secret generic agentswarms-env --namespace agentswarms --from-env-file=.env.k8s && rm .env.k8s
```

**Add the variables Compose was defaulting for you.** `docker-compose.yml`
fills a dozen values with `${VAR:-default}`; Kubernetes has no equivalent, so a
Secret built from a `.env` that relied on those defaults is missing them and the
pod stops with `couldn't find key … in Secret`. The three that matter:

| Variable                     | Needed by      | What Compose defaulted it to   |
| ---------------------------- | -------------- | ------------------------------ |
| `BI_CRON_TOKEN`              | the `CronJob`  | nothing — it was already yours |
| `INTERNAL_RUN_SECRET`        | the JS sandbox | the service-role key           |
| `LAKEHOUSE_CATALOG_PASSWORD` | the catalog    | `change-me`                    |

```bash
kubectl apply -f deploy/k8s/app/agentswarms.yaml
```

**The optional services get their own Deployments.** `deploy/k8s/app/services.yaml`
covers the Office renderer, the JS sandbox and the lakehouse catalog — each its
own pod behind its own `Service`, found by the same name the app uses under
Compose. Apply it if you want those features:

```bash
kubectl apply -f deploy/k8s/app/services.yaml
```

The catalog is a `StatefulSet` with a `PersistentVolumeClaim`, not a
`Deployment`: it holds the DuckLake catalog, which is the one part of the
lakehouse that cannot be rebuilt from object storage. In production prefer a
managed Postgres and point `LAKEHOUSE_CATALOG_URL` at it. The notebook runtime
is separate again — it needs its own namespace, RBAC and quota, in
`deploy/k8s/notebooks/`.

**Security posture.** The app image drops to a non-root user, and both app
Deployments run with `runAsNonRoot`, a read-only root filesystem, all
capabilities dropped and no API token mounted; `/tmp` is an `emptyDir` because
the lakehouse engine spills there. Verified in-cluster — `id` reports uid 1000
and a write to `/` is refused. The JS sandbox, which runs user-supplied code,
adds a `NetworkPolicy` denying it egress outright (needs a CNI that enforces
policy — Docker Desktop's default does not).

The app is stateless, so replica count and the HPA are free to move. Two probe
details matter: **liveness** on `/api/health`, **readiness** on
`/api/health/ready`. They are different questions — liveness decides restarts,
readiness decides routing — and `APP_ROLE=analytics` depends on being able to
answer them differently (see
[Analytics-only nodes](#analytics-only-nodes)). A pool that probes only
`/api/health` will keep routing to analytics pods and to pods that cannot reach
the database.

**Set `resources.limits.cpu`.** The worker count comes from the pod's CPU limit,
so a pod with no limit on a 64-core node forks 64 workers at ~0.5–1 GB RSS each.
With a limit set, sizing follows it — verified on an 8-core node: `cpu: "2"`
logged `forking 2 workers`, and `cpu: 500m` logged `single process`. Give memory
at least `1Gi` per worker plus headroom.

**Do not put a readiness probe on an analytics `Deployment`.** `APP_ROLE=analytics`
answers readiness with 503 for ever, and Kubernetes gates rollout progress on
readiness — so a new pod never becomes Ready, the old one is never retired, and
`kubectl rollout status` hangs on _"1 old replicas are pending termination"_
until you kill it. Keep the liveness probe and exclude those pods from the
`Service` by label, as the shipped manifest does. The role's 503 is still what
holds a node out of a pool that health-checks readiness directly — a cloud LB
target group, or a single `Deployment` serving mixed roles.

Kubernetes is also the way to scale the **Developer-workspace Python runtime**
across nodes: it launches a pod per notebook session (cluster-addressable,
unlike the single-host Docker backend). Manifests live under
`deploy/k8s/notebooks/`; set `NOTEBOOK_RUNTIME_BACKEND=k8s` and run the app
in-cluster. See [DEVELOPER_WORKSPACE_RUNTIME.md](./DEVELOPER_WORKSPACE_RUNTIME.md).

### D3. Managed clusters: AWS, GCP, Azure, OCI

The manifests in this repository use core Kubernetes APIs only and name no
StorageClass, so the same `kubectl apply` lands on any managed cluster. What
differs is everything around them, and it is the same six decisions on each
cloud: where the images live, what the default StorageClass provisions,
which CNI actually enforces `NetworkPolicy`, how traffic and TLS arrive,
where the lakehouse catalog's Postgres lives, and which object store holds
the lake.

Each runbook below walks all six from an empty account to a working
instance, in order, with a check after every step. They are long because
they are meant to be followed rather than read: nothing is left as "and then
configure ingress".

| Decision              | Why it is a decision                                                                                                                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Registry**          | Nodes pull from a registry. Images built on your laptop end in `ImagePullBackOff` on every cluster that is not local.                                                                                                           |
| **Default storage**   | The lakehouse catalog and the Supabase chart claim volumes from the default StorageClass. On EKS there is no working one until you install a CSI driver yourself.                                                               |
| **NetworkPolicy CNI** | The policy that denies the JS sandbox all egress is silently inert without a CNI that enforces policy — it applies cleanly and does nothing. On GKE and AKS the choice is made at cluster creation and cannot be changed later. |
| **Ingress and TLS**   | `port-forward` proves the install; a hostname and a certificate make it usable, and `PUBLIC_APP_URL` has to match the result.                                                                                                   |
| **Catalog Postgres**  | The DuckLake catalog is the one part of the lakehouse that cannot be rebuilt from object storage. In production it belongs on managed Postgres, not the in-cluster StatefulSet.                                                 |
| **Lake object store** | The lakehouse writes Parquet to S3-compatible storage. Three of these four clouds have one; Azure does not (see its runbook).                                                                                                   |

| Cloud     | Registry          | Storage                              | Policy enforcement                  | Ingress                                  |
| --------- | ----------------- | ------------------------------------ | ----------------------------------- | ---------------------------------------- |
| **AWS**   | ECR               | EBS CSI add-on, then a default `gp3` | VPC CNI with network policy enabled | AWS Load Balancer Controller (ALB) + ACM |
| **GCP**   | Artifact Registry | `standard-rwo`, default already      | Dataplane V2, at creation           | GKE Ingress + ManagedCertificate         |
| **Azure** | ACR               | Azure Disks, default already         | `--network-policy`, at creation     | App Routing add-on (managed NGINX)       |
| **OCI**   | OCIR              | `oci-bv`, default already            | Calico, installed by you            | Native ingress controller, or NGINX      |

The in-cluster observations in D1 and D2 come from the clusters this was
built and broken on. The vendor commands below are each cloud's documented
path for those six decisions; run them against a scratch cluster before a
production one, and read your provider's current CLI reference beside them,
because flag names move.

#### What every cloud needs first: five images

D1a names the three images the installer substitutes. Two more are pulled by
the notebook namespace if you use the developer workspace, ETL, or anything
in the ML platform — training, prediction and pipeline runs are all batch
pods there:

| Image                                 | Build context                 | Needed for                             |
| ------------------------------------- | ----------------------------- | -------------------------------------- |
| `agentswarms:latest`                  | the repository root           | the app itself                         |
| `agentswarms/docgen:latest`           | `./docgen-service`            | Office exports                         |
| `agentswarms/js-sandbox:latest`       | `./services/js-sandbox`       | custom code in deployed runs           |
| `agentswarms/notebook-gateway:latest` | `./services/notebook-gateway` | the notebook session gateway           |
| `agentswarms/notebook-runtime:latest` | `./docker/notebook-runtime`   | notebook, ETL, ML training and scoring |

The build loop is the same everywhere; only `REGISTRY` changes. Run it from
the repository root:

```bash
export REGISTRY=<your registry host and path>   # set per cloud, below
export TAG=1.4.0
docker build -t "$REGISTRY/agentswarms:$TAG" .
docker build -t "$REGISTRY/docgen:$TAG" ./docgen-service
docker build -t "$REGISTRY/js-sandbox:$TAG" ./services/js-sandbox
docker build -t "$REGISTRY/notebook-gateway:$TAG" ./services/notebook-gateway
docker build -t "$REGISTRY/notebook-runtime:$TAG" ./docker/notebook-runtime
for i in agentswarms docgen js-sandbox notebook-gateway notebook-runtime; do docker push "$REGISTRY/$i:$TAG"; done
```

On an Apple Silicon laptop pushing to an x86 node pool, build for the
cluster's architecture or every pod crash-loops with `exec format error`:

```bash
docker buildx build --platform linux/amd64 -t "$REGISTRY/agentswarms:$TAG" --push .
```

The first three reach the manifests through the installer's environment
variables. The gateway is named in
`deploy/k8s/notebooks/notebook-runtime.yaml` (edit the `image:` line) and the
runtime through `NOTEBOOK_RUNTIME_IMAGE` in the app's Secret.

#### Amazon EKS (AWS)

**Before you start.** `aws` v2, `eksctl`, `kubectl` and `helm` on your path,
and an IAM principal that can create EKS clusters, IAM roles, ECR
repositories, RDS instances and S3 buckets. Set the variables this runbook
uses:

```bash
export AWS_REGION=us-east-1
export CLUSTER=agentswarms
export ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
export REGISTRY="$ACCOUNT.dkr.ecr.$AWS_REGION.amazonaws.com"
export TAG=1.4.0
```

**1. Create the cluster.** Three 4-vCPU nodes clear the roughly 3 CPU and
6 GiB our own pods request, with room for the Supabase chart. `--with-oidc`
is not optional here: every add-on below authenticates with IRSA, which
needs the OIDC provider that flag creates.

```bash
eksctl create cluster --name "$CLUSTER" --region "$AWS_REGION" --version 1.31 --nodegroup-name app --node-type m6i.xlarge --nodes 3 --nodes-min 3 --nodes-max 6 --managed --with-oidc
```

Fifteen to twenty minutes. Check:

```bash
kubectl get nodes -o wide
```

**2. Give the cluster a working default StorageClass.** A current EKS
cluster ships a `gp2` StorageClass whose provisioner is not installed, so
every `PersistentVolumeClaim` sits in `Pending` for ever and the lakehouse
catalog never starts. Install the EBS CSI driver with its own IAM role:

```bash
eksctl create iamserviceaccount --cluster "$CLUSTER" --region "$AWS_REGION" --namespace kube-system --name ebs-csi-controller-sa --role-name AgentSwarmsEBSCSIRole --attach-policy-arn arn:aws:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy --approve --role-only
```

```bash
eksctl create addon --cluster "$CLUSTER" --region "$AWS_REGION" --name aws-ebs-csi-driver --service-account-role-arn "arn:aws:iam::$ACCOUNT:role/AgentSwarmsEBSCSIRole" --force
```

Then make `gp3` the default and take the mark off `gp2` — two defaults is
the same as none:

```bash
kubectl apply -f - <<'YAML'
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: gp3
  annotations:
    storageclass.kubernetes.io/is-default-class: "true"
provisioner: ebs.csi.aws.com
parameters:
  type: gp3
  encrypted: "true"
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
YAML
```

```bash
kubectl annotate storageclass gp2 storageclass.kubernetes.io/is-default-class- --overwrite
```

Check exactly one class is marked `(default)`:

```bash
kubectl get storageclass
```

**3. Turn on network policy.** The VPC CNI enforces `NetworkPolicy` only
when told to, and the JS sandbox's egress ban depends on it:

```bash
aws eks update-addon --cluster-name "$CLUSTER" --region "$AWS_REGION" --addon-name vpc-cni --resolve-conflicts PRESERVE --configuration-values '{"enableNetworkPolicy":"true"}'
```

```bash
aws eks describe-addon --cluster-name "$CLUSTER" --region "$AWS_REGION" --addon-name vpc-cni --query 'addon.status'
```

Wait for `ACTIVE` before continuing.

**4. Create the ECR repositories and push.**

```bash
for r in agentswarms docgen js-sandbox notebook-gateway notebook-runtime; do aws ecr create-repository --repository-name "$r" --region "$AWS_REGION" >/dev/null || true; done
```

```bash
aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "$REGISTRY"
```

Then run the build loop from "What every cloud needs first".

**5. Install AgentSwarms.** Fully self-hosted, Supabase in the cluster too:

```bash
AGENTSWARMS_IMAGE="$REGISTRY/agentswarms:$TAG" DOCGEN_IMAGE="$REGISTRY/docgen:$TAG" JS_SANDBOX_IMAGE="$REGISTRY/js-sandbox:$TAG" ADMIN_EMAIL=you@corp.com ADMIN_PASSWORD='choose-a-strong-one' bash scripts/setup-k8s.sh
```

Or, with your own Supabase, follow D2 instead and apply
`deploy/k8s/app/agentswarms.yaml` and `deploy/k8s/app/services.yaml`.

**6. Watch it come up.**

```bash
kubectl -n agentswarms get pods -w
```

```bash
kubectl -n agentswarms port-forward svc/agentswarms 8080:80
```

Then open `http://localhost:8080` and sign in as the admin you named. A pod
in `Pending` with a `FailedScheduling` event is capacity; one waiting on a
volume is step 2; `ImagePullBackOff` is step 4.

**7. Put an ALB in front, with TLS.** Install the AWS Load Balancer
Controller — the IAM policy comes from the controller's own repository, so
it stays current:

```bash
curl -fsSL -o alb-policy.json https://raw.githubusercontent.com/kubernetes-sigs/aws-load-balancer-controller/v2.9.2/docs/install/iam_policy.json
```

```bash
aws iam create-policy --policy-name AgentSwarmsALBControllerPolicy --policy-document file://alb-policy.json
```

```bash
eksctl create iamserviceaccount --cluster "$CLUSTER" --region "$AWS_REGION" --namespace kube-system --name aws-load-balancer-controller --role-name AgentSwarmsALBControllerRole --attach-policy-arn "arn:aws:iam::$ACCOUNT:policy/AgentSwarmsALBControllerPolicy" --approve
```

```bash
helm repo add eks https://aws.github.io/eks-charts && helm repo update
```

```bash
helm install aws-load-balancer-controller eks/aws-load-balancer-controller --namespace kube-system --set clusterName="$CLUSTER" --set serviceAccount.create=false --set serviceAccount.name=aws-load-balancer-controller --set region="$AWS_REGION"
```

```bash
kubectl -n kube-system rollout status deploy/aws-load-balancer-controller
```

Request a certificate for the hostname and validate it by DNS:

```bash
aws acm request-certificate --domain-name agentswarms.example.com --validation-method DNS --region "$AWS_REGION"
```

```bash
aws acm describe-certificate --certificate-arn <arn from the previous command> --region "$AWS_REGION" --query 'Certificate.DomainValidationOptions[0].ResourceRecord'
```

Create that CNAME in your DNS, wait for `Status: ISSUED`, then apply the
Ingress:

```bash
kubectl apply -f - <<'YAML'
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: agentswarms
  namespace: agentswarms
  annotations:
    alb.ingress.kubernetes.io/scheme: internet-facing
    alb.ingress.kubernetes.io/target-type: ip
    alb.ingress.kubernetes.io/listen-ports: '[{"HTTP":80},{"HTTPS":443}]'
    alb.ingress.kubernetes.io/ssl-redirect: "443"
    alb.ingress.kubernetes.io/certificate-arn: arn:aws:acm:REGION:ACCOUNT:certificate/ID
    alb.ingress.kubernetes.io/healthcheck-path: /api/health/ready
    alb.ingress.kubernetes.io/healthcheck-interval-seconds: "15"
spec:
  ingressClassName: alb
  rules:
    - host: agentswarms.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend: { service: { name: agentswarms, port: { number: 80 } } }
YAML
```

Health-check `/api/health/ready`, not `/api/health`: readiness is the answer
that holds an analytics pod, or a pod that cannot reach the database, out of
the target group. Get the load balancer's hostname and point your domain at
it with an ALIAS or CNAME record:

```bash
kubectl -n agentswarms get ingress agentswarms -o jsonpath='{.status.loadBalancer.ingress[0].hostname}'
```

**8. Tell the app its own hostname.** `PUBLIC_APP_URL` is what invitations,
embeds and OAuth callbacks use, so it has to be the name people type:

```bash
kubectl -n agentswarms patch secret agentswarms-env --type merge -p "{\"stringData\":{\"PUBLIC_APP_URL\":\"https://agentswarms.example.com\"}}"
```

```bash
kubectl -n agentswarms rollout restart deploy/agentswarms
```

**9. Managed Postgres for the lakehouse catalog.** The in-cluster
StatefulSet is fine for a trial and wrong for production. Create an RDS
instance in the cluster's VPC:

```bash
export VPC=$(aws eks describe-cluster --name "$CLUSTER" --region "$AWS_REGION" --query 'cluster.resourcesVpcConfig.vpcId' --output text)
```

```bash
aws rds create-db-instance --db-instance-identifier agentswarms-catalog --engine postgres --engine-version 16.4 --db-instance-class db.t4g.medium --allocated-storage 50 --storage-encrypted --master-username lakehouse --master-user-password '<strong-password>' --db-name lakehouse_catalog --no-publicly-accessible --vpc-security-group-ids <sg allowing 5432 from the node group> --region "$AWS_REGION"
```

When it is `available`, put its endpoint in the Secret and restart:

```bash
kubectl -n agentswarms patch secret agentswarms-env --type merge -p "{\"stringData\":{\"LAKEHOUSE_CATALOG_URL\":\"postgres://lakehouse:<password>@<endpoint>:5432/lakehouse_catalog\"}}"
```

**10. S3 for the lake.** Leave `LAKEHOUSE_S3_ENDPOINT` unset — it is for
MinIO and other S3-compatible stores, and setting it to an AWS host is the
usual cause of a lakehouse that cannot read its own Parquet:

```bash
aws s3api create-bucket --bucket agentswarms-lake --region "$AWS_REGION"
```

```bash
kubectl -n agentswarms patch secret agentswarms-env --type merge -p "{\"stringData\":{\"LAKEHOUSE_DATA_URL\":\"s3://agentswarms-lake/main\",\"LAKEHOUSE_S3_REGION\":\"$AWS_REGION\",\"LAKEHOUSE_S3_URL_STYLE\":\"vhost\",\"LAKEHOUSE_S3_USE_SSL\":\"true\",\"LAKEHOUSE_S3_KEY_ID\":\"<key>\",\"LAKEHOUSE_S3_SECRET\":\"<secret>\"}}"
```

Give that key pair `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject` and
`s3:ListBucket` on that one bucket, and nothing else.

**11. The notebook namespace, if you train or run pipelines.** Edit the
gateway image in the manifest first, then:

```bash
kubectl apply -f deploy/k8s/notebooks/notebook-runtime.yaml
```

```bash
kubectl -n agentswarms patch secret agentswarms-env --type merge -p "{\"stringData\":{\"NOTEBOOK_RUNTIME_BACKEND\":\"k8s\",\"NOTEBOOK_RUNTIME_IMAGE\":\"$REGISTRY/notebook-runtime:$TAG\"}}"
```

The sandbox reaches the internet through a squid proxy whose allow-list is a
ConfigMap. Under Compose the app rewrites it; on Kubernetes it cannot, so
add the lake's host by hand or the first training job fails with DuckDB's
misleading "Authentication Failure":

```bash
kubectl -n agentswarms-notebooks edit configmap notebook-egress
```

```bash
kubectl -n agentswarms-notebooks rollout restart deploy/notebook-egress
```

**12. GPUs, only if you bring a CUDA runtime image.** The built-in trainers
are CPU-only, so this buys nothing on its own:

```bash
eksctl create nodegroup --cluster "$CLUSTER" --region "$AWS_REGION" --name gpu --node-type g5.xlarge --nodes 1 --node-labels accelerator=nvidia
```

```bash
kubectl apply -f https://raw.githubusercontent.com/NVIDIA/k8s-device-plugin/v0.17.0/deployments/static/nvidia-device-plugin.yml
```

```bash
kubectl -n agentswarms patch secret agentswarms-env --type merge -p '{"stringData":{"ML_TRAIN_GPUS":"1","NOTEBOOK_K8S_GPU_NODE_SELECTOR":"{\"accelerator\":\"nvidia\"}","NOTEBOOK_K8S_GPU_TOLERATIONS":"[{\"key\":\"nvidia.com/gpu\",\"operator\":\"Exists\",\"effect\":\"NoSchedule\"}]"}}'
```

**13. Tearing it down.** `eksctl delete cluster` leaves the load balancer,
the RDS instance and the bucket behind, and they keep charging:

```bash
kubectl -n agentswarms delete ingress agentswarms
```

```bash
eksctl delete cluster --name "$CLUSTER" --region "$AWS_REGION"
```

```bash
aws rds delete-db-instance --db-instance-identifier agentswarms-catalog --skip-final-snapshot --region "$AWS_REGION"
```

#### Google GKE (GCP)

**Before you start.** `gcloud`, `kubectl` and `helm`, a project with billing
enabled, and the Kubernetes Engine, Artifact Registry, Cloud SQL Admin and
Cloud Storage APIs turned on:

```bash
export PROJECT=$(gcloud config get-value project)
export REGION=us-central1
export CLUSTER=agentswarms
export REGISTRY="$REGION-docker.pkg.dev/$PROJECT/agentswarms"
export TAG=1.4.0
gcloud services enable container.googleapis.com artifactregistry.googleapis.com sqladmin.googleapis.com storage.googleapis.com
```

**1. Create the cluster with Dataplane V2.** This is the flag to get right:
it is what enforces `NetworkPolicy`, and it cannot be turned on afterwards
without recreating the cluster.

```bash
gcloud container clusters create "$CLUSTER" --region "$REGION" --num-nodes 1 --machine-type e2-standard-4 --enable-dataplane-v2 --enable-ip-alias --workload-pool="$PROJECT.svc.id.goog" --release-channel regular
```

`--num-nodes` is per zone, so a regional cluster gives three nodes. Then:

```bash
gcloud container clusters get-credentials "$CLUSTER" --region "$REGION"
```

Autopilot works too, with one caveat: it applies its own admission and
resource rules, so check the Office renderer first — it is the one image
here that runs as root. Standard clusters keep that choice yours.

**2. Storage needs nothing.** GKE ships `standard-rwo` as the default and
the PD CSI driver is already installed. Confirm before you rely on it:

```bash
kubectl get storageclass
```

**3. Create the Artifact Registry repository and push.**

```bash
gcloud artifacts repositories create agentswarms --repository-format=docker --location="$REGION" --description="AgentSwarms images"
```

```bash
gcloud auth configure-docker "$REGION-docker.pkg.dev"
```

Then run the build loop from "What every cloud needs first".

**4. Install AgentSwarms.**

```bash
AGENTSWARMS_IMAGE="$REGISTRY/agentswarms:$TAG" DOCGEN_IMAGE="$REGISTRY/docgen:$TAG" JS_SANDBOX_IMAGE="$REGISTRY/js-sandbox:$TAG" ADMIN_EMAIL=you@corp.com ADMIN_PASSWORD='choose-a-strong-one' bash scripts/setup-k8s.sh
```

```bash
kubectl -n agentswarms get pods -w
```

**5. Ingress with a Google-managed certificate.** Reserve a static address
first, so the DNS record you create outlives a rebuild of the Ingress:

```bash
gcloud compute addresses create agentswarms-ip --global
```

```bash
gcloud compute addresses describe agentswarms-ip --global --format='value(address)'
```

Create an A record for that address, then:

```bash
kubectl apply -f - <<'YAML'
apiVersion: networking.gke.io/v1
kind: ManagedCertificate
metadata:
  name: agentswarms
  namespace: agentswarms
spec:
  domains: [agentswarms.example.com]
---
apiVersion: cloud.google.com/v1
kind: BackendConfig
metadata:
  name: agentswarms
  namespace: agentswarms
spec:
  healthCheck:
    type: HTTP
    requestPath: /api/health/ready
    port: 8080
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: agentswarms
  namespace: agentswarms
  annotations:
    kubernetes.io/ingress.class: gce
    kubernetes.io/ingress.global-static-ip-name: agentswarms-ip
    networking.gke.io/managed-certificates: agentswarms
spec:
  rules:
    - host: agentswarms.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend: { service: { name: agentswarms, port: { number: 80 } } }
YAML
```

The `BackendConfig` needs the Service to reference it, which is one
annotation:

```bash
kubectl -n agentswarms annotate service agentswarms cloud.google.com/backend-config='{"default":"agentswarms"}' --overwrite
```

A managed certificate stays `Provisioning` until the A record resolves to
the reserved address, which takes tens of minutes on first issue:

```bash
kubectl -n agentswarms describe managedcertificate agentswarms
```

Then set the hostname as in the AWS runbook's step 8.

**6. Cloud SQL for the lakehouse catalog.**

```bash
gcloud sql instances create agentswarms-catalog --database-version=POSTGRES_16 --tier=db-custom-2-7680 --region="$REGION" --storage-auto-increase
```

```bash
gcloud sql databases create lakehouse_catalog --instance=agentswarms-catalog
```

```bash
gcloud sql users create lakehouse --instance=agentswarms-catalog --password='<strong-password>'
```

Reach it over private IP from the cluster's VPC, or run the Cloud SQL Auth
Proxy as a sidecar; then set `LAKEHOUSE_CATALOG_URL` as in the AWS runbook.

**7. Cloud Storage for the lake, through its S3-compatible endpoint.** GCS
speaks S3 with an HMAC key, which is what the lakehouse needs:

```bash
gcloud storage buckets create "gs://agentswarms-lake" --location="$REGION" --uniform-bucket-level-access
```

```bash
gcloud storage hmac create <service-account-email>
```

```bash
kubectl -n agentswarms patch secret agentswarms-env --type merge -p '{"stringData":{"LAKEHOUSE_DATA_URL":"s3://agentswarms-lake/main","LAKEHOUSE_S3_ENDPOINT":"storage.googleapis.com","LAKEHOUSE_S3_URL_STYLE":"path","LAKEHOUSE_S3_USE_SSL":"true","LAKEHOUSE_S3_KEY_ID":"<access id>","LAKEHOUSE_S3_SECRET":"<secret>"}}'
```

**8. The notebook namespace** — identical to the AWS runbook's step 11, with
`storage.googleapis.com` as the host to add to the egress allow-list.

**9. GPUs.** GKE installs the drivers for you when the pool asks for them:

```bash
gcloud container node-pools create gpu --cluster "$CLUSTER" --region "$REGION" --machine-type g2-standard-8 --accelerator type=nvidia-l4,count=1,gpu-driver-version=latest --num-nodes 1
```

```bash
kubectl -n agentswarms patch secret agentswarms-env --type merge -p '{"stringData":{"ML_TRAIN_GPUS":"1","NOTEBOOK_K8S_GPU_NODE_SELECTOR":"{\"cloud.google.com/gke-accelerator\":\"nvidia-l4\"}"}}'
```

**10. Tearing it down.**

```bash
gcloud container clusters delete "$CLUSTER" --region "$REGION"
```

```bash
gcloud sql instances delete agentswarms-catalog
```

```bash
gcloud compute addresses delete agentswarms-ip --global
```

#### Azure AKS

**Before you start.** `az`, `kubectl` and `helm`, and a subscription where
you can create resource groups, AKS clusters, container registries and
databases:

```bash
export RG=agentswarms-rg
export LOCATION=eastus
export CLUSTER=agentswarms
export ACR=agentswarmsacr          # must be globally unique
export REGISTRY="$ACR.azurecr.io"
export TAG=1.4.0
az group create --name "$RG" --location "$LOCATION"
```

**1. Create the cluster with a policy-enforcing dataplane.** Like GKE's
Dataplane V2, this is chosen at creation: `--network-policy` cannot be added
to a running cluster.

```bash
az aks create --resource-group "$RG" --name "$CLUSTER" --node-count 3 --node-vm-size Standard_D4s_v5 --network-plugin azure --network-dataplane cilium --network-policy cilium --enable-managed-identity --enable-cluster-autoscaler --min-count 3 --max-count 6 --generate-ssh-keys
```

```bash
az aks get-credentials --resource-group "$RG" --name "$CLUSTER"
```

```bash
kubectl get nodes -o wide
```

`--network-policy azure` and `calico` are the alternatives; Cilium is the
current default recommendation and enforces the sandbox's egress ban.

**2. Storage needs nothing.** AKS ships a default StorageClass backed by
Azure Disks. Confirm which one carries the mark before you assume the tier:

```bash
kubectl get storageclass
```

**3. Create the registry and let the cluster pull without a secret.**

```bash
az acr create --resource-group "$RG" --name "$ACR" --sku Standard
```

```bash
az aks update --resource-group "$RG" --name "$CLUSTER" --attach-acr "$ACR"
```

```bash
az acr login --name "$ACR"
```

`--attach-acr` grants the cluster's kubelet identity `AcrPull`, which is why
no `imagePullSecrets` appear anywhere in this runbook. Then run the build
loop from "What every cloud needs first".

**4. Install AgentSwarms.**

```bash
AGENTSWARMS_IMAGE="$REGISTRY/agentswarms:$TAG" DOCGEN_IMAGE="$REGISTRY/docgen:$TAG" JS_SANDBOX_IMAGE="$REGISTRY/js-sandbox:$TAG" ADMIN_EMAIL=you@corp.com ADMIN_PASSWORD='choose-a-strong-one' bash scripts/setup-k8s.sh
```

```bash
kubectl -n agentswarms get pods -w
```

**5. Ingress with the managed NGINX add-on**, which brings its own public IP
and can manage certificates from Key Vault:

```bash
az aks approuting enable --resource-group "$RG" --name "$CLUSTER"
```

```bash
kubectl apply -f - <<'YAML'
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: agentswarms
  namespace: agentswarms
  annotations:
    nginx.ingress.kubernetes.io/proxy-read-timeout: "300"
    nginx.ingress.kubernetes.io/proxy-body-size: 64m
spec:
  ingressClassName: webapprouting.kubernetes.io
  rules:
    - host: agentswarms.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend: { service: { name: agentswarms, port: { number: 80 } } }
YAML
```

The read timeout matters: an AI Analyst turn takes 30–95 seconds, and NGINX's
60-second default cuts it off with a 504 halfway through. Get the address
and create the DNS record:

```bash
kubectl -n app-routing-system get service nginx -o jsonpath='{.status.loadBalancer.ingress[0].ip}'
```

For TLS, either attach a Key Vault certificate to the add-on, or install
cert-manager and add the usual `cert-manager.io/cluster-issuer` annotation
and `tls:` block. Then set the hostname as in the AWS runbook's step 8.

**6. Azure Database for PostgreSQL for the lakehouse catalog.**

```bash
az postgres flexible-server create --resource-group "$RG" --name agentswarms-catalog --location "$LOCATION" --tier Burstable --sku-name Standard_B2s --version 16 --storage-size 64 --admin-user lakehouse --admin-password '<strong-password>' --public-access None --yes
```

```bash
az postgres flexible-server db create --resource-group "$RG" --server-name agentswarms-catalog --database-name lakehouse_catalog
```

Give the cluster's subnet a private endpoint or a firewall rule, then set
`LAKEHOUSE_CATALOG_URL` as in the AWS runbook's step 9.

**7. The lake needs S3-compatible storage, and Azure Blob is not.** This is
the one place AKS differs materially. Two honest options:

- **Run MinIO in the cluster**, backed by a Premium disk, and point
  `LAKEHOUSE_S3_ENDPOINT` at its Service. This is what the Compose stack
  does and what the lakehouse was built against.
- **Use an S3 endpoint elsewhere** — an existing AWS account, or any
  S3-compatible store you already operate.

Azure Blob and ADLS Gen2 _are_ first-class as **mounted data lakes**: a
read-only schema over data that already lives there, queried in place. That
is a different feature from the lakehouse's own storage, and it needs none of
this.

**8. The notebook namespace** — identical to the AWS runbook's step 11, with
whichever S3 host you chose in step 7 added to the egress allow-list.

**9. GPUs.**

```bash
az aks nodepool add --resource-group "$RG" --cluster-name "$CLUSTER" --name gpu --node-count 1 --node-vm-size Standard_NC4as_T4_v3 --node-taints nvidia.com/gpu=present:NoSchedule --labels accelerator=nvidia
```

```bash
kubectl apply -f https://raw.githubusercontent.com/NVIDIA/k8s-device-plugin/v0.17.0/deployments/static/nvidia-device-plugin.yml
```

Then set `ML_TRAIN_GPUS`, `NOTEBOOK_K8S_GPU_NODE_SELECTOR` and
`NOTEBOOK_K8S_GPU_TOLERATIONS` to match that label and taint, as in the AWS
runbook's step 12.

**10. Tearing it down.** One command, because everything is in the group:

```bash
az group delete --name "$RG" --yes --no-wait
```

#### Oracle OKE (OCI)

**Before you start.** The `oci` CLI configured, `kubectl` and `helm`, and a
compartment you can create clusters, databases and buckets in. OKE's
**Quick create** in the console builds the VCN, subnets and node pool in one
pass and is the shortest path; the CLI needs those OCIDs to exist already:

```bash
export COMPARTMENT=<compartment OCID>
export OCI_REGION=us-ashburn-1
export REGION_KEY=iad                     # the registry prefix for that region
export NAMESPACE=$(oci os ns get --query data --raw-output)
export REGISTRY="$REGION_KEY.ocir.io/$NAMESPACE/agentswarms"
export TAG=1.4.0
```

**1. Create the cluster and a node pool.** Size the pool for the roughly
3 CPU and 6 GiB our pods request plus the Supabase chart — three
`VM.Standard.E4.Flex` nodes at 4 OCPUs and 32 GB is comfortable:

```bash
oci ce cluster create --compartment-id "$COMPARTMENT" --name agentswarms --vcn-id <VCN OCID> --kubernetes-version v1.31.1 --service-lb-subnet-ids '["<LB subnet OCID>"]'
```

```bash
oci ce cluster create-kubeconfig --cluster-id <cluster OCID> --file "$HOME/.kube/config" --region "$OCI_REGION" --token-version 2.0.0
```

```bash
kubectl get nodes -o wide
```

**2. Storage needs nothing.** OKE ships `oci-bv` (Block Volume CSI) as the
default. Block volumes are zonal, so keep the lakehouse catalog's node pool
in one availability domain — or move the catalog to managed Postgres in
step 7 and stop caring.

**3. Install Calico if you want the sandbox's egress ban enforced.** OKE's
flannel and VCN-native pod networking do not enforce `NetworkPolicy` on
their own; Oracle documents installing Calico over the top. Without it the
policy applies cleanly and does nothing — the quiet failure this guide keeps
warning about.

**4. Push to OCIR.** The password is an **auth token** generated in the
console under your user's Auth Tokens, not your console password, and the
username carries the tenancy namespace:

```bash
docker login "$REGION_KEY.ocir.io" --username "$NAMESPACE/oracleidentitycloudservice/you@corp.com"
```

Run the build loop from "What every cloud needs first". Unless you make the
repositories public, the cluster needs the same credentials:

```bash
kubectl create namespace agentswarms --dry-run=client -o yaml | kubectl apply -f -
```

```bash
kubectl create secret docker-registry ocir --namespace agentswarms --docker-server="$REGION_KEY.ocir.io" --docker-username="$NAMESPACE/oracleidentitycloudservice/you@corp.com" --docker-password='<auth-token>'
```

```bash
kubectl -n agentswarms patch serviceaccount default -p '{"imagePullSecrets":[{"name":"ocir"}]}'
```

**5. Install AgentSwarms.**

```bash
AGENTSWARMS_IMAGE="$REGISTRY/agentswarms:$TAG" DOCGEN_IMAGE="$REGISTRY/docgen:$TAG" JS_SANDBOX_IMAGE="$REGISTRY/js-sandbox:$TAG" ADMIN_EMAIL=you@corp.com ADMIN_PASSWORD='choose-a-strong-one' bash scripts/setup-k8s.sh
```

**6. Ingress.** Either enable the **native ingress controller** cluster
add-on, which fronts the cluster with an OCI load balancer, or install
ingress-nginx and let its `LoadBalancer` Service create one:

```bash
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx && helm repo update
```

```bash
helm install ingress-nginx ingress-nginx/ingress-nginx --namespace ingress-nginx --create-namespace --set controller.service.annotations."service\.beta\.kubernetes\.io/oci-load-balancer-shape"=flexible --set controller.service.annotations."service\.beta\.kubernetes\.io/oci-load-balancer-shape-flex-min"=10 --set controller.service.annotations."service\.beta\.kubernetes\.io/oci-load-balancer-shape-flex-max"=100
```

```bash
kubectl -n ingress-nginx get service ingress-nginx-controller
```

Then an Ingress with `ingressClassName: nginx`, the same
`proxy-read-timeout` annotation the AKS runbook explains, and cert-manager
for TLS. For a first look, a `LoadBalancer` Service is enough:

```bash
kubectl -n agentswarms patch svc agentswarms -p '{"spec":{"type":"LoadBalancer"}}'
```

**7. OCI Database with PostgreSQL for the lakehouse catalog**, in a subnet
the cluster can reach; then set `LAKEHOUSE_CATALOG_URL` as in the AWS
runbook's step 9.

**8. OCI Object Storage for the lake**, through its S3 compatibility
endpoint. Create a **Customer Secret Key** for the user (console: Identity →
Users → Customer Secret Keys) — an auth token will not work here, they are
different credentials:

```bash
oci os bucket create --compartment-id "$COMPARTMENT" --name agentswarms-lake
```

```bash
kubectl -n agentswarms patch secret agentswarms-env --type merge -p "{\"stringData\":{\"LAKEHOUSE_DATA_URL\":\"s3://agentswarms-lake/main\",\"LAKEHOUSE_S3_ENDPOINT\":\"$NAMESPACE.compat.objectstorage.$OCI_REGION.oraclecloud.com\",\"LAKEHOUSE_S3_URL_STYLE\":\"path\",\"LAKEHOUSE_S3_USE_SSL\":\"true\",\"LAKEHOUSE_S3_REGION\":\"$OCI_REGION\",\"LAKEHOUSE_S3_KEY_ID\":\"<access key>\",\"LAKEHOUSE_S3_SECRET\":\"<secret key>\"}}"
```

**9. The notebook namespace** — identical to the AWS runbook's step 11, with
the `compat.objectstorage` host added to the egress allow-list.

**10. GPUs.** Add a node pool on a GPU shape (`VM.GPU.A10.1`, for example)
with Oracle's GPU image, install the NVIDIA device plugin as in the AKS
runbook, and set the same three variables against that pool's label and
taint.

**11. Tearing it down.**

```bash
oci ce cluster delete --cluster-id <cluster OCID> --force
```

Then delete the load balancer, the database and the bucket, which outlive
the cluster.

#### After any of them: the same seven checks

```bash
kubectl -n agentswarms get pods
```

1. **Every pod is Running and Ready.** `Pending` with a `FailedScheduling`
   event is capacity; `Pending` on a volume is the StorageClass step;
   `ImagePullBackOff` is the registry step; `CrashLoopBackOff` with
   `exec format error` is an image built for the wrong architecture.
2. **The Office renderer exists.** No pod and no error is the `restricted`
   Pod Security Standard refusing its root image — the failure D1a describes,
   which warns at apply time and is silent afterwards.

```bash
kubectl -n agentswarms get deploy agentswarms-docgen -o jsonpath='{.status.replicas}/{.status.readyReplicas}'
```

3. **`resources.limits.cpu` is set on the web Deployment.** The worker count
   is read from it, so a pod with no limit on a large node forks a worker per
   core at up to a gigabyte each.

```bash
kubectl -n agentswarms get deploy agentswarms -o jsonpath='{.spec.template.spec.containers[0].resources}'
```

4. **The sandbox's egress really is denied**, which is only true if the CNI
   enforces policy:

```bash
kubectl -n agentswarms exec deploy/agentswarms-js-sandbox -- sh -c 'wget -qO- --timeout=5 https://example.com || echo DENIED'
```

`DENIED` is the pass. Anything else means the network-policy step did not
take, and user-supplied code can reach the internet.

5. **Readiness and liveness answer different questions.** The load balancer
   must health-check `/api/health/ready`:

```bash
kubectl -n agentswarms exec deploy/agentswarms -- wget -qO- localhost:8080/api/health/ready
```

6. **`PUBLIC_APP_URL` matches the hostname people type.** Invitations,
   embeds and OAuth callbacks are built from it.
7. **The lakehouse can write.** Sign in, open **Data & BI → Lakehouse**, and
   run `CREATE SCHEMA IF NOT EXISTS smoke; CREATE TABLE smoke.t AS SELECT 1 AS n;`
   — this exercises the catalog Postgres and the object store together, which
   is the pair most likely to be misconfigured.

#### When it does not work

| Symptom                                                        | Cause                                                                                                                    |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Every PVC `Pending`, no events about capacity                  | No usable default StorageClass. On EKS the `gp2` class exists with no driver behind it — install the EBS CSI add-on.     |
| `ImagePullBackOff` on a cloud cluster                          | The images are still only on your laptop, or the pull secret is missing. Five images, not three.                         |
| Pods `CrashLoopBackOff` with `exec format error`               | An arm64 image on an amd64 node pool. Rebuild with `docker buildx --platform linux/amd64`.                               |
| Every pod fails readiness with `Invalid supabaseUrl`           | The Secret was built from a `.env` with the quotes left on. Strip them (D2).                                             |
| `couldn't find key … in Secret`                                | A variable Compose was defaulting for you. `BI_CRON_TOKEN`, `INTERNAL_RUN_SECRET` and `LAKEHOUSE_CATALOG_PASSWORD` (D2). |
| The analyst answers in the app but 504s through the ingress    | The proxy's read timeout. A turn takes 30–95 seconds; NGINX defaults to 60.                                              |
| A training job fails with "Authentication Failure" from DuckDB | The object store's host is not in the notebook egress allow-list. The app log names the host to add.                     |
| `kubectl rollout status` hangs on an analytics Deployment      | It has a readiness probe. `APP_ROLE=analytics` answers readiness 503 for ever by design; exclude those pods by label.    |
| The sandbox reaches the internet                               | The CNI is not enforcing `NetworkPolicy`. On GKE and AKS that is decided at cluster creation and needs a new cluster.    |

---

### The ML platform on Kubernetes

Everything the ML platform does runs on Kubernetes with the scaling the
cluster gives you; nothing is Compose-only. What runs where:

| Piece                                             | Where it runs                                                                                                                   | Scales by                                                                                                                                                                               |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Training and prediction sandboxes                 | Batch **Jobs** in `agentswarms-notebooks` (the notebook runtime manifest), one per run, `activeDeadlineSeconds` from the budget | Nodes in the pool and the namespace `ResourceQuota`; per-user by `ML_MAX_CONCURRENT_TRAININGS_PER_USER`. Memory per job is `ML_TRAIN_MEM_LIMIT_MB`; the `LimitRange` max must allow it. |
| Model artifacts                                   | The lake bucket (`ml-artifacts/`), SHA-256 verified before inference                                                            | Object-store capacity                                                                                                                                                                   |
| Data in and out                                   | Lakehouse tables through the statement guard; the sandbox reads Parquet via the egress proxy                                    | Add the object-store host to the `notebook-egress` ConfigMap (the app names the host in its log if it is missing)                                                                       |
| Schedules, drift evaluation, materialized views   | The one sweep: the BI `CronJob` (web pods run `DISABLE_INPROCESS_SCHEDULER=1`) under the fleet-wide lease                       | Does not multiply with replicas — by design; raise the sweep's per-pass limits instead                                                                                                  |
| The public ML API, the wizard, predictions try-it | The web tier, behind the Service and HPA                                                                                        | Replicas; rate limits are global (`ML_API_RATE_LIMIT_PER_MIN` is per key across replicas)                                                                                               |
| GPUs                                              | `ML_TRAIN_GPUS` puts an `nvidia.com/gpu` limit on each training Job                                                             | A GPU node pool with the NVIDIA device plugin; `NOTEBOOK_K8S_GPU_NODE_SELECTOR` / `NOTEBOOK_K8S_GPU_TOLERATIONS` (JSON) place the pods; a CUDA build of the runtime image               |

Three things to set for a cluster that trains:

1. **The notebook runtime manifest is required**, not optional, and
   `NOTEBOOK_RUNTIME_BACKEND=k8s` in the app Secret. Training, prediction and
   ETL all run as Jobs there.
2. **The egress ConfigMap must admit the object store.** Under Compose the app
   rewrites the squid allow-list itself; on Kubernetes it cannot, so add the
   host of `LAKEHOUSE_S3_ENDPOINT` to `allowed_domains` (or `allowed_ips`) and
   restart the proxy. The first training job otherwise fails with DuckDB's
   misleading "Authentication Failure", and the app log says which host to add.
3. **Size the namespace for concurrent trainings**: `ResourceQuota`
   (cluster-wide ceiling), `LimitRange.max.memory` ≥ `ML_TRAIN_MEM_LIMIT_MB`, and
   `ML_MAX_CONCURRENT_TRAININGS_PER_USER`. A training on a few hundred thousand
   rows fits the 8 GiB default; tens of millions of rows want 32–64 GiB, or
   `ML_TRAIN_MAX_ROWS` to sample. The built-in trainers are CPU-only, so no GPU
   pool is needed unless you bring your own CUDA image.

The GPU placement knobs, like every other limit, come from the environment:

```bash
ML_TRAIN_GPUS=1
NOTEBOOK_K8S_GPU_NODE_SELECTOR='{"cloud.google.com/gke-accelerator":"nvidia-l4"}'
NOTEBOOK_K8S_GPU_TOLERATIONS='[{"key":"nvidia.com/gpu","operator":"Exists","effect":"NoSchedule"}]'
```

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
- **Back up Postgres yourself.** There is no managed backup now. It is _not_
  the only stateful component: the lakehouse catalog, the lake's Parquet
  files and the secrets in `.env` are separate, and `npm run backup` captures
  them together — see [Backups and restore](#backups-and-restore).
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

### Backups and restore

A self-hosted install has **four** things that cannot be regenerated. Back up
all four; a backup that captures the application database and forgets the
lakehouse catalog restores a lakehouse whose tables all exist and none can be
read.

| What                     | Where it lives                                                                                                           | Lost without it                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| **Application database** | Supabase Postgres (hosted project or your self-hosted stack)                                                             | users, agents, swarms, knowledge bases, connections, pipelines, decisions, the audit trail                  |
| **Lakehouse catalog**    | the `lakehouse-catalog` container (`lakehouse-catalog-data` volume), or the external Postgres in `LAKEHOUSE_CATALOG_URL` | which Parquet files make up each table and every snapshot — time travel, replay and `DROP` all depend on it |
| **Lakehouse data**       | zstd Parquet under `LAKEHOUSE_DATA_URL` in your S3-compatible bucket                                                     | the rows themselves                                                                                         |
| **Secrets in `.env`**    | `PROVIDER_CREDS_SECRET`, `PROVENANCE_SIGNING_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, the lake and catalog credentials …    | stored provider keys and warehouse passwords become undecryptable; no Answer Passport can be verified       |

#### Take a backup

```bash
npm run backup
```

This writes `backups/<timestamp>/` containing:

- `lakehouse-catalog.dump` — `pg_dump` of the catalog in custom format. The
  script reaches the Postgres named by the **host** in `LAKEHOUSE_CATALOG_URL`:
  a Docker container of that name (`docker exec`), else the compose
  `lakehouse-catalog` service when the host is its alias, else a local
  `pg_dump` against the URL. It then refuses any dump that lacks the
  `ducklake_snapshot` table — a wrong or empty Postgres cannot pass as a
  backup — and records which one answered in the manifest;
- `lake/…` — every object under `LAKEHOUSE_DATA_URL`, mirrored byte-for-byte,
  and `lake-objects.json` listing them with sizes;
- `supabase.dump` (self-hosted) or `supabase-schema.sql` + `supabase-data.sql`
  (hosted) — the application database;
- `SECRETS-REQUIRED.txt` — the **names** of the env keys you must store in your
  secret manager. Values are never written to a backup;
- `manifest.json` — what was captured, what was skipped and why, sizes, app
  version.

The application database needs a credential the script will not guess and
never prompts for (a scheduled backup must not hang):

- **self-hosted Supabase:** `npm run backup -- --db-url "postgresql://postgres:<POSTGRES_PASSWORD>@<db-host>:5432/postgres"`
  or set `SUPABASE_DB_URL`;
- **hosted Supabase, linked project:** set `SUPABASE_DB_PASSWORD` (Project
  Settings → Database) and the script runs `supabase db dump`.

Without either, the database step is **skipped and recorded** in
`manifest.json` — the backup still exits 0 for the other components, so read
the manifest, or run with a credential. `--dry-run` lists what would be
captured; `--skip-lake`, `--skip-catalog`, `--skip-supabase` narrow a run;
`--out <dir>` sends it to mounted storage.

Schedule it. A nightly cron on the host, output on a volume that is itself
backed up off-machine:

```bash
0 2 * * * cd /opt/agentswarms && npm run backup -- --out /mnt/backups/agentswarms/$(date +\%F) >> /var/log/agentswarms-backup.log 2>&1
```

#### Rehearse the restore

A backup nobody has restored is a hope. The drill restores the catalog dump
into a scratch database and a sample of the Parquet into a scratch prefix,
compares what came back with what was backed up, then removes both. Nothing
live is touched:

```bash
npm run restore -- backups/<timestamp> --drill
```

It prints the table, data-file and snapshot counts recovered from the dump,
notes whether the live catalog has moved since, re-lists the uploaded objects
to confirm sizes, and ends with `DRILL PASSED`. Run it after the first backup
and after any change to where the catalog or the lake lives.

#### Restore for real

Restoring is destructive, so each component is opted into and `--yes` is
required. Order matters:

1. **Secrets first.** Put the values named in `SECRETS-REQUIRED.txt` back into
   `.env` on the new host — the same values, not fresh ones.
2. **Application database.**
   `npm run restore -- backups/<timestamp> --supabase --db-url "postgresql://…" --yes`
   (hosted projects: `psql` the two `.sql` files into the new project, then
   `npx supabase db push` to confirm it is at the current migration).
3. **Lakehouse catalog.** `npm run restore -- backups/<timestamp> --catalog --yes`
   (or `--catalog-db <name>` to restore beside the live catalog and swap
   `LAKEHOUSE_CATALOG_URL`).
4. **Lakehouse data.** `npm run restore -- backups/<timestamp> --lake --yes`
   uploads every mirrored object to `LAKEHOUSE_DATA_URL`; `--lake-prefix`
   targets a different prefix if the new bucket is laid out differently — then
   point `LAKEHOUSE_DATA_URL` at it.
5. Start the app, open **Lakehouse**, pick a table you know and run
   `SELECT count(*)` on the **Query** tab. Then open **Audit** and click
   **Verify integrity** on the chain:
   a restored trail that verifies proves nothing was lost between the backup
   and the failure.

#### Example: moving to a new host

Take a backup on the old host with a database credential so nothing is
skipped, copy the backup directory and your secret-manager values across,
bring up the stack on the new host (`docker compose up -d --build`, then
`--profile lakehouse` if you use it), restore in the order above, and run
the drill against the same backup on the new host to prove the catalog and
lake it now serves match what you moved. Only then repoint DNS.

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
