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
| Deployment   | Docker (Node) — primary · Cloudflare Workers — secondary                                        |


## Project structure

```
agentswarms/
├── src/
│   ├── routes/       # pages and API routes (file-based routing)
│   ├── components/   # UI, organized by feature (agents, swarms, playground, ...)
│   ├── lib/          # curriculum content, agent/swarm export logic, sample data
│   └── utils/        # server-side utilities (providers, tools, memory, observability)
└── supabase/
    └── migrations/   # the full database schema, as SQL migrations
```

