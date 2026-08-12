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
  its dimensions and metrics. Optionally declares its **primary key** (the
  column that identifies one source row — the model's grain), which Validate
  measures for uniqueness.
- **Dimension** — a column or SQL expression you group by (e.g. `region`,
  `DATE_TRUNC('month', created_at)`).
- **Metric** — an aggregation over a column: `sum`, `avg`, `count`,
  `count_distinct`, `min`, `max`, or a `custom` expression. Metrics can carry
  filters (a _filtered measure_, e.g. revenue where `status = 'paid'`) and a
  display format.
- **Join** — up to 8 LEFT/INNER joins from the source across a star schema,
  each with a declared **cardinality** (see _Join safety_ below).
- **Assertion** — a pinned metric value under absolute filters that Validate
  re-computes, so a definition edit that moves a signed-off number fails
  loudly.

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

## Join safety — declared cardinality, refused fan-out

A join's **cardinality** declares how many joined rows one source row matches,
source → joined:

| cardinality                    | meaning                       | effect                                      |
| ------------------------------ | ----------------------------- | ------------------------------------------- |
| `many_to_one` / `one_to_one`   | lookup (orders → customers)   | safe, compiles as always                    |
| `one_to_many` / `many_to_many` | **fans out** (orders → items) | duplicate-sensitive metrics are **refused** |

A fanning join repeats each source row per match, so `SUM`/`AVG`/`COUNT` over
source-side columns silently inflates — measured: orders A (100) + B (50)
joined to A's three line items returns `SUM(orders.amount) = 350` against a
truth of 150. With the cardinality declared, that query **cannot compile**:

- `sum`/`avg` must reference the fanning table's columns only (qualify them,
  e.g. `order_items.qty`); anything touching a repeated table is refused with
  the reason and the fix.
- Plain `count` is refused (it counts joined rows); use `count_distinct` over
  the primary key, or a filtered count over the fanning table's columns.
- `count_distinct`, `min`, `max` are duplicate-insensitive and always pass.
- `custom` stays the documented owner-trusted escape hatch (e.g. an expression
  that pre-aggregates); `derived` metrics are checked at their leaves.
- **Two** fanning joins multiply each other (the chasm trap), so
  duplicate-sensitive metrics are refused outright there.

Models saved before cardinality existed keep compiling unchanged — breaking
every existing model on upgrade was not an option. They are protected by
measurement instead:

## Validate measures — it does not trust

**Validate** always ran every field against the real backend. It now also:

- **Measures each join's real cardinality** — COUNT the source, re-COUNT after
  each join cumulatively. An undeclared join that fans out in the data, or a
  declared lookup that actually multiplies rows, is reported with the real
  counts. With a primary key declared, the probe also counts DISTINCT keys,
  which catches fan-out an INNER join's dropped rows would hide from a bare
  row count.
- **Checks the primary key is unique** (`COUNT(*)` vs `COUNT(DISTINCT pk)`).
- **Re-computes every assertion**: a pinned `{metric, filters, expected,
tolerance?}` fails when the number moved — the difference between "the SQL
  still runs" and "revenue still means what the board was told". Assertion
  filters must be absolute; relative windows (`ytd`, `last_month`…) are
  refused because the pin would go stale by itself. The editor's **Pin current
  value** records what the model computes today — confirm it against a trusted
  reference before relying on it.

The default assertion tolerance is |expected| × 1e-9 — wide enough for
float-sum noise between engines, orders of magnitude too small to hide a
definition change.

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

### Fiscal calendars

A model can declare the month its **fiscal year starts**
(`fiscal_year_start_month`, Source tab). That unlocks:

- two extra grains — `fiscal_year` and `fiscal_quarter`;
- five extra windows — `this_fiscal_year`, `last_fiscal_year`,
  `this_fiscal_quarter`, `last_fiscal_quarter` and `fiscal_ytd`.

A fiscal year is **named by the calendar year it ends in** — with a July start,
July 2025 opens FY 2026. Fiscal buckets come back as sortable **numbers**
(`2026` for a year, `20261` for FY2026 Q1) so they order correctly in every
engine and chart with zero per-dialect date formatting. Implementation: the
compiler shifts the date **forward** by the months remaining to the next
fiscal-year boundary, then reads the calendar year/quarter of the shifted date
(`(13 - startMonth) % 12` months, reusing the per-dialect date arithmetic).

With no fiscal start configured (or January), the fiscal vocabulary still works
and equals its calendar counterparts — pinned by a differential test. Fiscal
_windows_ compile to literal date ranges and run everywhere; fiscal _grains_
need date arithmetic in SQL and therefore **refuse on `LOCAL_ENGINE=alasql`**
rather than bucketing into the wrong year.

### Parameters — governed what-ifs

A model can declare **parameters** its dimension/metric SQL references as
`{{name}}` tokens:

```sql
-- metric big_sales, parameter {{min_amount}} (number, default 100)
SUM(CASE WHEN amount >= {{min_amount}} THEN amount ELSE 0 END)
```

Callers (the runner, `metric_query` agents via `"params": {...}`, dashboards)
may override per query; otherwise the declared default applies. The rules, each
of which is a refusal rather than a degradation:

- **Every parameter must carry a default.** Validate, assertions and scheduled
  refreshes compile with no caller present; a parameter that breaks every
  unattended compile is a footgun, not a feature. (Scheduled widget refreshes
  deliberately re-run with defaults.)
- Values substitute as **literals** — numbers must be finite, strings are
  escaped exactly like filter values — so a parameter can never inject SQL.
- A query setting an **undeclared parameter** is refused with the declared
  list; a fragment referencing an undeclared `{{token}}` is refused at compile.
- **Join `ON` conditions cannot use parameters** — a parameterised join would
  change the query graph per caller, and every cardinality declaration,
  fan-out refusal and measured probe would be describing a different query.

### Hierarchies — declared drill paths

A **hierarchy** is an ordered drill path over existing dimensions, declared
once on the model:

```json
{ "name": "geo", "levels": ["region", "subregion", "city"] }
```

Agents see it in the catalog (`hierarchy geo: region → subregion → city`), so
"break that down" has a governed next level instead of a guess. Levels must
name real dimensions (2–6, broadest first); an unknown or repeated level is
refused at save with the list of what exists.

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
`yoy` one year, whatever the grain. The fiscal grains compare like their
calendar shapes — one `fiscal_quarter` back is three months, one `fiscal_year`
back is twelve — and because fiscal quarters are month-aligned, the shifted
dates land in exactly the previous fiscal bucket, including across the fiscal
year boundary.

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

The lead metric's **display format rides onto the widget**: a metric declared
`format: currency` with a `currency` code (ISO 4217) charts as `€1.2M`, not a
bare number, on KPI, pie, bar, line and area tiles alike. Scheduled refreshes
of a parameterised model re-run with the declared **defaults** — a widget is an
unattended caller, which is exactly why defaults are required.

## What the agent actually sees

The catalog injected into `metric_query`'s description carries, per field:

- the **description** the owner wrote ("excludes refunds and internal test
  orders") — authored knowledge used to be discarded here;
- each metric's **governed formula** (`revenue = SUM(amount)`), the same
  rendering the BI analyst gets, so a sum is never mistaken for an average;
- **synonyms** (`aka: turnover, GMV`) — and `metric_query` also **resolves**
  them server-side: a query for "turnover" maps to `revenue` with a disclosed
  note; an ambiguous synonym refuses rather than guessing;
- **sampled values** for low-cardinality categorical dimensions
  (`values: AMER|APAC|EMEA`), measured by Validate from the live source — the
  difference between the agent filtering `region = "EMEA"` and guessing
  `region = "Europe"` into silent zero rows. A dimension with more than 8
  distinct values gets _no_ list: a partial list would read as complete;
- certification markers and share-restriction notes (see above).

Unknown names refuse **listing what exists**, and results are honest about
size: the tool fetches one row past its 50-row cap and, when more exist, says
_"first 50 row(s) of a LARGER result"_ with instructions to narrow — never a
bare "50 row(s)" over a partial list.

The BI analyst's prompt gets the same treatment: governed definitions now
include **warehouse-backed models** (previously silently excluded), metric
descriptions, and every truncation cap discloses what it dropped.

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

## Sharing — with row-level security and field masks

A superadmin can share a model read-only with a user or group under
**Admin → IAM → Access** (grant type **Semantic model**). Grantees see it in
Semantic Layer (marked **Shared**, read-only) and their agents can query it via
`metric_query`. A shared metric **runs against the owner's data** — the metric
is the access boundary, so a grantee gets governed numbers without needing
access to the underlying tables/warehouse.

The grant can carry restrictions, and they are **enforced inside the compiled
SQL**, at the single choke point every consumer flows through (`metric_query`,
the query runner, BI widget refresh):

- **Row filter** — `dimension ∈ values` (e.g. `region ∈ [EMEA]`). The filter
  names a **dimension**, not a raw column, and compiles into the governed
  query as an IN-filter, so it works identically on the local engine and every
  warehouse dialect. If the grant names a dimension the model no longer has,
  the query **fails closed** with a message pointing at the grant — "filter
  didn't apply" never degrades to "grantee saw everything".
- **Field mask** — metric/dimension names the grantee may not use. Masked
  fields are refused at query time AND hidden from the grantee's catalog,
  editor and agent prompt, so no surface offers a name the query path would
  refuse.

Multiple grants merge with the same permissive-union semantics as BI dashboard
shares (an unrestricted grant wins; masks intersect) — literally the same
functions, not a copy. **Disclosure is part of the enforcement**: the grantee's
editor shows a banner describing their scope, the runner labels results
"restricted share", and the agent's tool result carries a note telling it to
say so when reporting — a scoped number must never pass for the global truth.

## Certification

A model is `draft`, `certified` or `deprecated`:

- **Certify** re-runs the full validation pipeline (field probes, join
  measurement, grain uniqueness, assertions) against the live backend and
  **refuses if anything fails** — then stamps who certified and when. The badge
  is a measured claim, never an opinion.
- **Editing a certified model's definition drops it back to draft** — enforced
  by a database trigger, so no write path can carry a stale certificate
  forward. Label/description edits keep it; anything that changes what the
  model computes does not.
- Agents see the state in the catalog (`[certified]`,
  `[DEPRECATED — prefer another model]`), so they weight governed answers
  accordingly.

## Version history and restore

Every change to a saved model snapshots the **previous** definition — written
by a database trigger (no save path can skip it), owner-readable under RLS,
capped at the newest 50 per model. The editor's **History & usage** tab shows
each version with a field-level diff against the current definition (metrics
added/removed/changed, join cardinality changes, grain changes…) and a
**Restore** button. A restore is a normal owner write, so the pre-restore state
is snapshotted too — restore is always undoable. Restored definitions pass
back through the same zod validation as a fresh save.

## Dependents

The same tab lists everything that would move if the model changed: dashboards
with metric-backed widgets (by widget title), agents and swarm nodes whose
`metric_query` allow-list names it, and (owner only) who it is shared with.
Deleting a model warns with that list first.

## Not yet (roadmap)

- **Aggregate awareness** — routing a month-grain query to a pre-aggregated
  rollup table instead of the raw fact. Deliberately deferred: it is a
  _performance_ optimisation that silently changes which table answered, and
  the correctness half of this layer (fan-out refusal, measured grain,
  assertions) had to be trustworthy first. When it lands it will be declared
  per model (fact ↔ rollup + match conditions) and **disclosed in the compiled
  SQL**, never inferred.
- **Multiple comparison axes** — a query compares along exactly one grained time
  dimension. Two would have no single "previous period", so the compiler refuses
  rather than choosing one.
- A native metric option **inside the BI visual builder** (today you author +
  run here and Add to dashboard; the builder's own source picker is next).
- **Chasm resolution** — two fanning joins are refused rather than resolved by
  aggregating each fact separately and joining the results.
- **Per-widget parameter overrides** — a dashboard widget built from a
  parameterised model refreshes with the declared defaults today; pinning an
  override onto a specific widget is a follow-up.
