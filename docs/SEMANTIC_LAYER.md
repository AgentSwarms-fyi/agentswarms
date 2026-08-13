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

## Join safety — declared cardinality, resolved fan-out

A join's **cardinality** declares how many joined rows one source row matches,
source → joined:

| cardinality                    | meaning                       | effect                                     |
| ------------------------------ | ----------------------------- | ------------------------------------------ |
| `many_to_one` / `one_to_one`   | lookup (orders → customers)   | safe, compiles as always                   |
| `one_to_many` / `many_to_many` | **fans out** (orders → items) | duplicate-sensitive metrics get a **plan** |

A fanning join repeats each source row per match, so `SUM`/`AVG`/`COUNT` over
source-side columns silently inflates — measured: orders A (100) + B (50)
joined to A's three line items returns `SUM(orders.amount) = 350` against a
truth of 150. With the cardinality declared, the compiler emits a
**multi-fact plan** instead of that wrong number: each metric aggregates in
its own **branch** — the source plus only the fanning join its columns
reference — at the requested dimension grain, and the branch aggregates are
stitched on a dimension **spine** with NULL-safe joins. The same query now
returns 150, and `SUM(order_items.qty)` beside it returns the line-item
truth, in one result. This is the classic **chasm** schema (orders → items,
orders → shipments) handled the way Tableau's relationships handle it:
per-fact aggregation, never a refusal — where the plan can be proven.

The rules, per metric:

- `sum`/`avg` reading **one** fanning table → that table's branch, at that
  fact's grain (a mixed `items.qty * orders.amount` evaluates once per item,
  with the order's amount as an attribute — standard related-table
  semantics).
- `sum`/`avg` reading only source/lookup columns → the base branch, which
  never sees a fanning join.
- A group missing from one fact shows **NULL** for that fact's metrics — the
  same honesty rule period-over-period uses for a missing period.
- `count_distinct`, `min`, `max` are duplicate-insensitive; they keep their
  full single-pass scope so resolution never changes an already-legal metric.
  `custom` stays the owner-trusted escape hatch, same scope; `derived`
  formulas compute over their leaves' branch columns.
- **Period-over-period composes with the plan.** The comparison builds the
  whole multi-fact plan twice — current and shifted — as flat CTEs under one
  `WITH` (Synapse rejects nested `WITH`), stitches them NULL-safe on the
  dimensions, and projects the same `_prev`/`_change`/`_pct_change` columns
  as a single-pass comparison. Same contract: exactly one grained time axis,
  NULL where a period has no predecessor.
- **Dimensions from a fanning table** group base metrics via **primary-key
  deduplication** when the model declares a primary key: the base branch
  reduces to one row per source row per distinct dimension combination
  (`SELECT DISTINCT` over dims + key + values), then aggregates — each order
  counts once per line-item bucket it relates to, Tableau's related-table
  attribution. The spine and base branch carry that one fanning join;
  filtered measures keep their filters as carried flags.
- **An INNER fanning join resolves by EXISTS-scoping.** INNER does two things
  at once: it multiplies (each source row repeats per match) and it
  **filters** (a source row with no match vanishes). The plan keeps the
  filter and contains the multiplication — the branch that reads the fanning
  table keeps the real INNER join; every other branch, and the dimension
  spine, gets a correlated `EXISTS (SELECT 1 FROM items WHERE …on…)`
  instead. Measured: an itemless order's solo region never
  appears on the spine (no ghost groups), and its shipment weight drops out
  of the shipment branch — the INNER scope holds everywhere, and nothing
  double-counts. Composes with deduplication and period-over-period.

**What still refuses** — everything the plan cannot prove, with the original
error plus the reason resolution did not apply:

- an **unqualified** `sum`/`avg` (`amount` with no table prefix) — a branch
  would silently choose which table it binds to; qualify it.
- a plain `count` — "count of what" has no provable answer on a fanned model;
  use `count_distinct` over the key or a filtered count.
- a metric reading **two** fanning tables — no single grain to aggregate at;
  split it and combine with a derived metric.
- dimensions from **two different** fanning tables — no shared row identity
  to deduplicate on.
- a fanning-table dimension **without a declared primary key** — nothing to
  deduplicate by; declare the key (Source tab).
- under deduplication, a duplicate-sensitive metric reading a **different**
  fact than the dimensions — its rows have no key under that grouping; split
  the query or add a dimension from that fact.
- a lookup **chained through** a fanning join, and the AlaSQL escape hatch
  (no CTEs).

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

### Fiscal calendar TABLES — 4-4-5 and friends

Calendars month arithmetic cannot express — retail **4-4-5**, 13-period,
ISO-week years — are DATA, not a formula: neighbouring periods have different
lengths, so "previous period" is not a fixed interval. A model declares a
**fiscal calendar table** instead of a start month (Source tab): one row per
day, and per grain a **sequence column** (a dense integer stepping by one per
period, across year boundaries) and the period's **start-date column**:

```
calendar: { table, dateColumn, grains: { fiscal_period: { seq, start }, … } }
```

That unlocks two further grains — `fiscal_period` and `fiscal_week` — and two
further windows — `this_fiscal_period` and `last_fiscal_period`; the
year/quarter vocabulary resolves against the table too, so a 53-week year is
honoured exactly. Buckets come back as the period's **start date**; the
windows compile to `day IN (SELECT day FROM calendar WHERE seq = today's)`,
so the window is exactly the days the calendar assigns — a `now` outside the
calendar yields an honest empty result, and Validate warns about the coverage.

**Comparisons step the sequence, not an interval.** The compiler joins the
calendar per day (a _grouped_ derived table — one row per day by construction,
so a dirty calendar can mislabel days but can NEVER multiply fact rows), and
the prior side of a comparison additionally joins the DISTINCT (seq, start)
period list `n` periods ahead — each prior row buckets into its successor's
start date, the existing equality stitch works untouched, and no window
functions are needed (Synapse compiles this). A 4-day period compares against
its 5-day predecessor, across the year boundary, exactly. Because relative
windows read the raw date column (which a sequence step cannot shift), the
prior side **skips the axis dimension's filters** and lets the stitch keep
only the buckets the filtered current side has — "this fiscal year vs
previous period" still finds January's predecessor in LAST year. `yoy` is
allowed only where the step is provably constant — a fiscal year (+1) or
fiscal quarter (+4); a year holds no fixed number of periods (12 in 4-4-5, 13
in four-week calendars) or weeks (52 vs 53), so those refuse with the reason.
`mom` has no meaning on a calendar grain and refuses too.

Declaring a calendar table **replaces** the start-month setting — two sources
of truth for the same fiscal year would disagree quietly, so both at once
refuse at save AND at compile. **Validate measures the table**: one row per
day, no coverage gaps, coverage through today, per-grain sequences with
exactly one start date each, and sequences whose starts actually increase —
each reported with counts. The differential suite executes a miniature 4-4-5
(4/4/5-day periods, two years) against hand-computed truth, including the
year-boundary comparison and a duplicate-day calendar that must not change a
single sum; fifteen mutations over the join shape, the sequence step, the
window subqueries and every probe are all killed.

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
  unattended compile is a footgun, not a feature.
- **A dashboard widget PINS the overrides it was built with.** Add to
  dashboard stores the runner's parameter values on the widget's source, the
  scheduled refresh re-runs with exactly those values (a refresh that quietly
  reverted to the defaults would keep the widget's title and change its
  number), and the widget's **Parameters…** menu edits the pinned values —
  saving re-runs the governed query immediately, so the stored SQL, rows and
  parameters can never disagree. A widget added without overrides keeps
  meaning the declared defaults, as before.
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

It also works from the other end: the BI builder's **Data source** picker
offers **Governed metrics (Semantic Layer)** next to local datasets and
warehouse connections. Pick a model, tick metrics and group-bys (time
dimensions get a per-dimension grain — day/week/month/quarter/year), preview,
and insert — no SQL is written or shown, because the semantic layer writes it
under the caller's own JWT: share grants, row filters, field masks and
attribute tokens all apply exactly as they do in the query runner, and a
preview answered by a declared rollup says so with a `rollup:` badge. A
restricted share is disclosed twice, same as the runner — a notice when you
pick the model, and the "your scoped view, not the global total" note on
the preview itself. The
inserted widget is the same metric-backed widget the runner creates — it
re-runs against the current model definition on refresh. Chart types beyond
the governed set (table, bar, line, area, KPI, pie) insert as a table, and
the builder says so before you commit.

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
- **Attribute-driven row filter** — a filter value may be the token
  `{{user.<key>}}` instead of a literal. At query time it resolves to the
  **calling viewer's** values for that key from **Admin → IAM → Attributes**
  (admin-written; users cannot widen their own scope). One grant on a group —
  `region ∈ [{{user.region}}]` — scopes every member to their own region; an
  attribute holding two values widens that viewer to both. A viewer whose
  account **lacks** the referenced attribute is **refused with the attribute
  named**, never run unfiltered and never silently empty — and a malformed
  token is refused at grant-writing time with the same grammar the enforcer
  uses, so a broken rule can never be stored as a literal that matches
  nothing. The disclosure banner shows the **resolved** values, so the viewer
  knows the scope they are actually seeing. Tokens resolve on **every grant
  surface** — semantic models, BI dashboards (stored results and live
  direct-query), and shared datasets — through the one shared resolver, so
  the same grant means the same rows wherever it is enforced.
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

## Aggregate awareness — declared rollups

A model can declare up to five **rollups** (Source tab): pre-aggregated
tables, each mapping model dimensions and metrics onto its columns:

```
{ table, dimensions: [{ dimension, column, grain? }], metrics: [{ metric, column }] }
```

A query is answered by the **first declared rollup that can provably answer
it** — and a routed query SAYS SO, in a machine-readable field, in a leading
comment inside its own compiled SQL, and as a banner in the runner, because
"which table answered" is part of the answer. Everything unprovable falls
back to the fact table unchanged. The proof obligations, each a refusal
rather than a degradation:

- every requested metric (derived formulas via their leaves) is **mapped**
  and its aggregation **re-aggregates**: sums of sums, counts as a SUM of
  pre-counts, min/max of themselves. `avg` never routes (an avg of avgs
  answers a different question — declare sum and count and a derived ratio),
  `count_distinct` never routes (distinctness does not survive partial
  aggregation), `custom` never routes; the editor refuses those mappings at
  save with the same reasons.
- every grouped **and filtered** dimension is mapped — a filter on a
  dimension the rollup lacks would blend filtered and unfiltered rows.
- a time dimension routes only at a grain the **stored grain provably
  serves**: identity always; `day` serves everything (calendar-table grains
  included); `month` serves month/quarter/year and the month-aligned fiscal
  pair; `quarter` serves quarter/year. Weeks nest into nothing, and nothing
  serves a FINER grain. An ungrained time dimension groups raw values only
  the fact holds — no routing.
- no routed fragment references a `{{parameter}}` — the rollup was
  materialised with some value baked in, and a caller's override would be
  silently ignored.

Comparisons and filters ride the routed table through the ordinary compile
path, and a query the fact table could only answer through a multi-fact plan
may route directly — the rollup has no joins, so there is nothing to fan
out. Metric filters (filtered measures) were baked into the rollup's columns
at materialisation; that is the owner's declaration, and **Validate measures
it**: every mapped metric's grand total is computed on the rollup AND on the
fact table (with rollups stripped, so the check can never route into the
thing it is checking), and a disagreement is reported with both numbers —
"revenue totals 115 on the fact table but 110 in the rollup" — because a
stale rollup must be a reported drift, not a quietly different dashboard.

Deliberately shipped LAST of the semantic-layer campaign: routing is a
performance optimisation that changes which table answers, and the
correctness half (fan-out refusal, measured grain, assertions, drift probes)
had to be trustworthy first. Row-level share filters compose safely: a
grantee's filter becomes an ordinary dimension filter before compilation, so
it routes only when that dimension is in the rollup and otherwise falls back
to the fact.

## Not yet (roadmap)

- **Multiple comparison axes** — a query compares along exactly one grained time
  dimension. Two would have no single "previous period", so the compiler refuses
  rather than choosing one.
