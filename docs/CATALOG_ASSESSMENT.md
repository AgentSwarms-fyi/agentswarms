# Data Catalog assessment

**As of 2026-11-07.** What the Data Catalog does, what this round changed, and
what would close the gaps that remain. Everything here is measured: read from
the code, or run.

## The short answer

The catalog's strength is being part of the platform: it sits on the same data
as the SQL Workbench, lineage from pipelines and BI, governed metrics and agents,
and it says plainly what it does not know. Its weak spots are search,
classification and automation; the scorecard rates each capability and the last
section lists what would close the gaps.

Before this round it had a defect at the centre: it did not understand a data
lake. A Hive-partitioned table became one asset per folder, a Delta table was
scanned as loose Parquet, and Hive Metastore had no support at all. Those are
fixed, and tested against real Hive.

**It is Hive Metastore compatible in one direction.** It reads any Hive Metastore,
3.1.3 and 4.0.1 tested. It does not act as one: Spark or Trino cannot point
`hive.metastore.uris` at AgentSwarms. See [Serving engines](#serving-engines) for
why that was not built, and the choice it leaves.

## Scorecard

| Capability            | What it does                                                                                                        | Rating  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------- | ------- |
| Source coverage       | 22 databases and warehouses, S3-compatible and Azure storage, Iceberg REST, Hive Metastore, AWS Glue, 17 SaaS apps  | Good    |
| Understanding a lake  | Hive partitions, Delta, Iceberg and Hudi in a bucket; location, SerDe, partition facts on every lake asset          | Good    |
| Serving other engines | Nothing. No Thrift endpoint, no Iceberg REST server, no public catalog API                                          | Missing |
| Lineage               | Table and column level from pipelines and SQL models, BI usage, Unity Catalog system tables, Hive and Glue view SQL | Good    |
| Search                | In-browser substring match over up to 20,000 assets. No ranking, no server-side index                               | Weak    |
| Curation              | Descriptions, tags, owner, certified or deprecated, flat glossary, AI-written docs                                  | Fair    |
| Classification        | By column name; since R521 also from sampled values on profiled tables and dataset pages                            | Fair    |
| Access control        | Read sharing through IAM; row filters, column masks and tag policies on the lakehouse                               | Good    |
| Data quality          | dbt-style checks and freshness alerts on local datasets; monitors on the lakehouse                                  | Fair    |
| Change history        | Column changes kept per asset, breaking changes marked                                                              | Good    |
| Automation            | Scheduled crawls with change alerts. No API, no webhooks, and agents cannot search the catalog                      | Weak    |

## What this round changed

| Finding                                                    | Kind   | What happens now                                                            |
| ---------------------------------------------------------- | ------ | --------------------------------------------------------------------------- |
| No Hive Metastore support                                  | Gap    | A source kind, read over Thrift, with view lineage                          |
| No AWS Glue support                                        | Gap    | A source kind with the same mapping. Tested on moto, not on AWS             |
| A partitioned table became one asset per folder            | Defect | One table, with its partition keys and count, queryable across partitions   |
| A Delta or Iceberg table was scanned as Parquet            | Defect | One asset, read from the table's own metadata, and refused for direct query |
| A bucket past 2,000 objects lost assets, curation included | Defect | The cap is 50,000. A listing that reaches it removes nothing and says so    |
| More than 1,000 assets showed as 1,000                     | Defect | Loaded a page at a time, up to 20,000, and the page says when it holds part |
| More than 500 matches showed as 500, with no sign of it    | Defect | The list says it is showing the first 500                                   |
| "Schema changed", with no record of what                   | Gap    | Each change kept: columns added, removed or retyped                         |
| No location, partition or table-type facts                 | Gap    | A Storage section on every lake asset                                       |
| A scaled row count looked exact (5,956 of 6,000)           | Defect | Parquet is counted from footers. A scaled count shows with a `≈`            |
| A pipeline lost a partitioned table's partition columns    | Defect | Taken from the paths. Spark reads the folder, since its glob has no `**`    |
| Same-named tables in two metastores shared lineage         | Defect | A metastore's lineage stays inside that metastore                           |
| Reopening Add Source kept the last source's secret         | Defect | The form starts empty, and secrets go when the dialog closes                |
| `npx supabase db push` missed the project on CLI 3.0.0     | Defect | `--remote` in the docs, the app and setup scripts, which now pin the CLI    |

### What real Hive showed that a mock would not have

- **`get_table_objects_by_name` no longer exists in Hive 4.** A client written from
  the older API, or tested against a mock of it, connects, lists every table and then
  reads none. The connector uses the newer call and falls back, and both paths are
  proved against real servers.
- **Hive can be wrong about its own statistics.** An external table with three rows on
  disk, which `SELECT count(*)` confirmed, reported `numRows=0` with
  `COLUMN_STATS_ACCURATE=true`, because the file was written from outside Hive. Trusting
  that flag would have told people a full table was empty. A zero on such a table now
  reads as unknown.

### What the UI showed that the tests had not

Every source type was then added and used through the real pages. That found eight
defects after the unit and real-Hive tests had passed, and each is listed in the table
above or in [the UI test record](./UI_TEST_RESULTS.md). The most serious ones share a
shape: each part was right alone, and the fault was where two parts met. A table
cataloged with `dt` and `region` reached a pipeline without them. Two metastores that
each worked merged their lineage. A form that validated correctly carried a secret
from one source into the next.

## Serving engines

"Hive Metastore compatible" can mean two things, and only the first is true today.

|                             | Today | What it takes                                                                |
| --------------------------- | ----- | ---------------------------------------------------------------------------- |
| Reads from a Hive Metastore | Yes   | Done                                                                         |
| Answers as a Hive Metastore | No    | A Thrift server, an auth model, and an answer for the lakehouse's own tables |

Answering as a metastore was left out for three reasons, and they are worth reading
before deciding to build it.

1. **The protocol has no credential to check.** Outside Kerberos, a Hive client sends a
   username and nothing proves it. A shared endpoint on a multi-tenant app would hand
   each caller whichever tenant its claimed name matched. It would have to be a small
   per-team process that holds a scoped key, and that process and key do not exist yet.
2. **The lakehouse's tables cannot be served this way honestly.** Hive reads a directory.
   DuckLake's truth is a list of live files in its catalog, and a directory also holds
   files from older snapshots, so an engine would read rows the table has deleted.
3. **New engines are moving to Iceberg REST.** It carries credentials, and current
   catalog servers speak it. Serving the lakehouse's tables as Iceberg REST reaches
   Spark, Trino, Flink and DuckDB with real authentication, which a Thrift endpoint
   cannot.

**Recommendation:** serve Iceberg REST, not Thrift, unless a named engine needs the
older protocol. Either one should wait for the public catalog API below, which both
would stand on.

## What would help most

In order, with a rough size. Each is independent of the others.

1. **A public catalog API and an agent tool** (days). Search, read an asset, read its
   lineage, behind a gateway key scope. An agent that finds the right table in the
   catalog and then queries it in the same product is what this platform is for, and
   everything else in this list builds on the API.
2. **OpenLineage ingestion** (days). One endpoint, and Airflow, Spark and dbt lineage
   arrive without writing a connector for each.
3. **Iceberg REST server over the lakehouse** (weeks). The real answer to serving
   engines.
4. **Server-side search** (weeks). Postgres full-text is enough to start, and it lifts
   the 20,000-asset ceiling.
5. **Content-based classification** (days). Done in R521 for the warehouse tables a
   crawl profiles and for local datasets on their own page, with the guardrails'
   detectors. Still by name: tables the crawl does not profile, and lake files.
6. **Domains, data products and access requests** (weeks). This is what a governance
   team buys a catalog for.

## Limits of this assessment

- Glue was tested against moto, which does not check AWS signatures. It has not been
  run against AWS. Do that in the AWS staging round.
- A pipeline's read of a partitioned table was run from the generated code on the real
  data and, for Spark, by reading that data in Spark 4.2 from local files. It was not run
  as a whole pipeline, or through S3 on Spark, because the test server could not start a
  kernel.
- Kerberos-secured metastores are not supported and were not tested. Metastores secured
  this way are common in enterprises, so ask before promising compatibility with a
  specific cluster.
- Hive 3.1.3 and 4.0.1 are the versions tested. Older versions are expected to work
  through the fallback call, and that has not been run.
