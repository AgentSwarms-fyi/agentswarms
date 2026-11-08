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

| Variable                                      | What it is                                                         |
| --------------------------------------------- | ------------------------------------------------------------------ |
| `LAKEHOUSE_CATALOG_URL`                       | Postgres every replica can reach (`postgres://u:p@host/db`)        |
| `LAKEHOUSE_DATA_URL`                          | Object-storage prefix for table data (`s3://lakehouse/main`)       |
| `LAKEHOUSE_S3_ENDPOINT`                       | `host:port` for SILO/MinIO/R2/etc.; omit for AWS S3                |
| `LAKEHOUSE_S3_KEY_ID` / `LAKEHOUSE_S3_SECRET` | Credentials for that prefix                                        |
| `LAKEHOUSE_S3_URL_STYLE`                      | `path` for SILO and MinIO, `vhost` for AWS                         |
| `LAKEHOUSE_S3_USE_SSL`                        | `false` for the plain-HTTP bundled store                           |
| `LAKEHOUSE_CATALOG_CONNECTIONS`               | Catalog sessions one app worker may hold (default 8); see Scaling  |
| `LAKEHOUSE_SSE_KMS`                           | `auto` (default), `on` or `off`: files under customer keys (below) |

Compose ships a catalog Postgres (`lakehouse-catalog`) and starts it with
everything else; any Postgres 12+ works instead, including a self-hosted
Supabase's own database. It is a separate database rather than the
application's for two reasons, both of which are about how it is reached:
DuckLake attaches over a **raw Postgres connection** rather than the HTTPS
API the rest of the app uses, so a pool of those sessions would land on the
application's database and grow with every worker and replica; and an ETL
pipeline writing a lakehouse table attaches it **from inside a notebook
kernel**, which sits on a network with no route off it (see below). Unset
variables leave the feature off — the page says so instead of
half-working.

### The bundled object store is SILO

Compose and the Kubernetes manifests ship [SILO](https://github.com/pgsty/silo)
(`pgsty/silo`, with its client `pgsty/mc`), a maintained fork of the MinIO
server, AGPL-3.0 like MinIO itself. Until R418 they shipped MinIO, and MinIO
stopped publishing images anyone can pull: Docker Hub's `minio/minio` is gone
and quay.io answers 401 to an anonymous pull, so a fresh install failed at the
object store, and the cached build could never be patched (VA-2026-10-25-35).

SILO keeps the S3 API, the `MINIO_*` settings, the `/minio/health/*` paths and
the on-disk format, so nothing about your install changes: the service is still
called `minio`, `LAKEHOUSE_S3_ENDPOINT="minio:9000"` still points at it, and
`docker compose pull && docker compose up -d` (or the installer) replaces the
container in place on the same `lake-data` volume. On Kubernetes the StatefulSet
keeps its name and its PVC, so the new image is a rolling restart.

What was measured before the switch, on a volume MinIO wrote and then SILO
opened (`pgsty/silo:RELEASE.2026-10-26T00-00-00Z`):

- every object read back with the same size, ETag and SHA-256, including an
  empty one, a 40 MB multipart one and a key with a space and an accent;
- versioning, every version id, the oldest version's bytes, object tags and a
  public-read bucket policy, all unchanged;
- a user with a read-only policy could list and was refused a write, its
  service account worked, a wrong password was refused, and `mc admin info`
  answered;
- SILO wrote new multipart objects and versions, and survived a restart;
- going back works too: MinIO opened the volume SILO had written and read
  SILO's objects;
- the lakehouse's own calls, run by `tests/unit/objectStoreLakeLive.test.ts`
  against SILO: signed PUT, HEAD, LIST (past one page) and DELETE, presigned
  URLs refused for another method, another key or after expiry, STS AssumeRole
  scoped to prefixes (refused outside them), and DuckDB writing and reading
  Parquet with that scoped credential;
- the Kubernetes pod settings (uid 1000, no capabilities): SILO started on a
  PVC MinIO had written as uid 1000.

If you run your own MinIO, nothing here applies to it: point `LAKEHOUSE_S3_*`
at it as before.

If a query against an HTTPS object store fails with **"Problem with the SSL
CA cert (path? access rights?)"**, the container running the engine has no
CA certificate bundle. The published app image ships one (`node:22-slim`
does not, and Node's own root store hides the gap from everything but
DuckDB's native httpfs); a custom base image needs `ca-certificates`
installed, or `LAKEHOUSE_S3_USE_SSL=false` for a plain-HTTP endpoint.

One implementation detail that is LOAD-BEARING: the engine attaches with
`ducklake:postgres:<libpq>`. Without the `postgres:` prefix DuckLake treats
the string as a file path and silently creates a single-writer duckdb-file
catalog — the exact opposite of this design. A wiring test pins the prefix.

### Only the app reaches the catalog

A sandbox, meaning an ETL run, a node preview, or an ML training or prediction,
holds no lakehouse credential (`sandboxLake.server.ts`). It asks the app for
what its run declared. The app runs the declared reads as the run's owner,
under the same governance as the SQL editor. It also commits the run's staged
writes into the declared targets. So the catalog has one client, the app, and
must be reachable from the app's network and from nothing a kernel can reach.

- **Compose**: `lakehouse-catalog` is on `default` only (R412, VA-42). It used
  to join `nb-internal`, the kernels' network, from when ETL kernels attached
  DuckLake themselves. There it was a Postgres every notebook could reach. An
  install that kept the `change-me` default handed notebooks the lakehouse's
  metadata.
- **External catalog** (managed Postgres, another host): reachable from the app,
  and not on `nb-internal`. An earlier version of this page told you to attach
  such a catalog's container to `nb-internal`. If you did, attach it to the
  app's network instead, then detach it, in that order so the app never loses
  it:

  ```bash
  docker network connect agentswarms_default <catalog-container>
  docker network disconnect agentswarms_nb-internal <catalog-container>
  ```

  The first network's name is your Compose project's default network. List them
  with `docker network ls`.

- **Kubernetes**: kernel pods may reach only the egress proxy, the app and Spark
  Connect (`kernels-default-deny`), never the catalog.

### Replace the published default credentials

`.env.example` ships two lake credentials that anyone can read: the object
store's `LAKEHOUSE_S3_SECRET` (`agentswarms-lake-dev`, the bundled store's
**root** password) and the catalog's `change-me`. Both services share the
Compose network with `spark-connect`, where Spark pipelines' Python UDFs run.
On either default, one pipeline author can read and rewrite every table,
outside every policy (VA-44). Observability → Monitoring marks a lake service
running on one as degraded.

**The object store.** The installers replace the default secret, on an existing
install too. By hand: put a new value in `.env`, then

```bash
docker compose up -d minio agentswarms
```

The store (SILO, as MinIO did) takes new root credentials when it starts and
keeps its data. Measured:
after a restart with a new password, the bucket and an object were still there,
readable with the new pair, and the old pair was refused. Anything else that
used the old pair needs the new one.

**The catalog.** Postgres reads its password only when its volume is created,
so a changed `.env` alone leaves the database and the app disagreeing. Change it
inside the database first, then in both places in `.env`:

```bash
docker compose exec lakehouse-catalog psql -U lakehouse -d lakehouse_catalog \
  -c "ALTER USER lakehouse PASSWORD 'NEW_PASSWORD'"
```

Set `LAKEHOUSE_CATALOG_PASSWORD` to it, and the password inside
`LAKEHOUSE_CATALOG_URL`, then run `docker compose up -d agentswarms`.

The installers generate the catalog's password only while it has no data
volume. On a catalog that already holds data on `change-me`, they leave `.env`
as it is and print these steps.

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

Five levers, in the order they usually matter.

**Partitioning.** `Partition` on a table's toolbar picks up to four keys;
DuckLake then writes one file set per partition value, and a query filtering
on those columns opens only the matching files. A key is a column's value, or
the column through a transform (R457): `day`, `month`, `year` or `hour` of a
date or timestamp, or a `bucket(N)` hash of anything. Partition a timestamp by
its day, never by its value, and a high-cardinality id by a bucket: a key
with a value per row writes a file per row and makes everything slower. These
are the transforms DuckLake accepts on DuckDB 1.5.5, measured; it refuses
`truncate`, and it accepts `year()` of a text column and means nothing by it,
so the server checks every key against its column's type. A VARIANT, a nested
value or a blob cannot be a key. While keys are picked, the dialog counts how
many partitions today's rows would fall in and how big each would be, and
warns when a spec cuts the table into many small ones: DuckLake writes a file
per partition an insert touches, so on object storage such a spec makes every
insert slow. Measured in R457: `day(ts), bucket(16, id)` on a 498-row table
made 263 partitions, and re-inserting the rows took 150 s against the
development object store (under 4 s on local disk), leaving 2.4 KB files.
Partitioning applies to files written from then on, so run maintenance (or
rewrite the table) to re-lay what already exists. The setting is read back from DuckLake's own catalog rather than from
anything the app recorded, transforms included, so a partition applied from
the SQL editor shows up in the UI too.

**Clustering.** Partitioning decides which file a new row goes to; clustering
decides the order of what is already there. **Layout** on a table's toolbar
shows what DuckLake's own per-file statistics say — for every column, how many
of the table's files a lookup on it opens — beside which columns this week's
queries actually filtered on, and advises: cluster by the column people filter
on whose files overlap, compact when files are small, rewrite again when files
landed since the last rewrite. **Rewrite now** puts the files in key order: the
rows are ranged on the first key at row-count quantiles, one range per
target-sized file, and every range is copied aside sorted by all keys, deleted
and inserted back — one transaction, rolled back whole on any failure, with the
old files dropped at commit and time travel to the previous snapshot intact. A
filter on the key then opens only the files whose range matches; the toast
says how many it opened before and after. Up to four keys; the first one
ranges the files, the rest order rows inside them. A VARIANT, a nested value
or a geometry has no order to cluster on and is not offered. On a partitioned
table a rewrite still writes at least one file per partition. The target file size is per
table (default `LAKEHOUSE_CLUSTER_FILE_BYTES`, else 128 MiB, never capped) —
small on purpose for a demo table, so the effect shows on a few files.
**Keep clustered** hands the table to the hourly maintenance pass, which
rewrites it again whenever files were written since the last rewrite and
leaves it out of file merging (merging concatenates neighbours and would fold
the ranges back together). The keys live in `lakehouse_table_layouts`; a table
clustered from elsewhere would not be known here.

Since R457 a clustered rewrite also records its keys as DuckLake's own sort
order (`ALTER TABLE … SET SORTED BY`, DuckLake 1.0), which DuckLake applies
when it flushes inlined rows to files and when it compacts: the small inserts
that land after a rewrite are written in key order at the next hourly flush,
not in arrival order. Measured on DuckDB 1.5.5: 400 rows inserted in reverse
key order were flushed to one file that reads back in key order. Clearing the
layout resets it. The table tab shows DuckLake's sort when it differs from the
cluster keys, so a sort set from the SQL editor shows up too. The rewrite is
still what ranges the files; the sort only orders what is written after it. Verified live on the compose lakehouse: four files each spanning
the whole key range became five ranged ones and a point lookup went from
opening all four to one; after one more unsorted load the advisor asked for a
rewrite, and the top-of-the-hour maintenance pass rewrote the table on its own
(six files to eight ranged ones, the lookup back to one file) while the
per-table merge folded a clean two-file neighbour into one. A table whose
files carry delete files is not merged, since DuckLake cannot fold those.

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

**Memory and spill.** The engine's memory limit and thread count are editable
under **Admin → Developer runtime → Data platform**, which takes precedence
over the environment variables below — so you can retune a running deployment
without a redeploy, and neither is capped by the application. The spill limit
is environment-only: there is no settings row for it, so changing it needs a
restart.

Each engine gets `LAKEHOUSE_MEMORY_LIMIT` (default 2GB)
and spills past it to a temp directory bounded by `LAKEHOUSE_SPILL_LIMIT`
(default 20GB). Both are set together deliberately: DuckDB's behaviour with a
memory limit and _no_ temp directory is to fail the query rather than spill, so
a large GROUP BY would error instead of running slower. Set the memory limit to
roughly half a container's RAM, since several requests can hold an engine at
once.

## A table's history and what changed

The table tab lists **the snapshots that changed this table**, newest first,
with what each did (created, inserted, deleted, altered), and a click queries
the table as of one. **rows** beside a snapshot that inserted or deleted shows
the rows it changed, from DuckLake's change feed (`ducklake_table_changes`):
what was inserted, what was deleted, and both sides of an update. The feed
starts at the snapshot that gave the table its current name, because DuckLake
looks a table up by name at both ends of the range.

FOUND IN R457: this panel listed the last twelve snapshots of the whole
lakehouse, whatever table they touched. On a lakehouse where anything else is
written, those were mostly other tables' commits, and the table's own history
was further back than the list reached. It now follows the table: by its id,
which survives a rename, and by every `schema.table` name it has had, which is
how DuckLake records the snapshot that created or renamed it.

The feed is a read the statement guard cannot express (a table function), so
the server writes it. It returns rows as they were, the before-image of an
update included, and a security policy cannot filter that: a table under
someone else's policy shows its readers no change feed, and its owner sees it
whole. Each read is audited as `lakehouse.changes`.

## Materialized views

A query whose answer is worth keeping becomes a table. **Save as view** in the
query editor stores the result and refreshes it on a schedule — manual, hourly,
daily or weekly — so dashboards read stored rows instead of recomputing.

The result is an ordinary lakehouse table: queryable, joinable, partitionable,
and governed by the same chokepoint as everything else. What the view record
adds is the definition, the schedule, and how the last refresh went.

**A refresh does only what the answer needs (R458).** Each refresh reads one
snapshot of the lakehouse and decides, from what the last one recorded:

| What changed since the last refresh                                   | What the refresh does                                                    |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Nothing the view reads                                                | Leaves the table as it is: no rows written, no snapshot                  |
| Its one table only gained rows, and the view keeps or drops rows one by one | Appends the view's answer for the new rows only                    |
| Anything else                                                         | Rebuilds it, as every refresh used to                                    |

"Keeps or drops rows one by one" means one table, no aggregate, window,
DISTINCT, LIMIT, join or subquery: a filter and a projection. The new rows are
those whose `rowid` is at or above the floor the last refresh recorded, which
holds because DuckLake assigns row ids in increasing order and keeps them
through updates, flushes and compaction (measured on DuckDB 1.5.5). A view is
rebuilt whenever it cannot be sure: its definition or a policy applied to it
changed; it reads a mount, a view, a table function or a name without a
schema; it calls something whose answer can change between runs (`now()`,
`current_date`, `random()`; the engine's own `duckdb_functions().stability`
decides); a policy applies to what it reads; rows were updated or deleted; or
its own table was written by anything but a refresh. The maintenance pass's
flushes and compactions leave rows as they were and do not count as changes.
What each refresh read is recorded in the hidden `_agentswarms.matview_state`
table in the same commit as the rows, so the record and the rows cannot
disagree; a view's first refresh after this change rebuilds once to make it.
**Refresh** on the table's tab says which of the three it did and why;
**Rebuild** recomputes every row whatever changed.

Three properties are worth knowing, because they decide how it behaves when
something goes wrong:

- **A refresh is one commit.** A rebuild runs `CREATE OR REPLACE TABLE … AS
<query>` and an append an `INSERT`, each in one transaction with the record
  of what it read, so anyone querying during a refresh sees the old rows or
  the new ones, never a half-built table.
- **A failed refresh keeps the previous data.** Stale rows a user can see and
  diagnose beat an empty table. The failure is recorded on the view, and the
  table's tab says so where people look: the badge reads **last refresh
  failed** in red, beside the reason's first line and the time of the refresh
  the rows are from (the whole error on hover). Until R185 the badge went on
  reading "materialized" and the failure lived only in its hover title.
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
The one failure this must never have is running unfiltered. A rewrite that
finds a policed table and replaces nothing is refused too (R224).

`SUMMARIZE` is a read like any SELECT: it reports the min, max, distinct
count and quartiles of every column, so a reader's `SUMMARIZE` goes through
the same rewrite and summarises only the rows and values they may see.
`DESCRIBE` and `SHOW` return a table's shape, not its rows, and are not
rewritten. Before R224 the statement's tables were looked up by its first
word, and SUMMARIZE named none, so no policy was loaded and a masked column's
minimum and maximum were two real values. That includes not
being able to _read_ the policy: a failed read of the table policies, the tag
policies or the catalog tags they key on is an error, never "no policy" (R223).
Before R223 those reads dropped their errors, and one failed read ran a
reader's query unfiltered.

A filter is validated against the real table when you save it, so a typo is
caught at authoring time rather than by blocking every reader at once.

### Policies by tag

A policy names one table. Tag a column `pii` on ten tables and you have still
written ten policies, and the eleventh table ships unmasked. **Tag policies**
(the lakehouse page's _Tag policies_ button) are one rule, written once,
applied wherever the tag is:

| Rule                         | What it does                                                                              |
| ---------------------------- | ----------------------------------------------------------------------------------------- |
| Columns with the tag — mask  | Every column carrying the tag is blanked or scrambled, in every table, for every grantee  |
| Tables with the tag — filter | Every table carrying the tag shows only the rows the condition allows (`@me`, `@user_id`) |

Tags live in the **Data Catalog**: a table's tags on the asset, a column's tags
in the asset drawer's Columns table. Both survive re-crawls. The rules read the
_Lakehouse catalog_ source's assets, so a table created since its last crawl
carries no tags until the source is re-crawled. At read time the
rules a table and its columns trigger are folded into the same per-table
policy the rewrite enforces — masks union, filters AND, and a blank beats a
scramble, so a stricter rule anywhere is never weakened by a looser one
elsewhere. A table with no policy of its own but a `pii` column under a mask
rule gets one. The owner is never filtered; a rule's filter is checked against
every table carrying the tag when it is saved; a tag nothing carries yet is
accepted, and the rule waits for it. A Spark query on a tag-policed table is
refused the way one on a policed table is.

Verified live: a column tagged `pii` and its table tagged `restricted` in the
catalog, one mask rule and one filter rule saved from the page, and a grantee's
SELECT returned hashed emails and only the permitted rows while the owner's
returned everything.

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

| Step               | What it does                                                                                    |
| ------------------ | ----------------------------------------------------------------------------------------------- |
| `flush_inlined`    | Writes rows still held in the catalog out as zstd Parquet                                       |
| `merge_files`      | Merges adjacent small files, table by table, skipping clustered tables — the biggest scan lever |
| `recluster`        | Rewrites tables kept clustered that gained files since their last rewrite (see Clustering)      |
| `expire_snapshots` | Retires snapshots older than 7 days                                                             |
| `cleanup_files`    | Deletes files only those expired snapshots referenced                                           |

Each step is independent: one failing is logged and the rest still run, because
a half-maintained lakehouse still answers queries correctly. Any replica may
run the pass — the steps are idempotent and DuckLake serialises them through
the catalog. Verified live: every step ran clean and inlined rows became real
Parquet files, with row counts unchanged.

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
   Pipelines and other sandboxes reach the lake through the same rules, run by
   the app for them: see [Sandbox lakehouse access](./SANDBOX_LAKEHOUSE_ACCESS.md).
   A write may not call a table function anywhere in it (R226). DuckDB
   will not parse a write into an AST, so every name the statement calls is
   compared with every table function the engine lists in
   `duckdb_functions()`; the pure generators pass, as they do in a SELECT.
4. Row caps (10k default) and an interrupt-based timeout bound every query.
5. **Tables a Sheets table sheet holds** (an uploaded file, rows imported
   from a connection) are read, never changed, here: every write path asks
   first, and dropping the schema that holds one is refused. See
   [Sheets → Tables a sheet holds](./SHEETS.md#tables-a-sheet-holds).

A three-part name (`lake.schema.table`, the catalog the lakehouse is
attached as) is checked as `schema.table`; any other catalog is refused.

Every statement — refusals included — lands in the user's **query history**
and in the platform **audit trail** (`lakehouse.select|dml|ddl`,
`lakehouse.schema.create|drop`, `lakehouse.import`, `lakehouse.nl2sql`).

### Files under a customer's key

On S3, a schema whose owner is under a **customer key** in AWS KMS (Admin →
IAM → Settings → Customer keys) has its files encrypted by the store under
that key: every new file in the schema's folder, whoever writes it, its
small writes (written as files rather than kept in the catalog), and Delta
Sharing snapshots of its tables. An assignment copies the files written before
in place under the key; **Re-encrypt lakehouse files** does it on demand. If
the customer disables or revokes the key, queries on those schemas fail with
an error naming the schema and the key, and other schemas are unaffected. A
Spark cluster reading the lakehouse needs `kms:Decrypt` on the key, and
`kms:GenerateDataKey` to stage a write; its scoped credential allows both
through S3 only. The members' model artifacts and the rows their pipelines
and ML runs stage are written under the same key.
On Cloud Storage the key is in Cloud KMS instead, named the way Cloud Storage
names a customer-managed key (R443).
`LAKEHOUSE_SSE_KMS` (`auto`, on for AWS S3 and Cloud Storage) decides whether the store is asked
at all. What it needs and what it does not cover:
[Key management → Lakehouse files](./KEY_MANAGEMENT.md#lakehouse-files).

## Sharing tables outside the platform (Delta Sharing)

A grant shares a schema with someone who has an account here. **Shares** hand
tables to people who do not — an auditor, a partner, a customer's data team —
over the [Delta Sharing](https://delta.io/sharing/) protocol, which the
`delta-sharing` Python package, Spark, Power BI and others speak. The
lakehouse page's **Shares** button:

1. **Create a share** — a name that appears in the recipient's URL
   (`finance-q3`), and a description.
2. **Add tables you own**, each optionally under a different name in the
   share, with a row filter and masked columns of its own. These apply on
   top of the table's policy the way tag rules do — filters AND, masks
   union, a blank beats a scramble — so a share can never widen what the
   table's policy allows.
3. **Mint a recipient token**, labelled, optionally bound to an email
   (which binds `@me` in a row filter) and expiring. The dialog shows the
   **profile** once — the small JSON file a client loads — and offers to copy
   or download it as `<share>.share`. Revoke from the same list; the next
   request gets a 401 and the attempt is audited.

The recipient's side, with the Python client:

```python
import delta_sharing
client = delta_sharing.SharingClient("finance-q3.share")
client.list_all_tables()
df = delta_sharing.load_as_pandas("finance-q3.share#finance-q3.analytics.revenue")
```

**What a recipient actually receives** is the question that decides whether
this is safe. The lakehouse's own Parquet files are never handed out: DuckLake
keeps deleted rows in its data files and marks them in delete files, and a
presigned URL bypasses every policy, since nothing runs between the recipient
and the bucket. So each read serves a **governed snapshot**: a `SELECT` through
the same policy rewrite every reader inside the platform goes through, written
by the engine to Parquet under `SHARE_DATA_URL` (default `s3://<bucket>/shares`,
beside the lake's data path and never inside it, because DuckLake's orphan
cleanup deletes what it does not track under its own prefix) with deletes
already applied. The snapshot is keyed by the table's current set of data and
delete files and by the policy, so an unchanged table is written once and
served many times; a change to the table or the policy writes a new one and
bumps the version the client sees, and older snapshots are pruned. A filter
that names the reader (`@me`, `@user_id`) makes the snapshot per token.

The recipient fetches the files through **presigned URLs** signed for
`LAKEHOUSE_S3_PUBLIC_ENDPOINT` when set (an in-network MinIO is typically
reachable as `minio:9000` and from outside as whatever you publish), valid
for `SHARE_URL_EXPIRY_SECONDS` (default 3600). The endpoint is
`https://<your host>/api/delta-sharing`; requests are rate limited across
tokens (`SHARE_RATE_LIMIT_PER_MIN`, default 600) and a snapshot write is
bounded by `SHARE_MATERIALIZE_TIMEOUT_MS` (default 600000). Every read is an
audit event under `share:<label>` with the table, version and file count;
every owner action (`lakehouse.share.*`) is one too.

The protocol surface is the read side of Delta Sharing 1.x: shares, schemas,
tables, `all-tables`, `version`, `metadata` and `query` (`limitHint` and
`predicateHints` are accepted and advisory, as the protocol allows). Change
data feed and Delta-format responses are not offered; the files are plain
Parquet, which is what the clients read.

## Iceberg interop

The lakehouse speaks Apache Iceberg in both directions through the engine's
`iceberg` extension, so a table built here is readable by Spark, Trino,
Flink, Snowflake or Databricks, and a table they own is queryable here
without a copy.

**Register a catalog.** Under Lakehouse → **Iceberg**, add an Iceberg REST
catalog: its endpoint, the warehouse it serves, and how to authenticate -
none, a bearer token, or OAuth2 client credentials - given as **secret
names** (Settings → Secrets); the values never enter the row. Lakekeeper,
Apache Polaris, Nessie, Unity Catalog and Snowflake Open Catalog speak this
protocol with those. OAuth2's server URI is optional: left empty, the token is
asked for at the catalog's own `<endpoint>/v1/oauth/tokens`. Until R458 it was
not optional in practice. The engine refused the secret without it ("no
'oauth2_server_uri' was provided, and no 'endpoint' was provided to fall back
on"), because the secret is made apart from the `ATTACH` that names the
endpoint, so every OAuth2 catalog saved without a URI failed to attach. It
was found by testing against **Apache Polaris 1.8.0** (R458), the first test
of OAuth2 and vended credentials against a production catalog. With the fix,
an engine holding no storage credential of its own signed in, published a v3
partitioned table, read it, upserted into it and read an earlier snapshot, all
through credentials Polaris vended, scoped to the table's own prefix. A wrong
client secret is refused in Polaris's words ("OAuth2 token request failed
(Unauthorized_401)"). Polaris on a MinIO-style store needs `"kmsUnavailable":
true` in the catalog's storage config: without it, the store's STS refuses the
session policy Polaris asks for, over a KMS key resource (measured). AWS Glue's and S3 Tables' REST endpoints need AWS SigV4
signing, which this form does not offer; this page said Glue worked until
R457, and nothing here could have signed its requests. It was left out on
purpose: the engine signs those requests with a DuckDB secret of type `s3`,
the same kind it reads `s3://` files with, and this engine is shared by every
user. A catalog's AWS keys held in an unscoped `s3` secret would be offered to
other users' reads of S3 paths. Doing it safely needs the secret scoped to the
catalog's own storage prefix and the table files read only with credentials
the catalog vends, and it needs testing against AWS, which this round could
not do. **Table files are read
with** decides where the file credentials come from: the catalog vends them
(the engine's default), or the lakehouse's own storage credentials read them
when both live in one store, and the catalog is then told not to vend
(`ACCESS_DELEGATION_MODE 'none'`). Until R457 that choice was stored and never
reached the engine, which asked every catalog to vend. A namespace or a table
with a hyphen in its name (`sales-prod`, `daily-metrics`) mounts and imports
like any other; until R457 the name rule refused both, though the engine reads
them. A nested namespace (`finance.eu`) is not listed by the engine on DuckDB
1.5.5, and its `SUPPORT_NESTED_NAMESPACES` option asks the catalog for
`/namespaces/financeeu/tables`, dropping the separator, and breaks the listing
of every other namespace, so it is not turned on. DuckDB 2.0.0 lists and reads
one with the same option (measured), so nested namespaces come with the engine
upgrade (see [the assessment](./LAKEHOUSE_ASSESSMENT.md#duckdb-20-measured)). The catalog is attached and asked for
its namespaces before it is saved, so a wrong endpoint or a missing secret is
refused with the engine's own words. Registered catalogs attach when the
engine boots; one that fails to attach is marked on its row and skipped,
never blocking the lakehouse, and tried again every five minutes until it
answers. Table files are read with the credentials the
catalog vends, or with the lakehouse's own storage credentials when both live
in one object store.

**Over a private path** (R428). The engine calls the catalog itself, so a
catalog on a private endpoint keeps its name and resolves privately from the
app server: there is nothing else to enter. The form's **Network** box has
**Check network path**, which says where the endpoint and the OAuth2 server
resolve, private or public. **Require a private network path**, per catalog
and off by default, attaches the catalog only when both names resolve only to
private addresses. It is checked at every attach and again at every engine
sync, and a catalog whose name stops resolving privately is detached with the
reason on its row. A proxy does not count: the engine takes `HTTP_PROXY`,
`HTTPS_PROXY` and `NO_PROXY` from the environment itself, so the app cannot
vouch for its route. The table files are read wherever the catalog points, and
the rule does not reach them. The rule needs migration `20261104000000`; until
it runs, asking for it says so. See
[PRIVATE_GENAI_CONNECTIVITY.md](./PRIVATE_GENAI_CONNECTIVITY.md).

**Mount a namespace.** A namespace becomes a lakehouse schema: one
read-only view per table, owned by you, shareable through IAM like any
schema, and read through the per-user statement guard like any table.
Nothing is copied - the engine reads the Parquet the catalog points at, at
the catalog's current snapshot. **Refresh** brings the views level with the
namespace when tables appear or are renamed. A user statement can never name
an attached catalog directly; the guard refuses every catalog but the
lakehouse's own, so the only way to an Iceberg table is a mount you can see.

**Read a mounted table.** A mounted table's tab shows what the table is, read
from its own metadata (the catalog's LoadTable answer; only its `metadata`,
never the catalog's config or the storage credentials the same answer can
carry): the format version and the v3 features in use (deletion vectors, row
lineage, VARIANT, nanosecond timestamps, geospatial types, column defaults),
the partition spec and how often it changed, the sort order, how the schema
evolved (matched by field id, so a rename is told apart from a drop and an
add), its branches, tags and snapshots with the rows each one left, its live
files by kind, and upkeep: delete files every scan applies, small files, a
long history, and for a v2 table what v3 would bring. Each item carries the
Spark procedure that deals with it, with the catalog named as registered here.
Measured against tables Spark 4.1 and Iceberg 1.12 wrote (R457): a v3 table
with 48 deletion vectors read 10,125 rows here, as it did in Spark.

**Maintain a mounted table (R459).** Where the deployment has a Spark engine,
the catalog's owner runs the upkeep items from the panel, each as a Spark job
like a query on Spark: **Compact on Spark** (`rewrite_data_files`), **Rewrite
on Spark** for delete files (`rewrite_data_files` with
`delete-file-threshold` 1, so a file with any delete applied is rewritten
without it), and **Expire on Spark** (`expire_snapshots` older than the days
you set, keeping at least the newest you set; branches and tags stay). Each
asks first and says what it does, and expiry says it cannot be undone. The job
configures the catalog on its own Spark Connect session (REST, the catalog's
auth, vended credentials or the lakehouse's keys scoped to the table's
location), with every credential from the job's environment and `${...}`
substitution switched off first, so no statement can read one back. When it
ends the panel says what the procedure did, in its own counts, and reads the
table again. Only the owner: the commit is made with the owner's catalog
credentials, and expiry deletes files. Audited as `lakehouse.iceberg.maintain`.

Measured on Spark 4.1.4 against a REST catalog on the development object
store, with the app's DuckDB 1.5.5 reading the same table before and after
every job (rows by region unchanged each time): a v2 table of 320 data files
and 200 positional delete files rewrote to 1 data file and 0 delete files, and
expiry with "keep 2" left 2 snapshots and deleted the 320 old data files. The
first version of the rewrite did not pass `remove-dangling-deletes`, and the
run showed why it must: 832 data files became 1, and all 520 delete files
stayed listed, still opened by every read. Spark had no Iceberg before R459:
Iceberg publishes no runtime for Spark 4.2, which the platform ran, so the
panel could only hand over the SQL.

Two counts on that panel were wrong in the UI pass and are worth knowing
about. A snapshot's `total-records` is the records in its data files, deleted
rows included until the files are rewritten, so the panel shows records less
position deletes (10,175 records, 10,125 rows); with equality deletes there
is no such count and it says so. And the file manifests also list files a
later snapshot removed (status `DELETED`): counted, 48 live deletion vectors
read as 50.

**Time travel on a mounted table.** Click a snapshot, a branch or a tag to see
the table as it was there, with that snapshot's columns (a column renamed
since shows under its old name). A mount's view cannot be time-travelled
(`Catalog type does not support time travel`), and the engine's `AT (VERSION
=> …)` takes only an id (`'q3-close'` fails to cast to INT64), so the server
resolves a branch or a tag to its snapshot id from the table's refs and reads
the Iceberg table itself. A reader of a table under someone else's security
policy is refused, as for Spark and publishing: a policy cannot apply to the
past. Audited as `lakehouse.iceberg.time_travel`.

**Publish a table.** On a table tab, **Publish to Iceberg** writes a copy of
the table into a catalog namespace as an Iceberg table: a `CREATE TABLE`
with the source's own column list, then an `INSERT` of its rows, through the
catalog, which commits the metadata and owns the files from then on. The
dialog sets the **format version**, v2 (read by every engine, and the
engine's default) or v3, and a **partition spec** of up to four keys: a
column's value, `year`/`month`/`day`/`hour`, `bucket(N)` or `truncate(W)`.
Measured: `PARTITIONED BY` must come before `WITH ('format-version' = …)`, and
the reverse is a syntax error. A VARIANT, TIMESTAMP_NS or GEOMETRY column fits
only v3, and in a v2 table the catalog answered a bare HTTP 500, so the dialog
says which column needs v3 before anything is sent, and a caller that asks for
no layout gets v3 for such a table. **Upsert into it by key** updates the rows
whose keys match and adds the rest with one `MERGE`, in one transaction: one
new metadata file at the catalog, so a reader goes from the old table to the
new one. Measured: a merge that updates and inserts is recorded as two
snapshots in that one file (an overwrite of the rows it rewrote, then an
append); one in which every row matched, as one overwrite. On a v3 table the
rewritten rows are marked with deletion vectors (measured: a 498-row upsert
wrote 9 data files and 9 deletion vectors, no positional delete files). Keys compare with `IS NOT DISTINCT FROM`, so a null
key updates its row rather than adding another each time, and a source in
which a key appears twice is refused before anything is written. A VARIANT, a
nested value, a JSON document or a geometry cannot be a key. The catalog's
table must already have the source's columns. It is
not a `CREATE TABLE AS`: the iceberg extension build a fresh image bakes
writes a `CREATE TABLE AS`'s files to a relative `data/` directory whenever
the ducklake extension is loaded, as it always is here, and every publish
failed (R181). Column types are accepted or refused exactly as before
(`UTINYINT`, `UBIGINT`, `ENUM` and `INTERVAL` are not Iceberg types). A
publish whose rows do not go in removes the empty table it made.

Only a table's **owner** publishes it whole. A reader of a shared schema reads
its tables through the owner's row filters and column masks, and an Iceberg
table cannot carry them, so a reader is refused a table under a policy, as on
Spark (R223). Before R223 the publish checked only that the reader could see
the schema, and copied the table unfiltered into a catalog the reader owns.

"Replace" never leaves the name empty (R182); the extension has no `CREATE
OR REPLACE` for Iceberg. When the catalog's table already has the new
data's columns (same names, order and types as the engine reads them), its
rows are deleted and the new ones inserted in one transaction: one commit,
so a reader sees the old rows or the new ones and a failed write leaves the
old rows. The old rows stay in the table's history until the catalog expires
its snapshots. Otherwise the new data is staged under a name made for that
publish (a write that cannot happen fails there, before anything is touched,
R107), then swapped in by two renames in one transaction, and the old table
is dropped last. A REST catalog applies those renames one after the other, so
for that moment (0.4 to 1.5 s on the development catalog) a reader can miss
the table, but never finds it empty. A swap that fails puts the old table
back. "Refuse" keeps an existing table. **Import** is the reverse: copy an
Iceberg table into a schema you created as a real DuckLake table, with no
dependence on the catalog afterwards.

Every action is audited: catalog definitions through the `iceberg_catalog`
row trigger; `lakehouse.iceberg.mount`, `lakehouse.iceberg.refresh`,
`lakehouse.iceberg.publish`, `lakehouse.iceberg.import` and (R459)
`lakehouse.iceberg.maintain` with the catalog,
namespace, table and row counts. Removing a catalog removes its mounted
schemas first and leaves the catalog's tables untouched.

## ETL pipelines

Pipelines read and write the lakehouse with dedicated **Lakehouse table**
source and target nodes. The sandbox holds no lakehouse credential: the app
reads each source for it, as the pipeline's owner and through the same policy
rewrite as the SQL editor, and hands it the rows as one staged Parquet file;
a target's rows are staged by the sandbox (on the Spark engine, by the
cluster) and committed by the app, so a pipeline's writes are ordinary ACID
commits that other readers see immediately. Targets support replace, append and merge (upsert as
delete-then-insert in one transaction). Schema access is checked server-side as
the **pipeline's owner** before the run starts, so naming a schema in a graph
grants nothing.

A mounted Iceberg table is a source like any other (R457, measured through
the read path: a Spark-written v3 table with deletion vectors read as its
10,125 live rows, and a table with hyphens and spaces in its column names
kept them). A VARIANT column reaches Python as dicts and lists, and goes back
as a VARIANT (R458): the sandbox remembers which columns it read as VARIANT,
stages them as JSON text and names them, and the app casts each to the type
its target column already has, or to VARIANT in a table the load creates or
replaces. A NULL stays a NULL; each row keeps its own shape and scalar types
(measured end to end with the notebook image's pandas and DuckDB 1.5.6:
payloads of three shapes, a NULL and a row built in Python came back as
`OBJECT(...)` with UINT64, BOOL and DOUBLE values, where a whole number comes
back as UINT64 rather than the INTEGER it may have been). Before R458 such a
column landed as a STRUCT, or as a MAP of strings when the payloads differed in
shape. A column a pipeline renames, or builds from dicts itself, has no VARIANT
to come from and is staged as before. A DECIMAL reaches pandas as a float and a
DATE as a timestamp, as for every pandas frame.

The runtime image ships the ducklake, postgres and httpfs extensions under
`/opt/agentswarms/duckdb-ext`, read-only, and the generated code loads them
from there — so a lakehouse node downloads nothing and works with no egress at
all. Two sandbox facts shaped the fallback for an image built without them:
the kernel's HOME is read-only (so DuckDB's default `~/.duckdb` extension
directory fails) and `/tmp` is mounted `noexec` (so an extension downloaded
there cannot be mapped) — `~/.local` is the one path that is both writable and
executable, and that download needs `.duckdb.org` on the egress allow-list;
without it the run fails with "Failed to download extension (HTTP 403)", which
is squid refusing it, not DuckDB. A run that reports a download at all is on an
old runtime image.

## Running a query on Spark

Every lakehouse query runs on DuckDB inside one app worker: fast per core,
spilling to disk when a working set outgrows memory, but one query never
spans machines. When the deployment has a Spark engine — the same endpoint or
per-job Kubernetes provider ETL pipelines use (Admin → Developer runtime →
Spark engine) — the Query tab offers a second place to run a `SELECT`:
**Spark cluster**. The statement is spread across the cluster's executors and
the rows come back to the same grid, with a `spark` badge and the Spark
version.

What happens, in order. The statement is governed exactly as it would be on
DuckDB — classified, schema access checked, security policies looked up.
The catalog's inlined rows are flushed to Parquet, the current snapshot is
pinned, and every table the statement reads is resolved to that snapshot's
data files and delete files through `ducklake_list_files`. A sandbox then
connects to the cluster, builds one temporary view per table straight from
those files (positional deletes applied by joining the delete file's
`file_path` and `pos` against Spark's `_metadata.row_index`; the catalog's
internal columns dropped), rewrites `schema.table` to the view names, runs the
statement and posts the rows back. The cluster never opens a catalog session:
the catalog Postgres is the lakehouse's narrow point, and a hundred executors
against it would be the outage this exists to avoid.

A table of your own **Iceberg mount** is read differently (R459): Spark reads
it from its catalog, configured on the job's own session, at the snapshot
that was current when the query was planned (`VERSION AS OF`, so a commit to
the catalog while the job waits is not in the answer), and it joins lakehouse
tables in the same statement. Before R459 every mount was refused, because the
cluster had no Iceberg.

Four things run on DuckDB only, and the page says which. A **data-lake
mount** — its views read raw files through server-authored bodies Spark
cannot see. An **Iceberg mount shared with you** — the session would need its
owner's catalog credentials, which a job of yours is not given. A table under
**another owner's security policy** — Spark has no way to apply the filter,
and an unfiltered read is never the answer. An **encrypted** lakehouse — the
Spark reader does not decrypt DuckLake files yet. Writes never go to Spark.

A job's plan is sealed (R459). The row a Spark job's sandbox is built from —
its statement and the files it reads — was writable by its owner, and the
scoped credential is minted for the prefixes that list names, so a user who
rewrote their queued query's file list was handed a credential for another
user's files. The plan is now sealed with the runtime's signing secret when
it is recorded, the seal travels in the session's inputs, and no program or
environment is built from a row that no longer matches. Migration
`20261112000000` also leaves users read-only on the table.

Two things to know. The dialect is **Spark SQL**, not DuckDB's: a statement
that leans on DuckDB-only functions is rewritten before it runs, not
translated. And the answer is the snapshot at the moment the query was
planned: rows committed while it runs are not in it, which is the same
guarantee a DuckDB query gives. Results are capped at the same row limit as
the page's DuckDB path; a query holds its cluster for at most
`LAKEHOUSE_SPARK_QUERY_MINUTES` (default 30). The History tab marks Spark
answers, so a 40-second Spark query is not mistaken for a slow DuckDB one.

The page polls the query every two seconds while it runs. A poll that fails,
whether the network or the server's read of the query, is retried; after five
in a row the page stops watching and says the query may still be running, and
History shows it when it ends. Before R222 the server answered a failed read as
"no such query", and the page took one such answer for the query having ended:
it stopped watching and said it "may have been cancelled elsewhere" while the
query ran on and finished.

Verified live on the compose Spark 4.2 endpoint: a table written, flushed,
then edited (so it had both a data file and a delete file) returned the same
rows and aggregates on Spark as on DuckDB, from the page, with the deleted
rows absent. Spark is 4.1.4 since R459 (one version set with Delta 4.4.1 and
Iceberg 1.12.0; see [ETL pipelines](ETL_PIPELINES.md)).

## Scaling behind a load balancer

The lakehouse is stateless by construction: each request opens an ephemeral
DuckDB, attaches the shared catalog + storage, runs, closes. App replicas
need no coordination — writes serialise through the Postgres catalog's ACID
commits (a conflicting concurrent commit fails cleanly and can be retried).
Requirements: all replicas share the same `LAKEHOUSE_*` values, and the
catalog Postgres and object store are reachable from every replica.

The ceilings are the same single-node honesty as ETL: one query's working
set lives on one replica (vectorised execution + file pruning is the speed
story, not a cluster) unless it is sent to Spark (see above), and cold reads
pay object-storage latency. Small
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

**The catalog's connection budget is bounded per worker.** The Postgres pool
behind the DuckLake attachment holds sessions per app process, and its
default acquire mode ignores any limit ("always connect"). The engine now sets
`pg_pool_max_connections` from `LAKEHOUSE_CATALOG_CONNECTIONS` (default 8)
and switches the pool to wait for a free session, so the rule for the
catalog's `max_connections` is simply
**`LAKEHOUSE_CATALOG_CONNECTIONS` × workers × replicas, plus one per worker**
for the attachment itself. Measured on the Compose catalog: a worker under 32
concurrent queries over a 300-file table held 3 pool sessions unbounded, and
stayed at the limit once one was set — queueing rather than opening more. Idle
sessions are kept, so size for the ceiling, not the average.

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

What follows is a record of one-off harnesses run against a real engine,
catalog and object store while these features were built. They are **not** in
`tests/`, so nothing re-runs them and the counts below cannot be reproduced
from this repository — read them as evidence that the behaviour was checked
against the real stack once, not as a suite you can invoke.

The governance suite (19 checks) ran against the real engine, catalog and
object store: DDL/DML/SELECT round trips, CTEs, row caps, ten distinct refusal
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
