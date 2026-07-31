# Architecture

> Part of the [AgentSwarms docs](../README.md#documentation).

## Tech stack

| Layer        | Tech                                                                                            |
| ------------ | ----------------------------------------------------------------------------------------------- |
| Framework    | [TanStack Start](https://tanstack.com/start) (React 19), file-based routing via TanStack Router |
| Backend      | [Supabase](https://supabase.com) — Postgres, Auth, Storage, pgvector                            |
| Styling      | [Tailwind CSS](https://tailwindcss.com) + [shadcn/ui](https://ui.shadcn.com)                    |
| Agents       | [LangChain](https://js.langchain.com) / LangGraph                                               |
| Swarm canvas | [XYFlow](https://xyflow.com)                                                                    |
| BI & SQL     | Custom SVG chart renderers · in-browser SQL via [AlaSQL](https://github.com/AlaSQL/alasql)      |
| Documents    | Client-side [pptxgenjs](https://gitbrent.github.io/PptxGenJS/) · [docx](https://docx.js.org) · [write-excel-file](https://gitlab.com/catamphetamine/write-excel-file) |
| Notebooks    | In-browser Python via [Pyodide](https://pyodide.org) (+ optional server runtime)               |
| Deployment   | Docker (Node) · Kubernetes · installable PWA                                                     |


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

