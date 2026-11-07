# Lakehouse and Iceberg: where it stands (R457, 2026-11-07)

The question asked was whether the lakehouse and its Iceberg support are the
best in the industry and current with where the industry is. They are not the
best in the industry, and this document says where they lead, where they are
level, where they trail, and what was changed in R457. Everything marked
_measured_ was run against a real engine, catalog and object store in this
round; everything else is read from the code or from the vendors' own
documentation, and says so.

## The short version

- **Where it leads:** governance that reaches every consumer (row filters,
  column masks and tag policies enforced on DuckDB's own AST, for SQL, BI,
  agents, pipelines and Delta Sharing alike), and how much of the platform
  reads the same governed tables: BI, ETL, SQL chat, agents, the ontology,
  Sheets, the semantic layer, monitors. No lakehouse product ships that set.
- **Where it is level:** ACID tables with time travel, partition transforms,
  file-layout tuning, a result cache keyed on the snapshot, scheduled
  materialized views, an integrity check between catalog and object store,
  and now reading and writing Iceberg v3 (deletion vectors, row lineage,
  VARIANT) through any REST catalog that speaks bearer or OAuth2.
- **Where it trails:** one engine per query (DuckDB on one worker; Spark only
  for SELECTs over DuckLake tables), no Iceberg on our Spark (no runtime
  exists for Spark 4.2), no Iceberg REST catalog of our own for other engines
  to use, no Iceberg table maintenance of our own, no incremental
  materialized views, no branching for DuckLake tables, no SigV4 catalogs
  (AWS Glue, S3 Tables), no nested Iceberg namespaces on DuckDB 1.5.

## Against the field

| Capability                          | Here (after R457)                                                  | Databricks      | Snowflake      | Dremio / Trino / Starburst | AWS (S3 Tables, Glue, Athena) |
| ----------------------------------- | ------------------------------------------------------------------ | --------------- | -------------- | -------------------------- | ----------------------------- |
| Native table format                 | DuckLake 1.0 (catalog in Postgres, Parquet in your store)          | Delta           | Iceberg / FDN  | Iceberg                    | Iceberg                       |
| Iceberg v3 read                     | Yes, measured (deletion vectors, VARIANT, evolved schema and spec) | Preview to GA   | GA             | Partial                    | DVs and row lineage           |
| Iceberg v3 write                    | Yes, measured (publish as v3, partitioned; upsert by key)          | Yes             | Yes            | Partial                    | Yes                           |
| Iceberg time travel, branches, tags | Read: any snapshot, branch or tag; write: none                     | Yes             | Yes            | Yes (Nessie)               | Yes                           |
| Iceberg REST catalog, as a client   | Bearer and OAuth2; vended or own credentials; private-path rule    | Yes             | Yes            | Yes                        | SigV4                         |
| Iceberg REST catalog, as a server   | No                                                                 | Unity speaks it | Open Catalog   | Yes                        | Yes                           |
| Engines over one table              | DuckDB per worker; Spark for DuckLake SELECTs                      | Photon, Spark   | One engine     | Many                       | Many                          |
| Row and column policies             | Yes, on the AST, by table and by tag, every consumer               | Unity           | Yes            | Ranger etc.                | Lake Formation                |
| Change feed                         | DuckLake, per snapshot (new)                                       | CDF             | Streams        | Partial                    | No                            |
| Automatic maintenance               | DuckLake hourly; Iceberg advice only                               | Predictive opt. | Automatic      | Manual / jobs              | S3 Tables automatic           |
| Incremental materialized views      | No (scheduled full rebuild)                                        | DLT / MV        | Dynamic tables | Reflections                | No                            |
| Sharing outside the platform        | Delta Sharing read side, governed snapshots                        | Delta Sharing   | Data sharing   | No                         | No                            |
| Branching / write-audit-publish     | No                                                                 | No (Delta)      | No             | Nessie                     | Iceberg branches              |

The vendor columns come from their documentation and announcements as of
November 2026, not from measurement here, and the sources disagree in places
(Databricks' Iceberg v3 status is called preview by one source and GA by
another).

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

## What was not done, and why

- **DuckDB 2.0 LTS (21 October 2026)** and with it DuckLake 1.1 (nested
  schemas, faster catalogs) and the Iceberg extension's new attach options.
  Measured on an isolated copy (below): the security core holds and three tests
  fail, two of which R457 fixed. It was not upgraded because the browser engine
  cannot follow yet: duckdb-wasm's stable release is still on 1.5 (its `next`
  tag is a development build of 3 November), and the server and the browser
  are kept on one minor version so the SQL a person writes means the same in
  both.
- **SigV4 catalogs (AWS Glue, S3 Tables).** The engine signs their requests
  with a DuckDB `s3` secret, the kind it also reads `s3://` files with, and one
  engine serves every user: a catalog's AWS keys in an unscoped secret would
  be offered to other users' S3 reads. Safe support needs the secret scoped to
  the catalog's storage prefix and vended table credentials, tested against
  AWS. The docs no longer say Glue works.
- **Iceberg on Spark.** Iceberg 1.12 publishes a runtime for Spark 4.1 and
  none for 4.2, which the Spark Connect server runs. Moving Spark back a minor
  version, or waiting for a 4.2 runtime, is the choice; neither was made here.
- **An Iceberg REST catalog served by the platform**, so Spark, Trino and
  Snowflake could read DuckLake tables without a copy. The protocol now
  includes credential vending and remote scan planning; this is the most
  valuable thing on the list below and the largest.
- **Nested namespaces.** The engine on DuckDB 1.5.5 does not list them, and
  its option for them drops the separator and breaks every other listing. On
  DuckDB 2.0.0 the same option lists `finance.eu` and reads its table (500
  rows, measured on the rig), so they arrive with the upgrade, together with a
  name rule that admits the dot.
- **Iceberg maintenance run from here.** The panel advises and gives the Spark
  procedure; running it needs Iceberg on Spark first.
- **Polaris.** The image was pulled to test OAuth2 and credential vending
  against a production catalog; the reference fixture was used instead, so
  those two paths remain untested against a real deployment.

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

The upgrade, when duckdb-wasm ships a stable 2.0: bump both packages, run the
suite, and check that the lakehouse catalog stays at DuckLake 1.0 until every
reader (the app and the notebook image's Python `duckdb<2`) is on 2.0.

## Next, in order

1. Serve DuckLake tables over the Iceberg REST protocol (read-only first, with
   vended, prefix-scoped credentials), so other engines read them in place.
   The same reasoning as Delta Sharing applies: DuckLake keeps deleted rows in
   its files until compaction, and a raw file bypasses every policy, so a
   table under a policy cannot be served this way.
2. DuckDB 2.0 when duckdb-wasm has a stable 2.0 (above).
3. Iceberg on Spark (4.1, or 4.2 when a runtime ships), then Iceberg
   compaction and snapshot expiry run from the upkeep panel.
4. Incremental materialized views on the change feed.
5. SigV4 for Glue and S3 Tables with prefix-scoped secrets, tested against AWS.
