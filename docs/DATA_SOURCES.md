# Data sources & connectors

> Part of the [AgentSwarms docs](../README.md#documentation).

Connect your own databases, warehouses and lakehouses so agents and the BI
Workspace can query them directly. Connectors live under **Integrations →
Data Sources**.

## Three different things are called a catalog

The word does a lot of work in this business, and two of the three are ours, so
it is worth being explicit once:

| What you read                                   | What it is                                                                                                                  |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **Data Catalog** (`/data-sql`)                  | The inventory of every dataset you can reach — columns, tags, PII flags, profile. Describes data **for people and agents**. |
| **External table catalog**                      | Somebody else's metadata service — Iceberg REST, Unity, Polaris, Nessie. Connected here as a source.                        |
| **lakehouse catalog** (`LAKEHOUSE_CATALOG_URL`) | The Postgres the built-in lakehouse keeps its table manifests and snapshots in. **Machinery, not an inventory.**            |

They sit in a stack rather than side by side: the lakehouse catalog is what
makes the Parquet in your bucket queryable at all, and the Data Catalog then
describes those tables — along with everything else — so a person can find
them. Losing annotations in the first costs you documentation; losing the third
leaves you with files nobody can name.

They are also connected in one direction that matters: a **tag written in the
Data Catalog drives lakehouse masking and row policies**, so the thing that
describes the data is also what governs it. See
[LAKEHOUSE.md](./LAKEHOUSE.md#policies-by-tag) for that path.

## How connecting works

1. Open **Integrations → Data Sources** and pick a provider.
2. Fill in the connection fields (see the table below) and click **Test
   connection** — a `SELECT 1` probe confirms credentials and reachability
   before you save.
3. **Save.** Credentials are encrypted at rest with AES-256 (the
   `PROVIDER_CREDS_SECRET` key — see [deployment](./DEPLOYMENT.md)) and are
   **never returned to the client**. Only a redacted summary and the last
   test status come back.

Once saved, a source is available everywhere:

- **Data Catalog → SQL workbench** — browse its tables and run read-only SQL.
- **BI Workspace** — build charts from it (Direct Query or stored snapshots),
  include it in an **ontology**, and set up **scheduled refreshes** that run
  server-side with the owner's stored credentials.
- **SQL agents** — the `sql_query` tool can target a connection by name.
- **Data Catalog crawler** — profile and document its tables (see below).

### Read-only by design

Every driver enforces read-only SQL: a single statement that starts with
`SELECT` / `WITH` / `SHOW` / `DESCRIBE` / `EXPLAIN` after comments are
stripped. This is a guardrail, **not** a substitute for permissions —
**always connect a read-only database user/role**. Result sets are row-capped
(1,000 rows for data queries) and every value is normalised to a common
`{ columns, rows }` shape.

### Secret references

Any field can hold a `{{secret:NAME}}` reference instead of a literal value.
The secret is resolved from the **Secrets Manager** at query time, scoped to
the owning user, so you can rotate a password in one place and share a
connection template without exposing the credential. Superadmins can share
secrets with users/groups via **Admin → IAM**.

## Sharing a connection with your team

A connection is owned by whoever created it. Rather than every analyst creating
their own — N copies of one credential, each rotated separately, each a place it
can leak — a superadmin can share it under **Admin → IAM → Access**:

- **🏢 Database / warehouse connection**
- **🔌 App source** (Sheets, Stripe, CRM…)

Grant to a user or a group, like any other resource.

### What a grantee gets, and what they do not

**A SHARED CONNECTION RUNS AS ITS OWNER.** The credential _is_ the connection —
a grantee has none of their own — so the owner's credential is decrypted
server-side and the query runs against the owner's warehouse.

| Grantee can                                                             | Grantee cannot                  |
| ----------------------------------------------------------------------- | ------------------------------- |
| Query it from the workbench, BI, prep flows, agents and semantic models | See the credential, in any form |
| Test it, and see its health                                             | Edit or delete it               |
| Trigger a sync on a shared app source                                   | Change what it points at        |

The grantee's rows are never readable directly: unlike other shared resources,
connection rows carry the encrypted credential, so there is deliberately **no
row-level policy** granting access to them. The grant is resolved server-side
and the row loaded with the service role, so a grantee can _use_ a connection
without ever receiving it.

`{{secret:NAME}}` references resolve as the **owner**, not the caller — the
grantee's own vault is never consulted.

**Revocation takes effect on the next use.** Grants are resolved fresh on every
call, including scheduled refreshes, so nothing keeps working off a cached
grant.

### App sources: who the sync belongs to

A shared app source **syncs as its owner, into the owner's datasets.** If a
grantee notices the data is stale and re-runs it, it refreshes the real
datasets rather than building a parallel copy under their own account. The
audit entry records both the person who triggered it and whose data moved.

That means sharing the _source_ lets a teammate keep it healthy; to let them
_read_ the resulting data, share those datasets too (**data table** grants).

## Runtime support

The connectors split by how they reach the source:

| Transport        | Providers                                                                                                                             | Runs on            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| HTTP / REST API  | Snowflake, Databricks, BigQuery, Amazon Redshift (Data API), Amazon Athena, Trino/Starburst/Presto, **Oracle (ORDS)**, **ClickHouse** | **Any** deployment |
| PostgreSQL wire  | PostgreSQL, **CockroachDB**, **TimescaleDB**, **AlloyDB**, **Greenplum**, **YugabyteDB**                                              | **Any** deployment |
| MySQL wire       | MySQL, **MariaDB**, **SingleStore**, **StarRocks**, **Apache Doris**, **PlanetScale**                                                 | **Any** deployment |
| TDS (SQL Server) | Azure Synapse, **Microsoft SQL Server / Azure SQL**                                                                                   | **Node** only      |

**Most "new databases" are not new protocols.** A provider declares its wire
family and the dispatcher routes on that, so every Postgres-compatible engine
shares one proven driver rather than getting a near-duplicate of it. Each is
still first-class — its own entry, label, default port and docs — because
someone looking for CockroachDB should find CockroachDB.

## Apps (SaaS sources)

Databases are **queried in place**. Apps have no query language, so they are
**pulled into datasets** instead: Integrations → **Apps** → connect, discover
what is in there, choose what to sync. Each stream becomes its own dataset and
is then indistinguishable from an uploaded CSV — same type inference, same
version history, same use in BI, prep flows and the semantic layer.

| App                    | Auth                                             | Streams                                                                                                                |
| ---------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| **Google Sheets**      | Service-account JSON (share the sheet with it)   | One per worksheet                                                                                                      |
| **Stripe**             | Secret or restricted key                         | Charges, customers, invoices, subscriptions, payment intents, products, prices, refunds, payouts, balance transactions |
| **Shopify**            | Admin API access token                           | Orders, customers, products, draft orders, price rules                                                                 |
| **HubSpot**            | Private app token                                | Contacts, companies, deals, tickets, line items, products                                                              |
| **Jira**               | Email + API token (Jira Cloud)                   | Issues, one dataset per project — summary, status, type, priority, assignee, reporter, dates, labels                   |
| **Zendesk**            | Email + API token (sent as `email/token`)        | Tickets, users, organizations                                                                                          |
| **Salesforce**         | Connected app (client credentials)               | Accounts, contacts, leads, opportunities, cases, campaigns, users                                                      |
| **ServiceNow**         | Basic auth (integration user)                    | Incidents, change requests, problems, catalog requests, requested items, tasks, users, CMDB                            |
| **Intercom**           | Access token (app in your own workspace)         | Contacts, conversations, admins                                                                                        |
| **GitHub**             | Personal access token                            | Issues and pull requests, one dataset per repository                                                                   |
| **Linear**             | Personal API key (sent bare, no `Bearer`)        | Issues, projects, teams, users, cycles                                                                                 |
| **Asana**              | Personal access token                            | Tasks, one dataset per project                                                                                         |
| **Freshdesk**          | API key (used as the basic-auth username)        | Tickets, contacts, companies, agents                                                                                   |
| **Klaviyo**            | Private API key (`Klaviyo-API-Key`)              | Profiles, events, lists, metrics, email campaigns                                                                      |
| **Notion**             | Internal integration secret, shared per database | One dataset per database                                                                                               |
| **Airtable**           | Personal access token, scoped per base           | One dataset per table                                                                                                  |
| **Google Analytics 4** | Service-account JSON + property id               | One dataset per report — traffic, pages, events, countries, devices, key events                                        |

**Auth is a pasted credential, never OAuth.** A redirect flow needs a public
callback URL that a self-hosted deployment behind a firewall may not have, so
every connector uses the vendor's server-to-server credential instead. That is
a deliberate constraint, and it is why sources offering no such credential are
not here yet.

Syncs run on demand or hourly / daily / weekly, and the owner is notified if
one fails or comes back partial. Nested API objects are flattened into
columns; arrays are stored as JSON with a count alongside.

### Following a source instead of re-reading it

A sync does one of two things, and the **Streams** button on a connection says
which for every stream it syncs.

**Full refresh** re-reads the source and replaces the dataset. It is the right
semantic where rows are edited and deleted in place with nothing to filter on
— a spreadsheet, a small reference list — and it is what every source did
until now. The previous contents are snapshotted as a restorable version
first, so a sync that pulls a truncated source is recoverable.

**Incremental** asks the API for records changed since the last sync and folds
them into the dataset by key. Re-reading a Salesforce org or a Stripe account
every hour burns the customer's rate limit for no new information and
eventually takes longer than the interval it runs on.

| Source                 | Follows                                                                    | On                                 | Keyed by                        |
| ---------------------- | -------------------------------------------------------------------------- | ---------------------------------- | ------------------------------- |
| **Salesforce**         | every object                                                               | `SystemModstamp`                   | `Id`                            |
| **Stripe**             | charges, invoices, payment intents, refunds, payouts, balance transactions | `created`                          | `id`                            |
| **Shopify**            | every resource                                                             | `updated_at`                       | `id`                            |
| **HubSpot**            | every object                                                               | `hs_lastmodifieddate`              | `id`                            |
| **Jira**               | every project                                                              | `updated`                          | `id`                            |
| **Zendesk**            | tickets, users                                                             | `updated_at`                       | `id`                            |
| **ServiceNow**         | every table                                                                | `sys_updated_on`                   | `sys_id`                        |
| **Intercom**           | contacts, conversations                                                    | `updated_at` (Unix seconds)        | `id`                            |
| **GitHub**             | every repository                                                           | `updated_at`                       | `id`                            |
| **Linear**             | every stream                                                               | `updatedAt`                        | `id`                            |
| **Asana**              | every project                                                              | `modified_at`                      | `gid`                           |
| **Freshdesk**          | tickets, contacts                                                          | `updated_at`                       | `id`                            |
| **Klaviyo**            | every stream                                                               | `updated`, or `datetime` on events | `id`                            |
| **Notion**             | every database                                                             | `last_edited_time`                 | `id`                            |
| **Google Analytics 4** | every report                                                               | `date`, with a 14-day re-read      | `row_key` (the dimension tuple) |

Everything else is a full refresh, and each of those is a decision rather than
something pending. Stripe's `customers`, `subscriptions`, `products` and
`prices` are edited in place while their `created` never moves, so following it
would miss every edit; they are few enough that re-reading costs little.
Zendesk offers no incremental export for **organizations**, Intercom has
no search endpoint for **admins**, and Freshdesk offers no changed-since filter
for **companies** or **agents**. **Airtable** is the third source with nothing
to follow at all: it exposes no universal modified timestamp, and a base only
has one if somebody added a Last Modified Time field to that table. Guessing at
a likely field name would follow the wrong column on some bases and miss edits
silently, which is worse than re-reading — and Airtable bases are small by
design, so a full read is cheap — a workspace has tens of them, so a full
read is one request. Google Sheets has
nothing to follow at all — a worksheet's rows are edited and deleted in place
with no timestamp — which is the case full refresh exists for.

Each API is asked in its own dialect, and three of them have a trap worth
naming:

- **Jira pages by OFFSET**, so it is now ordered `updated ASC`. Under the old
  `updated DESC` a record edited while the sync was running was prepended and
  shifted every later page down one, skipping a row per edit on a busy project.
  JQL also compares a bare timestamp against the **site's** timezone, which the
  connector cannot know without another call, so the window is widened by 24
  hours — wider than any UTC offset can be. Guessing the offset wrong in the
  wrong direction skips edits silently.
- **HubSpot's list endpoint cannot filter by date at all**, so following means
  searching. Search stops returning a cursor past **10,000 results**, so the
  query is reissued from the last timestamp seen rather than paged further —
  otherwise a large object silently stops at ten thousand records.
- **ServiceNow pages by OFFSET** and promises no stable order without one, so
  every query carries `ORDERBYsys_updated_on`. It is also asked for RAW values
  rather than display values: `sysparm_display_value=true` renders dates in the
  instance's own format and timezone, which would make the cursor unparseable
  and shift the window by the instance's offset. The key is `sys_id`, a GUID,
  rather than the `number` an admin can reformat.
- **Intercom's cursor is Unix seconds**, so it compares numerically. Compared
  as text, "9…" beats "10…" and the mark walks backwards at every digit
  boundary.
- **GitHub returns pull requests from the issues endpoint** — they are issues
  underneath. Dropping them would lose data somebody asked for, and hiding the
  difference would make "how many issues" wrong, so `is_pull_request` is a
  column of its own. Issues are asked for with `state=all`: the default is
  open-only, which is a minority of any real repository's history.
- **Freshdesk's two filters are spelt differently**: tickets take
  `updated_since` and contacts take `_updated_since`, with a leading
  underscore. Getting it wrong is silent — Freshdesk ignores an unknown
  parameter and returns everything, so the sync appears to work and simply
  never follows. It also stops paginating a list at 300 pages, so a window
  holding more than 30,000 records raises rather than returning a dataset
  quietly short.
- **Linear has no REST API**, so it is the one connector that posts a GraphQL
  query. Its personal API key goes in as a bare `Authorization` header with no
  `Bearer` prefix, and GraphQL answers a failed query with HTTP 200 and an
  `errors` array — so the status alone would report a failure as a success.
- **Asana's `modified_since` is exclusive**, unlike most of the APIs here. That
  is safe rather than lossy: the task that set the mark has already been
  synced. Its task endpoint also returns only a gid and a name unless
  `opt_fields` names everything wanted, which would otherwise produce a
  two-column dataset that looks like it worked.
- **Klaviyo has its own filter grammar** — `greater-or-equal(field,value)`
  rather than a parameter per field — and requires a `revision` header naming
  an API date on every request. Its `next` link carries the cursor AND the
  filters, so it is followed rather than rebuilt: rebuilding is how a filter
  gets dropped on page two and a sync quietly returns everything. Campaigns
  additionally refuse to answer without a channel filter.
- **A Notion integration sees nothing until each database is SHARED with it**
  from Notion's own UI, and Notion answers that with an empty list rather than
  an error — so an empty stream list says which step is missing. Every property
  is wrapped in its type (`{type:"date",date:{start,end}}`), so each is
  unwrapped to the value a person expects; a date range keeps its end, because
  collapsing one to its start is a silently wrong answer to "how long did this
  take".
- **GA4 is not a record source at all**, and it is the only one here that is
  not. Its Data API answers a question — these dimensions, these metrics, this
  date range — and returns aggregated rows that exist only because you asked
  for them. So a stream is a report definition, the cursor is a date, and the
  key is composed from the dimension tuple because an aggregate has no id.
  Two consequences worth knowing: GA4 **restates recent days** as late hits and
  modelled conversions arrive, so every incremental run re-reads the previous
  fortnight and the merge replaces those days by key — following the mark
  naively would write each day's first, incomplete figure and never look at it
  again, leaving a dashboard permanently understated with nothing to indicate
  it. And every metric arrives as a **string**, so each is converted to a
  number: left alone, a column of sessions is text and cannot be summed.
- **Zendesk's incremental export walks a time-ordered log**, where an empty
  page is a quiet hour rather than the end. Only `end_of_stream` terminates it;
  stopping on an empty page would truncate the sync at the first quiet hour.

Salesforce follows `SystemModstamp` rather than `LastModifiedDate` on purpose.
LastModifiedDate reflects user edits only, while SystemModstamp also moves when
the platform touches a record — a merge, a cascade from a parent, a bulk
update. Following the wrong one silently misses those, and "the row changed but
we never saw it" is the failure that takes a quarter to notice.

Four properties the implementation guarantees, each because getting it wrong
fails quietly:

- **The first pass reads everything and REPLACES.** With no high-water mark
  the connector returns the whole source, and merging that into a stale dataset
  would leave rows the source has since deleted, for ever.
- **The mark is written only after the rows are committed.** Advanced first and
  then lost to a failed ingest, the next run would skip the whole window and
  nothing would say so.
- **It never moves backwards, and never on a tie.** A record sharing the exact
  timestamp of the last one seen is re-read and folded away by its key, rather
  than dropped.
- **A record without the cursor field does not reset the mark.** It is ignored,
  not treated as "start again".

### Starting a stream over

**Streams → Start over** forgets the high-water mark, so the next sync reads
that stream in full. It is the escape hatch for what a cursor cannot see:
records the API changed without moving their cursor field, or a backfill that
predates the connection.

It is **owner-only**, unlike triggering a sync, and it is audited as
`saas_connection.cursor_reset`. A full re-read is charged to the owner's API
quota and can take hours on a large account, so a grantee who may ask for a
refresh cannot spend that on their behalf.

## Providers

| Provider                             | Key fields                                                                                         | Notes                                                                                                                                                                    |
| ------------------------------------ | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **PostgreSQL**                       | host, port (5432), database, username, password, SSL                                               | Any Postgres — Supabase, RDS, Neon, self-hosted. `ssl=require` for managed hosts.                                                                                        |
| **MySQL / MariaDB**                  | host, port (3306), database, username, password, SSL                                               | RDS, PlanetScale, self-hosted.                                                                                                                                           |
| **Oracle**                           | ORDS base URL, database user, password, schema alias (optional)                                    | Autonomous Database or any ORDS-enabled Oracle — see below. HTTPS only; no wallet or client driver needed.                                                               |
| **Amazon Redshift**                  | region, access key, secret key, database, workgroup **or** cluster+DB user                         | Uses the Redshift Data API (serverless or provisioned). IAM needs `redshift-data:*` (+ `GetClusterCredentials` for provisioned).                                         |
| **Snowflake**                        | account, programmatic access token, warehouse, database, schema, role                              | SQL API v2 with a PAT (Snowsight → profile → Programmatic access tokens).                                                                                                |
| **Databricks SQL**                   | workspace URL, SQL warehouse ID, PAT, catalog, schema                                              | Statement Execution API.                                                                                                                                                 |
| **Google BigQuery**                  | project ID, service-account JSON, location, dataset                                                | Needs BigQuery Job User + Data Viewer roles.                                                                                                                             |
| **Azure Synapse**                    | server, database, username, password                                                               | Dedicated SQL pool over TDS — **Node deployment only**.                                                                                                                  |
| **Trino / Starburst / Presto**       | host, port, user, password **or** JWT/OAuth2, catalog, schema, TLS                                 | The usual way to query a raw Iceberg / Delta / Hive lakehouse.                                                                                                           |
| **Amazon Athena**                    | region, access key, secret key, (session token), database, workgroup, results S3 location, catalog | Serverless SQL over S3/Glue. IAM needs Athena + Glue read + `s3:GetObject/PutObject` on the results location.                                                            |
| **Microsoft SQL Server / Azure SQL** | host, port (1433), database, username, password, `instance_name`, `trust_server_certificate`       | TDS — **Node deployment only**. A named instance is mutually exclusive with a port. `trust_server_certificate` for on-prem self-signed certs; never needed on Azure SQL. |
| **ClickHouse**                       | url (HTTP interface), username, password, database                                                 | e.g. `https://abc.clickhouse.cloud:8443`. Works on any deployment.                                                                                                       |

The remaining ten take **exactly** the PostgreSQL or MySQL fields above,
because that is the protocol they speak:

| Same fields as | Providers                                                  |
| -------------- | ---------------------------------------------------------- |
| **PostgreSQL** | CockroachDB, TimescaleDB, AlloyDB, Greenplum, YugabyteDB   |
| **MySQL**      | MariaDB, SingleStore, StarRocks, Apache Doris, PlanetScale |

Each is still a first-class entry with its own label, default port and docs —
pick the engine you actually run.

### Oracle (Autonomous Database / ORDS)

Oracle is reached over **Oracle REST Data Services (ORDS)** rather than the
native SQL\*Net protocol, so it works from any deployment with no wallet or
Instant Client:

1. **ORDS base URL** — on Autonomous Database, open **Database Actions** and
   copy the base up to `/ords`, e.g.
   `https://<id>-<db>.adb.<region>.oraclecloudapps.com/ords`. On-prem Oracle
   needs ORDS installed.
2. **Database user / password** — the schema's DB credentials, used for HTTP
   Basic auth. The schema must be **REST-enabled**
   (`ORDS.ENABLE_SCHEMA`) — Autonomous DB has ORDS on by default.
3. **Schema alias** (optional) — the URL path segment set when REST-enabling;
   defaults to the lower-cased username.

Queries run against `POST {base}/{schema}/_/sql`. Schema browsing lists the
connected schema's own objects from `USER_TAB_COLUMNS` (Oracle has no
`information_schema`), and the connectivity probe uses `SELECT 1 FROM DUAL`.
Use a read-only Oracle user.

## Verifying a connector

Two ways to confirm a connector works end-to-end against your systems:

**From the UI** — in **Data Sources**, click **Test connection** (a `SELECT 1`
probe), then open the **Data Catalog → SQL workbench**, expand the source to
confirm its tables list, and run a small `SELECT`. Green on all three means the
driver, credentials, schema listing and read path all work.

**From the command line** — a harness runs the _real_ drivers against your own
credentials and reports connectivity + schema listing + a read query per
connector:

```bash
cp connectors.example.json connectors.json   # fill in real credentials
npx vite-node scripts/verify-connectors.ts ./connectors.json
```

`connectors.json` holds real credentials and is gitignored — never commit it.
The script prints pass/fail and timings per connector and never echoes secret
values. This is the recommended way to "live-verify" a connector: it exercises
the exact code the app runs, just with credentials only you hold.

## Cataloging a source

The **Data Catalog** (`/data-sql`) can crawl a connected warehouse — or an
S3-compatible bucket (AWS S3, GCS, Cloudflare R2, MinIO, Spaces, B2), an
**Azure Blob Storage / ADLS Gen2** container (account key or SAS token), or an
**Iceberg REST catalog** — to list every table/object, infer schemas by
sampling, profile columns (null %, distinct counts, ranges), estimate row
counts, flag likely-PII columns, and trace which dashboards/prep flows/metrics
consume each table. Crawls can run on a daily/weekly schedule with
schema-drift notifications. Object-storage and Iceberg credentials are
encrypted with the same `PROVIDER_CREDS_SECRET` key.

## Staying connected

Three things run underneath every connection. All are tuned by the operator —
see [deployment](./DEPLOYMENT.md#connection-pooling).

- **Health checks.** Every connection is re-tested on a schedule (default 12
  hours) with the same probe the **Test** button uses — a `SELECT 1` through
  the real driver, or the same stream listing an app source's test makes. A
  warehouse password expiring on your rotation policy is found here rather
  than by a dashboard erroring in front of a customer. A failure shows a
  badge, notifies **once** on the transition, and writes an audit event.
  Nothing is ever auto-disabled.
- **Credential age.** Measured from when the secret was last entered, so
  re-saving a connection resets it and a health check does not. Past the
  policy age (default 90 days) the connection is badged in the UI. Advisory
  only — nothing expires.
- **Retries.** Rate limits and brief provider outages (`429`, `503`, and
  friends) are retried with backoff and jitter rather than failed. Every
  retried request is a read, so nothing can be double-written.

Connections to PostgreSQL- and MySQL-family databases are **pooled**, keyed by
a hash of every credential, so two tenants never share a session and rotating
a password builds a fresh pool. This is worth real time: opening a connection
was 92% of a `SELECT 1` against a local Postgres, and pooling took the driver
from 30.7ms to 2.9ms per query. Reproduce it on your own database with
`npx vite-node scripts/bench-pool.ts`.

If your network has no direct egress, set `HTTPS_PROXY` / `NO_PROXY` and every
connector follows them — without it, reaching a cloud warehouse fails as a
connection timeout rather than anything that names the cause.

## Use cases

### Connect the production warehouse and hand it to the team

1. **Integrations → Data Sources.** Name the connection, choose the provider,
   enter host, database and a read-only login, and test it. The credential is
   encrypted at rest under `PROVIDER_CREDS_SECRET`; what you typed is never
   shown again.
2. Share it with a group from **Admin → IAM → Access**. Grantees' agents and
   workbench sessions query it, but the connection runs as its owner — see
   [Sharing a connection with your team](#sharing-a-connection-with-your-team).
   Rows returned to an agent are capped, so a runaway `SELECT *` cannot flood a
   context window.

### Catalog an Azure container

Finance drops monthly Parquet extracts into an ADLS Gen2 container.

1. **Data catalog → add a source.** Choose _Azure Blob Storage / ADLS Gen2_.
   The wizard asks for the **Container**, the **Storage account name** and an
   **Account key or SAS token**.
2. Files are read in place with DuckDB over `az://`; mount the container into
   the lakehouse as a read-only source when agents should query it with SQL.

### Ask an agent about Jira, or about Zendesk

1. **Integrations → Apps → Jira.** Enter the site URL, the account email and
   an API token, and optionally the project keys to include. Each project
   becomes a stream (`issues:<KEY>`); each stream syncs into a local table
   under a schedule. **Zendesk** works the same way with a subdomain, email
   and token, and exposes tickets, users and organizations.
2. Give an agent the synced tables as a source and ask _which open bugs in
   PROJ are older than thirty days?_ — the answer comes from your copy of the
   data, on your schedule, with the same provenance as any other read.

Each connector checks the credential when you connect it — by listing the
projects, or calling the account endpoint — so a wrong token is reported at
the form rather than at the first sync.

## Security notes

- Credentials are encrypted at rest and never leave the server; shared
  dashboards and embeds always read **stored snapshots**, never a viewer's
  connection.
- Service-role code paths (scheduled refreshes, crawls, shared semantic
  models) load a connection **scoped to its owner**, so a connection id coming
  from user content can never decrypt another tenant's credentials.
- Outbound connectors (Trino, Oracle ORDS, object storage, provider tests) run
  through an SSRF guard that blocks cloud-metadata and link-local targets while
  still allowing private networks where warehouses commonly live.
