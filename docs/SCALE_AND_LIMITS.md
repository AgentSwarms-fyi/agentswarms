# Scale and limits

The question this page answers is **"will this handle my data?"** — asked before
any pilot, and usually answered by a vendor with the word "enterprise".

The honest version is one sentence:

> **Aggregate queries push down into your warehouse, so table size is your
> warehouse's problem. Everything that materialises locally is capped, and the
> caps are listed below.**

A billion-row `GROUP BY` in Snowflake works because Snowflake does the work and
returns a few hundred rows. A billion-row `SELECT *` is refused — by design,
because nothing good is on the other side of it.

Every number here is a default you can change with an environment variable, and
every one is read by code you can grep for.

---

## Where the work happens

| Path                                     | Runs where                                    | Bounded by                           |
| ---------------------------------------- | --------------------------------------------- | ------------------------------------ |
| Warehouse table (linked)                 | **In your warehouse**                         | Result-row cap, timeout, concurrency |
| Local dataset (uploaded/synced)          | **DuckDB**, in the app process or the browser | Dataset row cap                      |
| Prep flow, all sources on one connection | **In your warehouse** (query folding)         | Output-row cap                       |
| Prep flow, mixed or non-foldable         | **Locally**, after fetching                   | Output-row cap                       |
| BI widget, `direct` mode                 | **In your warehouse**, at view time           | Direct-query cap                     |
| BI widget, `import` mode (default)       | **From a cached snapshot**                    | Snapshot cap — see the warning below |

---

## The caps

### Warehouse queries — `src/utils/warehouse/governor.server.ts`

| Setting                             | Default | What it bounds                                     |
| ----------------------------------- | ------- | -------------------------------------------------- |
| `WAREHOUSE_MAX_ROWS`                | `1000`  | Rows returned when a caller doesn't specify        |
| `WAREHOUSE_ABS_MAX_ROWS`            | `5000`  | Hard ceiling — no caller may exceed it             |
| `WAREHOUSE_QUERY_TIMEOUT_MS`        | `60000` | Wall clock for one query, including result polling |
| `WAREHOUSE_MAX_CONCURRENT`          | `8`     | Simultaneous warehouse queries per app process     |
| `WAREHOUSE_MAX_CONCURRENT_PER_USER` | `3`     | Per user, so one person cannot occupy the pool     |
| `WAREHOUSE_QUEUE_TIMEOUT_MS`        | `30000` | How long a query waits for a slot                  |

These bound the **result set**, never the table. `SELECT country, SUM(amount)
FROM billion_row_table GROUP BY country` scans a billion rows in the warehouse
and returns ~200 — entirely fine.

Concurrency limits are **per process**. Behind a load balancer, multiply by
replica count when sizing against your warehouse's `max_connections`.

### Local datasets — `src/utils/data/ingest.server.ts`

| Setting            | Default              | What it bounds                    |
| ------------------ | -------------------- | --------------------------------- |
| `UPLOAD_MAX_ROWS`  | `500000`             | Largest dataset accepted, in rows |
| `UPLOAD_MAX_BYTES` | `104857600` (100 MB) | Largest file accepted             |

Local datasets are a laptop-scale convenience — CSVs, sample data, SaaS syncs —
not a warehouse replacement. Past a few million rows, link the warehouse table
instead of importing it.

The SQL workbench's **in-browser** engine (DuckDB-Wasm) is bounded by the
browser tab's memory, and its inline preview shows **50 rows**
(`PLAYGROUND_ROW_CAP`).

### Semantic layer — `src/lib/semanticLayer.ts`

| Constant        | Default | What it bounds                 |
| --------------- | ------- | ------------------------------ |
| `DEFAULT_LIMIT` | `1000`  | Rows when a query doesn't ask  |
| `MAX_LIMIT`     | `10000` | Ceiling for any semantic query |

Dimensions and metrics compile to SQL that runs **where the data lives**, so the
aggregation happens in the warehouse and only the grouped result travels.

### Data preparation — `src/utils/bi/prep.server.ts`

| Setting                | Default  | What it bounds                                   |
| ---------------------- | -------- | ------------------------------------------------ |
| `PREP_OUTPUT_ROWS_CAP` | `250000` | Rows a prep flow may write to its output dataset |

**Query folding** is what makes prep scale: when every source in a flow is
linked to the same warehouse connection and every step is expressible in that
dialect, the whole pipeline is compiled to one SQL statement and executed
**inside the warehouse**. The fold is _proved_ before it is trusted — the
generated SQL is run against the real warehouse first, and any parse or
semantic error falls back to local execution. A refusal therefore costs
performance, never correctness.

Folding does **not** happen when sources span different connections or mix
local and warehouse tables, or when a step has no dialect equivalent. The UI
names the reason. In that case rows are fetched and processed locally, and the
caps above apply.

When you add a warehouse table to a flow, _Snapshot_ copies up to **1,000
rows** locally for design-time preview; _Link_ reads the table in place and is
what you want for real volume.

### BI dashboards — `src/lib/biDashboards.ts`

| Setting / field             | Default                  | What it bounds                     |
| --------------------------- | ------------------------ | ---------------------------------- |
| `VITE_BI_SNAPSHOT_ROWS_CAP` | `500` (ceiling `100000`) | Rows cached in a widget's snapshot |
| `DIRECT_QUERY_DEFAULT_ROWS` | `50000`                  | Rows for a `direct`-mode widget    |
| `DIRECT_QUERY_MAX_ROWS`     | `100000`                 | Ceiling for `direct` mode          |

> [!IMPORTANT]
> **Read this before trusting a total.** Warehouse-backed widgets default to
> `import` mode: a cached snapshot of at most **500 rows**, which is fast and
> cheap and renders instantly for shared links. If a chart sums raw rows in the
> browser and the refresh hit that cap, **the number shown is a partial sum**.
>
> Two ways to get a complete number:
>
> - **`agg_pushdown`** — do the `GROUP BY` in SQL so the widget stores
>   already-aggregated rows. New widgets default to this wherever the chart type
>   supports it. It is deliberately **not** switched on retroactively, because
>   doing so would silently change numbers on existing dashboards.
> - **`query_mode: "direct"`** — re-run the query against the warehouse at view
>   time for current truth, at the cost of a warehouse query per view.
>
> The cap itself is configurable — `VITE_BI_SNAPSHOT_ROWS_CAP`, one value read
> by both the browser (which creates snapshots) and the server (which refreshes
> them). Set it in `.env`; `docker compose` passes it through as a build arg
> automatically, because `VITE_` values are inlined at **build** time rather
> than read at runtime — so changing it means rebuilding the image, not
> restarting it. Raising it grows every dashboard record, which is the cost
> being traded.
>
> A widget whose last refresh filled the cap sets `truncated`, and the UI says
> so rather than showing a confident wrong total. Public embeds and share links
> always render the snapshot, never a live query.

**Incremental refresh** (`incremental: { column, days }`) re-queries only the
recent window and keeps older snapshot rows. Whole time buckets are recomputed
rather than partial aggregates merged — `avg` and `count_distinct` cannot be
merged from partials. The assumption you accept is the usual one: history
outside the window is immutable, so a late edit to an old row is not seen until
a full refresh.

### Data catalog

The catalog reads **metadata only** — row counts come from stored statistics,
never a scan, so a billion-row table costs the same to browse as an empty one.
The asset table renders the first **500** matches of the current filter.

### Knowledge bases (RAG)

Per synced source: **500 items**, **400,000 characters** per document, and a
crawl depth of **5**. Retrieval is pgvector (HNSW cosine) in your Postgres.

---

## What this means in practice

**Works well:** warehouse tables of any size queried through the semantic layer,
prep flows that fold, `direct`-mode widgets, dashboards over pre-aggregated
results, catalog browsing of thousands of assets.

**Does not:** importing a billion rows into a local dataset, `SELECT *` of a
huge table into the browser, or trusting an `import`-mode widget's raw-row sum
without `agg_pushdown`.

**Sizing the app itself:** the container is CPU-light and roughly 0.5–1 GB RSS —
it streams JSON between browsers and APIs. The stateful component that grows is
Postgres (traces, audit, KB vectors); see
[SYSTEM_REQUIREMENTS.md](./SYSTEM_REQUIREMENTS.md).

**Scaling out:** the container is stateless with no sticky sessions. Background
work takes a cross-instance database lease, and `DISABLE_INPROCESS_SCHEDULER`
pins scheduling to one node. Remember that pool and rate limits are per process.
