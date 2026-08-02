# Data sources & connectors

> Part of the [AgentSwarms docs](../README.md#documentation).

Connect your own databases, warehouses and lakehouses so agents and the BI
Workspace can query them directly. Connectors live under **Integrations →
Data Sources**.

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

| App               | Auth                                           | Streams                                                                                                                |
| ----------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **Google Sheets** | Service-account JSON (share the sheet with it) | One per worksheet                                                                                                      |
| **Stripe**        | Secret or restricted key                       | Charges, customers, invoices, subscriptions, payment intents, products, prices, refunds, payouts, balance transactions |
| **Shopify**       | Admin API access token                         | Orders, customers, products, draft orders, price rules                                                                 |
| **HubSpot**       | Private app token                              | Contacts, companies, deals, tickets, line items, products                                                              |
| **Salesforce**    | Connected app (client credentials)             | Accounts, contacts, leads, opportunities, cases, campaigns, users                                                      |

**Auth is a pasted credential, never OAuth.** A redirect flow needs a public
callback URL that a self-hosted deployment behind a firewall may not have, so
every connector uses the vendor's server-to-server credential instead. That is
a deliberate constraint, and it is why sources offering no such credential are
not here yet.

A sync **replaces** its dataset — the correct semantic for a source where rows
are edited and deleted in place. The previous contents are snapshotted as a
restorable version first. Syncs run on demand or hourly / daily / weekly, and
the owner is notified if one fails or comes back partial. Nested API objects
are flattened into columns; arrays are stored as JSON with a count alongside.

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
S3-compatible bucket (AWS S3, GCS, Cloudflare R2, MinIO, Spaces, B2) or an
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
