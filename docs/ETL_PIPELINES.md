# ETL Pipelines

> Part of the [AgentSwarms docs](../README.md#documentation).

Python pipelines — [dlt](https://dlthub.com) for loading, [ibis](https://ibis-project.org)
and pandas for transforms — that pull from files, APIs and systems the warehouse cannot
see, and land the result in S3-compatible object storage, where the Data Catalog, BI, the
AI Analyst and agents can already reach it.

This page is the operator's view: how execution works, what to enable, and where the
seams are. The user-facing guide lives in the app under **Docs → ETL Pipelines**.

## Where it sits

AgentSwarms already had two transform surfaces. **Prep flows** (BI → Data preparation)
are visual SQL over tables the platform can query — pushed down, never leaving the
engine. The **Semantic Layer** compiles governed metrics. Pipelines are the third leg:
data movement between systems, expressed as a DAG or as Python — API extraction,
raw-file conversion, cross-system joins, anything needing a pip package.

```
   HTTP APIs ──┐                                      ┌─→ object storage
   buckets ────┼─→  batch kernel (sandboxed runtime) ─┼─→ postgres/mysql/mssql
   databases ──┼─→   joins · aggregates · transforms  │      families
   Python ─────┘                                      └─→ (any fan-out)
                                                              │
                                              catalog crawl ──┘→ assets
                                                → BI · Analyst · agents
```

The visual builder is a node graph (XYFlow, the swarm-canvas engine): sources,
transforms (filter/select/rename/derive/join/union/aggregate/sort/dedupe/nulls/
limit/SQL/Python) and targets, compiled deterministically to Python by
`src/utils/etl/codegen.ts`. File formats: CSV, TSV, JSON, JSONL, Parquet and
Excel as sources; Parquet, CSV and JSONL as storage targets. Database sources
and targets cover the three wire families (PostgreSQL, MySQL, SQL Server —
14 of the 22 connection providers) over per-run SQLAlchemy URLs built
server-side in `sqlalchemyUrlFor`; IAM-auth and token-only systems (Snowflake,
BigQuery, Redshift, Databricks, Trino, Athena, Oracle, ClickHouse) refuse at
save time with guidance to stage through object storage, which all of them
ingest natively.

## Execution model

A run is a **batch kernel on the notebook runtime** — the same container image,
hardening, egress allow-list and reaper documented in
[DEVELOPER_WORKSPACE_RUNTIME.md](./DEVELOPER_WORKSPACE_RUNTIME.md). No new service, no
new trust surface, and nothing executes in the app process.

The run sequence:

1. `startEtlRun` (`src/utils/etl/service.server.ts`) pins the pipeline's current code
   onto an `etl_runs` row — the pipeline can be edited mid-run, and a run log pointing
   at code that no longer says what ran is evidence of nothing — then starts a batch
   session linked by `etl_run_id`.
2. The sandbox's batch runner fetches its bundle from `/api/notebook/runtime/source`
   with its session token. For an ETL session that bundle is a generated prelude plus
   the pinned script.
3. The prelude fetches the **resolved environment** (`{"part": "etl_env"}` on the same
   route) — destination credentials and `{{secret:NAME}}` bindings — into process
   memory, then pip-installs the pipeline's requirements. Credentials are never
   container env vars (visible to `docker inspect` and pod specs) and never appear in
   code text; the same decision the MCP builder made, for the same reasons.
4. The script's `entrypoint(inputs)` runs; its return value becomes the run's metrics.
5. The result callback (`/api/notebook/runtime/result`) finalises the run: status,
   logs with secret values scrubbed, metrics; updates the pipeline's last-run summary;
   triggers a catalog crawl of the destination; registers catalog lineage
   (each source descriptor → each produced asset, `source_system = 'etl'`,
   replaced wholesale per pipeline so renamed targets never strand old edges);
   notifies the owner on failure.

**The runtime must be enabled** (Admin → Developer runtime; `--profile notebooks` on
Compose). Without it, runs fail immediately with a message saying exactly that.

## Quality gates

The **Quality gate** transform validates the frame flowing through it. Rules:
`not_null`, `unique`, `range` (min/max, half-open allowed), `regex`,
`allowed_values` — all column-scoped — plus `row_count_min` for the frame
itself. Each rule carries a severity:

| Severity | On violation                                              |
| -------- | --------------------------------------------------------- |
| `fail`   | Abort the run with `RuntimeError: Quality gate <name>: …` |
| `warn`   | Log `[quality] WARN …` and continue                       |
| `drop`   | Log `[quality] DROP …`, remove offending rows, continue   |

Every rule's outcome — violating row counts included, zero or not — lands in
the run's `quality` metric, so a Runs-tab entry answers "what did the gate see"
without re-running anything. `[quality]` log lines carry the same numbers for
live tailing. Nulls violate `range` and `regex` (use `not_null` to name that
explicitly); `unique` counts every row of a duplicated key, not just the
extras. Malformed rules (no column, range without bounds, unknown check) are
compile-time save errors, not runtime surprises.

Verified against the seeded `orders.csv` (308 rows, planted defects): warn
`not_null(customer_id)` reported 6, warn `unique(order_id)` reported 16, drop
`range(amount, min 0)` removed 4 — 304 rows loaded; flipping the null rule to
`fail` aborted the run with the rule and row count in the error.

## Streamed rows (webhook ingest)

`POST /api/etl/ingest` (same Bearer trigger token as `/api/etl/run`) stages
JSON rows for a pipeline — up to 1,000 rows / 1MB per request, 500k backlog
cap, globally rate-limited. An **ingest** source node drains the staging in id
order with the CDC consume/peek shape: each run first deletes what the
previous run durably loaded (ids at or below the engine cursor), then reads
the rest and reports the new max id as its watermark. Push whenever events
happen and let the schedule load them, or call `/api/etl/run` right after
pushing for near-real-time. Rows arrive with `_ingest_id` and
`_ingest_received_at` alongside their own fields. Node previews read the
backlog without consuming it. Verified live: 3 pushed rows loaded, 2 more
pushed, second run drained the first 3 and loaded exactly the 2 new ones.

## Reverse ETL (HTTP API targets)

The **HTTP API** target pushes the incoming frame to an external endpoint in
JSON batches (`POST`/`PUT`/`PATCH`, configurable rows-per-request, optional
`{<wrap_key>: rows}` envelope). Auth is a Bearer token read from an env var
bound to a platform secret (Settings → secret bindings) — resolved in the
sandbox's memory and scrubbed from logs. A non-2xx response fails the run,
which the retry ladder then handles. Verified live against a local sink:
5 rows arrived as 3 batches with the bound bearer header, and the token
never appeared in run logs.

## Cost attribution

The dashboard's **Runtime · 7d** card totals sandbox wall-clock across
pipelines, and each pipeline row shows its own `runtime 7d` and `rows 7d` —
computed from run start/finish stamps in `computeEtlOverview`, so a
still-running run accrues up to now and queued time costs nothing.

## Staging copies

**Duplicate** (copy icon on a pipeline row) creates `<name> (copy)`: same
graph, code, destination, alert policy and defaults — but manual schedule, a
fresh trigger token and no run history. Re-point its connections and
destination, then enable its schedule to promote.

## Change data capture

A database source in **CDC** mode reads a PostgreSQL logical-replication slot
(wal2json, format v2) instead of querying the table. The engine names and
creates the slot (`aswarm_<pipeline>_<node>`), takes an optional initial
snapshot AFTER slot creation so nothing falls in the gap, and hands each run
last run's durably-loaded LSN as the cursor: a run first CONSUMES the slot up
to that LSN, then PEEKS everything newer — a crash between read and load
re-reads the same changes rather than losing them (at-least-once). Rows carry
`_cdc_action` (I/U/D), `_cdc_deleted` and `_cdc_lsn`.

What the target does with the log is the target's choice:

- **Append / plain files** — a change event log, every version kept.
- **Merge + Delta table** — an applied mirror of the source table: dlt's
  upsert merge handles inserts and updates, and an explicit transactional
  delete pass applies `_cdc_deleted` rows (dlt's delta upsert has no
  hard-delete path of its own — its merge builder only update/inserts).

Deleting a pipeline drops its slots best-effort — a leaked slot would make
the source database retain WAL forever. Requirements: PostgreSQL family with
`wal_level = logical` and the wal2json plugin (Debian/Ubuntu:
`postgresql-<v>-wal2json`), plus TCP reachability from the runtime network.

Verified live against a wal2json Postgres: snapshot, then three mutation
rounds — the Delta mirror matched the source table exactly (inserts, updates
AND deletes), the LSN cursor advanced through `etl_pipeline_state`, and
deleting the pipeline removed the slot.

## Open-table formats

An object-storage target can write **Delta Lake** or **Iceberg** tables
instead of plain files (Table format on the target node). dlt's filesystem
destination does the writing — delta-rs for Delta, pyiceberg for Iceberg —
so the result is a real table: `_delta_log/` transaction log, or Iceberg's
`data/` + `metadata/` tree with manifests and snapshots. File format is
forced to Parquet (that is what the table formats materialise); requirements
pull `dlt[deltalake]` / `dlt[pyiceberg]` automatically. The crawler hides
each format's bookkeeping (underscore rule for Delta; json/avro under a
`metadata/` segment for Iceberg) and catalogs the data files as one asset,
which is also the fqn lineage records. Verified live against MinIO: both
formats written, crawled as single clean assets with correct row counts.

## Alerts

Each pipeline has an alert policy (Settings → Alerts): **run fails** (on by
default, fires only after the retry ladder is exhausted), **run recovers**
(on by default — the first success after a failure), and **every success**
(off by default; noisy on tight schedules). Delivery goes through the
platform's notification chokepoint: an in-app notification row plus a
best-effort mirror to every Slack / Teams / Discord / generic-webhook channel
connected on the Integrations page. A dead webhook never fails the run —
channel errors are logged and surfaced as delivery-health badges on the
Integrations page.

## Platform dataset sources

The **Platform dataset** source node reads a dataset that already lives on the
platform — an upload, a prep-flow output, or a table synced from a SaaS
connector (Salesforce, HubSpot, …). The sandbox fetches the rows from the app
over its own session token (`{"part": "etl_dataset"}` on the source route), so
ownership is enforced server-side, nothing is signed for a browser, and no
extra credentials exist to leak. Reads are capped at 200,000 rows with a loud
`[etl] WARN … truncated` log line beyond that. Lineage records the upstream as
`platform:<dataset name>`.

## Node previews

Select any canvas node and **Preview data** runs its ancestors in the sandbox
on sampled sources (500 rows per source) and shows the first 50 rows of the
frame that node produces — a target previews exactly what it would load. The
preview is a freshly compiled script with no dlt, no writes and no watermark
movement; source credentials resolve exactly as a real run's do (over HTTP into
process memory), destinations and drift baselines are skipped. A broken graph
fails at the compile step with the compiler's message, before any container
starts.

## Native warehouse targets

Database targets route by provider. PostgreSQL, MySQL and SQL Server families
load over SQLAlchemy as before. **Snowflake, BigQuery and Databricks** load
through their native bulk paths (dlt's `snowflake`, `bigquery` and
`databricks` destinations — staged loads, not row-by-row inserts), reusing the
same warehouse connections the BI workspace holds: Snowflake authenticates
with the stored programmatic access token over the OAuth authenticator,
BigQuery with the service-account key, Databricks with the workspace token
against `/sql/1.0/warehouses/<id>`. The engine hands the sandbox one
`ETL_<NODE>_DEST_CREDS` JSON env var per native target; every token in it is
registered with the log scrubber. Requirements pull the matching dlt extra
(`dlt[snowflake]`, …) instead of a SQLAlchemy driver.

Reading still goes through SQL families or object storage — native providers
are refused as source nodes at compile time with a message saying so. Redshift
connections use the Data API (no direct SQL endpoint stored), so they are not
loadable this release; stage through object storage instead.

## Version history

Every save that changes a pipeline's content (graph, generated or hand-written
code, requirements, mode) snapshots it into `etl_pipeline_versions` —
settings-only saves (schedule, retries, destination) do not. The Settings tab
lists the newest 50 with one-click **Restore**; restoring writes the old
content back and records the restore as the newest version, so history only
moves forward and a regretted restore has its own undo. Rows are
service-role-written and owner-read-only, and deleting a pipeline cascades its
history away.

## Schema drift

Each target carries a **schema policy**: `evolve` (default — load whatever
arrives, today's behavior), `warn`, or `strict`. The generated code captures
the frame's column→dtype map for every target into `metrics.schemas`; on
success the engine persists it to `etl_pipeline_state` under
`schema:<node>` rows — the same pattern as incremental cursors, and stored
server-side for the same reason. The next run of a `warn`/`strict` target
receives last run's shape as `ETL_<NODE>_SCHEMA` and diffs **before the
load**: added columns, removed columns, retyped columns.

- `strict` aborts with `RuntimeError: [schema] schema drift on <dataset>.<table>: added …` —
  the destination still holds the previous run's data, because nothing was
  written yet.
- `warn` prints the same message as a `[schema] WARN` log line and loads anyway,
  updating the stored baseline.

Verified live: a strict target loaded orders.csv (baseline stored), a second
run with one derived column added aborted naming exactly `added audit_flag`,
and the warn policy loaded it with the WARN line in the run logs.

## Lineage

Every successful run writes edges into `catalog_lineage`: one per (source,
produced asset) pair. Sources are labeled with what they actually are — an
object-storage path (`raw/orders/*.csv`), a database table, an HTTP URL, or
`python` for script sources. Target fqns use the crawler's vocabulary
(`<dataset>/<table>/*.<format>`, with `jsonl` registered as `ndjson`), so the
edge lands on the same fqn the crawl gives the asset and the Data Catalog's
asset drawer shows it under "Data lineage · from source".

Two systems share the table without clobbering each other: crawler-derived
lineage (Databricks system tables) refreshes only rows with
`source_system = 'databricks'`, ETL runs replace only their own pipeline's
rows (`pipeline_id` column, added in migration `20260836000000`; deleting a
pipeline cascades its edges away).

One catalog nicety came out of the same verification pass: the crawler now
sees through gzip. dlt writes text formats gzipped by default
(`file.jsonl.gz`), which used to register as an opaque `compressed` asset;
the format detector now reports the inner format and column inference
decompresses the ranged-GET sample (sync-flush, so a truncated tail is fine).

## Data-size limits and machine sizing

Each run executes in ONE sandbox container as an in-memory pandas process —
there is no distributed engine. That is the honest boundary of this feature:
a single run never spans machines, and its working set must fit in the
container's RAM. Pandas typically needs **3–5× the raw data size** in memory
(joins, wide aggregations and SCD-style self-comparisons sit at the high
end), and the per-kernel ceiling is the **batch memory limit** in Admin →
Developer runtime (default 4096 MB, 2 CPUs).

Sizing guidance for the machine running the kernels (the Docker host in the
default setup — add the app itself ~1 GB, Postgres/Supabase if co-hosted,
and multiply the kernel column by how many runs you allow concurrently):

| Data per run  | Transforms                      | Kernel mem limit  | Host machine (kernels + app) |
| ------------- | ------------------------------- | ----------------- | ---------------------------- |
| ≤ 100 MB      | anything                        | 2 GB (default ok) | 4 GB / 2 vCPU                |
| 100 MB – 1 GB | filters, derives, dedupe        | 4 GB              | 8 GB / 4 vCPU                |
| 100 MB – 1 GB | joins, aggregations, SCD, fuzzy | 8 GB              | 16 GB / 4 vCPU               |
| 1 – 5 GB      | simple linear transforms        | 16 GB             | 32 GB / 8 vCPU               |
| 1 – 5 GB      | joins / wide reshapes           | 24–32 GB          | 64 GB / 8+ vCPU              |
| > 5–10 GB     | any                             | — not this tool   | see below                    |

Past a few GB per run, do not grow the kernel — change the shape of the work:

1. **Narrow the read**: incremental cursors (or CDC) so each run moves only
   the delta, not the history.
2. **Push transforms to the warehouse**: load raw with a light pipeline into
   Snowflake / BigQuery / Databricks (native bulk targets) and transform
   there — ELT instead of ETL.
3. Split one huge pipeline into chained smaller ones (`run after`), each with
   a bounded working set.

A run that exceeds its kernel memory dies with a container OOM (surfaced as
a failed run whose logs end abruptly); raise the batch memory limit or apply
one of the three moves above.

## Horizontal scaling

Two layers scale independently:

**Run execution (the data plane) scales out.** Kernels are dispatched
through a backend selected in Admin → Developer runtime:

- `docker` — kernels run on one Docker host; scale UP that host, and cap
  concurrency with the runtime's session limits.
- `k8s` — every run is its own pod, scheduled across the cluster; this is
  the horizontal path. Many pipelines run in parallel across nodes.
- `e2b` — runs land in externally hosted sandboxes; capacity is theirs.

Whichever backend, the unit of parallelism is the RUN: ten pipelines can
execute on ten nodes at once, but one run's dataframe still lives on one
machine (see sizing above).

**The app tier scales out behind a load balancer.** App replicas are
stateless — all state lives in Postgres — and the ETL engine's scheduler
decisions are ATOMIC CLAIMS, so replicas do not duplicate work:

- a due pipeline's clock advance is a compare-and-set on `next_run_at`; one
  replica wins the tick, the rest skip it;
- a due retry claims `retrying → queued` with one winner;
- run finalisation claims the terminal status from a live one exactly once,
  so chains, alerts, lineage and crawls cannot double-fire even if the
  result callback and the orphan reaper race.

Requirements for a multi-replica deployment: all replicas share the same
database and the same runtime backend; sticky sessions are not needed
(result callbacks and trigger/ingest endpoints work on any replica). The one
per-host concern is the egress allowlist files, which each Docker host's
squid reads locally — apply egress changes on every host (the k8s backend
carries egress policy in its own manifests).

## Credentials

Connections are the ones the rest of the product governs: Data Catalog storage
sources (AWS, MinIO, R2, Spaces, B2) and warehouse connections — including
IAM-granted shared connections, resolved through the same
`loadWarehouseConnectionForUser` path BI uses. Each graph node's credentials
resolve at run start under its own env stem (`envKey(nodeId)` → `ETL_<NODE>_URL`,
`ETL_<NODE>_ACCESS_KEY_ID`, …); storage access stays scoped to the source's
configured bucket prefix. Code-mode pipelines keep the documented `ETL_DEST_*`
contract from the pipeline-level destination. User bindings
(`KEY={{secret:NAME}}`) ride along; one that fails to resolve is dropped rather
than fatal, so the code that needed it reports a missing variable.

## Scheduling and triggering

Hourly/daily/weekly schedules are swept by the same dispatcher that drives BI refreshes
and catalog crawls (`processDueEtlPipelines` in `src/utils/etl/schedule.server.ts`,
hooked into `runCronPass`), under the shared cron lease — N app replicas produce one
sweep. `next_run_at` advances **before** the run starts: an overrunning pipeline skips a
beat instead of queueing a backlog behind itself.

External systems trigger through `POST /api/etl/run` with a per-pipeline bearer token
(minted in Settings, stored as SHA-256, shown once). One 404 covers "no such pipeline",
"no token minted" and "wrong token" — distinguishing them would tell a token guesser
which ids exist. `ETL_TRIGGER_PER_MIN` (default 6) rate-limits per pipeline, counted in
Postgres so the ceiling holds across replicas.

## Operability: retries, cron, params, chaining, incremental

The run engine owns the operational behaviours a mature ETL tool is judged on:

- **Retries** — up to 5 per pipeline, exponential backoff from 1 minute,
  engine-owned (`failOrRetry` in `src/utils/etl/service.server.ts`). Both
  failure paths — a sandbox error and a launch that could not start — converge
  on the same ladder, attempts reuse one run row (logs accumulate per attempt),
  and the failure notification fires only when the ladder is exhausted. The
  retry sweep rides the shared cron lease in `schedule.server.ts`.
- **Cron schedules** — five-field expressions in an IANA timezone
  (`src/lib/cron.ts`, no dependency): Vixie OR-rule day matching, `*/n` steps,
  DST via Intl. Validation happens at save; a snapped quarter-hour stride keeps
  next-occurrence exact in :30/:45-offset zones (Kolkata is a test case).
- **Overlap policy** — refused by default across ALL triggers while a run is
  queued/running/retrying; `allow_concurrent` opts a pipeline out.
- **Parameters** — `default_params` merged under per-run params (UI dialog or
  trigger body), pinned on the run row, delivered to `entrypoint(inputs)` via
  the existing `NB_INPUTS` plumbing. Backfills are parameterised runs.
- **Chaining** — `run_after` starts a pipeline on another's success; cycles are
  refused at save (`etl.functions.ts` walks the chain), and the child's own
  overlap guard prevents storms.
- **Engine-managed incremental** — source nodes carry
  `incremental.cursor_column`; the compiler emits a pushed-down `WHERE` (DB)
  or a row filter (storage) reading `ETL_<NODE>_CURSOR`, reports the new
  maximum in `metrics.watermarks`, and finalize persists it to
  `etl_pipeline_state` AFTER the durable load — crash-safe in the
  re-read-not-skip direction. Empty reads keep the previous cursor.
- **Live logs** — the batch runner streams captured stdout to the result
  callback every 5 s (`{"partial": true}`); the run row's logs update while
  running and the Logs dialog tails them. **Changing the runner requires an
  image rebuild**: `docker compose --profile notebooks build`.

Verified live (no sandbox required for most of it): the retry ladder walked to
exhaustion with correct attempt counts and audit events
(`etl.run.retry_scheduled` ×2 → `etl.run.failed`), overlap refused during
backoff, chain fired on success, and the full incremental circle ran against
MinIO — 308 rows, watermark persisted, cursor re-injected by `resolveRunEnv`,
second run loaded 0.

## Governance

- **RLS on both tables** (`etl_pipelines`, `etl_runs`); runs are readable by their
  owner and written only by the server, so a client cannot forge a "succeeded" row.
- **Audit events** on create, update, delete, run start and run outcome
  (`etl.pipeline.*`, `etl.run.*`).
- **AI generation** goes through the caller's own provider and the shared model
  picker, so IAM model allow-lists apply. Drafts are text in an editor until reviewed,
  saved and run.
- **Concurrency**: three runs per account at once; batch CPU/memory/time ceilings come
  from the runtime settings like every other batch kernel.

## Sample pipelines

Six worked scenarios ship in `src/lib/etlTemplates.ts`, offered by the New
pipeline dialog: a medallion branch-out (three targets from one source), an
orders/payments reconciliation (outer join + defect classification), SCD Type 2
(history with validity ranges, computed by reading the destination back), an
incremental watermark load (state persisted in the destination bucket), fuzzy
contact dedupe (canonical match keys + survivorship), and clickstream
sessionization (30-minute-gap windowing). They run against deterministic messy
datasets in `public/etl-samples/` — every defect in that data is deliberate and
counted, and the scenarios were verified end-to-end against those counts (the
reconciliation recovers exactly the 25 missing / 12 mismatched / 6 duplicated
payments the generator planted). `tests/unit/etlTemplates.test.ts` keeps the
templates compiling and the datasets present.

## Local development with MinIO

The stack is testable end to end with nothing but a MinIO binary:

```bash
# 1. Run MinIO (any S3-compatible store works the same way)
minio server ./minio-data --address :9000

# 2. In the app: Data Catalog → Sources → add an object-storage source
#    endpoint http://127.0.0.1:9000, bucket "etl", path-style on,
#    credentials minioadmin/minioadmin (the dev defaults).

# 3. ETL Pipelines → New pipeline → pick that source as destination → Run now.
```

The loaded Parquet appears under `etl/<dataset>/<table>/`, the post-run crawl registers
it as catalog assets, and BI object-store queries can read it immediately.

**Two things the first real sandbox run teaches** (both verified live, the hard
way):

1. **The endpoint must be reachable from inside a container.** `127.0.0.1`
   points at the sandbox itself — bind MinIO to `0.0.0.0` and use the host's
   LAN address (e.g. `http://192.168.1.85:19000`) in the catalog source, so the
   host-side crawler and the kernels resolve the same thing.
2. **The kernel egress proxy must allow it.** Kernels reach the network only
   through the default-deny squid proxy. Add the MinIO address under
   Admin → Developer runtime → Egress allowlist; raw IPs are written to a
   separate `allowed_ips` (squid `dst`) file because `dstdomain` never matches
   an IP-form URL, and squid's `Safe_ports` includes 9000/19000 for object
   stores. The proxy restarts on save.

## Files

| Piece                                        | Where                                                  |
| -------------------------------------------- | ------------------------------------------------------ |
| Visual graph → Python compiler               | `src/utils/etl/codegen.ts`                             |
| Run lifecycle, env resolution, log scrubbing | `src/utils/etl/service.server.ts`                      |
| Schedule sweep                               | `src/utils/etl/schedule.server.ts`                     |
| RPC for the page                             | `src/utils/etl.functions.ts`                           |
| AI generate/refine                           | `src/routes/api/etl.generate.ts`                       |
| External trigger                             | `src/routes/api/etl.run.ts`                            |
| UI                                           | `src/routes/_authenticated/etl.tsx`                    |
| Schema                                       | `supabase/migrations/20260834000000_etl_pipelines.sql` |
| Tests                                        | `tests/unit/etlPipelines.test.ts`                      |

The compiler treats every user string as an injection surface (`pyStr`/`pyIdent` — the
discipline the agent/swarm exporters learned the hard way), and its tests feed every
generated script to CPython's `compile()` rather than trusting shape checks.

## Known limits

- **Destinations are object storage.** Warehouse destinations mean handing the sandbox
  warehouse credentials, which deserves its own design rather than a checkbox. Land
  Parquet and query it, or use prep flows for in-warehouse transforms.
- **First run pays cold start + pip install** (a couple of minutes for the dlt stack).
- **Merge mode is dlt's merge on object storage** — correct, but not a warehouse
  MERGE; heavy upsert workloads belong in a warehouse.
