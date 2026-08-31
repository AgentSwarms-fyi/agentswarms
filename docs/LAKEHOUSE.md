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
warm result. The cache is per-replica and in-memory: a restart simply re-earns
it, and replicas never need to coordinate.

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

**The engine runs inside each app process**, so its memory limit is per
replica: eight replicas at 16 GB is 128 GB of intent, not 16. Size it against
`host RAM ÷ replicas`, and at larger scales consider keeping one or two
replicas with a high limit out of the request path, since a heavy analytical
query and a user request otherwise compete inside the same process. Worked
numbers are in
[System requirements § Sizing ETL and the lakehouse](./SYSTEM_REQUIREMENTS.md#3a-sizing-etl-and-the-lakehouse).

Two per-replica behaviours are worth knowing when you scale out. The result
cache is local to each replica, so the same query behind a round-robin load
balancer may be a hit on one replica and a miss on another — correctness is
unaffected (the snapshot id is in the key), only the timing varies. And spill
files are local disk: give each replica real scratch space, not a tmpfs sized
for a container's RAM.

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
