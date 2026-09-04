# Lakehouse

The built-in columnar warehouse: DuckDB attached to a **DuckLake** catalog.
Use it wherever you would reach for a data warehouse — fast analytical SQL
over tables you own — with the lakehouse architecture underneath: open
Parquet in your own object storage, a transactional catalog in Postgres, and
stateless compute on every app replica.

```
   app replica 1 ─┐            ┌─► Postgres catalog (schemas, tables,
   app replica 2 ─┼─ DuckDB ───┤    file manifests, snapshots — ACID)
   app replica N ─┘  (per      └─► Object storage (zstd Parquet data files)
                     request)
```

## Configuration

Two pieces of shared infrastructure, both named in `.env`:

| Variable                                      | What it is                                                   |
| --------------------------------------------- | ------------------------------------------------------------ |
| `LAKEHOUSE_CATALOG_URL`                       | Postgres every replica can reach (`postgres://u:p@host/db`)  |
| `LAKEHOUSE_DATA_URL`                          | Object-storage prefix for table data (`s3://lakehouse/main`) |
| `LAKEHOUSE_S3_ENDPOINT`                       | `host:port` for MinIO/R2/etc.; omit for AWS S3               |
| `LAKEHOUSE_S3_KEY_ID` / `LAKEHOUSE_S3_SECRET` | Credentials for that prefix                                  |
| `LAKEHOUSE_S3_URL_STYLE`                      | `path` for MinIO, `vhost` for AWS                            |
| `LAKEHOUSE_S3_USE_SSL`                        | `false` for plain-HTTP local MinIO                           |

The compose `lakehouse` profile ships a catalog Postgres
(`lakehouse-catalog`); any Postgres 12+ works, including a self-hosted
Supabase's own database. Unset variables leave the feature off — the page
says so instead of half-working.

One implementation detail that is LOAD-BEARING: the engine attaches with
`ducklake:postgres:<libpq>`. Without the `postgres:` prefix DuckLake treats
the string as a file path and silently creates a single-writer duckdb-file
catalog — the exact opposite of this design. A wiring test pins the prefix.

### The catalog must be reachable from the notebook network

An ETL pipeline with a **lakehouse target** attaches DuckLake from inside a
notebook kernel, not from the app. Kernels run on `nb-internal`, a Docker
network with `internal: true` — no route off it — and reach the outside world
only through the HTTP egress proxy. Parquet is HTTP and goes through the proxy;
**the catalog is a raw Postgres TCP connection and cannot**. So the catalog has
to be on the kernel's network, not merely reachable from the app:

- **Compose users**: nothing to do. `lakehouse-catalog` joins `nb-internal`, and
  `LAKEHOUSE_CATALOG_URL` should name it by service — `lakehouse-catalog:5432`,
  not a host IP or a published port, neither of which an internal network can
  route to.
- **External catalog** (managed Postgres, another host): kernels cannot reach it
  at all. Either attach that host's container to `nb-internal`, or move kernels
  to a network that has a route with `NOTEBOOK_NETWORK=<network>` — weaker
  isolation, because egress control then rests on the proxy environment
  variables alone rather than on the network.

The symptom when this is wrong is `connection to server at "…" failed: Network
is unreachable` in the pipeline run log. It appears **only in production**: under
`npm run dev` the orchestrator places kernels on the routable `nb-dev` network
instead, so the whole class of failure is invisible in development.

## What you get

- **Warehouse SQL** — full DuckDB: joins, window functions, CTEs, `SUMMARIZE`,
  vectorised columnar execution. zstd-compressed Parquet storage.
- **ACID row operations** — `INSERT`/`UPDATE`/`DELETE`/`MERGE` commit through
  the catalog; every commit is a **snapshot** you can time-travel-query
  (`SELECT … FROM t AT (VERSION => n)` — one click in the table view).
- **Schemas as the unit of ownership and sharing** — create them in the UI,
  share them from Admin → IAM (`lakehouse_schema` grants). Grantees query and
  write; only owners drop.
- **NL→SQL** — ask in plain language; the model sees only schemas you can
  access, the draft is shown for review, and the run goes through the same
  governed path as typed SQL.
- **Imports** — any platform dataset (uploads, prep outputs, connector-synced
  tables, samples) becomes a lakehouse table with inferred types.

## Querying your data lake

**Mount data lake** turns a crawled object-storage source into a read-only
lakehouse schema: one view per dataset, each reading its files in place. No
copying, no path handling — and you can join lake files against lakehouse
tables in a single query:

```sql
SELECT r.customer, r.total, count(o.order_id) AS lake_orders
FROM analytics.orders_rollup r          -- lakehouse table (Parquet + catalog)
LEFT JOIN raw_lake.orders o             -- raw files in object storage
  ON o.customer_id = r.customer
GROUP BY 1, 2;
```

How it stays governed: the `read_parquet` / `read_csv_auto` / `read_json_auto`
calls live inside **server-authored view bodies**, never in user SQL — the
query governor still refuses table functions typed by a user. Each mount gets
its own S3 secret **scoped** to that bucket and prefix, so a view over source A
cannot read source B. Mounts are read-only: writes to them are refused with a
message saying so, because the bytes belong to the storage source.

Mounting requires the source to have been crawled in the Data Catalog (that is
where the dataset list and formats come from). Parquet, CSV and JSON/NDJSON
datasets become views; anything else is skipped and counted in the result.

## Making queries fast

Four levers, in the order they usually matter.

**Partitioning.** `Partition` on a table's toolbar picks up to four columns;
DuckLake then writes one file set per partition value, and a query filtering
on those columns opens only the matching files. Pick columns with few distinct
values — a date, a region, a tenant. Never a high-cardinality id: that writes
a file per row and makes everything slower. Partitioning applies to files
written from then on, so run maintenance (or rewrite the table) to re-lay what
already exists. The setting is read back from DuckLake's own catalog rather
than from anything the app recorded, so a partition applied from the SQL
editor shows up in the UI too.

**The result cache.** A repeated SELECT is served from memory and marked
`cached` in the toolbar and in history. The cache key includes the catalog
snapshot id, so **any write invalidates it automatically** — there is no TTL
to tune and no way to read a stale answer after an insert. It is keyed per
user and consulted _after_ the access check, so a revoked grant cannot read a
warm result. The cache is in-memory and per worker process — the app runs one
worker per CPU, so a repeat only hits when it lands on the same worker. That
costs hit rate, never correctness: a miss just re-runs the query, and workers
never need to coordinate.

**`Explain`.** Runs `EXPLAIN ANALYZE` and shows the plan the engine chose plus
what it cost — rows scanned, engine time, rows returned. "Rows scanned" is the
number to watch: if it is close to the whole table on a filtered query, the
filter is not matching a partition key. Only SELECTs can be profiled, because
`EXPLAIN ANALYZE` executes the statement.

**Cached file metadata.** Reading remote Parquet costs a footer round trip per
file per query. The engine caches that metadata, which measured ~20% faster
across _different_ queries over the same files — the case the result cache
doesn't cover — and noticeably steadier (231/233/239 ms versus 252/290/320 ms).
It is safe because DuckLake never rewrites a data file: a write adds new
UUID-named paths and the catalog decides which are live, so the content behind
a cached path cannot change. Foreign files behind a lake mount _can_ be
overwritten, and that case was checked separately — the engine validated the
entry and returned the new content. Two neighbouring settings were measured and
deliberately left off: HTTP metadata caching was slower and less consistent, and
Parquet prefetching bought nothing. Disable with `LAKEHOUSE_METADATA_CACHE=false`.

**Memory and spill.** Both of the engine's sizing knobs are editable under
**Admin → Developer runtime → Compute resources**, which takes precedence over
the environment variables below — so you can retune a running deployment
without a redeploy, and neither is capped by the application.

Each engine gets `LAKEHOUSE_MEMORY_LIMIT` (default 2GB)
and spills past it to a temp directory bounded by `LAKEHOUSE_SPILL_LIMIT`
(default 20GB). Both are set together deliberately: DuckDB's behaviour with a
memory limit and _no_ temp directory is to fail the query rather than spill, so
a large GROUP BY would error instead of running slower. Set the memory limit to
roughly half a container's RAM, since several requests can hold an engine at
once.

## Materialized views

A query whose answer is worth keeping becomes a table. **Save as view** in the
query editor stores the result and rebuilds it on a schedule — manual, hourly,
daily or weekly — so dashboards read stored rows instead of recomputing.

The result is an ordinary lakehouse table: queryable, joinable, partitionable,
and governed by the same chokepoint as everything else. What the view record
adds is the definition, the schedule, and how the last rebuild went.

Three properties are worth knowing, because they decide how it behaves when
something goes wrong:

- **A rebuild is one commit.** It runs as `CREATE OR REPLACE TABLE … AS
<query>`, so anyone querying during a rebuild sees the old rows or the new
  ones, never a half-built table.
- **A failed rebuild keeps the previous data.** Stale rows a user can see and
  diagnose beat an empty table. The failure is recorded on the view and shown
  in the UI.
- **The definition is re-checked every time, not just when saved.** A grant
  revoked since then stops the refresh, and a definition edited into a write is
  refused rather than executed.

Refreshes run as the view's **owner**, since a schedule has no session behind
it, and ride the same sweep as BI refreshes and ETL schedules — with the same
compare-and-set claim, so every replica can run the sweep without any view
being rebuilt twice.

Removing a view forgets the definition and **leaves the table**. Deleting
someone's data because they removed a schedule would be the wrong default; drop
the table yourself if you want it gone.

## Row and column security

A grant gives someone a whole schema. A **policy** narrows what they see inside
one table: which rows, and which column values. Set it from a table's
**Security** button — only the schema's owner sees that button, and only they
can author the rule.

| Setting                 | What it does                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------- |
| Rows they can see       | A condition over the table's own columns. Empty means all rows                                          |
| Columns they can't read | Values are replaced before the reader ever sees them                                                    |
| Blank / Scramble        | Blank empties any column type; Scramble hashes text so it stays groupable and joinable while unreadable |

Two placeholders make one rule serve everybody: `@me` becomes the reader's
email address and `@user_id` their user id, both as escaped literals. So
`owner_email = @me` on a shared table gives each person exactly their own rows.

**The owner is never filtered.** A rule its author cannot see through would be
impossible to check, so policies apply to grantees only.

**A policed table is read-only for everyone but its owner.** A reader who sees
part of a table must not be able to update or delete the parts hidden from
them — they could destroy rows they can't even see.

### How it is enforced

DuckDB has no per-user ACLs, so the policy cannot be handed to the engine.
Instead the server rewrites the reader's SELECT before it runs: each reference
to a policed table becomes a subquery carrying the filter and the masks.

The rewrite happens on **the AST DuckDB itself produced** — serialized out,
substituted, deserialized back — not on the SQL text. That distinction is the
whole security argument: text rewriting can be defeated by comments, casing,
aliases, or a name reached through a CTE, while the parser sees through all of
it. Verified live against six evasion shapes (CTE, alias, subquery, self-join,
comments-and-casing, UNION arm), all of which stayed filtered, plus an
aggregate over a masked column, which returned no values.

If the rewrite cannot be completed for any reason, the query is **refused**.
The one failure this must never have is running unfiltered.

A filter is validated against the real table when you save it, so a typo is
caught at authoring time rather than by blocking every reader at once.

## Concurrent writes

Two replicas writing at once is the case a shared catalog has to get right, so
it was measured rather than assumed, with two genuinely independent engines
attached to the same catalog:

| Situation                          | What actually happens                                                                                                 |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Concurrent appends to one table    | Both commit — each writes its own Parquet files                                                                       |
| Concurrent writes to the same rows | One commits; the other's commit **fails**                                                                             |
| The failed commit                  | Applies **nothing** — verified with a 500-row insert bundled into the losing transaction, of which zero rows survived |

That atomicity is what makes recovery safe. Because this chokepoint runs
exactly one autocommit statement per request, a failed commit means the
statement did not happen — so re-running it applies it exactly once, never
twice. A losing write is therefore retried automatically
(`LAKEHOUSE_WRITE_RETRIES`, default 3) on a **fresh connection**, because
retrying on the snapshot that just lost would simply lose again. Retries use
exponential backoff with jitter so two replicas that collided do not line up
and collide again.

DuckLake also retries internally within a single attempt
(`LAKEHOUSE_COMMIT_RETRIES`, `LAKEHOUSE_COMMIT_RETRY_WAIT_MS`); the two layers
address different failures — theirs a transient commit race, ours a stale
read-modify-write that only a fresh catalog read can fix.

Every retry is counted in query history, so a table under contention is
visible as rising retry counts long before users see failures. If retries are
exhausted, the user gets a plain message saying the statement was rolled back
and nothing was applied — not the engine's `Failed to commit DuckLake
transaction`.

## Maintenance and compaction

An hourly pass (riding the same scheduler sweep as BI refreshes and ETL
schedules) keeps the lakehouse fast and small, in the only safe order:

| Step               | What it does                                                  |
| ------------------ | ------------------------------------------------------------- |
| `flush_inlined`    | Writes rows still held in the catalog out as zstd Parquet     |
| `merge_files`      | Merges adjacent small files — the biggest lever on scan speed |
| `expire_snapshots` | Retires snapshots older than 7 days                           |
| `cleanup_files`    | Deletes files only those expired snapshots referenced         |

Each step is independent: one failing is logged and the rest still run, because
a half-maintained lakehouse still answers queries correctly. Any replica may
run the pass — the steps are idempotent and DuckLake serialises them through
the catalog. Verified live: all four steps ran clean and inlined rows became
real Parquet files, with row counts unchanged.

## When the catalog and the object store disagree

A DuckLake table is two things: rows of metadata in the catalog Postgres, and
Parquet objects in your object storage. **Nothing keeps them together.** Replace
the object store, empty a bucket, or restore a catalog backup taken on a
different day, and the catalog goes on confidently describing files that are no
longer there.

The dangerous part is how quiet that is. `count(*)` on a DuckLake table is
answered from `ducklake_data_file.record_count` — **without reading a single
Parquet** — so a table whose data has vanished still reports its full row count
and looks healthy in the table list. Measured on an instance whose MinIO had
been replaced while the catalog survived on its own volume:

| Table                     | `count(*)` | `SELECT *` |
| ------------------------- | ---------- | ---------- |
| `analytics.f1_standings`  | 21 rows    | HTTP 404   |
| `analytics.orders`        | 4 rows     | HTTP 404   |
| `analytics.revenue_facts` | 836 rows   | fine       |

Two of those tables could not be read at all, and the only outward sign was a
404 when somebody opened one.

So the Lakehouse page checks. After the table list loads it lists the object
store once, compares it against the live data files the catalog claims, and
marks any table whose objects are missing — with the count of unreadable rows
rather than the metadata row count, which is exactly the number that would
otherwise reassure you. The check is best-effort and never blocks the page.

Two deliberate limits. Superseded files are skipped (they are _supposed_ to be
absent after compaction, and reporting them would make every compacted table
look broken), and a listing that hits its ceiling reports **nothing** rather
than guessing — a check that cries wolf gets ignored, and then it is worth
nothing.

There is no automatic repair, because there is no correct one: the rows are
gone. Re-import the table from its source, or drop it.

## Governance — how access control actually works

DuckDB has no per-user ACLs, so the server enforces everything BEFORE SQL
reaches the engine, at one chokepoint (`runLakehouseStatement`):

1. **One statement per request**, classified select / DML / DDL. Anything
   else — `ATTACH`, `COPY`, `SET`, `PRAGMA`, `INSTALL`, transactions — is
   refused by construction.
2. **SELECTs are parsed to an AST** with DuckDB's own `json_serialize_sql`;
   every base-table reference must resolve to a schema the caller owns or
   holds a grant on. CTE names are exempt; unqualified table names are
   refused as ambiguous; table functions (`read_parquet`, `postgres_scan`,
   …) are refused because the engine-level S3 secret would otherwise let any
   user read any path the deployment can (pure generators like `range` pass).
3. **Writes must be schema-qualified** and target an accessible schema.
4. Row caps (10k default) and an interrupt-based timeout bound every query.

Every statement — refusals included — lands in the user's **query history**
and in the platform **audit trail** (`lakehouse.select|dml|ddl`,
`lakehouse.schema.create|drop`, `lakehouse.import`, `lakehouse.nl2sql`).

## ETL pipelines

Pipelines read and write the lakehouse with dedicated **Lakehouse table**
source and target nodes. The sandbox attaches the same DuckLake catalog the
app uses (credentials arrive as env, resolved server-side — never in code
text), so a pipeline's writes are ordinary ACID commits that other readers see
immediately. Targets support replace, append and merge (upsert as
delete-then-insert in one transaction). Schema access is checked server-side as
the **pipeline's owner** before the run starts, so naming a schema in a graph
grants nothing.

Two sandbox facts the implementation had to respect, both found by running it:
the kernel's HOME is read-only (so DuckDB's default `~/.duckdb` extension
directory fails) and `/tmp` is mounted `noexec` (so an extension downloaded
there cannot be mapped) — `~/.local` is the one path that is both writable and
executable. The kernels also need `.duckdb.org` on the egress allow-list to
fetch the ducklake/postgres/httpfs extensions; without it a run fails with
"Failed to download extension (HTTP 403)", which is squid refusing it, not
DuckDB.

## Scaling behind a load balancer

The lakehouse is stateless by construction: each request opens an ephemeral
DuckDB, attaches the shared catalog + storage, runs, closes. App replicas
need no coordination — writes serialise through the Postgres catalog's ACID
commits (a conflicting concurrent commit fails cleanly and can be retried).
Requirements: all replicas share the same `LAKEHOUSE_*` values, and the
catalog Postgres and object store are reachable from every replica.

The ceilings are the same single-node honesty as ETL: one query's working
set lives on one replica (vectorised execution + file pruning is the speed
story, not a cluster), and cold reads pay object-storage latency. Small
inserts are held **inlined** in the catalog until flushed — that is why a
fresh table can show real row counts with `0 B` of Parquet.

**The engine runs inside each app PROCESS**, and the app forks one worker
process per available CPU — so the memory limit multiplies by workers first and
replicas second. A single 16-core host set to 16 GB is **256 GB of intent, not
16**. Size it against `host RAM ÷ workers`, not `÷ replicas`; `WEB_CONCURRENCY`
is what sets the worker count
([Deployment § Scale up before you scale out](./DEPLOYMENT.md#scale-up-before-you-scale-out)).

The limit is a ceiling, not a reservation — an idle worker holds nothing, so
the multiplied figure is the worst case of every worker running a heavy query at
once, not steady-state usage. It is still the number to size against, because
that worst case is what an OOM kill needs.

At larger scales, give the heavy work its own nodes: **`APP_ROLE=analytics`**
holds a node out of the interactive pool (it reports not-ready to the load
balancer while staying alive) and defaults it to a single worker, so a large
memory limit means what you meant by it. Otherwise a thirty-second `GROUP BY`
and a page render compete inside the same process. See
[Deployment § Analytics-only nodes](./DEPLOYMENT.md#analytics-only-nodes).
Worked numbers are in
[System requirements § Sizing ETL and the lakehouse](./SYSTEM_REQUIREMENTS.md#3a-sizing-etl-and-the-lakehouse).

Two process-local behaviours are worth knowing when you scale. The result cache
belongs to a single worker process, so the same query may be a hit on one worker
and a miss on the next — true across replicas behind a load balancer and equally
true across workers inside one replica. Correctness is unaffected (the snapshot
id is in the key), only the timing varies. And spill files are local disk: give
each replica real scratch space, not a tmpfs sized for a container's RAM.

## Use cases

### Ask a question in plain language and keep the SQL

An analyst wants totals by customer from a table they have never queried.

1. Open **Lakehouse**, pick the table from the schema list (the search box
   filters schemas and tables), and switch to **Query**.
2. Type the question in the _Ask in plain language_ box — for example
   _total amount by customer, largest first_. The generated SQL is shown and
   run; edit it like any other statement.
3. Open the plan (_Show the plan the engine chose and what it actually cost_)
   when a query is slow. Results that came from the result cache are marked;
   the cache is invalidated automatically by any write, so a cached answer is
   never stale.

Every read the analyst's agents make later on carries a decision id and the
snapshot that was current, so the same answer can be replayed as of that
moment — see [Decision provenance](./PROVENANCE.md).

### A table whose files are gone

Someone emptied a bucket prefix by hand. The catalog still lists the table;
queries fail.

1. The table shows a **Missing data files** marker in the schema list, and
   [When the catalog and the object store disagree](#when-the-catalog-and-the-object-store-disagree)
   explains what the marker means and what can still be recovered.
2. If the data is gone for good, open the table's tab and choose **Drop**. A
   dialog asks _Drop table schema.table?_ and the drop proceeds through the
   catalog even though the files cannot be read — the catalog is the source of
   truth for what exists.
3. Anything that still needs the rows is restored from a backup (below) rather
   than from the catalog.

### Answer as of last week

A dashboard number changed and the owner wants to know whether the data moved
or the query did.

1. Open the trace of the original answer under **Traces**; its Provenance
   section names the lakehouse snapshot that was current.
2. Use the trace's Replay control. The recorded reads run again **as of that
   snapshot** (the result must match the recorded fingerprint) and against
   **today's** data (a difference here means the world moved on). The
   **History** tab on the lakehouse page lists the snapshots a table has been
   through.

### Back it up and prove the backup works

The catalog and the Parquet are two separate things; a backup of one without
the other is a lakehouse that cannot be read.

```bash
npm run backup
npm run restore -- backups/<timestamp> --drill
```

The drill restores the catalog dump into a scratch database and the Parquet
into a scratch prefix, checks what came back, removes both and prints
`DRILL PASSED`. Full runbook in
[DEPLOYMENT.md → Backups and restore](./DEPLOYMENT.md#backups-and-restore).

## Verified live

The governance suite (19 checks) runs the real engine, catalog and object
store: DDL/DML/SELECT round trips, CTEs, row caps, ten distinct refusal
paths, history + audit rows, snapshot commits. A further 26 checks cover the
performance surfaces against the same live stack: spill settings actually
applied to the engine, cache miss → hit → invalidated-by-write, cache bypass,
partition round trip read back from DuckLake's metadata, writes into a
partitioned table, and the security case that matters — a user whose grant is
revoked between two identical queries is refused rather than served the warm
result. Concurrency was proven the same way: a contending engine was made to
win the commit race, and the losing statement retried on a fresh snapshot and
landed exactly once, with the retry counted in history. Row and column security
was proven with a real second user holding a real grant, across 21 checks:
`@me` binding, masked values (including through aggregates), six evasion
shapes, write refusal, cache correctness, hash masking, and the audit trail.
Materialized views were verified across 18 checks including the two that
matter: a broken definition failed without destroying the previous data, and a
write disguised as a definition was refused without running. Two concurrent
sweeps over one due view refreshed it exactly once. The UI flow was exercised
end-to-end: schema and table creation, inserts, aggregation queries, NL→SQL
draft-review-run, dataset import, snapshot time travel, IAM grant listing,
and the audit page showing the events.
