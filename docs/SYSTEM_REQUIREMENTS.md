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

| Component                               | What it is                                                                                                                                        | Resource profile                                                                                                                                                                             |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **App server**                          | One stateless Node process (SSR + API + in-process scheduler). Scales horizontally behind any load balancer — no sticky sessions.                 | CPU-light, ~0.5–1 GB RSS. Almost all "AI work" is streaming JSON between the browser and an LLM API.                                                                                         |
| **PostgreSQL (Supabase)**               | Auth, RLS data, traces, audit, BI results, vectors (pgvector). Use [Supabase Cloud](https://supabase.com/pricing) (free tier works) or self-host. | The main stateful component. Grows with traces/audit/KB — see [storage growth](#storage-growth).                                                                                             |
| **LLM calls**                           | External by default (BYOK: OpenRouter, OpenAI, Anthropic, Bedrock, …).                                                                            | **No GPU needed.** Your cost here is _tokens_, not hardware — see [§4](#4-token-budgets). GPUs only enter the picture if you self-host models ([§5](#5-gpu-sizing-self-hosted-models-only)). |
| **Notebook / MCP runtime** _(optional)_ | Sandboxed Docker containers for the Developer workspace (Python Lab) and MCP Builder.                                                             | Each interactive sandbox is capped at **2 GB RAM** (batch: 4 GB) and ~1 CPU by default. Size the host for _concurrent_ sandboxes, not total users.                                           |
| **docgen-service** _(optional)_         | Python sidecar rendering PPTX/DOCX/XLSX.                                                                                                          | Bursty; 1 vCPU / 1–2 GB is fine for teams.                                                                                                                                                   |

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
