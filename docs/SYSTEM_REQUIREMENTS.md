# System requirements & sizing guide

What it takes to run AgentSwarms — from a laptop evaluation to a
1,000-user deployment — and what that costs on AWS, GCP, Azure and OCI
across US, Europe, Middle East, India and APJC regions.

> **How to read the cost numbers.** All prices are **approximate on-demand
> list prices as of early 2026**, rounded, for Linux VMs billed ~730 h/month,
> **excluding** egress, support plans, backups and taxes. Committed-use /
> reserved pricing is typically **30–60 % cheaper**; spot/preemptible more.
> Always confirm with the official calculators:
> [AWS](https://calculator.aws) · [GCP](https://cloud.google.com/products/calculator) ·
> [Azure](https://azure.microsoft.com/pricing/calculator/) ·
> [OCI](https://www.oracle.com/cloud/costestimator.html).

---

> **Sizing the machine is not the same question as sizing the data.** This page
> covers CPU, memory, storage and cost. For how much data each module can
> handle — what pushes down into your warehouse and what is capped locally —
> see **[Scale and limits](./SCALE_AND_LIMITS.md)**.

## 1. What actually consumes resources

AgentSwarms is deliberately light to host. Understanding _why_ makes every
sizing decision below obvious:

| Component                               | What it is                                                                                                                                          | Resource profile                                                                                                                                                                             |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **App server**                          | Stateless Node (SSR + API + in-process scheduler), clustered one worker per CPU. Scales horizontally behind any load balancer — no sticky sessions. | ~0.5–1 GB RSS **per worker**. Almost all "AI work" is streaming JSON to an LLM API, but SSR costs ~30 ms CPU per page — see [§3b](#3b-one-big-host-measured).                                |
| **PostgreSQL (Supabase)**               | Auth, RLS data, traces, audit, BI results, vectors (pgvector). Use [Supabase Cloud](https://supabase.com/pricing) (free tier works) or self-host.   | The main stateful component. Grows with traces/audit/KB — see [storage growth](#storage-growth).                                                                                             |
| **LLM calls**                           | External by default (BYOK: OpenRouter, OpenAI, Anthropic, Bedrock, …).                                                                              | **No GPU needed.** Your cost here is _tokens_, not hardware — see [§4](#4-token-budgets). GPUs only enter the picture if you self-host models ([§5](#5-gpu-sizing-self-hosted-models-only)). |
| **Notebook / MCP runtime** _(optional)_ | Sandboxed Docker containers for the Developer workspace (Python Lab) and MCP Builder.                                                               | Each interactive sandbox is capped at **2 GB RAM** (batch: 4 GB) and ~1 CPU by default. Size the host for _concurrent_ sandboxes, not total users.                                           |
| **docgen-service** _(optional)_         | Python sidecar rendering PPTX/DOCX/XLSX.                                                                                                            | Bursty; 1 vCPU / 1–2 GB is fine for teams.                                                                                                                                                   |

Heavy load therefore means: many concurrent SSE streams (cheap), scheduled
BI refreshes / swarm runs (short CPU bursts), and — the only genuinely heavy
part — concurrent notebook sandboxes.

---

## 2. Minimum requirements

| Setup                                                     | CPU     | RAM   | Disk       | Notes                                                                                                    |
| --------------------------------------------------------- | ------- | ----- | ---------- | -------------------------------------------------------------------------------------------------------- |
| **Laptop / evaluation** (dev server, Supabase Cloud)      | 2 cores | 8 GB  | 15 GB free | Any macOS / Linux / Windows machine from the last ~8 years.                                              |
| **Smallest production server** (app only, Supabase Cloud) | 2 vCPU  | 4 GB  | 20 GB      | The "[2 vCPU / 4 GB is plenty to start](./DEPLOYMENT.md)" VM. Runs the app + scheduler for a small team. |
| **+ Notebook/MCP runtime** (`--profile notebooks`)        | 4 vCPU  | 8 GB  | 40 GB      | Adds Docker sandboxes; each active notebook takes up to 2 GB.                                            |
| **+ Building on the same box**                            | 4 vCPU  | 8 GB  | +10 GB     | `vite build` peaks around 6 GB — build in CI or on your laptop if the VM is smaller.                     |
| **Self-hosted Supabase on the same box**                  | +2 vCPU | +4 GB | +20 GB     | Or just use Supabase Cloud (free tier) and skip this.                                                    |

GPU: **none required**. Browsers do the rendering; LLMs are API calls.

> **Free-tier corner:** OCI's Always Free tier (4 Ampere A1 OCPUs, 24 GB RAM,
> 200 GB block storage) comfortably runs the app **and** the notebook profile
> at $0/month, paired with Supabase's free tier. This is the cheapest real
> deployment of AgentSwarms that exists.

---

## 3. Example scenarios

Concurrency assumptions: at any moment roughly **5–10 % of daily active
users** have an in-flight request, and ~1–3 % hold an open notebook.

|                            | **A — Solo / pilot**     | **B — Team**                           | **C — Department**                                                                                       | **D — Heavy / public**                                                |
| -------------------------- | ------------------------ | -------------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Users                      | 1–10                     | up to ~50                              | 100–250                                                                                                  | 500–1,000 + public embeds                                             |
| Feature profile            | Everything, lightly      | Chat, swarms, BI, a few notebooks      | + scheduled refreshes, MCP Builder, embeds                                                               | + published dashboards, embedded agents, constant scheduled swarms    |
| **App tier**               | shared 2 vCPU / 8 GB VM  | 4 vCPU / 16 GB                         | 2 × (4 vCPU / 16 GB) + LB                                                                                | 4 × (4 vCPU / 16 GB) + LB                                             |
| **Worker / notebook host** | same VM                  | same VM                                | 8 vCPU / 32 GB (≈ 12–14 concurrent sandboxes)                                                            | 2 × (8 vCPU / 32 GB)                                                  |
| **Postgres**               | same VM or Supabase Free | Supabase Pro ($25/mo) or 2 vCPU / 8 GB | 4 vCPU / 16 GB (or Supabase Team)                                                                        | HA pair 8 vCPU / 32 GB (or managed HA)                                |
| **Storage total**          | 60 GB                    | 100 GB                                 | 500 GB                                                                                                   | 1 TB                                                                  |
| Multi-instance flags       | —                        | —                                      | `DISABLE_INPROCESS_SCHEDULER=1` + external cron ([details](./DEPLOYMENT.md#scheduling--background-jobs)) | same + `/api/metrics` + [alert pack](../deploy/prometheus/alerts.yml) |

## 3a. Sizing ETL and the lakehouse

The table above sizes the app tier for **request traffic**. ETL and the
lakehouse are a different workload with different arithmetic, and the defaults
are deliberately small enough to be safe on a 2 vCPU VM — they do not grow on
their own. All the knobs below live in **Admin → Developer runtime → Compute
resources** and none is capped by the application.

### The three facts that drive every number

1. **One ETL run = one batch sandbox.** It costs exactly `batch_cpu_limit` CPU
   and `batch_mem_limit_mb` RAM for as long as it runs. Concurrency is bounded
   by `etl_max_concurrent_runs_per_user`, so a user's worst case is
   `concurrent runs × batch CPU / batch memory`. The admin page prints that
   product for you.
2. **The lakehouse engine runs inside each app process**, not in a sandbox. The
   app forks one worker process per CPU, so its memory limit is charged **per
   worker** — a 16-core host at 16 GB is 256 GB of intent, not 16. Size it
   against `host RAM ÷ workers`, leaving room for the app itself. (A ceiling,
   not a reservation: idle workers hold nothing.)
3. **The app forks one worker per CPU.** `server.mjs` clusters by default, so a
   big host is used without extra configuration. Set `WEB_CONCURRENCY=1` when
   you run many small containers instead — see
   [§3b](#3b-one-big-host-measured).

### Worked ETL sizes

Measured on the pipeline in
[End to end: data and AI](./END_TO_END_DATA_AND_AI.md) — 4 CSV sources, 17
nodes including a SQL transform, a quality gate and a lakehouse target:

| Workload                                                   | Batch CPU / memory | Concurrent runs | Sandbox scratch | Notes                                                                |
| ---------------------------------------------------------- | ------------------ | --------------- | --------------- | -------------------------------------------------------------------- |
| **Light** — a few thousand rows, CSV/API sources           | `2` / `4096`       | `3` (default)   | `1024`          | The defaults. Runs in about a minute, most of it package install.    |
| **Typical** — low millions of rows, joins and aggregates   | `4` / `16384`      | `4`             | `2048`          | pandas needs 3–5× the raw size in memory; joins sit at the high end. |
| **Heavy** — tens of millions, wide frames, several sources | `8` / `65536`      | `4`             | `4096`          | Past this, push the work into the lakehouse (SQL) instead of pandas. |

Per-run memory is sized in detail — by data size _and_ transform shape — in
[ETL pipelines § Data-size limits and machine sizing](./ETL_PIPELINES.md#data-size-limits-and-machine-sizing).
The table here is the host-level view: what to set so several of those runs
can happen at once.

> **Raise sandbox scratch before anything else.** A pipeline that uses both the
> SQL transform (`ibis-framework[duckdb]`, ~447 MB installed) and a lakehouse
> node (DuckDB extensions into the same tmpfs) needs more than the 512 MB
> default and fails intermittently without it — reported as a bare pip exit
> code. 2 GB is the smallest number that removes the problem.

**pandas is the memory ceiling, not the row count.** ETL transforms operate on
an in-memory DataFrame, so a 5 GB CSV needs far more than 5 GB. When a pipeline
starts needing tens of gigabytes, the answer is not a bigger sandbox — it is a
lakehouse SQL step, which streams and spills to disk instead.

### Worked lakehouse sizes

| Workload                           | Memory limit    | Threads | Notes                                                      |
| ---------------------------------- | --------------- | ------- | ---------------------------------------------------------- |
| Dashboards and metric queries      | `2GB` (default) | `4`     | Aggregates over Parquet; the result cache absorbs repeats. |
| Interactive analysis, larger joins | `8–16GB`        | `8`     | Spills past the limit rather than failing.                 |
| Heavy analytical queries           | `32GB+`         | `12+`   | Consider dedicating replicas to analytics — see below.     |

Remember these are **per worker process**, and the app runs one worker per CPU —
multiply before you compare against host RAM. `LAKEHOUSE_SPILL_LIMIT`
(default 20 GB) bounds the disk a spilling query may use; give each replica real
scratch disk, not a RAM-backed tmpfs.

## 3b. One big host, measured

Numbers below are **measured, not derived** — `server.mjs` under load on an
8-core / 23 GB machine that was also running six Docker containers and a dev
server. Treat them as a conservative floor; a dedicated host does better.

| What                          | 1 worker             | 8 workers                |
| ----------------------------- | -------------------- | ------------------------ |
| Static asset, 50 connections  | 1,940 req/s          | 1,944 req/s              |
| SSR page, 1 connection (idle) | 28 req/s, p50 30 ms  | 24 req/s, p50 33 ms      |
| SSR page, 10 connections      | 19 req/s, p50 460 ms | **55 req/s, p50 127 ms** |

Three things follow, and they decide every sizing decision:

- **SSR is the bottleneck; the HTTP layer is not.** Static assets serve ~65×
  faster than rendered pages and are unaffected by worker count. One rendered
  page costs about **30 ms of CPU**, so plan on roughly **25–30 SSR requests per
  second per core** and put a CDN in front of `/assets` if you can.
- **Clustering is what converts cores into throughput.** Under load, forking
  workers took SSR from 19 to 55 req/s and cut p50 from 460 ms to 127 ms. It
  does nothing when the server is idle — a single request costs the same 30 ms
  either way — which is exactly the expected shape: clustering removes queueing,
  it does not make rendering faster.
- **Scaling is sub-linear.** 8 workers gave ~2.9×, not 8×. Some of that is this
  box being busy, and some is real: workers share memory bandwidth and one
  Postgres. Size on the measured ratio, not the core count.

`server.mjs` forks one worker per CPU by default, so a large machine is used
without extra work — one container is enough, and inside a container the count
follows the CPU quota rather than the host. Running many small containers is
equally valid; set `WEB_CONCURRENCY=1` there so workers do not fight over a
fractional quota. Either way, **size the per-process knobs against the number of
worker processes**, which is `cores × replicas` — not the replica count.

Worked example — **16 OCPU / 128 GB**, mixed traffic and ETL, one app container:

| Component              | Allocation    | Reasoning                                                                   |
| ---------------------- | ------------- | --------------------------------------------------------------------------- |
| App container          | 1, `cpus=8`   | 8 workers of JS execution; the other 8 cores are for ETL sandboxes          |
| Lakehouse memory limit | `6GB`         | Per **worker**: 8 × 6 = 48 GB worst case if every worker runs a heavy query |
| Lakehouse threads      | `4`           | 8 workers × 4 = 32 threads, oversubscribed on purpose — queries burst       |
| Batch CPU / memory     | `4` / `16384` | 4 concurrent ETL runs ≈ 16 cores and 64 GB at full tilt                     |
| Concurrent runs / user | `4`           | Matches the line above                                                      |
| Pipelines per sweep    | `8`           | A start rate, not a concurrency cap — sweeps run every 60s                  |
| Sandbox scratch        | `2048`        | See the warning above                                                       |

The lakehouse figure is the one people get wrong. It is charged **per worker
process**, so raising `WEB_CONCURRENCY` or moving to a bigger box silently
multiplies it — halve the limit when you double the workers.

That deliberately does not sum to 128 GB. ETL sandboxes, the lakehouse engines
and the app all share the host, and a machine allocated to exactly 100 % has
nowhere to put a spike.

**Separating the two workloads scales better than one big pool.** A heavy
analytical query and a user request compete inside the same process, so at
larger sizes run two groups: nodes sized for traffic with a small lakehouse
limit, and one or two with `APP_ROLE=analytics` and a large one. That role holds
a node out of the interactive pool by reporting not-ready to the load balancer
while staying alive, and defaults it to a single worker so the large limit is
not multiplied — see
[Deployment § Analytics-only nodes](./DEPLOYMENT.md#analytics-only-nodes).

### What does not scale by adding replicas

**Scheduled work.** `runCronPass` takes a fleet-wide lease, so at most one sweep
runs across the whole fleet at a time. That is what stops N replicas
double-firing a schedule, and it makes scheduled throughput a **start rate**
rather than a function of replica count:

```
pipelines started per minute  =  PIPELINES_PER_SWEEP     (the tick is 60s)
```

Adding replicas does not raise it; raising the per-sweep number does, and it is
editable under **Admin → Developer runtime**. Two things bound how far:

- **A sweep has to finish inside the tick.** Measured on this deployment, an
  _idle_ sweep — nothing due in any of the nine job categories — costs
  **~2.1 s** steady-state (7.8 s on the first, cold call). Real work adds to
  that. Once a sweep exceeds 60 s the next tick finds the lease held and returns
  `skipped: true`, so the effective rate degrades from "once per minute" to
  "once per sweep duration" without any error being raised.
- **Concurrency is capped separately** by `MAX_CONCURRENT_RUNS_PER_USER`. The
  start rate governs how fast work is picked up; that governs how much runs at
  once.

Note that the in-process tick is **per worker process**, so a 16-core host ticks
16 times a minute and 15 of those immediately lose the lease. Harmless, but it
is 16× the lease traffic for no gain — another reason to set
`DISABLE_INPROCESS_SCHEDULER=1` and drive sweeps from one external cron once you
are past a single small box.

**Postgres — the real ceiling.** Every replica and every worker shares one
Supabase project, and nothing above changes that. What helps is knowing what
actually touches it:

| Load                                        | Hits Postgres?                                                                                                                                                                                                    |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Page renders, auth, RLS reads               | Yes — over HTTPS (PostgREST), so **connections do not multiply** with replicas or workers                                                                                                                         |
| Traces, audit, BI results                   | Yes, and they _grow_ — see [storage growth](#storage-growth); retention purges are the control                                                                                                                    |
| Scheduled sweeps                            | Yes: nine category queries every tick, per worker unless the in-process scheduler is off                                                                                                                          |
| **Analytical queries over your own data**   | **No** — the lakehouse is DuckDB over Parquet. This is the product's main answer to the ceiling                                                                                                                   |
| Lakehouse _catalog_ (DuckLake transactions) | Yes, as **raw connections held per worker process** that has served a lakehouse request (the engine is built lazily) — the one place clustering multiplies connections. It is your catalog Postgres, not Supabase |
| Warehouse connectors                        | Raw pools, bounded by `WAREHOUSE_POOL_MAX_KEYS` × replicas                                                                                                                                                        |

The levers, in the order worth reaching for: move analytical load onto the
lakehouse (where it does not touch Postgres at all); keep retention windows
short so traces and audit do not dominate the working set; raise the Supabase
compute tier; put direct connections behind a pooler (Supavisor/PgBouncer); and
add read replicas for read-heavy BI if your plan offers them.

> **No load test has been run against Postgres.** The app tier's numbers in
> [§3b](#3b-one-big-host-measured) are measured; the database ceiling is not.
> Anyone quoting a concurrent-user figure for it — including this page — is
> reasoning from architecture, not from a benchmark. Treat "a few hundred
> concurrent users" as the point to start watching database metrics, not as a
> measured limit.

### Storage growth

Rules of thumb (all tunable via retention settings):

- **Execution traces**: ~8–25 KB per LLM call with payloads. 100k calls/month
  ≈ **1–2.5 GB/month**; the trace-retention purge caps this.
- **Audit trail**: tiny (≤1 KB/event, 365-day default retention, archived to
  stdout as NDJSON on purge).
- **Knowledge bases + chat documents**: dominated by what users upload;
  budget explicitly. Vectors add ~1.5× the raw text size.
- **BI widget results**: bounded per widget; scheduled refreshes overwrite
  rather than accumulate.

---

## 4. Token budgets

Infrastructure is the cheap part — **tokens are the real bill** in BYOK
deployments. Working assumptions: a typical agent turn is ~3k tokens in +
~800 out; tool-calling loops (SQL, web search, BI) run 2–3 turns, so budget
**~5k–10k blended tokens per user interaction**.

| Monthly volume    | How you get there                        | Economy models¹ | Mainstream² | Frontier³ |
| ----------------- | ---------------------------------------- | --------------- | ----------- | --------- |
| **~10 M tokens**  | Solo power user                          | $1–10           | $5–25       | $50–400   |
| **~300 M tokens** | 50-person team (80 % casual, 20 % power) | $30–270         | $90–750     | $1.5k–12k |
| **~1.5 B tokens** | 250-person department + scheduled swarms | $150–1,350      | $450–3,750  | $7.5k–60k |
| **~5 B tokens**   | 1,000 users + public embeds              | $500–4.5k       | $1.5k–12.5k | $25k–200k |

¹ Open-weights via OpenRouter/Groq/DeepSeek (≈ $0.10–0.90 / M blended)
² GPT-4o-mini / Haiku / Gemini Flash class (≈ $0.30–2.50 / M blended)
³ Claude Sonnet/Opus, GPT-5-class (≈ $5–40 / M blended)

Embeddings are noise by comparison (≈ $0.02 / M tokens).

**Keep the ceiling yours, not the provider's:** per-user monthly budget caps,
per-agent guardrail limits, and IAM model allow-lists (pin heavy surfaces to
economy models) are all built in — use them before scaling anything.

---

## 5. GPU sizing (self-hosted models only)

Skip this section entirely if you use API providers. If data-residency or
cost-at-scale pushes you to self-host via **Ollama/vLLM** (both are
first-class connectors):

| Model class                       | GPU needed                               | Serves (vLLM, streaming)                          | Example instances (US, ~monthly)                                                                                                        |
| --------------------------------- | ---------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **7–9 B** (Llama 3.1 8B, Qwen 7B) | 1 × 24 GB (L4 / A10)                     | ~10–30 concurrent streams, ≈ 1–3k tok/s aggregate | AWS g6.xlarge ≈ $590 · GCP g2-standard-8 ≈ $620 · Azure NV36ads A10 ≈ $2,340 (or NCas T4 ≈ $385, quantized) · OCI VM.GPU.A10.1 ≈ $1,460 |
| **30–34 B**                       | 1 × 48–80 GB (L40S / A100)               | ~5–15 streams                                     | AWS g6e.xlarge (L40S) ≈ $1,360 · GCP/Azure 1 × A100 ≈ $2,700                                                                            |
| **70 B+**                         | 2 × A100/H100 80 GB (FP8) or 4–8 × 40 GB | ~5–20 streams                                     | ≈ $5k–24k/month depending on GPU class and cloud                                                                                        |

Notes that matter in practice:

- **GPU regional availability is the constraint, not price** — L4/A100/H100
  capacity in Middle East and India regions is limited or absent; most teams
  place the GPU node in the nearest hub (Frankfurt, Mumbai when available,
  Singapore) and accept a few ms of latency.
- A 70 B self-hosted model breaks even against mainstream API pricing at
  roughly **1–3 B tokens/month** of sustained use. Below that, use APIs.

---

## 6. Monthly cost by cloud and region

Compute + block storage for the scenarios in [§3](#3-example-scenarios)
(managed-Postgres line items included where noted; **tokens from §4 are
always additional**). Regions used: **US** = N. Virginia / us-central1 /
East US / Ashburn · **Europe** = Frankfurt / europe-west3 / West Europe ·
**Middle East** = UAE / Doha / UAE North / Dubai · **India** = Mumbai /
asia-south1 / Central India · **APJC** = Singapore / asia-southeast1 /
Southeast Asia.

### Scenario A — Solo / pilot (1 VM + 60 GB)

| Cloud                         | US      | Europe  | Middle East | India   | APJC    |
| ----------------------------- | ------- | ------- | ----------- | ------- | ------- |
| AWS (t3.large)                | $66     | $72     | $76         | $68     | $75     |
| GCP (e2-standard-2)           | $55     | $61     | $66         | $60     | $63     |
| Azure (B2ms)                  | $66     | $72     | $77         | $69     | $75     |
| **OCI (E4.Flex 1 OCPU/8 GB)** | **$30** | **$30** | **$30**     | **$30** | **$30** |

_(Or $0 on OCI Always Free + Supabase Free.)_

### Scenario B — Team ≤ 50 (app VM + Supabase Pro + 100 GB)

| Cloud                          | US      | Europe  | Middle East | India   | APJC    |
| ------------------------------ | ------- | ------- | ----------- | ------- | ------- |
| AWS (m7i.xlarge)               | $180    | $196    | $205        | $185    | $203    |
| GCP (e2-standard-4)            | $133    | $146    | $155        | $144    | $149    |
| Azure (D4s v5)                 | $173    | $188    | $198        | $180    | $195    |
| **OCI (E4.Flex 2 OCPU/16 GB)** | **$83** | **$83** | **$83**     | **$83** | **$83** |

### Scenario C — Department 100–250 (2 × app + worker + DB VM + LB + 500 GB)

| Cloud   | US       | Europe   | Middle East | India    | APJC     |
| ------- | -------- | -------- | ----------- | -------- | -------- |
| AWS     | $790     | $865     | $915        | $815     | $905     |
| GCP     | $560     | $625     | $670        | $615     | $645     |
| Azure   | $765     | $840     | $895        | $805     | $880     |
| **OCI** | **$300** | **$300** | **$300**    | **$300** | **$300** |

### Scenario D — Heavy / public 500–1,000 (4 × app + 2 × worker + HA DB + LB + 1 TB)

| Cloud   | US       | Europe   | Middle East | India    | APJC     |
| ------- | -------- | -------- | ----------- | -------- | -------- |
| AWS     | $1,830   | $2,010   | $2,120      | $1,880   | $2,100   |
| GCP     | $1,310   | $1,470   | $1,570      | $1,440   | $1,510   |
| Azure   | $1,800   | $1,980   | $2,110      | $1,890   | $2,070   |
| **OCI** | **$710** | **$710** | **$710**    | **$710** | **$710** |

### Why the tables look the way they do

- **OCI is flat across regions** — Oracle publishes one global list price, which
  is why its column never moves; combined with the cheapest per-core Flex
  pricing it is consistently the lowest-cost home for this stack.
- **Regional multipliers** (vs. US, typical): Europe +8–12 %, Middle East
  +15–20 %, India +3–10 %, APJC +15–20 % on AWS/GCP/Azure.
- **What's excluded**: egress (matters for public embeds — budget $0.05–0.12/GB
  on the big three, $0 for the first 10 TB on OCI), backups, support tiers,
  and NAT gateways.
- **Managed Postgres instead of a DB VM** swaps roughly like-for-like: e.g.
  RDS/Cloud SQL/Flexible Server at the same vCPU/RAM runs ~1.5–2.5× the raw
  VM price but removes the ops burden; Supabase Cloud (Pro $25, Team $599)
  is usually the simplest choice up through Scenario C.

### A worked total (Scenario B, mainstream models)

50-person team in Europe on GCP: **$146 infra + ~$90–750 tokens ≈
$240–900/month all-in** — the model bill dominates everything else, which is
exactly why the budget caps and model allow-lists exist.

---

_Prices verified against public list pricing in early 2026 and rounded.
If a number here disagrees with a cloud calculator, the calculator wins —
and a PR fixing this page is welcome._
