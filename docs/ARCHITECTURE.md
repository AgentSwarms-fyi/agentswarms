# Architecture

> Part of the [AgentSwarms docs](../README.md#documentation).

See also **[Scale and limits](./SCALE_AND_LIMITS.md)** for where each module's
work executes (warehouse pushdown vs. local DuckDB) and every row, timeout and
concurrency cap.

This page is the map. **[The engineering behind AgentSwarms](./engineering/README.md)**
is the territory: how a request acquires an identity, how the agent and swarm
runtimes actually execute, the three sandboxes and the threat model each answers,
and the conventions that keep all of it from drifting.

## Tech stack

| Layer        | Tech                                                                                                                                                                                                |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Framework    | [TanStack Start](https://tanstack.com/start) (React 19), file-based routing via TanStack Router                                                                                                     |
| Backend      | [Supabase](https://supabase.com) — Postgres, Auth, Storage, pgvector                                                                                                                                |
| Styling      | [Tailwind CSS](https://tailwindcss.com) + [shadcn/ui](https://ui.shadcn.com)                                                                                                                        |
| Agents       | [LangChain](https://js.langchain.com) / LangGraph                                                                                                                                                   |
| Swarm canvas | [XYFlow](https://xyflow.com)                                                                                                                                                                        |
| BI & SQL     | Custom SVG chart renderers · in-browser SQL via [DuckDB-WASM](https://duckdb.org/docs/api/wasm/overview) (AlaSQL remains an opt-out escape hatch, `LOCAL_ENGINE=alasql`)                            |
| Documents    | Client-side [pptxgenjs](https://gitbrent.github.io/PptxGenJS/) · [docx](https://docx.js.org) · [write-excel-file](https://gitlab.com/catamphetamine/write-excel-file)                               |
| Notebooks    | Python on sandboxed server kernels (Docker or Kubernetes) — see [DEVELOPER_WORKSPACE_RUNTIME.md](./DEVELOPER_WORKSPACE_RUNTIME.md)                                                                  |
| Custom code  | Function / component nodes: a browser Worker on the canvas, and an isolated container for deployed runs — see [DEPLOYMENT.md § JS sandbox](./DEPLOYMENT.md#js-sandbox-custom-code-in-deployed-runs) |
| Deployment   | Docker (Node) · Kubernetes · installable PWA                                                                                                                                                        |

## Project structure

```
agentswarms/
├── src/
│   ├── routes/       # pages and API routes (file-based routing)
│   ├── components/   # UI, organized by feature (agents, swarms, playground, bi, ...)
│   ├── lib/          # agent/swarm export, BI/charts, docGen, sample data
│   └── utils/        # server-side utilities (providers, tools, warehouse, catalog, iam, observability)
└── supabase/
    └── migrations/   # the full database schema, as SQL migrations
```

**Extension seams worth knowing:**

- **Warehouse connectors** — `src/utils/warehouse/drivers.server.ts` exposes
  `executeWarehouseQuery` / `listWarehouseTables` / `testWarehouseConnection`,
  switching on `config.provider`. Everything downstream (Data Catalog, BI Direct
  Query, semantic executor, SQL agents) goes through these, so adding a database
  means adding one driver + a `WarehouseProvider` union member + a zod
  `ConfigSchema` entry. See [Data sources & connectors](./DATA_SOURCES.md).
- **Charts** — `ChartSpec` + the renderers under `src/components/bi/` drive
  every visual type.
- **Document generation** — `src/lib/docGen/` (typed plans → client-side
  builders). See [Agent Chat & document generation](./AGENT_CHAT.md).
- **Custom code** — user-authored JavaScript (Function nodes, custom
  components) runs in one of two sandboxes with a shared contract:
  `src/lib/sandbox/jsSandbox.ts` (a browser Worker, used by the canvas) and
  `services/js-sandbox/` (a separate hardened container, used by deployed and
  scheduled runs). Neither ever executes in the app process, which holds the
  service-role key. `tests/unit/sandboxParity.test.ts` pins the two to the same
  contract so a component behaves identically wherever it runs.
