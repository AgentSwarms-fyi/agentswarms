<div align="center">
  <img src="public/og-image.png" alt="AgentSwarms" width="140" style="border-radius:28px" />

  <h1>AgentSwarms</h1>

  <p><strong>Deploy your own agentic AI platform — with learning guidance built in.</strong><br />
  Build agents, run multi-agent swarms, ground them in your data, and inspect
  every trace — on your own infrastructure, with your own keys.</p>

  <p>
    <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg" />
    <img alt="PRs Welcome" src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" />
    <img alt="Node" src="https://img.shields.io/badge/node-%E2%89%A520.19-339933?logo=node.js&logoColor=white" />
    <img alt="TanStack Start" src="https://img.shields.io/badge/TanStack%20Start-React%2019-FF4154?logo=react&logoColor=white" />
    <img alt="Supabase" src="https://img.shields.io/badge/backend-Supabase-3ECF8E?logo=supabase&logoColor=white" />
    <img alt="Deploy" src="https://img.shields.io/badge/deploy-Docker%20%7C%20Cloudflare-2496ED?logo=docker&logoColor=white" />
  </p>


  <p>
    <a href="#features">Features</a> ·
    <a href="#quickstart">Quickstart</a> ·
    <a href="#documentation">Documentation</a> ·
    <a href="#this-repo-vs-agentswarmsfyi">Open source vs. hosted</a> ·
    <a href="./CONTRIBUTING.md">Contributing</a>
  </p>
</div>

---

**AgentSwarms open source** is a complete, self-hostable agentic AI platform:
an agent playground, a visual multi-agent swarm canvas, knowledge bases with
RAG, tool use, MCP connections, budgets, and full execution traces — plus the
guided learning content to make sense of it all. It is designed for **easy
deployment**: one Supabase project as the backend, one Docker command to run,
and **bring-your-own-everything** — your data lives in your own Supabase
project, and models run against your own provider keys (OpenRouter, OpenAI,
Anthropic, Gemini, Bedrock, Azure, OCI, Qwen, Grok, Groq, Ollama, vLLM…).
Optionally set one instance-wide OpenRouter key so every user on your
instance can start with zero setup.

## This repo vs. agentswarms.fyi

Same UI, two different missions:

|              | **This repository (MIT)**                                                                                                                                                  | **[agentswarms.fyi](https://agentswarms.fyi) (hosted)**                                                                                                                 |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Focus**    | **Easy deployment of the full agentic AI platform** on your own infrastructure — agents, swarms, RAG, traces, budgets — with the learning curriculum included as guidance. | **Learning first**: a hands-on classroom for agentic AI — guided curriculum, build-along labs, interactive notebooks, presentations, and certification — fully managed. |
| **Runs on**  | Your Supabase project, your provider keys, your Docker host (or Cloudflare Workers).                                                                                       | Managed infrastructure, including an AI gateway with free-tier models — nothing to configure.                                                                           |
| **Extras**   | Headless control of your own data; no usage caps other than your own budgets.                                                                                              | Hosted-only surfaces: field-engineering blog, community galleries, voice agents, website embeds, and free standalone tools.                                             |
| **Best for** | Teams and tinkerers who want to **run** an agentic AI platform they own.                                                                                                   | Learners who want to **study and practice** agentic AI without setting anything up.                                                                                     |

The "AgentSwarms" name and the hosted service remain with the project author.

## Features

|                              |                                                                                                                                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 🤖 **Agent Playground**      | Build an agent, wire up tools, and chat with it in-browser, with full request/response traces.                                                                                                          |
| 🐝 **Swarm canvas**          | Design multi-agent workflows visually (built on [XYFlow](https://xyflow.com)) and execute them end-to-end.                                                                                              |
| 📚 **Knowledge Base / RAG**  | Upload documents, chunk and embed them (pgvector), and ground agents in your own data.                                                                                                                  |
| 🏢 **Data warehouses & databases** | Connect **PostgreSQL** (Supabase, RDS, Neon…), **MySQL/MariaDB**, Amazon Redshift, Snowflake, Databricks, Google BigQuery, or Azure Synapse (encrypted credentials, read-only). Query them from the Data & SQL page, from SQL agents, and feed BI charts, ontologies and scheduled refreshes. |
| 🔑 **Secrets Manager**       | Store credentials once (encrypted, write-only) and reference them anywhere as `{{secret:NAME}}` — warehouse connections, provider keys. Superadmins share secrets with users/groups via IAM.            |
| 🗂️ **Data Catalog**          | Connect warehouses or S3-compatible buckets (AWS S3, Google Cloud Storage, Cloudflare R2, MinIO, Spaces, B2) through a wizard; the crawler lists every table and object, groups partitioned folders into datasets, infers CSV/JSON schemas by sampling, profiles columns (null %, distinct counts, ranges), estimates row counts, and flags likely-PII columns. Schedule daily/weekly incremental crawls with schema-drift notifications, generate asset + column documentation with AI, certify or deprecate assets with owners and tags, trace lineage and usage (which dashboards, prep flows and metrics consume each table), define a business glossary, and jump straight into the SQL workbench. |
| 📊 **Business Intelligence** | A BI Workspace with drag-and-drop dashboards: build charts from local datasets or connected warehouses, generate visuals with the AI analyst, then publish with a public link or share with IAM groups. Enterprise depth included: click-to-cross-filter and drill-down on every chart type (incl. maps, treemaps, heatmaps), drill-through to underlying rows, locale/currency number formatting, dashboard filters with date presets and pinned defaults, expandable matrix (pivot) with subtotals, version history with restore, scheduled refreshes with email reports and "what changed" insight digests, data alerts (in-app + email), row-level security on shared dashboards, usage analytics, and a mobile-stacked layout. |
| 🔍 **Observability**         | Inspect every tool call, token, and cost in a full execution trace.                                                                                                                                     |
| 🔌 **BYOK + MCP + A2A**      | Encrypted per-user provider keys, MCP server connections, swarm export to LangGraph/CrewAI/OpenAI SDK/Strands, and an A2A endpoint.                                                                     |
| 🛂 **IAM**                   | Superadmins, groups, invite/manual user provisioning, per-user/group model allow-lists, read-only sharing of KBs and data tables, invite-only mode.                                                     |
| 🧭 **Guided curriculum**     | Five tracks — Foundations, Patterns & Tools, SQL Agents, Multi-Agent Swarms, Scaling & Enterprise — each chapter pairs a concept with something you actually run.                                       |
| 📓 **Python Lab**            | Your own in-browser Python notebooks (Pyodide) — experiment with code and frameworks, with a built-in helper for calling your connected models.                                                         |
| 🛡️ **Guardrails & evals**    | Prompt-injection tests, PII redaction, LLM-as-judge scoring — hands-on, not hypothetical.                                                                                                               |
| 🎓 **Certification**         | Pass the exam, get a verifiable certificate and badge.                                                                                                                                                  |

<div align="center">
  <img src="public/sample-badge-current.png" alt="AgentSwarms Certified Agentic AI Practitioner badge" width="220" />
  <br />
  <sub>Every learner who passes the certification exam earns a verifiable badge like this one.</sub>
</div>


## Quickstart

There is no separate backend to install — **Supabase _is_ the backend**
(Postgres + Auth + Storage), and you run it as a free-tier hosted project
rather than installing anything yourself:

```bash
git clone <your-fork-or-repo-url> agentswarms
cd agentswarms
npm install
cp .env.example .env   # fill in your Supabase + provider keys
# apply the database schema once: npx supabase login && npx supabase link && npx supabase db push
npm run dev            # → http://localhost:8080
```

Self-host with Docker (any Node-capable host — VPS, Fly, Railway, Render, K8s):

```bash
cp .env.example .env   # fill in Supabase + keys, apply migrations once
docker compose up --build
# → http://localhost:8080
```

First time? Follow **[the full installation guide](./docs/INSTALL.md)** — it
covers every step on macOS, Linux, and Windows, including the Supabase
dashboard clicks and a troubleshooting section for the errors people
actually hit.

## Documentation

The docs live in [`docs/`](./docs), one focused guide per topic:

| Guide | What it covers |
| --- | --- |
| **[Installation](./docs/INSTALL.md)** | Complete local setup on macOS / Linux / Windows: prerequisites, Supabase project, environment variables, first run, and troubleshooting. |
| **[Production deployment](./docs/DEPLOYMENT.md)** | Docker (recommended), Cloudflare Workers, and bare Node. |
| **[Business Intelligence](./docs/BUSINESS_INTELLIGENCE.md)** | Dashboards and the AI analyst: 19 visual types incl. the AI-built ontology, drill-down & forecasting, scheduled refresh + data alerts, AI-generated dashboards, publishing / embedding / export, data prep, and warehouse connectors. |
| **[Access control (IAM) & SSO](./docs/IAM.md)** | Superadmins, groups, user provisioning, model allow-lists, read-only resource sharing, invite-only mode, and SAML SSO. |
| **[Architecture](./docs/ARCHITECTURE.md)** | Tech stack and project structure. |

## Contributing

Contributions are welcome — see **[CONTRIBUTING.md](./CONTRIBUTING.md)** for
the workflow, and please read the **[Code of Conduct](./CODE_OF_CONDUCT.md)**
first.

## Security

Found a vulnerability? Please see **[SECURITY.md](./SECURITY.md)** for how
to report it responsibly instead of opening a public issue.

## License & acknowledgements

Released under the **[MIT License](./LICENSE)**. Every direct dependency
uses a permissive license (MIT / Apache-2.0 / ISC / BSD) — the full audit
and credits for the open-source projects AgentSwarms builds on live in
**[ACKNOWLEDGEMENTS.md](./ACKNOWLEDGEMENTS.md)**.

---

<div align="center">
  <sub>Built with TanStack Start, Supabase, and a genuine dislike of theory-only AI courses.</sub>
</div>
