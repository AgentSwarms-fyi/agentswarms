# Lakehouse and Iceberg: where it stands (R457, R458, R459; 2026-11-08)

The question asked was whether the lakehouse and its Iceberg support are the
best in the industry and current with where the industry is. They are not the
best in the industry, and this document says where they lead, where they are
level, where they trail, and what was changed in R457 and R458. Everything
marked _measured_ was run against a real engine, catalog and object store;
everything else is read from the code or from the vendors' own documentation,
and says so. R458 was asked to close every gap that could be closed: it closed
three, found and fixed a fourth that nobody had seen, and the rest are listed
below with what each is waiting for.

## The short version

- **Where it leads:** governance that reaches every consumer (row filters,
  column masks and tag policies enforced on DuckDB's own AST, for SQL, BI,
  agents, pipelines and Delta Sharing alike), and how much of the platform
  reads the same governed tables: BI, ETL, SQL chat, agents, the ontology,
  Sheets, the semantic layer, monitors. No lakehouse product ships that set.
- **Where it is level:** ACID tables with time travel, partition transforms,
  file-layout tuning, a result cache keyed on the snapshot, materialized views
  that refresh only what changed (R458), an integrity check between catalog
  and object store, and reading and writing Iceberg v3 (deletion vectors, row
  lineage, VARIANT) through any REST catalog that speaks bearer or OAuth2,
  measured against Apache Polaris with credentials it vends (R458).
- **Where it trails:** one engine per query (DuckDB on one worker; Spark for
  SELECTs over DuckLake tables and your own Iceberg mounts), lakehouse tables
  reach other engines only as a published copy, Iceberg maintenance run on
  demand rather than on its own schedule, incremental refresh only for views
  that filter one table (an aggregate rebuilds), no branching for DuckLake
  tables, no SigV4 catalogs (AWS Glue, S3 Tables), no nested Iceberg
  namespaces on DuckDB 1.5.
- **R459, one version set:** Spark 4.1.4 with Delta 4.4.1 and Iceberg 1.12.0
  (Iceberg has no Spark 4.2 runtime, so Spark 4.2 meant no Iceberg), and DuckDB
  1.5.5 in the server, the browser and the sandbox image, which had run three
  releases (1.5.6 was tried first: the ORC extension is not published for it). That put Iceberg on Spark: a pipeline's Iceberg target, Spark
  SELECTs over Iceberg mounts, and maintenance from the upkeep panel.

## Against the field

| Capability                          | Here (after R458)                                                                        | Databricks      | Snowflake      | Dremio / Trino / Starburst | AWS (S3 Tables, Glue, Athena) |
| ----------------------------------- | ---------------------------------------------------------------------------------------- | --------------- | -------------- | -------------------------- | ----------------------------- |
| Native table format                 | DuckLake 1.0 (catalog in Postgres, Parquet in your store)                                | Delta           | Iceberg / FDN  | Iceberg                    | Iceberg                       |
| Iceberg v3 read                     | Yes, measured (deletion vectors, VARIANT, evolved schema and spec)                       | Preview to GA   | GA             | Partial                    | DVs and row lineage           |
| Iceberg v3 write                    | Yes, measured (publish as v3, partitioned; upsert by key)                                | Yes             | Yes            | Partial                    | Yes                           |
| Iceberg time travel, branches, tags | Read: any snapshot, branch or tag; write: none                                           | Yes             | Yes            | Yes (Nessie)               | Yes                           |
| Iceberg REST catalog, as a client   | Bearer and OAuth2; vended or own credentials; private-path rule; measured on Polaris 1.8 | Yes             | Yes            | Yes                        | SigV4                         |
| Iceberg REST catalog, as a server   | No: a published copy (DuckLake's format cannot be served in place)                       | Unity speaks it | Open Catalog   | Yes                        | Yes                           |
| Engines over one table              | DuckDB per worker; Spark for DuckLake SELECTs and own Iceberg mounts (R459)              | Photon, Spark   | One engine     | Many                       | Many                          |
| Row and column policies             | Yes, on the AST, by table and by tag, every consumer                                     | Unity           | Yes            | Ranger etc.                | Lake Formation                |
| Change feed                         | DuckLake, per snapshot (new)                                                             | CDF             | Streams        | Partial                    | No                            |
| Automatic maintenance               | DuckLake hourly; Iceberg on demand from the panel, on Spark (R459)                       | Predictive opt. | Automatic      | Manual / jobs              | S3 Tables automatic           |
| Incremental materialized views      | Skip when unchanged; append for one-table filters; else rebuild                          | DLT / MV        | Dynamic tables | Reflections                | No                            |
| Sharing outside the platform        | Delta Sharing read side, governed snapshots                                              | Delta Sharing   | Data sharing   | No                         | No                            |
| Branching / write-audit-publish     | No                                                                                       | No (Delta)      | No             | Nessie                     | Iceberg branches              |

The vendor columns come from their documentation and announcements as of
November 2026, not from measurement here, and the sources disagree in places
(Databricks' Iceberg v3 status is called preview by one source and GA by
another).

## What changed in R459: one version set

Asked to use "the versions where everything works with everything". Checked
against Maven Central, npm, PyPI and Docker Hub on 2026-11-08:

| Piece                | Was                       | Now                                   | Why this one                                                                                                                                           |
| -------------------- | ------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Spark                | 4.2.0                     | **4.1.4** (`apache/spark:4.1.4-python3`, Java 21) | Iceberg publishes a Spark runtime for 4.0 and 4.1 only; 4.1.4 (2026-10-28) is the newest 4.1. Spark 4.2.1 and 4.3.0 exist and have no Iceberg runtime |
| Delta                | 4.4.0 (`delta-spark_2.13`, built for Spark 4.2) | **4.4.1** (`delta-spark_4.1_2.13`, built for Spark 4.1.0) | the newest Delta, in its artifact for this Spark                                                                         |
| Iceberg on Spark     | none                      | **1.12.0** runtime + `iceberg-aws-bundle` | the newest Iceberg; S3 FileIO is what applies credentials a REST catalog vends                                                                      |
| hadoop-aws           | 3.5.0                     | **3.4.2**                             | the image ships hadoop-client 3.4.2, and S3A must match it                                                                                             |
| sqlite-jdbc          | none                      | **3.53.4.0**                          | the per-run catalog an Iceberg pipeline target commits through (below); 3.54.1.0 was ten days old                                                      |
| pyspark-client       | 4.2.0                     | **4.1.4**                             | the Connect protocol is versioned; the client is the server's exact release                                                                            |
| DuckDB, server       | 1.5.5 (`@duckdb/node-api` 1.5.5-r.2) | **1.5.5** (1.5.5-r.2, pinned exactly) | one release in all three engines; not 1.5.6, for which the ORC community extension is not published (404 on all four platforms)                                                                                                                         |
| DuckDB, browser      | 1.5.4 (`duckdb-wasm` 1.33.1-dev57.0, npm `latest`) | **1.5.5** (1.33.1-dev64.0, its 1.5.5 build) | `latest` still points at a CI-dependency bump on the 1.5.4 build; every duckdb-wasm since v1.33.0 is tagged `-dev` |
| DuckDB, sandbox      | 1.5.6 (`duckdb>=1.4,<2`, a rebuild's pick) | **1.5.5** (`duckdb==1.5.5`)           | pinned, so a rebuild cannot drift                                                                                                                       |
| DuckDB 2.0           | not adopted               | not adopted                           | the browser has no stable 2.0 (`next` is 1.33.1-dev114.0), so 2.0 is the one choice where everything does not work with everything                     |

`src/utils/etl/sparkVersions.ts` writes the Spark set down once;
`tests/unit/sparkVersionSet.test.ts` holds the Compose file, the sandbox
image and the admin form to it, and `tests/unit/duckdbEnginesParity.test.ts`
now holds the three DuckDBs to one release, not one minor. The image scan
finds the same two criticals in 4.1.4 as in 4.2.0 (netty-handler, derby; both
baselined with reasons) and 71 fixable highs against 4.2.0's 61, because its
netty line is older; the server listens on loopback and the internal
networks, behind a token.

What the move made possible, each run against Spark 4.1.4 (the app's own
generated programs, in the sandbox image) and checked against the app's
DuckDB 1.5.5:

- **Iceberg maintenance from the upkeep panel**, by the catalog's owner, as a
  Spark job. On a v2 table of 320 data files and 200 positional delete files:
  rewritten to 1 data file and 0 delete files, then expiry ("keep 2") left 2
  snapshots and deleted the 320 old files; rows by region identical before and
  after each job. The first version left every delete file listed (832 data
  files became 1, 520 delete files stayed); `remove-dangling-deletes` fixed it,
  in the job and in the advice's SQL.
- **Spark SELECTs over your own Iceberg mounts**, from the catalog at the
  planned snapshot (`VERSION AS OF`; the `snapshot-id` read option is refused
  by Iceberg 1.12), joinable with lakehouse tables: the same totals as DuckDB.
- **A pipeline's Iceberg target on the Spark engine**, writing the same table
  the pandas engine writes. Run in turn on one table: pandas creates (100
  rows), Spark appends (200), Spark merges by key (250: 50 updated, 50 added),
  pandas appends (350), Spark replaces (100), pandas appends (200); pyiceberg
  and DuckDB read every step's count, and the metadata files run `00000` to
  `00007` across both engines.
  Three things the runs found: Iceberg's in-memory catalog cannot commit a
  real table (it keeps metadata in memory whatever `io-impl` says), so the
  target uses Iceberg's JDBC catalog over an in-memory SQLite; dlt's two
  required columns (`_dlt_load_id`, `_dlt_id`) must be written by Spark too,
  or each engine refuses the other's table; and a MERGE refuses a
  non-deterministic source, so the source is checkpointed first.

Found on the way, both pre-existing:

- **A user could rewrite a queued Spark query's plan** (S1). The table the
  sandbox's plan lives in was writable by its owner, and the plan's file list
  decides which prefixes the job's credential covers. Plans are now sealed,
  and migration `20261112000000` makes the table server-written.
- **The Spark UI listed every run's S3 keys** (S2): a Connect job's call site
  is its request, and a request carries a read's options. Both servers now
  run without the UI.

## What changed in R458

Each closed gap was measured against a real engine and store, then driven in
the UI on the development lakehouse.

- **Materialized views refresh only what changed.** A refresh leaves the table
  alone when nothing it reads changed (no rows written, no snapshot), appends
  the answer for the new rows when the view filters one table that only gained
  rows, and rebuilds otherwise. Every case it cannot be sure of rebuilds: a
  changed definition or policy, a mount, a function the engine calls unstable,
  an update or delete, or its own table written by anything else. The record
  of what it read commits with the rows. Measured against a real DuckLake:
  every refresh's table compared with the view's query run fresh (12 cases),
  and in the UI: up to date (no rows written), 20 appended of 40 inserted,
  rebuilt after an update, and up to date again.
- **A VARIANT column survives a Python pipeline.** It is staged as JSON text
  and committed as VARIANT (or the target column's own type), where it used
  to land as a STRUCT or a MAP of strings. Measured end to end on the notebook
  image with three payload shapes, a NULL and a row built in Python.
- **OAuth2 and vended credentials, tested against Apache Polaris 1.8.0.** The
  first test against a production catalog found a defect: an OAuth2 catalog
  saved without the optional server URI could never attach. Fixed, and then
  an engine with no storage credential of its own published, read, upserted
  and time-travelled through what Polaris vended.
- **Found while building the append:** reading DuckDB's parse tree with
  JavaScript's `JSON.parse` rounds integers past 2^53, so a statement printed
  back from it would compare against a different number. The rewrite reads
  and writes the tree without rounding, pinned by a test with a BIGINT key
  that rounds to its neighbour.

## What changed in R457

Measured on the rig described below, then exercised through the UI on the
development lakehouse.

- **A mounted Iceberg table reads as what it is.** Format version, the v3
  features in use, partition spec and its history, sort order, schema
  evolution matched by field id, branches, tags, snapshots with the rows each
  left, live files by kind, and upkeep advice with the Spark procedure for it.
- **Time travel on a mounted table**, to any snapshot, branch or tag. A mount
  is a view, and a view cannot be time-travelled; the panel offered nothing
  for a mount before.
- **Publish as v3, partitioned, or upsert by key.** v2 stays the default.
  A VARIANT column needs v3, and the dialog says so instead of the catalog's
  HTTP 500.
- **A table's own snapshots.** The table tab listed the whole lakehouse's
  latest twelve snapshots, whatever they touched.
- **What a snapshot changed**, row by row, from DuckLake's change feed.
- **Partition transforms** for lakehouse tables: day, month, year, hour,
  bucket. A VARIANT, nested value or blob cannot be a key. The dialog counts
  the partitions a spec would make of today's rows and warns before one cuts
  a table into many small files.
- **DuckLake's own sort order** under clustering: a clustered rewrite records
  its keys with `SET SORTED BY`, so rows flushed from the catalog after it are
  written in key order; clearing the layout resets it.
- **Ready for DuckDB 2.0's parser:** the column-lineage tracer reads both
  engines' trees (measured on 2.0.0: 6 of 6 statements traced as on 1.5.5;
  before the change it returned nothing through a CTE or a UNION on 2.0).
- **Fixed:** the catalog form's "Table files are read with" choice never
  reached the engine; hyphenated namespaces and tables were refused; the
  docs said AWS Glue's REST endpoint worked, which nothing here could sign.

## Defects the UI found after the tests passed

Seven, all fixed and pinned:

1. A snapshot's "rows" were the records in its data files: 10,176 for a table
   that reads 10,125, because deleted rows stay in data files until rewritten.
   It now subtracts position deletes, and with equality deletes it says there
   is no row count instead of guessing.
2. File counts included files a later snapshot removed: 48 live deletion
   vectors read as 50.
3. The newest snapshot in the list was a branch's head, unlabelled. Snapshots
   now carry the branches and tags that point at them.
4. The partition dialog offered a VARIANT column as a key.
5. The upsert dialog offered a VARIANT column as a match key, and the server
   took one. Keys are now plain values, in the dialog and on the server.
6. The layout dialog offered a VARIANT column as a cluster key. Same rule.
7. A partition spec could cut a small table into hundreds of partitions with
   no word of it. `day(ts), bucket(16, id)` on a 498-row table made 263, and a
   clustered rewrite of it then ran for 145 s in the UI (150 s measured step
   by step) where local disk takes under 4 s: DuckLake writes a file per
   partition an insert touches, one upload each. The table went from 2 files
   (7.7 KB) to 527 (633 KB). The dialog now counts the partitions today's rows
   would make, says how big each would be, and warns. The count is checked
   against the engine: the 18 partitions it predicts for a test table are the
   18 files an insert then writes.

Two claims were corrected. A MERGE into Iceberg is one catalog commit (one new
metadata file); it holds two snapshots when it updates and inserts, and one
when every row matched (measured both ways). And `LAKEHOUSE.md` said the ETL
sandbox attaches the lakehouse catalog with its own credentials, which has
not been true since the app began reading and loading for it.

## The consumers, through the UI

Exercised on this branch's server against the development lakehouse, with the
test catalog's Spark-written tables mounted:

| Consumer                | What was done                                                                                                        | Result                                                                                                                                                                                                          |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SQL Workbench, SQL Chat | join of a mount and a lakehouse table; a question in words                                                           | right rows (earlier in R457)                                                                                                                                                                                    |
| ETL                     | Lakehouse table source picker; the read path the sandbox is served by, as the pipeline's owner                       | mounts listed; v3 table with deletion vectors read as 10,125 rows, hyphenated names kept, VARIANT table read (498). The sandbox's own preview needs the container network, which a host dev server cannot reach |
| ETL in Python           | the staged files read by the notebook image's DuckDB 1.5.6 as `_lake_read` does                                      | VARIANT arrives as dicts; written back it would land as STRUCT or MAP (documented)                                                                                                                              |
| BI                      | an existing 44-widget lakehouse dashboard refreshed; a new chart on the v3 mount; a VARIANT column in a table widget | 31 tiles refreshed with no error; chart and server refresh right; VARIANT shows as `{'kind': 'spec2'}`                                                                                                          |
| Ontology                | Explore, a metric, all 29 rules on the sample over lakehouse tables                                                  | 120 customers; 25 pass, the sample's 4 planted failures fail, 0 errored                                                                                                                                         |
| Data monitors           | schema check on the VARIANT table, run once                                                                          | 5 columns recorded as the baseline                                                                                                                                                                              |
| Semantic layer          | a model on the v3 mount, validated, saved, queried by region                                                         | 3 regions summing to the table's 62,505,705.25                                                                                                                                                                  |
| Iceberg publish         | upsert by key into the v3 table published earlier                                                                    | one commit, 9 deletion vectors, 498 live rows; inspector and upkeep advice right                                                                                                                                |
| Layout                  | clustered rewrite, then Forget layout                                                                                | sort order recorded as `region ASC`, then removed from DuckLake's catalog                                                                                                                                       |

## The rig

- Apache Iceberg REST fixture (the project's reference catalog, current tag),
  storing tables in a new bucket on the development object store.
- Spark 4.1.1 with Iceberg 1.12.0 as an independent writer: `sales.orders_v3`
  (format 3, deletion vectors, `days(ts)` and `bucket(4, id)`, a partition
  field added later, `WRITE ORDERED BY`, a renamed and an added column, a
  branch `audit` and a tag `q3-close`), `sales.orders_v2` (positional deletes),
  `` `sales-prod`.`daily-metrics` `` (hyphens and quoted columns),
  `finance.eu.ledger` (a nested namespace), and a table of every nested type.
- The app's engine, DuckDB 1.5.5 with its iceberg, ducklake and httpfs
  extensions, read every table with the counts Spark reported (10,125 on main,
  9,975 at the tag, 10,126 on the branch, 1,800 for the v2 table).

## What is still open, and what each is waiting for

Checked again on 2026-11-08, against the registries rather than articles:

- **DuckDB 2.0 LTS (21 October 2026)**, and with it DuckLake 1.1 (nested
  schemas, faster catalogs) and the Iceberg extension's new attach options.
  Waiting for: a stable duckdb-wasm 2.0. On npm, `@duckdb/node-api`'s `latest`
  is `2.0.0-r.1`, but the 2.0 engine exists for the browser only as
  duckdb-wasm's `next`, `1.33.1-dev114.0`, a development build. Decided in
  R459 ("the versions where everything works with everything"): every engine
  stays on DuckDB 1.5, now one release, 1.5.5, in all three. Measured on an
  isolated copy (below): on 2.0 the security core holds and three tests fail,
  two of which R457 fixed.
- **SigV4 catalogs (AWS Glue, S3 Tables).** Waiting for: an AWS account to
  test against. The engine signs their requests with a DuckDB `s3` secret, the
  kind it also reads `s3://` files with, and one engine serves every user: a
  catalog's AWS keys in an unscoped secret would be offered to other users' S3
  reads. Safe support needs the secret scoped to the catalog's storage prefix
  and table files read with vended credentials. No emulator here speaks Glue's
  Iceberg REST endpoint, so it cannot be tested without AWS.
- ~~Iceberg on Spark, and Iceberg maintenance run from here.~~ **Closed in
  R459** by moving Spark to 4.1.4 (above). Still on demand, not scheduled:
  Iceberg maintenance runs when the owner presses the button; S3 Tables and
  Snowflake run theirs on their own. A schedule per table is buildable on the
  same job and is listed below. `remove_orphan_files` is not offered: it
  lists the table's whole location and deletes what no snapshot references,
  which needs a dry run shown first and a location the table owns alone.
- **Lakehouse tables served to other engines in place**, as an Iceberg REST
  catalog. Not possible on this format today: DuckLake has no supported export
  to Iceberg metadata, and a DuckLake snapshot can reference part of a file and
  hold rows inlined in the catalog, which Iceberg metadata cannot describe
  ([ducklake discussion #663](https://github.com/duckdb/ducklake/discussions/663)).
  Serving a table means serving a copy, which **Publish to Iceberg** already
  writes, as v3 or v2, partitioned, or as an upsert by key. Keeping that copy
  current on a schedule is the next step that can be built.
- **Incremental refresh of an aggregate.** A view that groups rebuilds when its
  table gains rows: merging new rows into old groups is right for counts and
  sums and wrong for averages and distinct counts, and is not done until each
  aggregate can be shown to merge exactly.
- **Nested namespaces.** The engine on DuckDB 1.5 (measured on 1.5.5) does not list them, and
  its option for them drops the separator and breaks every other listing. On
  DuckDB 2.0.0 the same option lists `finance.eu` and reads its table (500
  rows, measured on the rig), so they arrive with the upgrade, together with a
  name rule that admits the dot.

## DuckDB 2.0, measured

On an isolated copy of the repository with `@duckdb/node-api` 2.0.0-r.1,
never attached to any real catalog:

| Measure                                                       | DuckDB 1.5.5                                       | DuckDB 2.0.0                                                        |
| ------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------- |
| Engine-touching tests (214 files, 4,126 tests)                | 2 fail (pre-existing)                              | 2 of those, plus 3 new                                              |
| Row and column policies (plain, CTE, nested CTE, UNION, join) | held                                               | held; the rewritten SQL differs only in spacing and parentheses     |
| Column-lineage tracer                                         | traces                                             | empty through a CTE or a UNION; **fixed in R457**                   |
| Browser and server engines on one minor version               | yes                                                | no: duckdb-wasm has no stable 2.0                                   |
| A 1.0 DuckLake catalog written by 2.0                         | n/a                                                | stays spec 1.0; a catalog 2.0 creates is 1.1, which 1.5 cannot open |
| Nested Iceberg namespace (`finance.eu`) on the rig            | not listed; the nested option breaks every listing | listed and read (500 rows), with `SUPPORT_NESTED_NAMESPACES true`   |

What changed in 2.0's parse tree, as the app reads it: a CTE's body moved from
`value.query.node` to `value.query_node`; UNION, EXCEPT and INTERSECT moved
from `left`/`right` to a `children` list; literals carry `{kind, text}`; table
functions list `arguments` with a `qualified_name`. The policy rewrite and the
table-reference checks were unaffected.

The upgrade, when duckdb-wasm ships a stable 2.0: bump all three (the two
packages and the sandbox image's `duckdb==1.5.5`) together, run the suite,
and check that the lakehouse catalog stays at DuckLake 1.0 until every reader
is on 2.0.

## Next, in order

1. Keep a published Iceberg copy current on a schedule, appending from the
   change feed when the source only gained rows, the way a materialized view
   now does; that is how other engines read lakehouse tables without a
   by-hand publish. A table under a policy still cannot be published, for the
   reason Delta Sharing gives: a copy cannot carry the policy.
2. Iceberg maintenance on a schedule per table, on the job R459 runs on
   demand, so a busy table is compacted and expired without anyone pressing
   a button.
3. DuckDB 2.0 when duckdb-wasm has a stable 2.0 (above), all three engines
   together.
4. Spark 4.2 or later when Iceberg publishes a runtime for it, moved as one
   set with Delta and the sandbox client (`sparkVersions.ts`).
5. Incremental refresh for aggregates whose merge is exact (count, sum, min,
   max), proven per function.
6. SigV4 for Glue and S3 Tables with prefix-scoped secrets, tested against AWS.
