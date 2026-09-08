# SQL models

A transformation layer over the lakehouse. A **model** is one `SELECT` that
becomes a table; `ref('other_model')` names another model, which both declares
the dependency and resolves to its table. A **build** walks the graph in
dependency order, so a staging table is always rebuilt before the fact that
reads it.

The vocabulary is dbt's on purpose: if you have written a dbt project, you
already know what a model, a ref, a materialization and a `not_null` test are.
What is deliberately absent is Jinja, macros, seeds and packages. The gap this
closes is **ordered transformation**, not a templating language.

Find it under **Data & BI → SQL Models**.

---

## Why this and not a materialized view

A materialized view already turns one query into one table on a schedule (see
[LAKEHOUSE.md](LAKEHOUSE.md)). What it cannot do is the thing every warehouse
team actually has: a set of tables that depend on each other.

Two behaviours follow from the graph and neither is available without it:

- **Order.** A model is built only after everything it refs. Rebuilding a fact
  on a schedule while its staging table is rebuilt on another leaves the two
  disagreeing for however long the gap is.
- **Propagation.** When a model fails — or an `error` test on it fails —
  everything downstream is **skipped**, not built. A fact silently rebuilt
  from a staging table you already know is broken is the failure mode this
  exists to prevent.

A model and a materialized view cannot claim the same `schema.table`. Saving a
model over an existing view's target is refused by name.

---

## Writing a model

```sql
select
  order_id,
  customer_id,
  cast(created_at as date) as order_date,
  amount
from analytics.raw_orders
where amount is not null
```

Save it as `stg_orders` into a schema you own. It becomes the table
`<schema>.stg_orders` — **the model's name is its table name**, so there is
exactly one way to refer to it and no chance of the ref name and the physical
name drifting apart.

Then a model that reads it:

```sql
select
  order_date,
  count(*) as orders,
  sum(amount) as revenue
from ref('stg_orders')
group by 1
```

`ref('stg_orders')` is replaced with the quoted table before the query runs,
and the dependency is recorded. Nothing else is templated.

**Names** are lower case letters, digits and underscores, starting with a
letter or underscore.

**A ref inside a comment is not a dependency.** A commented-out ref that still
imposed a build order would refuse projects that are actually fine.

**A cycle is refused when you save**, by name, with the loop spelled out —
while the project still builds, rather than at the next scheduled build when
nothing runs.

### Table or view

| Materialization | What happens                                         | Use it when                                         |
| --------------- | ---------------------------------------------------- | --------------------------------------------------- |
| `table`         | Rows are written at build time (`CREATE OR REPLACE`) | The default. Reads are fast and repeatable.         |
| `view`          | The query runs on every read                         | The model is cheap, and you want it always current. |

A build lands as one DuckLake commit, so readers see the previous table or the
new one and never a half-built one. A **failed** build leaves the previous
table in place: stale data someone can see and diagnose beats no data at all.

---

## Tests

Tests run after a model builds, against the table it just wrote.

| Test              | Asserts                                   |
| ----------------- | ----------------------------------------- |
| `not_null`        | A column is never null.                   |
| `unique`          | A column has no repeated value.           |
| `accepted_values` | A column is one of a list.                |
| `range`           | A numeric column sits between two bounds. |
| `row_count_min`   | The table has at least N rows.            |

Each has a severity:

- **error** — the model is marked failed and **everything downstream is
  skipped**. Use it for anything that would make a dependant wrong.
- **warn** — the failure is recorded on the build and the build carries on.

A test that cannot run (a misspelled column, say) is recorded as an **error**,
not a pass. A misspelling that read as a clean assertion for ever would be
worse than no test.

A model with no tests always counts as built, however wrong the rows are.

---

## Building

- **Build all** builds every active model, in order.
- **Build this and what it reads** builds one model with its ancestors — dbt's
  `+model`. Rebuilding a fact without the staging table it reads would leave
  the two disagreeing.
- **A schedule on a model** (`hourly`, `daily`, `weekly` or a cron expression
  with a timezone) does the same thing on its own. Several due models for one
  owner become **one** build over the union of their ancestors, so a shared
  staging table is built once per sweep rather than once per dependant.

Scheduled builds ride the same sweep as everything else on the platform, with
the same compare-and-set claim, so every replica behind a load balancer can
run it without building twice. See the cron contract in
[DEPLOYMENT.md](DEPLOYMENT.md).

Pausing a model stops it being **rebuilt**, not being **read**: its table stays
on disk and `ref()` still resolves to it.

Deleting a model deletes the **definition**. The table stays where it is,
because a dashboard, an agent or another tool may still be reading it — drop it
from the Lakehouse page if you want it gone. Models that still ref a deleted
one are named when you delete it, and will fail until you edit them.

---

## After it builds: naming what the columns mean

A model produces a **table**. It does not say that `net_usd` summed is
"revenue", that only completed orders count, or that nobody outside Finance
may see the margin. That is the [semantic layer](./SEMANTIC_LAYER.md), and the
two are meant to be used together:

1. Build the model. It writes `analytics.fct_orders`.
2. Press **Define metrics on this** on the model, or on the table in the
   Lakehouse page.
3. The semantic editor opens on that table. Name the metrics and dimensions
   once.
4. Dashboards, the AI Analyst, agents through the `metric_query` tool and the
   `/api/v1/metrics` HTTP API all compute them the same way.

The lakehouse is reached as a **warehouse connection** whose provider is the
built-in lakehouse, so this needs one connection row the first time. The
button offers to create it; it asks only for a name, because the deployment
already holds the credentials.

Keep the division clean and both layers stay small. Shape belongs in the
model: joins, filters, casts, deduplication, incremental history, done once at
build time. Meaning belongs in the semantic layer: aggregations, ratios,
fiscal calendars, row filters per role, resolved at query time. If you are
writing the same `WHERE` clause into five dashboards, you wanted a dimension,
not another model.

---

## Governance

Everything a model does, it does **as its owner**. A schedule has no session
behind it, so the owner's grants are the only correct authority.

- **Where it can write.** Only a lakehouse schema the owner owns. A mounted
  data lake is read-only and is refused, at save and again at every build.
- **What it can read.** Re-checked on every build against the owner's current
  grants, not against what they had when the model was saved. A grant revoked
  since then stops the build.
- **What it can be.** A model must be a `SELECT`. A definition edited into a
  write is refused by the same classifier the SQL workbench uses.
- **Audit.** `sql_model.build` for every build, with the trigger, the outcome
  of each model and how many were built, failed and skipped;
  `sql_model.pause` / `sql_model.resume`; and the table's own row trigger for
  every change to a definition, its schedule or its tests.
- **Lineage.** Model-to-model edges are written to the catalog on every build
  and appear in the Data Catalog's lineage panel alongside crawled and ETL
  edges. They are replaced wholesale each build: a stale edge is worse than a
  missing one, because a stale graph is believed. Column edges come with
  them: every output column of the model's SELECT, traced through DuckDB's own
  parse to the lakehouse columns it reads — aliases, functions, CTEs,
  subqueries, joins and `SELECT *` — so the drawer can say which columns of
  which tables a model's column was computed from, and a pipeline's column
  lineage continues into the model built on its target.
- **RLS.** Models and build logs are owner-only.

---

## Limits

| Setting                   | Default | Meaning                                                     |
| ------------------------- | ------- | ----------------------------------------------------------- |
| Owners built per sweep    | 5       | So one large estate cannot stall the shared scheduler pass. |
| Due models read per sweep | 50      | The claim window; the rest are picked up on the next pass.  |
| Tests per model           | 50      | Enforced when a model is saved.                             |

---

## Built by a pipeline

A pipeline can build models when one of its runs succeeds — every active
model, or named ones with their ancestors — from the pipeline's Settings
("After it succeeds, also…"). The build is the one this page runs, as the
pipeline's owner, and appears in the run list with the trigger `chain`; a
failing model skips its downstream exactly as a scheduled build would. See
[ETL pipelines → Beyond pipelines](./ETL_PIPELINES.md#beyond-pipelines-one-graph-from-ingest-to-model).

## Troubleshooting

| Symptom                                           | Cause and fix                                                                                                           |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `ref('x') names a model that does not exist`      | The model was renamed or deleted. The editor flags an unknown ref before you save; the Build order tab lists every one. |
| `These models depend on each other in a circle`   | The loop is named in the message. Break it by inlining one side or splitting a model.                                   |
| A model says **skipped**                          | Something it reads failed. The build log names which one; fix that model and rebuild.                                   |
| `A model can only be built into a schema you own` | The target schema is shared with you, or is a data-lake mount. Mounts are read-only; create your own schema.            |
| `... is already a materialized view`              | That `schema.table` is claimed. Delete the view on the Lakehouse page, or give the model another name.                  |
| A build wrote nothing and the run says **error**  | The whole plan was refused before anything ran — a cycle, or the lakehouse is not configured on this instance.          |
| The table exists but the model was deleted        | Deleting a definition deliberately leaves the table. Drop it from the Lakehouse page.                                   |
