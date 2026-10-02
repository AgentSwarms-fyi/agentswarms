# Sandbox lakehouse access

How a sandbox (an ETL run or node preview, an ML training, prediction or
scoring session, a Spark query) reads and writes the lakehouse, and what it
holds while it does.

## Before: engine credentials in the sandbox

Until October 2026 a sandbox that touched the lakehouse was handed the
engine's own credentials: the DuckLake catalog's Postgres connection string
(`ETL_LAKEHOUSE_CATALOG`) and the object store's access key and secret
(`ETL_LAKEHOUSE_S3_KEY_ID`, `ETL_LAKEHOUSE_S3_SECRET`). Generated code
attached DuckLake with them and read and wrote tables directly.

Every check the server made before a run (the owner's schemas, R225's query
and policy checks) bounded what the generated code asked for. None of it
bounded what code in the sandbox could do with those credentials. A
pipeline's Custom Python node, or any library in the image, runs with the same
environment. With the catalog string it could read every table's metadata,
statistics and inlined rows; with the storage key, every table's files.

## After: the app does the lakehouse work

The sandbox reaches the lake through the app, over the channel it already
uses for its code and secrets (`/api/notebook/runtime/source`, authenticated
by the session's own token and scoped to the session's owner). The module is
`src/utils/lakehouse/sandboxLake.server.ts`.

| The sandbox asks for | What the app does |
| --- | --- |
| `lake_read` of a declared source | Runs the source's SELECT as the owner through `governSelect`, the SQL editor's schema check and the owners' policies. Writes the rows as one Parquet file under the session's staging prefix and returns a presigned GET and DELETE for it. A preview's read is capped at the preview's sample size. |
| `lake_stage` for a declared target | Returns presigned PUTs under the session's staging prefix. |
| `lake_commit` of staged loads | Checks each target again (an accessible schema, never a mount, never a table under another owner's policy, never a table a Sheets workbook holds) and loads every staged batch, with the run's cursors, in one transaction. A merge whose rows lack its key is refused. Deletes the staged files once committed. |
| `lake_cursors` | Returns the cursors that committed with the pipeline's last exactly-once load. |

A presigned URL carries its method and key inside the signature: a URL to put
one staging file cannot read it, write another, or list anything.

One read or one commit may run for `LAKEHOUSE_SANDBOX_IO_TIMEOUT_MS` (default
30 minutes) before the engine interrupts it.

### What a run may ask for

When the sandbox fetches its environment, the app builds the run's manifest
(`src/utils/etl/lakeManifest.ts`) and pins it on the session: each lakehouse
source by node id with its SQL, each lakehouse target with its table, write
mode and key, and, for an exactly-once continuous run, the pipeline's own
source nodes as the only cursors it may commit. Every `lake_*` call is served
from the pin, never from what the sandbox sends. A node preview's pin has no
targets, and its session may only read.

### Staging

Staging lives beside the lake, never inside its data path:
`s3://<bucket>/_sandbox_staging/<session-id>/`. A read's file is deleted by
the sandbox once downloaded; a load's files are deleted by the app once
committed; a stopped session's prefix is deleted when it stops; and the
runtime reaper deletes anything no live session owns that nothing has touched
for an hour. When the reaper cannot read the live sessions it skips the
sweep rather than guess.

### Why not a scoped catalog role

DuckLake's catalog is about twenty Postgres tables, plus one inlined-data table
per table and schema version, created on the fly. Row-level security over all
of them, keyed on schema and table ids, would have kept generated code
unchanged, but:
- `ducklake_snapshot_changes` records other tables' names as text, and the
  commit path reads it for conflict detection, so it cannot be filtered;
- inlined-data tables are created by whichever writer needs one, so their
  grants would race between concurrent runs;
- every DuckLake upgrade can add a table, and the policies would have to
  follow it.

A sandbox that holds no catalog string needs none of that.

## Status

| Path | Credentials in the sandbox |
| --- | --- |
| ETL, sandbox engine: runs, previews, continuous exactly-once | **None** (October 2026) |
| ETL, Spark engine: lakehouse sources and cursors | **None** |
| ETL, Spark engine: lakehouse target (the cluster writes its Parquet) | **A credential scoped to that run's staging prefix**, which expires (R230). No catalog. |
| Lakehouse queries on Spark | **A read credential scoped to the files the query's plan resolved**, which expires (R230). No catalog. |
| ML training, prediction and warm scoring | Engine credentials, until they move to the gateway |

Scoped credentials on Spark are only worth anything if the cluster uses the
credentials a call passes. It did not: Hadoop caches one S3A client per
bucket per JVM, and the cached client kept the credentials that built it.
Since R229 every call the generated Spark code makes builds its own client
(`fs.s3a.impl.disable.cache`), which is what the scoped credentials rely on.

## The Spark cluster's own credentials

A sandbox reaches the lake through the app. The Spark cluster cannot: its
executors read and write object storage themselves, and there is no app in the
middle. So it gets a credential the STORE limits, minted per run through STS
AssumeRole with a session policy (`src/utils/lakehouse/sts.server.ts`):

- **An ETL lakehouse target** may write, read back and delete under that run's
  own staging prefix, `_sandbox_staging/<session>/out/`, and nothing else. The
  app then loads the batch the sandbox names and deletes what it loaded.
- **A lakehouse query on Spark** may read the directories of the files its
  governed plan resolved, and nothing else — one prefix per table, not one per
  file, so the policy stays small for a large table.
- Listing is bounded to the same prefixes, so a credential cannot enumerate
  the bucket to find what else is there. Nothing is granted on the bucket
  itself.

Neither carries the catalog any more: the ETL target's load is the app's, and a
Spark query reads Parquet the app resolved before the query was planned.

The store enforces the policy, so a cluster holding the credential cannot
widen it and nothing running there has to be trusted to respect a prefix.
Verified against this deployment's MinIO: a session scoped to one prefix read
inside it and was refused outside it.

Stores differ. MinIO and AWS S3 answer AssumeRole; R2 and GCS's S3 endpoint do
not. A deployment whose store has no STS keeps the lakehouse's own credentials
for the cluster and says so in the log once per process;
`LAKEHOUSE_STS_REQUIRED=true` makes that a refusal instead. AWS also needs a
role to assume (`LAKEHOUSE_STS_ROLE_ARN`); MinIO derives the session from the
calling key.

A scoped credential is not value-scrubbed out of a run's log the way the
deployment's own secrets are: it is minted per session, so the code that
scrubs a log later cannot know it. It expires, it reaches one run's files, and
the generated program never prints it.

## What changed for users

- A pipeline reading a shared table under its owner's row filter or column
  masks works, and reads only the rows and values the owner allows. R225
  refused it, because the sandbox had no way to apply the policy.
- Writing a shared table under a policy stays refused.
- A Custom Python node that read the `ETL_LAKEHOUSE_*` variables or opened
  its own DuckLake connection no longer can: the lakehouse is reached through
  sources and targets.
