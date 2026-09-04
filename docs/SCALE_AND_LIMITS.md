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

## Choosing per dataset, and bounding the total

Each local dataset carries a **storage mode**, visible and changeable on
**Monitoring → Materialised data**. That panel lists the datasets actually
holding bytes; the rest — the ones reading directly, which is most of them on a
typical workspace — are one click away behind _"Show N datasets holding
nothing"_. The modes:

| Mode     | What it does                                                  |
| -------- | ------------------------------------------------------------- |
| `auto`   | Mirror it when the row count makes that worth doing (default) |
| `import` | Always mirror — you have said this one matters                |
| `direct` | Never mirror; always read the source                          |

`auto`'s thresholds are `PARQUET_MIN_ROWS` and `PARQUET_MAX_ROWS`: too small
and the mirror costs more than it saves, too large and one table would consume
the whole budget. An **explicit mode always wins** — a setting a heuristic can
override is a setting that lies.

`MIRROR_BUDGET_BYTES` bounds how much one workspace holds. Past it, mirrors are
dropped **least-recently-used first**, and anything pinned to `import` goes only
after every `auto` one has. The owner is told which datasets went, by name.

**Eviction costs speed, never correctness.** A mirror is a cache over the same
rows; a dataset that loses one still answers the same question by reading its
rows, more slowly. Nothing in the capacity system can narrow a query's scope or
change a number — that distinction is why row caps below are disclosed on the
result and evictions are not.

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

A crawl lists at most **2,000 objects** per bucket and infers a schema for the
**20** largest groups. CSV/JSON schemas come from a **128 KB** head-of-file
sample; Parquet schemas come from the file's **footer**, which is also where
its exact row count is read from — neither downloads the file.

### Object-store queries — `src/utils/catalog/objectStoreQuery.server.ts`

| Setting           | Default  | What it bounds                              |
| ----------------- | -------- | ------------------------------------------- |
| `OBJECT_ROWS_CAP` | `50,000` | Rows read from EACH file a query references |

**Bucket queries are not pushed down.** The engine that can reach `s3://` needs
network access, and DuckDB has no setting that grants that while denying the
local filesystem — so it never sees user SQL. The referenced files are read up
to the cap and the query runs in the sandboxed engine over those rows, which
means a `WHERE` clause does not reduce what is fetched.

Only files the query names are read: a bucket with two hundred objects costs
one read, not two hundred, to select from one of them. A file that hits the cap
is named back to the caller, because the answer is then over a prefix of that
file rather than all of it.

### Formats

| Format        | Schema | Query | How                                       |
| ------------- | ------ | ----- | ----------------------------------------- |
| Parquet       | ✅     | ✅    | Built in. Footer read in place            |
| CSV / TSV     | ✅     | ✅    | Built in                                  |
| JSON / NDJSON | ✅     | ✅    | Built in                                  |
| **ORC**       | ✅     | ✅    | Community extension, downloaded, isolated |
| **Avro**      | ❌     | ❌    | No extension build exists — see below     |

**ORC is handled differently from everything else**, for two measured reasons.

`read_orc` does not use DuckDB's virtual filesystem. On the same connection,
one statement apart: `read_parquet('s3://…')` returns 4 columns and
`read_orc('s3://…')` returns "no files found matching". `http://` fails the
same way; a local path works. So an ORC object is **downloaded whole** before
it is read, bounded by:

| Setting                  | Default              | What it bounds                       |
| ------------------------ | -------------------- | ------------------------------------ |
| `ORC_MAX_DOWNLOAD_BYTES` | `268435456` (256 MB) | Largest ORC object that will be read |

A partial download is not a smaller ORC — the footer is at the end — so a file
over the ceiling is refused with its size rather than fetched and then failed.

And **ORC runs in a child process**, because the extension can abort the host.
On `TestOrcFile.test1.orc`, a conformance file published by the Apache ORC
project, `DESCRIBE` succeeds and reading rows panics inside the extension's
Arrow bridge in a function that cannot unwind — it calls `abort()`. That is
reachable by putting a file with a nested column in a bucket the crawler reads,
so it is never given the chance to run in the server. A crashed read kills the
child, and the message says the reader failed rather than blaming the file.

Flat ORC files read fine; nested `STRUCT`/`LIST`/`MAP` columns are where it
breaks. Schemas are read for both, so a nested file is still cataloged with its
columns even though it cannot be queried.

**Avro is cataloged but cannot be read.** It needs the DuckDB `avro` community
extension, which has no published build for the DuckDB version this project
uses — checked against the community repository for `windows_amd64`,
`linux_amd64`, `linux_arm64` and `osx_arm64`, all 404, while ORC returns 200
from the same host. The last release was for DuckDB v1.1.3. An `.avro` file
still appears in the catalog with its name and size, and the reason it has no
columns is stated rather than left as a silent gap.

### Skills in the prompt

| Variable                  | Default | What it bounds                                                                                                                                                                         |
| ------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SKILLS_INLINE_MAX_CHARS` | `8000`  | Combined skill-body size an agent may carry with every body inlined into the prompt. Past it, the prompt carries a compact index and the model loads a body on demand via `use_skill`. |

The default is measured, not guessed: all six bundled sample skills together
are ~6.7k characters, so any configuration built from them stays on the
classic inline path and nothing observable changes. Deferral exists for the
setups inlining punishes — many skills, or a few very long playbooks — where
most of what is resent on every turn is instructions for situations that are
not happening this turn. Swarm nodes attach skills per node and are
deliberately narrow, so in practice they stay inline; the gate applies to
them identically if one is ever overloaded.

### The swarm API

Per API key, enforced server-side on `/api/swarm/run`:

| Variable                       | Default  | What it bounds                                                                      |
| ------------------------------ | -------- | ----------------------------------------------------------------------------------- |
| `SWARM_RUN_RATE_LIMIT_PER_MIN` | `30`     | Requests per key per minute → 429                                                   |
| `SWARM_RUN_MAX_CONCURRENT`     | `5`      | Runs in flight per key — the one protecting your provider quota                     |
| `SWARM_RUN_TIMEOUT_MS`         | `600000` | Wall clock per run (10 min). Anything that may approach it should use `async: true` |

The run timeout is also what decides synchronous versus asynchronous calls —
a swarm with a human-approval node in any branch must be called async, because
a parked run can outlive any HTTP connection. See the API guide in the app at
`/docs/api`.

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

### Machine learning — `src/utils/notebookRuntime/config.server.ts`

Training and batch prediction run inside batch sandboxes of the notebook
runtime, so the sandbox limits (`batch_cpu_limit`, `sandbox_tmpfs_mb`) apply
as well. Each value below is resolved per call as **settings row → environment
variable → default**; the settings row is edited under **Admin → Developer
runtime** and takes effect on the next job, no redeploy.

| Setting                                | Default   | What it bounds                                                                                            |
| -------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------- |
| `ML_TRAIN_MAX_ROWS`                    | 2,000,000 | Rows one training run reads. A larger table is reservoir-sampled to this many, and the version says so.   |
| `ML_TRAIN_TIME_BUDGET_MINUTES`         | 30        | Default wall-clock budget per run; candidates are skipped, not aborted, once 85% is spent.                |
| `ML_TRAIN_MEM_LIMIT_MB`                | 8192      | Memory ceiling of a training sandbox. A model that needs more fails with the sandbox's OOM, not silently. |
| `ML_MAX_CONCURRENT_TRAININGS_PER_USER` | 2         | Training jobs one user may have live at once.                                                             |
| `ML_PREDICT_MAX_ROWS`                  | 5,000,000 | Rows one batch prediction may score.                                                                      |
| `ML_API_RATE_LIMIT_PER_MIN`            | 60        | Calls a minute one ML API key may make, across every `/api/ml/*` endpoint (global limiter).               |

Nothing here is a ceiling in the code. On a 64-core, 512 GB machine set
`ML_TRAIN_MAX_ROWS` to the size of your largest table and
`ML_TRAIN_MEM_LIMIT_MB` to what a sandbox may take, and the trainer will use
it; the admin page shows what the host actually has so the numbers are chosen
against reality.
