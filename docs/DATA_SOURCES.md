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

## Runtime support

The connectors split by how they reach the source:

| Transport         | Providers                                                                                                             | Runs on            |
| ----------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------ |
| HTTP / REST API   | Snowflake, Databricks, BigQuery, Amazon Redshift (Data API), Amazon Athena, Trino/Starburst/Presto, **Oracle (ORDS)** | **Any** deployment |
| Native TCP driver | PostgreSQL, MySQL/MariaDB, Azure Synapse (TDS)                                                                        | **Any** deployment |

## Providers

| Provider                       | Key fields                                                                                         | Notes                                                                                                                            |
| ------------------------------ | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **PostgreSQL**                 | host, port (5432), database, username, password, SSL                                               | Any Postgres — Supabase, RDS, Neon, self-hosted. `ssl=require` for managed hosts.                                                |
| **MySQL / MariaDB**            | host, port (3306), database, username, password, SSL                                               | RDS, PlanetScale, self-hosted.                                                                                                   |
| **Oracle**                     | ORDS base URL, database user, password, schema alias (optional)                                    | Autonomous Database or any ORDS-enabled Oracle — see below. HTTPS only; no wallet or client driver needed.                       |
| **Amazon Redshift**            | region, access key, secret key, database, workgroup **or** cluster+DB user                         | Uses the Redshift Data API (serverless or provisioned). IAM needs `redshift-data:*` (+ `GetClusterCredentials` for provisioned). |
| **Snowflake**                  | account, programmatic access token, warehouse, database, schema, role                              | SQL API v2 with a PAT (Snowsight → profile → Programmatic access tokens).                                                        |
| **Databricks SQL**             | workspace URL, SQL warehouse ID, PAT, catalog, schema                                              | Statement Execution API.                                                                                                         |
| **Google BigQuery**            | project ID, service-account JSON, location, dataset                                                | Needs BigQuery Job User + Data Viewer roles.                                                                                     |
| **Azure Synapse**              | server, database, username, password                                                               | Dedicated SQL pool over TDS — **Node deployment only**.                                                                          |
| **Trino / Starburst / Presto** | host, port, user, password **or** JWT/OAuth2, catalog, schema, TLS                                 | The usual way to query a raw Iceberg / Delta / Hive lakehouse.                                                                   |
| **Amazon Athena**              | region, access key, secret key, (session token), database, workgroup, results S3 location, catalog | Serverless SQL over S3/Glue. IAM needs Athena + Glue read + `s3:GetObject/PutObject` on the results location.                    |

### Oracle (Autonomous Database / ORDS)

Oracle is reached over **Oracle REST Data Services (ORDS)** rather than the
native SQL\*Net protocol, so it works from any deployment (including Cloudflare
Workers) with no wallet or Instant Client:

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
