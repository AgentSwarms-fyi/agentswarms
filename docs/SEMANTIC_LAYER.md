# Semantic Layer

> Part of the [AgentSwarms docs](../README.md#documentation).

A **semantic layer** turns raw tables into governed business concepts —
**metrics** (what you measure) and **dimensions** (how you slice) — defined once
and consumed the same way by the BI engine and your AI agents. So
"revenue" always computes the same way, and an AI answering _"why are European
sales down?"_ picks a metric **name** rather than inventing SQL.

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
  filters (a _filtered measure_, e.g. revenue where `status = 'paid'`) and a
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
{
  "model": "orders",
  "metrics": ["revenue"],
  "dimensions": ["region"],
  "filters": [{ "field": "region", "op": "in", "value": ["EU", "US"] }]
}
```

The compiler (`src/lib/semanticLayer.ts`) turns that into a single read-only
`SELECT`. **Security:** the only SQL that reaches the database is the model's own
authored fragments; field names are validated against the model and filter
values are literal-escaped, so a query can never inject SQL.

### Relative date filters

Prefer these over hard-coded dates — they resolve against today every time the
query runs, so a dashboard does not need editing as time passes.

| op                              | window                                             |
| ------------------------------- | -------------------------------------------------- |
| `last_n_days`                   | the last N days, **today included** (`value` is N) |
| `this_month` / `last_month`     | the calendar month                                 |
| `this_quarter` / `last_quarter` | the calendar quarter                               |
| `ytd`                           | 1 January **to today**                             |

```json
{ "field": "order_date", "op": "last_n_days", "value": 30 }
```

They apply only to a **time** dimension, and compare the raw date rather than a
rollup bucket — so "last 30 days" grouped by month still means 30 days. Windows
are **half-open** (`>= start AND < end`), which keeps a timestamp late on the
final day inside the window, and are computed in **UTC** so the same dashboard
answers identically wherever it is deployed. The runner shows the resolved
dates beside the filter.

### Period-over-period

Set `compare` to `yoy`, `mom` or `prior_period` and each metric gains three
columns: `<metric>_prev`, `<metric>_change` and `<metric>_pct_change` (a
fraction — `0.25` is +25%).

```json
{
  "model": "orders",
  "metrics": ["revenue"],
  "dimensions": ["order_date"],
  "grains": { "order_date": "month" },
  "compare": "yoy"
}
```

Requires **exactly one time dimension with a grain** — that is the axis being
compared. `prior_period` steps back one unit of that grain; `mom` one month and
`yoy` one year, whatever the grain.

Worth knowing:

- A period with **no predecessor** (the first in the series, or a gap in the
  data) gets NULL rather than being dropped from the result.
- `pct_change` is **NULL when the earlier value was zero** — a change from
  nothing is not a percentage.
- Any date filter you set **moves with the comparison**, so filtering to this
  year still compares against last year rather than against nothing.
- It compiles to a date-shifted self-join, not `LAG`, so a gap in the series
  cannot line a period up against the wrong predecessor.
- **Not available on the AlaSQL escape hatch** (`LOCAL_ENGINE=alasql`), which
  has neither CTEs nor date arithmetic. The compiler refuses with that message
  rather than emitting SQL that cannot run.

## On a dashboard

From the query runner, **Add to dashboard** creates a metric-backed widget in a
BI project. Unlike a raw-SQL widget, its source is the metric query — so on
every scheduled refresh it **re-runs against the current metric definition**.
Change what "revenue" means once, and every metric-backed widget updates.

## AI agents: the `metric_query` tool

Enable **Semantic Metrics** on an agent (Agent Builder → Tools), **then pick
which models it may read**. The agent calls `metric_query` with a structured
query instead of writing SQL — governed by the same IAM model rules, budgets and
Traces as every other model call, and owner-scoped so it only ever reads data
the account may access.

**The picker is deny-by-default: an agent with no models selected does not get
the tool at all.** Two reasons:

- **Least privilege.** A marketing agent has no business reading the finance
  metrics that live in the same account.
- **Cost and accuracy.** The catalog — every selected model's dimensions and
  metrics — goes into the system prompt on _every_ call. Selecting the two
  models an agent actually needs makes it cheaper per turn and leaves the model
  fewer wrong names to choose between.

The allow-list applies on top of access, never instead of it: naming a model
cannot grant access to one the owner could not already read. It is enforced
when the tool runs, not just in what gets advertised — an agent that asks for a
model it was not given is refused.

> **Upgrading:** agents that had this tool enabled before the picker existed
> read every model in the account. They now read none until you select models
> on each one.

**Swarm agent nodes** get the same tool and the same picker, in the node
inspector's Tools section. A swarm runs headless — under the service role, with
no user JWT — so the tool still resolves the swarm owner's own and IAM-shared
models via `scopeUserId`, never another tenant's, and the node's allow-list
narrows it from there.

## Execution backends

- **Local datasets** run through the in-app **DuckDB** engine. Setting
  `LOCAL_ENGINE=alasql` opts out to a JS interpreter that has no CTEs, window
  functions or date arithmetic — period-over-period is unavailable there.
- **Warehouse models** compile with the connection's dialect and run through the
  existing warehouse drivers (Snowflake, BigQuery, Redshift, Postgres, …).

Write dimension/metric SQL for the model's own backend — the compiler only
composes SELECT/GROUP BY/WHERE/HAVING and quotes identifiers per dialect. It
does re-quote authored identifiers for the target dialect, so a model authored
against a local dataset is not locked to one engine.

## Sharing

A superadmin can share a model read-only with a user or group under
**Admin → IAM → Access** (grant type **Semantic model**). Grantees see it in
Semantic Layer (marked **Shared**, read-only) and their agents can query it via
`metric_query`. A shared metric **runs against the owner's data** — the metric
is the access boundary, so a grantee gets the owner's numbers without needing
access to the underlying tables/warehouse.

## Not yet (roadmap)

- **Multiple comparison axes** — a query compares along exactly one grained time
  dimension. Two would have no single "previous period", so the compiler refuses
  rather than choosing one.
- Authoring **warehouse-sourced** models from the UI (the engine already runs
  them; the editor's source picker is local-dataset only for now).
- A native metric option **inside the BI visual builder** (today you author +
  run here and Add to dashboard; the builder's own source picker is next).
