# Semantic Layer

> Part of the [AgentSwarms docs](../README.md#documentation).

A **semantic layer** turns raw tables into governed business concepts —
**metrics** (what you measure) and **dimensions** (how you slice) — defined once
and consumed the same way by the BI engine and your AI agents. So
"revenue" always computes the same way, and an AI answering *"why are European
sales down?"* picks a metric **name** rather than inventing SQL.

## Why it matters

Natural-language-over-data is only trustworthy if the definitions are governed.
Without a semantic layer, an LLM writes fresh SQL each time and "revenue" might
mean gross one query and net the next. With it, the model chooses from a curated
catalog and the platform compiles the exact, consistent SQL.

## Concepts

- **Semantic model** — binds a source (a local dataset or a warehouse table) to
  its dimensions and metrics.
- **Dimension** — a column or SQL expression you group by (e.g. `region`,
  `DATE_TRUNC('month', created_at)`).
- **Metric** — an aggregation over a column: `sum`, `avg`, `count`,
  `count_distinct`, `min`, `max`, or a `custom` expression. Metrics can carry
  filters (a *filtered measure*, e.g. revenue where `status = 'paid'`) and a
  display format.

Every field has a stable **name** (`[a-zA-Z_][a-zA-Z0-9_]*`) used as the query
handle and SQL alias, plus an optional label/description for humans and the AI.

## Defining models

Open **Semantic Layer** in the sidebar:

1. **New model** → give it a name, pick a source dataset (its columns appear as
   chips to help authoring).
2. **Generate with AI** proposes dimensions + metrics from the dataset's columns
   (governed by your IAM model rules, like every AI call) — or add them by hand
   with **+ from column** and refine the SQL/aggregation.
3. **Save**, then use the **Query runner** to pick metrics + dimensions and see
   the rows and the compiled SQL.

## Querying — structured, not raw SQL

A query references fields by name:

```json
{ "model": "orders", "metrics": ["revenue"], "dimensions": ["region"],
  "filters": [{ "field": "region", "op": "in", "value": ["EU", "US"] }] }
```

The compiler (`src/lib/semanticLayer.ts`) turns that into a single read-only
`SELECT`. **Security:** the only SQL that reaches the database is the model's own
authored fragments; field names are validated against the model and filter
values are literal-escaped, so a query can never inject SQL.

## On a dashboard

From the query runner, **Add to dashboard** creates a metric-backed widget in a
BI project. Unlike a raw-SQL widget, its source is the metric query — so on
every scheduled refresh it **re-runs against the current metric definition**.
Change what "revenue" means once, and every metric-backed widget updates.

## AI agents: the `metric_query` tool

Enable **Semantic Metrics** on an agent (Agent Builder → Tools). The agent then
sees the semantic catalog and calls `metric_query` with a structured query
instead of writing SQL — governed by the same IAM model rules, budgets, and
Traces as every other model call, and owner-scoped so it only ever reads data
the account may access.

## Execution backends

- **Local datasets** run through the in-app AlaSQL engine.
- **Warehouse models** compile with the connection's dialect and run through the
  existing warehouse drivers (Snowflake, BigQuery, Redshift, Postgres, …).

Write dimension/metric SQL for the model's own backend (e.g. `DATE_TRUNC` on a
warehouse; AlaSQL-compatible expressions on a local dataset) — the compiler only
composes SELECT/GROUP BY/WHERE/HAVING and quotes identifiers per dialect.

## Sharing

A superadmin can share a model read-only with a user or group under
**Admin → IAM → Access** (grant type **Semantic model**). Grantees see it in
Semantic Layer (marked **Shared**, read-only) and their agents can query it via
`metric_query`. A shared metric **runs against the owner's data** — the metric
is the access boundary, so a grantee gets the owner's numbers without needing
access to the underlying tables/warehouse.

## Not yet (roadmap)

- Authoring **warehouse-sourced** models from the UI (the engine already runs
  them; the editor's source picker is local-dataset only for now).
- A native metric option **inside the BI visual builder** (today you author +
  run here and Add to dashboard; the builder's own source picker is next).
