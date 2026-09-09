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

## Picking sources and targets

Nothing a pipeline reads from or writes to is typed. The node panel offers
what the platform already knows: the warehouse connections and, behind each,
its schemas and tables read from `information_schema` the moment the picker
opens; the lakehouse schemas the owner can reach and their tables; the buckets
registered as Data Catalog storage sources and the files and partitioned
folders the crawl found in them, with their formats; the secrets under
Settings → Secrets, by name; the AWS regions a Kinesis stream may live in. A
target that may create something offers **New …** and asks for a name only
then. Every pick reports the columns of what was picked, so the incremental
cursor, the merge keys and the transforms downstream are picked from a list
too, before any preview has run. What stays a field is what the platform
cannot know: a URL, a topic on somebody else's broker, a Pub/Sub project, an
expression, a query.

The pickers follow the way each system is organised, one level at a time:
a connection, then its schema, then a table; a bucket, then a folder, then a
file or partitioned dataset; a lakehouse schema, then a table (a target sees
only the schemas it may write to - a mounted lake or Iceberg namespace is
read-only). Every level lists what the previous one holds, with the counts,
formats and rows the crawl knows.

The **Data Catalog asset** source goes one step further: a catalog source,
then its schema or folder, then any table, view, file or dataset the catalog
crawled there. Picking one resolves
it to the source the compiler already knows — a warehouse table through the
catalog source's connection, a bucket file or folder through its storage
source, a lakehouse table through the engine — and stores that resolution on
the node, so a run reads exactly what was picked with the same credentials
and the same access checks (a lakehouse schema the owner cannot reach still
refuses at run start). Lineage records the asset as `catalog:<fqn>`. An
Iceberg REST catalog table is listed but read through a lakehouse mount, and
the entry says so.

A reverse-ETL target's bearer token is a secret picked by name on the node,
resolved as the pipeline owner at run start and scrubbed from logs; the older
env-var binding through Settings → secret bindings still works.

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

## Engines: the sandbox, or a Spark cluster

Every pipeline runs on the **pandas engine** unless it says otherwise: one
batch kernel, an in-memory pandas program, the sizing table below. That is
right for most pipelines, and nothing about it changed.

A pipeline whose data does not fit one box can pick the **Spark engine**
(Settings → Engine). The graph is the same, the canvas is the same, the run
log and metrics are the same; what changes is where the program executes.
The compiler emits a PySpark program instead of a pandas one, and the run's
sandbox drives a Spark cluster over **Spark Connect** — the sandbox holds
only the pure-Python client (no JVM), so every hardening decision made for it
stands, and the cluster is a resource the run attaches to rather than a
second place code runs. Node previews always sample in the sandbox, on
either engine.

**What runs where.** The split is by design and is the same for every
pipeline:

| On the cluster (distributed)                                                                             | In the sandbox, then lifted into Spark                                                                                           |
| -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Object-storage reads and writes (CSV, TSV, JSON, JSONL, Parquet; Delta including MERGE)                  | Spreadsheets (xlsx), HTTP API fetches, platform datasets                                                                         |
| Database reads and writes over JDBC (PostgreSQL, MySQL and SQL Server families)                          | CDC, webhook ingest, stream drains (Kafka, Kinesis, Pub/Sub)                                                                     |
| Every transform: filter, select, rename, derive, join, union, aggregate, sort, dedupe, nulls, limit, SQL | Custom Python (its contract is a whole pandas frame), the lakehouse (DuckLake has no Spark connector), HTTP API and SaaS targets |
| Quality gates                                                                                            |                                                                                                                                  |

The sandbox-side nodes are bounded by design — a CDC peek, a stream drain, a
SaaS push — and none of them is where the size problem lives. Each reuses
the pandas compiler's own emitter for that node, so the two engines cannot
disagree about what it does.

**Same answer on either engine.** Where pandas semantics differ from SQL's,
the pandas behaviour is reproduced on purpose: a null group key forms a
group (`dropna=False`), nulls sort last in either direction, a join suffixes
shared columns `_x`/`_y` and collapses a same-named key to one column, a
null fails a range, regex or allowed-values check. Filter conditions and
derived columns keep their pandas `query`/`eval` spelling; the compiler
translates them to Spark SQL at save time — `and`/`or`/`not`, `&`/`|`/`~`,
`in [...]`, `.isnull()`, the everyday `.str` and `.dt` accessors — and a
construct Spark has no equivalent for is refused at save, naming it and the
fix (usually: a SQL step). A SQL step is Spark SQL on this engine, DuckDB SQL
on the pandas engine; the overlap is large but not total.

**What the Spark engine refuses**, at save time, in words: an Iceberg target
(write Delta, or land in the lakehouse and publish from there), merge into
plain files (merge needs a Delta table), merge into a database (append or
replace, or merge on the pandas engine). Which duplicate `dedupe` keeps is
not defined on a cluster; pandas keeps the first.

### Where the cluster comes from

Admin → Developer runtime → Spark engine picks one of two providers for the
whole deployment.

**An endpoint you run (`static`, the default).** One Spark Connect endpoint,
shared by every run; the platform does not manage its lifecycle. Set it there
or as `SPARK_CONNECT_URL` (the setting wins); until one is set the engine
picker says so and the option is disabled. Locally the Compose `spark` profile
runs a single-host Spark 4.2 Connect server with the S3A, Delta and JDBC
connectors already on it:

```bash
docker compose --profile spark up -d
```

and `sc://spark-connect:15002` is the endpoint. The first start downloads the
connector jars into a volume; later starts are fast. In production the endpoint
can be a standalone cluster, a Spark Connect server in front of one, or a
managed service that speaks Spark Connect. A token in the URL
(`sc://host:15002;token=…`) is kept out of every run log.

**One cluster per run, on Kubernetes (`k8s`).** Available when the app itself
runs in a cluster. Each Spark-engine run gets its own driver pod — which is
also its Spark Connect endpoint — plus the executor pods it asks for, sized in
the admin form (executors per run, cores and memory each, driver memory). They
are deleted when the run ends, so a run's size is the node pool rather than one
box, and nothing is paid for between runs. Apply the reference manifest first:

```bash
kubectl apply -f deploy/k8s/spark/spark-runtime.yaml
```

It carries the `agentswarms-spark` namespace, the ServiceAccount the driver
needs to ask for its executors, the ResourceQuota that bounds every Spark run
at once, and the NetworkPolicy that lets a sandbox reach a driver. Spark pods
live in their own namespace on purpose: a kernel is under a default-deny policy
whose only way out is the HTTP egress proxy, and a driver has to reach object
storage and databases directly.

Three things keep a per-run cluster from outliving its run. Executors are
_owned_ by the driver pod, so deleting the driver garbage-collects them. The
driver carries `activeDeadlineSeconds` past the run's own timeout, so the
kubelet ends it even if the app never comes back. And every object is labelled
with the run id, so the ETL sweep can find and delete a cluster whose run is
over even when nothing in the database points at it any more.

Provisioning is not instant — resolving the connector jars on a stock image
takes minutes — so the run stays **queued** while its cluster comes up, and the
orphan reaper knows to wait for it. Build an image with the jars baked in and
set `SPARK_PACKAGES=` (empty) to skip that entirely; it is the single biggest
difference to how quickly a Spark run starts.

Either way, Spark Connect is gRPC and cannot go through the HTTP egress proxy,
so the endpoint's host is added to the run's no-proxy list and must be
reachable from the sandbox network directly.

Credentials for object storage travel as per-call data-source options —
scoped to the read or write, never set on the cluster's shared
configuration where another session could read them. Warehouse credentials
go to the JDBC driver the same way.

**Versions.** The sandbox image carries `pyspark-client` (the Spark Connect
client, 4.2) and the server must be the same major.minor — the protocol is
versioned. The Compose service and the per-run default both pin
`apache/spark:4.2.0-python3`, `delta-spark 4.4`, `hadoop-aws 3.5`.

**Settings and environment.** Each is the settings row first, then the
environment, then the default.

| Setting              | Env                                                           | Default                      | What it does                                                             |
| -------------------- | ------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------ |
| Clusters come from   | `SPARK_PROVIDER`                                              | `static`                     | `static` (a shared endpoint) or `k8s` (one per run)                      |
| Endpoint             | `SPARK_CONNECT_URL`                                           | —                            | `static` only: where every run dials                                     |
| Spark image          | `SPARK_IMAGE`                                                 | `apache/spark:4.2.0-python3` | driver and executors                                                     |
| Executors per run    | `SPARK_EXECUTORS`                                             | 2                            | executor pods one run asks for                                           |
| Cores per executor   | `SPARK_EXECUTOR_CORES`                                        | 1                            |                                                                          |
| Executor memory (MB) | `SPARK_EXECUTOR_MEM_MB`                                       | 2048                         |                                                                          |
| Driver memory (MB)   | `SPARK_DRIVER_MEM_MB`                                         | 2048                         | collected results land here                                              |
| —                    | `SPARK_PACKAGES`                                              | the four connectors          | set empty for an image that already has them                             |
| —                    | `SPARK_K8S_NAMESPACE`                                         | `agentswarms-spark`          | where per-run pods live                                                  |
| —                    | `SPARK_K8S_SERVICE_ACCOUNT`                                   | `spark-driver`               | the driver's identity                                                    |
| —                    | `SPARK_K8S_STARTUP_TIMEOUT_SECONDS`                           | 420                          | how long a driver may take to answer                                     |
| —                    | `SPARK_K8S_NODE_SELECTOR` / `SPARK_K8S_TOLERATIONS`           | —                            | JSON; place Spark on its own pool                                        |
| —                    | `SPARK_K8S_EXTRA_CONF`                                        | —                            | comma-separated `spark.*=value` for anything else                        |
| —                    | `SPARK_K8S_PULL_POLICY`                                       | `IfNotPresent`               | image pull policy for per-run pods                                       |
| —                    | `SPARK_K8S_RUN_AS_USER`                                       | 185                          | the uid in your Spark image                                              |
| —                    | `SPARK_K8S_DRIVER_CPU_REQUEST` / `SPARK_K8S_DRIVER_CPU_LIMIT` | `500m` / `2`                 | driver CPU                                                               |
| —                    | `SPARK_K8S_DRIVER_SCRATCH`                                    | `8Gi`                        | the driver's writable scratch (shuffle spill, ivy cache)                 |
| —                    | `SPARK_K8S_EXECUTOR_POD_TEMPLATE`                             | —                            | executor pod template, needed under a `restricted` Pod Security Standard |

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

## Streaming sources (Kafka, Kinesis, Pub/Sub)

Three source nodes read a stream in **micro-batches on the pipeline's own
schedule**: a **Kafka / Redpanda topic** (and anything that speaks the Kafka
protocol - Confluent, MSK, Event Hubs), an **Amazon Kinesis stream** and a
**Google Pub/Sub subscription**. A run reads from where the previous run
durably loaded, up to _messages per run_ or until the stream has been quiet
for _stop after quiet_, and reports the new positions - Kafka offsets per
partition, Kinesis sequence numbers per shard - as its engine-managed
watermark, the same `etl_pipeline_state` cursor the CDC source uses. The
cursor is persisted only when the run's load committed, so a run that fails
after reading re-reads the same messages: **at-least-once, never lost**. No
consumer-group offsets are committed to the broker; the platform is the
record, and a preview reads without moving anything. Pub/Sub is the
exception, because it has no replayable position: a message is acknowledged
as it is read (never on a preview), so give the subscription a dead-letter
topic, or use Kafka, when a failed run must not lose messages.

Rows carry the payload - a JSON object's keys become columns, or one `value`
column for text - plus `_stream_*` metadata (`_stream_topic`,
`_stream_partition`, `_stream_offset`, `_stream_key`, `_stream_timestamp`
for Kafka; shard, sequence, key and arrival time for Kinesis; message id,
publish time and attributes for Pub/Sub). Schedule the pipeline every minute
for a near-real-time feed into the lakehouse, or make it **continuous** (next
section) for a feed measured in seconds; the merge target with primary keys
deduplicates a replayed batch.

Credentials are **secrets by name**: the node names the secrets (Settings →
Secrets) holding the SASL username and password, the AWS access key pair, or
the service-account JSON, and the run resolves them as the owner into the
node's env stem (`ETL_<NODE>_SASL_USERNAME`, `ETL_<NODE>_ACCESS_KEY_ID`,
`ETL_<NODE>_CREDENTIALS_JSON`, …). Their values never enter the graph. The
broker or service host must already be on the **sandbox egress allow-list**
(Admin → Developer runtime); a run refuses before it starts when it is not,
naming the host - a pipeline author cannot widen where the sandbox may
reach. Kafka is a raw TCP protocol, so the brokers must be reachable from the
kernel network itself (the same Docker network, a VPC peering, or
`NOTEBOOK_NETWORK`); Kinesis and Pub/Sub are HTTPS and go through the egress
proxy like every other web call. The runtime image ships `confluent-kafka`,
`boto3` and `google-cloud-pubsub`.

## Auto-ingest from object storage

An object-storage source reads its whole prefix on every run. That is right
for a file that is replaced, and wrong for a landing zone where files arrive
and stay: every run re-reads everything, and an append target doubles it.
**Only files not loaded before** (on the source node) turns the prefix into a
feed:

- Every run lists the prefix and reads only the files it has not loaded. The
  engine keeps a **ledger** on the source's cursor: the newest modification
  time it loaded and the keys stamped with that exact time, so two files
  landing in the same second are told apart without a growing manifest. The
  ledger is written only after the run's load committed, like every other
  cursor, so a failed run re-reads the same files.
- **Files per run** (default 500) bounds one run; the rest wait for the next,
  so a backlog of ten thousand files drains in order rather than in one
  frame.
- A file uploaded again later carries a newer time and **loads again as a
  new version** — the honest reading of an object store, where a re-upload is
  a new object. A merge target with primary keys makes that idempotent; an
  append target keeps both versions.
- An idle run hands downstream an empty frame with the columns of the last
  load, so transforms after the source keep working between arrivals.
- The source is now **drainable**, so the pipeline can run **continuous**: one
  long-running run watches the prefix every few seconds, and with a lakehouse
  target it is exactly-once. The row-level incremental cursor still applies on
  top when set.
- **Sandbox engine only.** The Spark engine reads a prefix whole; a pipeline
  with this setting is refused at save on that engine, by name.

There is no notification-driven discovery (bucket events): the listing is the
discovery, which works on every S3-compatible store, MinIO included, and costs
one LIST per run, taken fresh each time (the listing is never served from
a cache, so a file that lands mid-run is seen on the next tick). Verified live
against the compose MinIO: a continuous, exactly-once pipeline watching
`landing/*.csv` loaded each dropped file once within a tick, a run restarted
after a stop resumed from the committed ledger and read only the file that
had arrived meanwhile, a re-dropped file loaded again as a new version, and
an idle prefix cost nothing but the listing.

## Continuous pipelines

A scheduled stream pipeline reads in micro-batches on the scheduler's clock:
one run per sixty-second sweep, each paying a sandbox start, so the feed is a
minute or two behind at best. **Continuous** (Settings → Schedule) keeps one
long-running run live instead. The compiled program is the same; a run told
to loop drains the source, transforms, loads, reports its positions and
counters to the platform, advances its own cursors, and goes again — after
_poll every_ seconds only when a tick found nothing, straight away when it
did, so a backlog drains at full speed and an idle stream costs one poll.

What holds it together:

- **Positions persist every tick, after the load.** The engine cursor
  (`etl_pipeline_state`) is written when the tick's load has committed, the
  same rule a scheduled run follows at its end. A crash between a commit and
  its report replays at most one tick's batch: **at-least-once**, with a
  replay window of seconds rather than a run. A merge target with primary keys
  makes that replay invisible.
- **Exactly-once into the lakehouse.** When every target is a lakehouse
  table, the tick is one DuckLake transaction: every target's load and the
  tick's source positions — written to a hidden `_agentswarms.etl_cursors`
  table in the same catalog — commit together, or not at all. The next run
  resumes from the positions that committed _with the rows_, not from the
  report, so the crash window above closes: a crash before the commit loses
  nothing and replays the tick; a crash after it cannot replay. The card says
  _exactly-once_ beside _continuous_ when a pipeline qualifies; a pipeline
  with a storage, database, HTTP or SaaS target stays at-least-once, because
  those targets have no part in the lakehouse's transaction.
- **The sweep keeps it alive.** Every sixty seconds the scheduler starts a
  run for any active continuous pipeline that has none live. A run ends on its
  own at the **rollover** (`ETL_CONTINUOUS_ROLLOVER_MINUTES`, default 720): a
  bounded container lifetime, so memory and logs reset and an image upgrade
  reaches a pipeline that never stops. A run that fails outright is restarted
  after `ETL_CONTINUOUS_RESTART_BACKOFF_SECONDS` (default 300), not every
  sweep. The sandbox's wall-clock limit sits past the rollover, so a run is
  never cut off mid-tick.
- **The card is live.** _streaming · rows · ticks_ updates as the run reports;
  the Runs tab shows the same counters on the live run and the totals on a
  finished one. **Stop** on the card cancels the live run; pause the pipeline
  as well if it should stay stopped, because an active one is restarted by the
  next sweep.
- **What it needs.** A visual pipeline (the loop wraps the compiled graph; a
  code pipeline owns its own entrypoint) with a source that can be drained
  again and again — a Kafka, Kinesis or Pub/Sub stream, webhook ingest, change
  data capture, or an incremental cursor. A plain batch source would re-read
  everything on every tick, and the save refuses it. Concurrent runs are off
  by construction: two live runs would drain the same stream twice. Chaining
  does not fire at a rollover — a continuous run "succeeds" every time it rolls
  over, which is not the event a chain means.

Verified live against the compose Redpanda from the ETL page: a Kafka topic
fed in bursts while a continuous pipeline loaded it into a lakehouse table
every three seconds; every message arrived once, the card counted them as
they landed, and Stop ended the sandbox.

## Reverse ETL (HTTP API targets)

The **HTTP API** target pushes the incoming frame to an external endpoint in
JSON batches (`POST`/`PUT`/`PATCH`, configurable rows-per-request, optional
`{<wrap_key>: rows}` envelope). Auth is a Bearer token read from an env var
bound to a platform secret (Settings → secret bindings) — resolved in the
sandbox's memory and scrubbed from logs. A non-2xx response fails the run,
which the retry ladder then handles. Verified live against a local sink:
5 rows arrived as 3 batches with the bound bearer header, and the token
never appeared in run logs.

## Reverse ETL into a SaaS tool

The **SaaS tool** target pushes rows back into HubSpot or Salesforce through a
connection you have already made — the same one that syncs contacts _in_ syncs
them back _out_, so there is no second copy of the CRM's credential to manage.

Pick the connection, the object (Contacts, Companies, Deals, Accounts, Leads,
Opportunities…), and the column that identifies a record: a HubSpot **unique
property** such as `email`, or a Salesforce **External ID field**. Every other
column is sent as a field. It is an **upsert** — the same row twice updates
rather than duplicates.

### Why this is not just the HTTP API target with a URL filled in

**These APIs answer `200` and report per-record failures inside the body.** The
HTTP target checks the status code, sees 200, and records every row as loaded.
So a run that pushed 5,000 contacts and had 4,000 rejected for a missing
required property shows in the run history as a complete success, and nobody
finds out until somebody asks the CRM why the numbers are wrong.

This target reads the response the way each vendor actually writes it —
HubSpot's `numErrors`/`errors`, Salesforce's per-record `success` flag — and
**fails the run**, naming what was rejected and why. A Salesforce reply that is
not a per-record list at all counts as every record in the batch failing,
because "the shape was wrong so nothing was checked" must never read as
success.

Two more things it knows that a URL does not:

- **The batch cap.** HubSpot takes 100 records per request and Salesforce 200.
  Exceeding it rejects the whole batch, not one record, so the cap is applied
  here rather than left in a number you have to look up.
- **The id column must exist.** Checked against the frame before the first
  request, because otherwise every record is rejected one batch at a time.

### What it deliberately does not do

**Only HubSpot and Salesforce can be written to.** The other connectors —
Stripe, Shopify, Jira, Zendesk, Google Sheets — are read-only here. Creating a
charge or an issue from a nightly pipeline is a different kind of decision from
updating a CRM record, and this is not the door for it.

**A shared connection can be read from but not written to.** An IAM share
grants the ability to pull rows out; pushing records into somebody else's CRM
is a bigger step, and it should be its own grant rather than a side effect of
that one. Reverse-ETL targets resolve owner-only.

**Partial batches are not rolled back.** Salesforce is called with
`allOrNone: false`, so one bad record does not block the rest — the run fails
and tells you which records were rejected, and re-running is safe because an
upsert on the same key updates rather than duplicates.

The CRM's host must be on the egress allow-list (`api.hubapi.com`, or your
Salesforce My Domain) under **Admin → Developer runtime**. A run blocked by the
proxy **says so by name** — a 403 whose body is not JSON did not come from a
JSON API, so the error names the host to add rather than leaving you reading
squid's deny page as though the CRM had refused you. (The proxy also permits
only ports 80, 443, 9000 and 19000; the real CRMs are on 443.)

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

## Lakehouse targets need the catalog on the kernel network

A pipeline whose target is a lakehouse table attaches DuckLake **from inside the
notebook kernel**, not from the app. Kernels run on an `internal` Docker network
with no route off it except the HTTP egress proxy — Parquet is HTTP and goes
through it, the catalog is a raw Postgres connection and cannot. So the catalog
has to be on the kernel's network and named by service (`lakehouse-catalog:5432`),
not by a host IP or published port.

Compose users get this already. The symptom when it is wrong is
`connection to server at "…" failed: Network is unreachable` in the run log, and
it appears **only in production**: under `npm run dev` the orchestrator places
kernels on a routable network, so the whole class of failure is invisible in
development. Full detail, including the `NOTEBOOK_NETWORK` escape hatch for a
catalog outside Docker, is in
[Lakehouse § the catalog must be reachable](./LAKEHOUSE.md#the-catalog-must-be-reachable-from-the-notebook-network).

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

**Column lineage** rides beside it. A run reports the columns every node's
frame actually had, and the engine traces each target column back to the
source columns it came from by what each transform is known to do: a rename
maps names, a derive reads the columns its expression names, an aggregate
maps each output to the column it summarises, a join keeps both sides (with
pandas' `_x` / `_y` suffixes read as left and right), a union merges, a filter
keeps everything. A Python or SQL step is opaque: every output column is
recorded as depending on every input column of that step, and the edge says
so — the drawer shows those with a `≈`, so a guess is never presented as a
fact. Edges are written beside the table edges, replaced wholesale with them,
and capped so one wide opaque step cannot flood the table. The asset drawer
lists them under **Column lineage**, per column, upstream and downstream. A
SQL model's build adds its own edges the same way: each output column of the
model's SELECT, traced through DuckDB's parse to the lakehouse columns it
reads (aliases, functions, CTEs, subqueries, joins and `SELECT *`), which is
what joins a pipeline's column lineage to a model's.

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
2. **Push transforms into the lakehouse**: land raw with a light pipeline into
   a lakehouse target, then do the joins and aggregations in SQL. DuckDB
   streams and spills to disk instead of holding a frame in RAM, so this is
   the move that changes the ceiling rather than raising it. The same applies
   to an external warehouse — load raw into Snowflake / BigQuery / Databricks
   (native bulk targets) and transform there. ELT instead of ETL.
3. Split one huge pipeline into chained smaller ones (`run after`), each with
   a bounded working set.

Host-level sizing — how many of these runs can happen at once, and how that
interacts with the lakehouse engine and app replicas on the same machine — is
in [System requirements § Sizing ETL and the lakehouse](./SYSTEM_REQUIREMENTS.md#3a-sizing-etl-and-the-lakehouse).

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
machine (see sizing above) — unless the pipeline is on the Spark engine,
where the run's data is spread across the cluster's executors and the
sandbox is only the driver's client (see Engines above).

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

## Beyond pipelines: one graph from ingest to model

A pipeline chains to another pipeline with **Run after**; that was the whole
of orchestration, and SQL models and ML schedules ran on their own clocks
beside it. A pipeline can now also say what to start **when a run succeeds**,
in Settings → "After it succeeds, also…":

- **Build SQL models** — every active model you own, rebuilt in dependency
  order, or only the models you pick, with everything they depend on built
  first. The build is the same one the SQL Models page runs, recorded there
  with the trigger `chain`, and a failing model still skips its downstream.
- **Run ML schedules** — any retrain or batch-predict schedule you own,
  started exactly as its own clock would start it, recorded on the model's
  Operations tab.

Both run **as the pipeline's owner**, so the grants are the owner's, and both
are their own runs with their own records: a model that fails to build or a
retrain that is refused shows on its own page and never rewrites the
pipeline's outcome — the pipeline did succeed. The save path refuses a model
name that is not yours and a schedule that is not yours, by name.

The typical shape is ingest → transform → train: a pipeline that lands raw
rows in the lakehouse, chained to the staging and fact models, chained to the
retrain schedule whose features those facts are. Each step is visible where
it always was; the graph is the new part.

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
   LAN address (e.g. `http://192.168.1.10:19000`) in the catalog source, so the
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
