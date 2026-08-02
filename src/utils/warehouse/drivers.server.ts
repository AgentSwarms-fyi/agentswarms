// Warehouse query drivers — one per provider, all speaking the vendor's
// official API:
//   redshift      → Redshift Data API (SigV4-signed JSON, works for
//                   serverless workgroups and provisioned clusters)
//   snowflake     → SQL API v2 (/api/v2/statements) with a programmatic
//                   access token
//   databricks    → SQL Statement Execution API (/api/2.0/sql/statements)
//   bigquery      → BigQuery REST (jobs.query) with a service-account JWT
//   azure_synapse → TDS via the pure-JS `tedious` driver (dynamic import —
//   + sqlserver     Node/Docker deployments only; neither has a REST SQL API)
//   clickhouse    → HTTP interface, FORMAT JSONCompact
//
// MOST PROVIDERS ARE NOT SEPARATE DRIVERS. CockroachDB, Timescale, AlloyDB,
// Greenplum and Yugabyte speak the PostgreSQL wire protocol; MariaDB,
// SingleStore, StarRocks, Doris and PlanetScale speak MySQL's. Each is a
// first-class provider with its own label, defaults and docs, but dispatch
// routes on PROVIDER_FAMILY so they all share one proven connection routine.
// See types.ts. Adding a wire-compatible database should not add a driver.
//
// All drivers enforce read-only SQL, cap returned rows, and normalise
// results to { columns, rows } with numeric coercion driven by column types.

import { isBlockedAlways } from "@/utils/ssrfGuard.server";
import { checkWarehouseReadOnlySql } from "@/lib/sqlSafety";
import {
  GOOGLE_SCOPES,
  googleAccessToken as googleServiceAccountToken,
} from "@/utils/google/serviceAccount.server";
import {
  warehouseAbsMaxRows,
  warehouseMaxRows,
  warehouseTimeoutMs,
  withWarehouseSlot,
  withWarehouseTimeout,
} from "@/utils/warehouse/governor.server";

import { connectorFetch } from "@/utils/http/connectorFetch.server";

import { getPool } from "./pool.server";
import { FAMILY_DEFAULT_PORT, PROVIDER_FAMILY } from "./types";
import type {
  WarehouseColumn,
  WarehouseConfig,
  WarehouseQueryResult,
  WarehouseTable,
} from "./types";

/**
 * @deprecated Read `warehouseMaxRows()` instead — the limit is configurable
 * per deployment now, and this constant is only the built-in default.
 */
export const MAX_WAREHOUSE_ROWS = 1000;
const POLL_INTERVAL_MS = 750;
// Per-poll-loop deadline. The whole query is additionally bounded by the
// governor's wall-clock budget, which is what stops a chain of individually
// fast polls from running for ever.
const POLL_TIMEOUT_MS = 60_000;

// ── Guards + helpers ─────────────────────────────────────────────────────────

/**
 * Read-only enforcement: one statement, starting with SELECT/WITH/SHOW/
 * DESCRIBE/EXPLAIN and containing no mutating keyword outside a literal.
 * Warehouse-side permissions remain the real boundary — connect read-only
 * credentials.
 *
 * This was a SECOND, hand-rolled implementation that checked the leading verb
 * and rejected stacked statements but had no mutation denylist, so
 * `WITH d AS (DELETE FROM users RETURNING *) SELECT * FROM d` passed it. It now
 * delegates to lib/sqlSafety, which the local engines already use, so the two
 * cannot drift apart again.
 */
export function assertReadOnlySql(sql: string): string {
  const verdict = checkWarehouseReadOnlySql(sql);
  if (!verdict.ok) throw new Error(verdict.reason);
  return verdict.sql;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const NUMERIC_TYPE_RE = /INT|NUM|DEC|FLOAT|DOUBLE|REAL|FIXED|LONG|BIGNUMERIC/i;

function coerceValue(value: unknown, typeName: string): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && NUMERIC_TYPE_RE.test(typeName)) {
    const n = Number(value);
    return Number.isNaN(n) ? value : n;
  }
  return value;
}

function toObjects(columns: WarehouseColumn[], data: unknown[][]): Record<string, unknown>[] {
  return data.map((row) => {
    const obj: Record<string, unknown> = {};
    columns.forEach((c, i) => {
      obj[c.name] = coerceValue(row[i], c.type);
    });
    return obj;
  });
}

async function readError(res: Response, provider: string): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    const msg =
      (j.message as string) ||
      (j.error as { message?: string })?.message ||
      ((j.error as { errors?: { message?: string }[] })?.errors?.[0]?.message ?? "") ||
      (j.Message as string);
    if (msg) return `${provider}: ${msg}`;
  } catch {
    /* fall through */
  }
  return `${provider}: HTTP ${res.status} ${text.slice(0, 200)}`;
}

// The uniform table-listing query (ANSI information_schema; per-driver
// prefixes are applied where the dialect needs them).
const COLUMNS_QUERY = (from: string, extraWhere = "") =>
  `SELECT table_schema, table_name, column_name, data_type ` +
  `FROM ${from} WHERE table_schema NOT IN ('information_schema', 'INFORMATION_SCHEMA', 'pg_catalog', 'pg_internal', 'sys') ${extraWhere} ` +
  `ORDER BY table_schema, table_name, ordinal_position LIMIT 5000`;

function rowsToTables(rows: Record<string, unknown>[]): WarehouseTable[] {
  const map = new Map<string, WarehouseTable>();
  for (const r of rows) {
    const schema = String(r.table_schema ?? r.TABLE_SCHEMA ?? "");
    const name = String(r.table_name ?? r.TABLE_NAME ?? "");
    const key = `${schema}.${name}`;
    if (!map.has(key)) map.set(key, { schema, name, columns: [] });
    map.get(key)!.columns.push({
      name: String(r.column_name ?? r.COLUMN_NAME ?? ""),
      type: String(r.data_type ?? r.DATA_TYPE ?? ""),
    });
  }
  return Array.from(map.values());
}

// ── Snowflake ────────────────────────────────────────────────────────────────

type SnowflakeConfig = Extract<WarehouseConfig, { provider: "snowflake" }>;

async function snowflakeQuery(
  cfg: SnowflakeConfig,
  sql: string,
  maxRows: number,
): Promise<{ columns: WarehouseColumn[]; data: unknown[][]; truncated: boolean }> {
  const base = `https://${cfg.account}.snowflakecomputing.com`;
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: `Bearer ${cfg.token}`,
    "X-Snowflake-Authorization-Token-Type": "PROGRAMMATIC_ACCESS_TOKEN",
  };
  let res = await connectorFetch(`${base}/api/v2/statements`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      statement: sql,
      timeout: Math.floor(POLL_TIMEOUT_MS / 1000),
      warehouse: cfg.warehouse,
      database: cfg.database,
      schema: cfg.schema || undefined,
      role: cfg.role || undefined,
      parameters: { rows_per_resultset: maxRows + 1 },
    }),
  });

  // 202 = still running: poll the statement handle.
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (res.status === 202) {
    if (Date.now() > deadline) throw new Error("Snowflake: query timed out");
    const { statementHandle } = (await res.json()) as { statementHandle: string };
    await sleep(POLL_INTERVAL_MS);
    res = await connectorFetch(`${base}/api/v2/statements/${statementHandle}`, { headers });
  }
  if (!res.ok) throw new Error(await readError(res, "Snowflake"));

  const body = (await res.json()) as {
    resultSetMetaData?: { rowType?: { name: string; type: string }[]; partitionInfo?: unknown[] };
    data?: unknown[][];
  };
  const columns = (body.resultSetMetaData?.rowType ?? []).map((c) => ({
    name: c.name,
    type: c.type,
  }));
  const data = body.data ?? [];
  const truncated =
    data.length > maxRows || (body.resultSetMetaData?.partitionInfo?.length ?? 1) > 1;
  return { columns, data: data.slice(0, maxRows), truncated };
}

// ── Databricks ───────────────────────────────────────────────────────────────

type DatabricksConfig = Extract<WarehouseConfig, { provider: "databricks" }>;

async function databricksQuery(
  cfg: DatabricksConfig,
  sql: string,
  maxRows: number,
): Promise<{ columns: WarehouseColumn[]; data: unknown[][]; truncated: boolean }> {
  const base = cfg.host.replace(/\/+$/, "");
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${cfg.token}`,
  };
  const submit = await connectorFetch(`${base}/api/2.0/sql/statements`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      statement: sql,
      warehouse_id: cfg.warehouse_id,
      catalog: cfg.catalog || undefined,
      schema: cfg.schema || undefined,
      wait_timeout: "30s",
      on_wait_timeout: "CONTINUE",
      disposition: "INLINE",
      format: "JSON_ARRAY",
      row_limit: maxRows + 1,
    }),
  });
  if (!submit.ok) throw new Error(await readError(submit, "Databricks"));

  type DbxStatement = {
    statement_id: string;
    status: { state: string; error?: { message?: string } };
    manifest?: {
      schema?: { columns?: { name: string; type_text: string }[] };
      truncated?: boolean;
    };
    result?: { data_array?: unknown[][] };
  };
  let body = (await submit.json()) as DbxStatement;
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (body.status.state === "PENDING" || body.status.state === "RUNNING") {
    if (Date.now() > deadline) throw new Error("Databricks: query timed out");
    await sleep(POLL_INTERVAL_MS);
    const poll = await connectorFetch(`${base}/api/2.0/sql/statements/${body.statement_id}`, {
      headers,
    });
    if (!poll.ok) throw new Error(await readError(poll, "Databricks"));
    body = (await poll.json()) as DbxStatement;
  }
  if (body.status.state !== "SUCCEEDED") {
    throw new Error(`Databricks: ${body.status.error?.message ?? body.status.state}`);
  }
  const columns = (body.manifest?.schema?.columns ?? []).map((c) => ({
    name: c.name,
    type: c.type_text,
  }));
  const data = body.result?.data_array ?? [];
  const truncated = Boolean(body.manifest?.truncated) || data.length > maxRows;
  return { columns, data: data.slice(0, maxRows), truncated };
}

// ── BigQuery ─────────────────────────────────────────────────────────────────

type BigQueryConfig = Extract<WarehouseConfig, { provider: "bigquery" }>;

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const b64 = pem
    .replace(/-----BEGIN [A-Z ]+-----/g, "")
    .replace(/-----END [A-Z ]+-----/g, "")
    .replace(/\s+/g, "");
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

/** BigQuery's access token. The signing itself lives in utils/google so the
 *  Sheets connector uses the same implementation rather than a second copy. */
function googleAccessToken(serviceAccountJson: string): Promise<string> {
  return googleServiceAccountToken(serviceAccountJson, {
    scope: GOOGLE_SCOPES.bigquery,
    label: "BigQuery",
  });
}

async function bigqueryQuery(
  cfg: BigQueryConfig,
  sql: string,
  maxRows: number,
): Promise<{ columns: WarehouseColumn[]; data: unknown[][]; truncated: boolean }> {
  const token = await googleAccessToken(cfg.service_account_json);
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
  type BqResponse = {
    jobComplete?: boolean;
    jobReference?: { jobId?: string };
    schema?: { fields?: { name: string; type: string }[] };
    rows?: { f: { v: unknown }[] }[];
    totalRows?: string;
    error?: { message?: string };
  };
  let body: BqResponse;
  const res = await connectorFetch(
    `https://bigquery.googleapis.com/bigquery/v2/projects/${encodeURIComponent(cfg.project_id)}/queries`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        query: sql,
        useLegacySql: false,
        maxResults: maxRows,
        timeoutMs: 30_000,
        location: cfg.location || undefined,
      }),
    },
  );
  if (!res.ok) throw new Error(await readError(res, "BigQuery"));
  body = (await res.json()) as BqResponse;

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (!body.jobComplete) {
    if (Date.now() > deadline) throw new Error("BigQuery: query timed out");
    const jobId = body.jobReference?.jobId;
    if (!jobId) throw new Error("BigQuery: job did not return an id");
    await sleep(POLL_INTERVAL_MS);
    const poll = await connectorFetch(
      `https://bigquery.googleapis.com/bigquery/v2/projects/${encodeURIComponent(cfg.project_id)}/queries/${jobId}?maxResults=${maxRows}${cfg.location ? `&location=${encodeURIComponent(cfg.location)}` : ""}`,
      { headers },
    );
    if (!poll.ok) throw new Error(await readError(poll, "BigQuery"));
    body = (await poll.json()) as BqResponse;
  }

  const columns = (body.schema?.fields ?? []).map((f) => ({ name: f.name, type: f.type }));
  const data = (body.rows ?? []).map((r) => r.f.map((cell) => cell.v));
  const truncated = Number(body.totalRows ?? 0) > data.length;
  return { columns, data, truncated };
}

// ── Redshift (Data API, SigV4) ───────────────────────────────────────────────

type RedshiftConfig = Extract<WarehouseConfig, { provider: "redshift" }>;

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey(
    "raw",
    key instanceof Uint8Array
      ? (key.buffer.slice(key.byteOffset, key.byteOffset + key.byteLength) as ArrayBuffer)
      : key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(data)));
}

async function sha256Hex(data: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function redshiftDataApi(
  cfg: RedshiftConfig,
  target: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const service = "redshift-data";
  const host = `${service}.${cfg.region}.amazonaws.com`;
  const body = JSON.stringify(payload);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);

  const canonicalHeaders = `content-type:application/x-amz-json-1.1\nhost:${host}\nx-amz-date:${amzDate}\nx-amz-target:RedshiftData.${target}\n`;
  const signedHeaders = "content-type;host;x-amz-date;x-amz-target";
  const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${await sha256Hex(body)}`;
  const credentialScope = `${dateStamp}/${cfg.region}/${service}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${credentialScope}\n${await sha256Hex(canonicalRequest)}`;

  const kDate = await hmac(new TextEncoder().encode(`AWS4${cfg.secret_access_key}`), dateStamp);
  const kRegion = await hmac(kDate, cfg.region);
  const kService = await hmac(kRegion, service);
  const kSigning = await hmac(kService, "aws4_request");
  const signature = [...(await hmac(kSigning, stringToSign))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const res = await connectorFetch(`https://${host}/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Date": amzDate,
      "X-Amz-Target": `RedshiftData.${target}`,
      Authorization: `AWS4-HMAC-SHA256 Credential=${cfg.access_key_id}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    body,
  });
  if (!res.ok) throw new Error(await readError(res, "Redshift"));
  return (await res.json()) as Record<string, unknown>;
}

async function redshiftQuery(
  cfg: RedshiftConfig,
  sql: string,
  maxRows: number,
): Promise<{ columns: WarehouseColumn[]; data: unknown[][]; truncated: boolean }> {
  const exec = await redshiftDataApi(cfg, "ExecuteStatement", {
    Sql: sql,
    Database: cfg.database,
    ...(cfg.workgroup_name
      ? { WorkgroupName: cfg.workgroup_name }
      : { ClusterIdentifier: cfg.cluster_identifier, DbUser: cfg.db_user }),
  });
  const id = exec.Id as string;

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    const desc = await redshiftDataApi(cfg, "DescribeStatement", { Id: id });
    const status = desc.Status as string;
    if (status === "FINISHED") break;
    if (status === "FAILED" || status === "ABORTED") {
      throw new Error(`Redshift: ${(desc.Error as string) ?? status}`);
    }
    if (Date.now() > deadline) throw new Error("Redshift: query timed out");
    await sleep(POLL_INTERVAL_MS);
  }

  type RsCell = {
    stringValue?: string;
    longValue?: number;
    doubleValue?: number;
    booleanValue?: boolean;
    isNull?: boolean;
  };
  const result = (await redshiftDataApi(cfg, "GetStatementResult", { Id: id })) as {
    ColumnMetadata?: { name: string; typeName?: string }[];
    Records?: RsCell[][];
    NextToken?: string;
  };
  const columns = (result.ColumnMetadata ?? []).map((c) => ({
    name: c.name,
    type: c.typeName ?? "",
  }));
  const data = (result.Records ?? []).map((row) =>
    row.map((cell) =>
      cell.isNull
        ? null
        : (cell.stringValue ?? cell.longValue ?? cell.doubleValue ?? cell.booleanValue ?? null),
    ),
  );
  const truncated = Boolean(result.NextToken) || data.length > maxRows;
  return { columns, data: data.slice(0, maxRows), truncated };
}

// ── Amazon Athena (SigV4, JSON API) ──────────────────────────────────────────
// Queries a Glue/Iceberg lakehouse through Athena's API: StartQueryExecution →
// poll GetQueryExecution → page GetQueryResults. Reuses the SigV4 primitives
// (hmac/sha256Hex) written for the Redshift Data API.

type AthenaConfig = Extract<WarehouseConfig, { provider: "athena" }>;

async function athenaApi(
  cfg: AthenaConfig,
  target: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const service = "athena";
  // region flows into the host + credential scope — keep it strictly [a-z0-9-].
  if (!/^[a-z0-9-]+$/.test(cfg.region)) throw new Error("Athena: invalid region");
  const host = `${service}.${cfg.region}.amazonaws.com`;
  const body = JSON.stringify(payload);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const token = cfg.session_token?.trim();

  // Canonical headers must be lexicographically sorted.
  const canonicalHeaders =
    `content-type:application/x-amz-json-1.1\n` +
    `host:${host}\n` +
    `x-amz-date:${amzDate}\n` +
    (token ? `x-amz-security-token:${token}\n` : "") +
    `x-amz-target:AmazonAthena.${target}\n`;
  const signedHeaders =
    "content-type;host;x-amz-date;" + (token ? "x-amz-security-token;" : "") + "x-amz-target";
  const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${await sha256Hex(body)}`;
  const credentialScope = `${dateStamp}/${cfg.region}/${service}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${credentialScope}\n${await sha256Hex(canonicalRequest)}`;

  const kDate = await hmac(new TextEncoder().encode(`AWS4${cfg.secret_access_key}`), dateStamp);
  const kRegion = await hmac(kDate, cfg.region);
  const kService = await hmac(kRegion, service);
  const kSigning = await hmac(kService, "aws4_request");
  const signature = [...(await hmac(kSigning, stringToSign))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const res = await connectorFetch(`https://${host}/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Date": amzDate,
      "X-Amz-Target": `AmazonAthena.${target}`,
      ...(token ? { "X-Amz-Security-Token": token } : {}),
      Authorization: `AWS4-HMAC-SHA256 Credential=${cfg.access_key_id}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    body,
  });
  if (!res.ok) throw new Error(await readError(res, "Athena"));
  return (await res.json()) as Record<string, unknown>;
}

async function athenaQuery(
  cfg: AthenaConfig,
  sql: string,
  maxRows: number,
): Promise<{ columns: WarehouseColumn[]; data: unknown[][]; truncated: boolean }> {
  const start = await athenaApi(cfg, "StartQueryExecution", {
    QueryString: sql,
    QueryExecutionContext: {
      ...(cfg.database ? { Database: cfg.database } : {}),
      Catalog: cfg.catalog || "AwsDataCatalog",
    },
    ...(cfg.output_location
      ? { ResultConfiguration: { OutputLocation: cfg.output_location } }
      : {}),
    WorkGroup: cfg.workgroup || "primary",
  });
  const id = start.QueryExecutionId as string;
  if (!id) throw new Error("Athena: no query execution id returned");

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    const desc = (await athenaApi(cfg, "GetQueryExecution", { QueryExecutionId: id })) as {
      QueryExecution?: { Status?: { State?: string; StateChangeReason?: string } };
    };
    const state = desc.QueryExecution?.Status?.State;
    if (state === "SUCCEEDED") break;
    if (state === "FAILED" || state === "CANCELLED") {
      throw new Error(`Athena: ${desc.QueryExecution?.Status?.StateChangeReason ?? state}`);
    }
    if (Date.now() > deadline) throw new Error("Athena: query timed out");
    await sleep(POLL_INTERVAL_MS);
  }

  type AthenaRow = { Data?: { VarCharValue?: string }[] };
  let columns: WarehouseColumn[] = [];
  const data: unknown[][] = [];
  let nextToken: string | undefined;
  let firstPage = true;
  let truncated = false;

  // Athena caps GetQueryResults at 1000 rows/page; the very first page's first
  // row is the header, which counts toward MaxResults.
  while (data.length < maxRows) {
    const want = maxRows - data.length + (firstPage ? 1 : 0);
    const result = (await athenaApi(cfg, "GetQueryResults", {
      QueryExecutionId: id,
      MaxResults: Math.max(1, Math.min(1000, want)),
      ...(nextToken ? { NextToken: nextToken } : {}),
    })) as {
      ResultSet?: {
        Rows?: AthenaRow[];
        ResultSetMetadata?: { ColumnInfo?: { Name: string; Type: string }[] };
      };
      NextToken?: string;
    };
    const colInfo = result.ResultSet?.ResultSetMetadata?.ColumnInfo ?? [];
    if (columns.length === 0 && colInfo.length) {
      columns = colInfo.map((c) => ({ name: c.Name, type: c.Type }));
    }
    let rows = result.ResultSet?.Rows ?? [];
    if (firstPage) rows = rows.slice(1); // drop the header row
    for (const r of rows) {
      if (data.length >= maxRows) {
        truncated = true;
        break;
      }
      data.push((r.Data ?? []).map((cell) => cell.VarCharValue ?? null));
    }
    nextToken = result.NextToken;
    firstPage = false;
    if (!nextToken) break;
  }
  if (nextToken) truncated = true;
  return { columns, data, truncated };
}

// ── Azure Synapse (TDS via tedious — Node runtimes only) ─────────────────────

type SynapseConfig = Extract<WarehouseConfig, { provider: "azure_synapse" }>;
type SqlServerConfig = Extract<WarehouseConfig, { provider: "sqlserver" }>;
type TdsLike = SynapseConfig | SqlServerConfig;

/**
 * SQL Server and Azure Synapse over TDS.
 *
 * One routine for both: Synapse's dedicated SQL pool IS SQL Server as far as
 * the wire is concerned. They differ only in defaults, and those differences
 * are real — an on-prem SQL Server commonly presents a self-signed
 * certificate, which Azure never does, so `trustServerCertificate` is
 * offered for SQL Server and pinned OFF for Synapse rather than being left to
 * a shared default that would be wrong for one of them.
 */
async function tdsQuery(
  cfg: TdsLike,
  sql: string,
  maxRows: number,
): Promise<{ columns: WarehouseColumn[]; data: unknown[][]; truncated: boolean }> {
  const label = cfg.provider === "sqlserver" ? "SQL Server" : "Azure Synapse";
  let tedious: typeof import("tedious");
  try {
    tedious = await import(/* @vite-ignore */ "tedious");
  } catch {
    throw new Error(
      `${label} connections need a Node deployment (Docker/bare Node) — the TDS driver is not available in this runtime.`,
    );
  }
  const { Connection, Request } = tedious;

  const isServer = cfg.provider === "sqlserver";
  // Synapse is addressed by `server`; SQL Server by host/port like every other
  // host-based provider, so its config uses the shared HostPortConfig shape.
  const server = isServer ? cfg.host : cfg.server;
  const port = isServer && cfg.port ? Number(cfg.port) : undefined;

  return new Promise((resolve, reject) => {
    const connection = new Connection({
      server,
      authentication: {
        type: "default",
        options: { userName: cfg.username, password: cfg.password },
      },
      options: {
        database: cfg.database,
        // A named instance is resolved by the SQL Browser service and is
        // mutually exclusive with a port; sending both makes tedious ignore
        // the instance and silently hit the wrong server.
        ...(isServer && cfg.instance_name
          ? { instanceName: cfg.instance_name }
          : port
            ? { port }
            : {}),
        encrypt: isServer ? cfg.ssl !== "disable" : true,
        rowCollectionOnRequestCompletion: false,
        trustServerCertificate: isServer ? cfg.trust_server_certificate === "true" : false,
        requestTimeout: POLL_TIMEOUT_MS,
        connectTimeout: 20_000,
      },
    });
    const columns: WarehouseColumn[] = [];
    const data: unknown[][] = [];
    let truncated = false;
    let settled = false;
    const fail = (err: Error) => {
      if (!settled) {
        settled = true;
        try {
          connection.close();
        } catch {
          /* ignore */
        }
        reject(new Error(`${label}: ${err.message}`));
      }
    };

    connection.on("connect", (err) => {
      if (err) return fail(err);
      const request = new Request(sql, (err2) => {
        if (err2) return fail(err2);
        if (!settled) {
          settled = true;
          connection.close();
          resolve({ columns, data, truncated });
        }
      });
      request.on("columnMetadata", (meta) => {
        for (const m of meta as { colName: string; type: { name: string } }[]) {
          columns.push({ name: m.colName, type: m.type?.name ?? "" });
        }
      });
      request.on("row", (cells: { value: unknown }[]) => {
        if (data.length >= maxRows) {
          truncated = true;
          return;
        }
        data.push(cells.map((c) => c.value));
      });
      connection.execSql(request);
    });
    connection.on("error", fail);
    connection.connect();
  });
}

// ── PostgreSQL / MySQL (generic OLTP databases) ─────────────────────────────

/** Rough type bucket so downstream tooling (ontology, prep) sees semantics. */
function pgTypeName(oid: number): string {
  if ([20, 21, 23, 26, 700, 701, 1700].includes(oid)) return "numeric";
  if ([1082, 1114, 1184, 1083].includes(oid)) return "date";
  if (oid === 16) return "boolean";
  return "text";
}

/**
 * Any provider that speaks the PostgreSQL wire protocol.
 *
 * The driver is deliberately typed by SHAPE rather than by provider name:
 * CockroachDB, Timescale, AlloyDB, Greenplum and Yugabyte are all served by
 * this one routine, and it must not need editing to add the next one.
 */
type PgLike = Extract<WarehouseConfig, { provider: "postgres" }>;
type MySqlLike = Extract<WarehouseConfig, { provider: "mysql" }>;

/** Shape both the pooled and unpooled paths return, so they cannot diverge. */
type PgResultLike = {
  fields?: { name: string; dataTypeID: number }[];
  rows?: unknown[];
};

function shapePgResult(
  res: PgResultLike,
  maxRows: number,
): { columns: WarehouseColumn[]; data: unknown[][]; truncated: boolean } {
  const columns: WarehouseColumn[] = (res.fields ?? []).map((f) => ({
    name: f.name,
    type: pgTypeName(f.dataTypeID),
  }));
  const all = (res.rows ?? []) as Record<string, unknown>[];
  const data = all.slice(0, maxRows).map((r) => columns.map((c) => r[c.name]));
  return { columns, data, truncated: all.length > maxRows };
}

async function pgQuery(
  config: PgLike,
  sql: string,
  maxRows: number,
): Promise<{ columns: WarehouseColumn[]; data: unknown[][]; truncated: boolean }> {
  // Pooled path. Measured at 2.2ms/query against a local Postgres versus
  // 27.1ms opening a connection each time — see scripts/bench-pool.ts.
  const pool = (await getPool("postgres", config)) as import("pg").Pool | null;
  if (pool) {
    const res = await pool.query(sql);
    return shapePgResult(res as PgResultLike, maxRows);
  }

  const { Client } = await import("pg");
  const client = new Client({
    host: config.host,
    port: Number(config.port) || FAMILY_DEFAULT_PORT.postgres,
    database: config.database,
    user: config.username,
    password: config.password,
    ssl: config.ssl === "require" ? { rejectUnauthorized: false } : undefined,
    connectionTimeoutMillis: 15_000,
    query_timeout: 60_000,
  });
  await client.connect();
  try {
    return shapePgResult((await client.query(sql)) as PgResultLike, maxRows);
  } finally {
    await client.end();
  }
}

function mysqlTypeName(t: number | undefined): string {
  if (t === undefined) return "text";
  if ([0, 1, 2, 3, 4, 5, 8, 9, 246].includes(t)) return "numeric";
  if ([7, 10, 11, 12, 13, 17, 18, 19].includes(t)) return "date";
  return "text";
}

/** Shared by the pooled and unpooled MySQL paths so they cannot diverge. */
function shapeMySqlResult(
  rows: unknown,
  fields: { name: string; type?: number }[] | undefined,
  maxRows: number,
): { columns: WarehouseColumn[]; data: unknown[][]; truncated: boolean } {
  const columns: WarehouseColumn[] = (fields ?? []).map((f) => ({
    name: f.name,
    type: mysqlTypeName(f.type),
  }));
  const all = (Array.isArray(rows) ? rows : []) as Record<string, unknown>[];
  const data = all.slice(0, maxRows).map((r) => columns.map((c) => r[c.name]));
  return { columns, data, truncated: all.length > maxRows };
}

async function mysqlQuery(
  config: MySqlLike,
  sql: string,
  maxRows: number,
): Promise<{ columns: WarehouseColumn[]; data: unknown[][]; truncated: boolean }> {
  const pool = (await getPool("mysql", config)) as import("mysql2/promise").Pool | null;
  if (pool) {
    const [rows, fields] = await pool.query(sql);
    return shapeMySqlResult(rows, fields as unknown as { name: string; type?: number }[], maxRows);
  }

  const mysql = await import("mysql2/promise");
  const conn = await mysql.createConnection({
    host: config.host,
    port: Number(config.port) || FAMILY_DEFAULT_PORT.mysql,
    database: config.database,
    user: config.username,
    password: config.password,
    ssl: config.ssl === "require" ? { rejectUnauthorized: false } : undefined,
    connectTimeout: 15_000,
  });
  try {
    const [rows, fields] = await conn.query(sql);
    return shapeMySqlResult(rows, fields as unknown as { name: string; type?: number }[], maxRows);
  } finally {
    await conn.end();
  }
}

// ── ClickHouse ───────────────────────────────────────────────────────────────
// ClickHouse's HTTP interface takes the SQL as the POST body and returns
// whatever FORMAT the query asks for. Asking for JSONCompact gets typed column
// metadata and row arrays in one response, so there is no second round trip to
// discover the schema and no per-row key repetition on the wire.

type ClickHouseConfig = Extract<WarehouseConfig, { provider: "clickhouse" }>;

type ClickHouseResponse = {
  meta?: { name: string; type: string }[];
  data?: unknown[][];
  rows?: number;
  exception?: string;
};

async function clickhouseQuery(
  cfg: ClickHouseConfig,
  sql: string,
  maxRows: number,
): Promise<{ columns: WarehouseColumn[]; data: unknown[][]; truncated: boolean }> {
  const base = cfg.url.replace(/\/+$/, "");
  const url = new URL(base);
  if (cfg.database) url.searchParams.set("database", cfg.database);
  // Ask for one row more than the cap so a full page is distinguishable from a
  // truncated one without a second COUNT query.
  url.searchParams.set("max_result_rows", String(maxRows + 1));
  url.searchParams.set("result_overflow_mode", "break");
  // Belt and braces against a query that ignores the guard: the server refuses
  // to write regardless of what the SQL says.
  url.searchParams.set("readonly", "1");

  // SSRF: refuse cloud metadata / link-local targets. Private networks stay
  // allowed, as for Trino — a self-hosted ClickHouse commonly sits inside the
  // customer's own VPC.
  if (isBlockedAlways(url.hostname)) {
    throw new Error("ClickHouse: refusing to connect to a blocked host");
  }
  const res = await connectorFetch(url.toString(), {
    method: "POST",
    headers: {
      // ClickHouse Cloud and self-hosted both accept Basic; the X-ClickHouse-*
      // headers are not supported by every proxy in front of it.
      Authorization: `Basic ${btoa(`${cfg.username}:${cfg.password}`)}`,
      "Content-Type": "text/plain; charset=utf-8",
    },
    // FORMAT is appended rather than set via a param so it survives a query
    // that already ends in a semicolon-free SELECT.
    body: `${sql}\nFORMAT JSONCompact`,
    signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
  });

  if (!res.ok) throw new Error(`ClickHouse: ${await readError(res, "clickhouse")}`);
  const json = (await res.json()) as ClickHouseResponse;
  // A 200 with an `exception` body happens when the error is raised after the
  // response has begun streaming; treating it as success would surface a
  // truncated result as a complete one.
  if (json.exception) throw new Error(`ClickHouse: ${json.exception}`);

  const columns: WarehouseColumn[] = (json.meta ?? []).map((m) => ({
    name: m.name,
    type: m.type,
  }));
  const all = json.data ?? [];
  return { columns, data: all.slice(0, maxRows), truncated: all.length > maxRows };
}

// ── Trino / Starburst / Presto ───────────────────────────────────────────────
// Speaks the Trino HTTP client protocol: POST the SQL text to /v1/statement,
// then follow `nextUri` (GET) until it is absent, accumulating `columns` and
// `data` across pages. Works against Trino, Starburst (Galaxy/Enterprise) and
// Presto, which is the common way to query a raw Iceberg/Delta/Hive lakehouse.

type TrinoConfig = Extract<WarehouseConfig, { provider: "trino" }>;

type TrinoResponse = {
  id: string;
  nextUri?: string;
  columns?: { name: string; type: string }[];
  data?: unknown[][];
  error?: { message?: string; errorName?: string };
  stats?: { state?: string };
};

function trinoBaseUrl(cfg: TrinoConfig): { base: string; host: string } {
  const host = cfg.host
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .trim();
  const useHttps = cfg.ssl !== "disable";
  const port = cfg.port && cfg.port.trim() ? cfg.port.trim() : useHttps ? "443" : "8080";
  return { base: `${useHttps ? "https" : "http"}://${host}:${port}`, host };
}

function trinoHeaders(cfg: TrinoConfig): Record<string, string> {
  const headers: Record<string, string> = {
    "X-Trino-User": cfg.username,
    "X-Trino-Source": "agentswarms",
  };
  if (cfg.catalog) headers["X-Trino-Catalog"] = cfg.catalog;
  if (cfg.schema) headers["X-Trino-Schema"] = cfg.schema;
  if (cfg.access_token) headers["Authorization"] = `Bearer ${cfg.access_token}`;
  else if (cfg.password)
    headers["Authorization"] = `Basic ${btoa(`${cfg.username}:${cfg.password}`)}`;
  return headers;
}

async function trinoQuery(
  cfg: TrinoConfig,
  sql: string,
  maxRows: number,
): Promise<{ columns: WarehouseColumn[]; data: unknown[][]; truncated: boolean }> {
  const { base, host } = trinoBaseUrl(cfg);
  // SSRF: refuse cloud metadata / link-local targets (private networks stay
  // allowed — a Trino coordinator commonly lives inside the customer's VPC).
  if (isBlockedAlways(host)) {
    throw new Error("Trino: refusing to connect to a blocked host");
  }
  const headers = trinoHeaders(cfg);

  let cols: WarehouseColumn[] | null = null;
  const data: unknown[][] = [];
  let truncated = false;
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  let res = await connectorFetch(`${base}/v1/statement`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "text/plain" },
    body: sql,
  });

  // Trino long-polls each nextUri (~1s) while QUEUED/RUNNING, so no client
  // sleep is needed; the deadline + iteration cap guard against a stuck query.
  for (let i = 0; i < 10_000; i++) {
    if (!res.ok) throw new Error(await readError(res, "Trino"));
    const body = (await res.json()) as TrinoResponse;
    if (body.error) {
      throw new Error(`Trino: ${body.error.message ?? body.error.errorName ?? "query failed"}`);
    }
    if (body.columns && !cols) {
      cols = body.columns.map((c) => ({ name: c.name, type: c.type }));
    }
    for (const row of body.data ?? []) {
      if (data.length >= maxRows) {
        truncated = true;
        break;
      }
      data.push(row);
    }
    // Stop once we have enough rows or the statement is complete.
    if (!body.nextUri || data.length >= maxRows) {
      if (body.nextUri && data.length >= maxRows) {
        truncated = true;
        // Best-effort cancel so we don't leave the query running.
        void connectorFetch(body.nextUri, { method: "DELETE", headers }).catch(() => {});
      }
      break;
    }
    if (Date.now() > deadline) throw new Error("Trino: query timed out");
    res = await connectorFetch(body.nextUri, { method: "GET", headers });
  }

  return { columns: cols ?? [], data, truncated };
}

// ── Oracle (ORDS REST SQL — Autonomous DB & any ORDS-enabled database) ────────
// Runs SQL over HTTPS via ORDS's REST SQL Service (POST {base}/{schema}/_/sql),
// so no wallet, Instant Client, or native driver is needed — it works on both
// the Cloudflare and Node builds. Autonomous Database ships ORDS enabled;
// on-prem databases need ORDS installed and the schema REST-enabled
// (ORDS.ENABLE_SCHEMA) with a password for HTTP Basic auth.

type OracleConfig = Extract<WarehouseConfig, { provider: "oracle" }>;

function oracleSchemaAlias(cfg: OracleConfig): string {
  return (cfg.schema?.trim() || cfg.username.trim().toLowerCase()).replace(/[^A-Za-z0-9_.-]/g, "");
}

async function oracleQuery(
  cfg: OracleConfig,
  sql: string,
  maxRows: number,
): Promise<{ columns: WarehouseColumn[]; data: unknown[][]; truncated: boolean }> {
  const base = cfg.ords_url.trim().replace(/\/+$/, "");
  const host = base
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .trim();
  if (!host) throw new Error("Oracle: ORDS URL is required");
  // SSRF: block cloud-metadata / link-local targets (private ORDS hosts stay
  // allowed — an on-prem ORDS commonly lives inside the customer's network).
  if (isBlockedAlways(host)) throw new Error("Oracle: refusing to connect to a blocked host");

  const schema = oracleSchemaAlias(cfg);
  const url = `${base}/${encodeURIComponent(schema)}/_/sql?limit=${maxRows + 1}`;
  const res = await connectorFetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/sql",
      Accept: "application/json",
      Authorization: `Basic ${btoa(`${cfg.username}:${cfg.password}`)}`,
    },
    body: sql,
  });
  if (!res.ok) throw new Error(await readError(res, "Oracle"));

  type OrdsMeta = { columnName?: string; jsonColumnName?: string; columnTypeName?: string };
  type OrdsStatement = {
    resultSet?: { metadata?: OrdsMeta[]; items?: Record<string, unknown>[]; hasMore?: boolean };
    errorCode?: string;
    errorMessage?: string;
    errorLine?: number;
  };
  const body = (await res.json()) as { items?: OrdsStatement[] };
  const stmts = body.items ?? [];
  const errored = stmts.find((s) => s.errorMessage);
  if (errored?.errorMessage) throw new Error(`Oracle: ${errored.errorMessage}`);

  const rs = (stmts.find((s) => s.resultSet) ?? stmts[0])?.resultSet;
  const meta = rs?.metadata ?? [];
  const columns: WarehouseColumn[] = meta.map((m) => ({
    name: m.columnName ?? m.jsonColumnName ?? "",
    type: m.columnTypeName ?? "",
  }));
  // ORDS keys each row object by jsonColumnName (defaults to the lower-cased
  // column name); fall back defensively across casings.
  const keys = meta.map((m, i) => ({
    json: m.jsonColumnName,
    upper: m.columnName,
    lower: (m.columnName ?? columns[i]?.name ?? "").toLowerCase(),
  }));
  const items = rs?.items ?? [];
  const data = items.slice(0, maxRows).map((row) =>
    keys.map((k) => {
      if (k.json && k.json in row) return row[k.json];
      if (k.upper && k.upper in row) return row[k.upper];
      return row[k.lower];
    }),
  );
  const truncated = Boolean(rs?.hasMore) || items.length > maxRows;
  return { columns, data, truncated };
}

// ── Public entry points ──────────────────────────────────────────────────────

export async function executeWarehouseQuery(
  config: WarehouseConfig,
  sql: string,
  maxRows?: number,
  /**
   * `userId` is the tenant this query is billed to — for a shared dashboard
   * that is the OWNER, not the viewer, so one popular dashboard cannot consume
   * every other tenant's concurrency budget.
   */
  opts: { userId?: string; timeoutMs?: number } = {},
): Promise<WarehouseQueryResult> {
  const safeSql = assertReadOnlySql(sql);
  const cappedRows = Math.min(Math.max(1, maxRows ?? warehouseMaxRows()), warehouseAbsMaxRows());
  const started = Date.now();

  const run = async (): Promise<{
    columns: WarehouseColumn[];
    data: unknown[][];
    truncated: boolean;
  }> => {
    // Wire-compatible providers route to the driver for their family FIRST, so
    // adding CockroachDB or MariaDB never means adding a connection routine.
    const family = PROVIDER_FAMILY[config.provider];
    if (family === "postgres") return pgQuery(config as PgLike, safeSql, cappedRows);
    if (family === "mysql") return mysqlQuery(config as MySqlLike, safeSql, cappedRows);
    if (family === "tds") return tdsQuery(config as TdsLike, safeSql, cappedRows);

    switch (config.provider) {
      case "snowflake":
        return snowflakeQuery(config, safeSql, cappedRows);
      case "databricks":
        return databricksQuery(config, safeSql, cappedRows);
      case "bigquery":
        return bigqueryQuery(config, safeSql, cappedRows);
      case "redshift":
        return redshiftQuery(config, safeSql, cappedRows);
      case "trino":
        return trinoQuery(config, safeSql, cappedRows);
      case "athena":
        return athenaQuery(config, safeSql, cappedRows);
      case "oracle":
        return oracleQuery(config, safeSql, cappedRows);
      case "clickhouse":
        return clickhouseQuery(config, safeSql, cappedRows);
      default:
        // Every provider must be reachable. A new one added to the union but
        // to neither PROVIDER_FAMILY nor this switch would otherwise fall
        // through and return undefined, surfacing as an unreadable crash
        // rather than "this provider is not wired up".
        throw new Error(
          `No driver for provider "${(config as { provider: string }).provider}". ` +
            `Add it to PROVIDER_FAMILY or give it a driver here.`,
        );
    }
  };

  // Slot first, then the clock: time spent queueing behind other queries is
  // not the warehouse being slow, so it must not count against the query's
  // own time budget.
  const raw = await withWarehouseSlot(opts.userId, () =>
    withWarehouseTimeout(opts.timeoutMs ?? warehouseTimeoutMs(), () => run()),
  );

  return {
    columns: raw.columns,
    rows: toObjects(raw.columns, raw.data),
    row_count: raw.data.length,
    truncated: raw.truncated,
    duration_ms: Date.now() - started,
  };
}

export async function listWarehouseTables(config: WarehouseConfig): Promise<WarehouseTable[]> {
  let sql = "";

  // Every wire-compatible family member exposes the ANSI information_schema,
  // so schema browsing follows the family exactly as querying does. MySQL-family
  // engines need their internal schemas filtered out or the picker is buried
  // under hundreds of system tables.
  const family = PROVIDER_FAMILY[config.provider];
  if (family === "postgres" || family === "tds") {
    return runColumnsQuery(config, COLUMNS_QUERY("information_schema.columns"));
  }
  if (family === "mysql") {
    return runColumnsQuery(
      config,
      COLUMNS_QUERY(
        "information_schema.columns",
        "AND table_schema NOT IN ('mysql', 'performance_schema', 'sys')",
      ),
    );
  }

  switch (config.provider) {
    case "snowflake":
      sql = COLUMNS_QUERY(`"${config.database}".information_schema.columns`);
      break;
    case "databricks":
      sql = COLUMNS_QUERY("information_schema.columns");
      break;
    case "bigquery": {
      const scope = config.dataset
        ? `\`${config.project_id}.${config.dataset}\`.INFORMATION_SCHEMA.COLUMNS`
        : `\`${config.project_id}\`.\`region-${(config.location || "us").toLowerCase()}\`.INFORMATION_SCHEMA.COLUMNS`;
      sql = COLUMNS_QUERY(scope);
      break;
    }
    case "redshift":
      sql = COLUMNS_QUERY("information_schema.columns");
      break;
    case "clickhouse":
      // ClickHouse ships information_schema, but system.columns is the native
      // view and is present on every version including the older ones people
      // actually run. Its own databases are excluded for the same reason
      // MySQL's are.
      sql =
        "SELECT database AS table_schema, table AS table_name, name AS column_name, " +
        "type AS data_type FROM system.columns " +
        "WHERE database NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema') " +
        "ORDER BY database, table, position LIMIT 5000";
      break;
    case "trino":
      // Qualify with the catalog when set (X-Trino-Catalog also scopes it).
      sql = COLUMNS_QUERY(
        config.catalog
          ? `"${config.catalog.replace(/"/g, '""')}".information_schema.columns`
          : "information_schema.columns",
      );
      break;
    case "athena":
      // Scoped to the configured database via QueryExecutionContext.
      sql = COLUMNS_QUERY("information_schema.columns");
      break;
    case "oracle":
      // Oracle has no information_schema; list the REST-enabled schema's own
      // tables from the data dictionary (Oracle 12c+ uses FETCH FIRST, not LIMIT).
      sql =
        "SELECT USER AS table_schema, table_name, column_name, data_type " +
        "FROM user_tab_columns ORDER BY table_name, column_id FETCH FIRST 5000 ROWS ONLY";
      break;
  }
  if (!sql) {
    throw new Error(
      `Schema browsing is not wired up for provider "${(config as { provider: string }).provider}".`,
    );
  }
  return runColumnsQuery(config, sql);
}

/**
 * Run a catalog query and group its rows into tables.
 *
 * Shared by the family branch and the per-provider switch so both normalise
 * identically — dialects disagree about the CASE of information_schema column
 * names (Oracle and Snowflake upper-case them), and grouping on the raw key
 * silently produces zero tables rather than an error.
 */
async function runColumnsQuery(config: WarehouseConfig, sql: string): Promise<WarehouseTable[]> {
  const result = await executeWarehouseQuery(config, sql, warehouseAbsMaxRows());
  const rows = result.rows.map((r) => {
    const lower: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) lower[k.toLowerCase()] = v;
    return lower;
  });
  return rowsToTables(rows);
}

/** Cheap connectivity probe used by the "Test connection" button. */
export async function testWarehouseConnection(config: WarehouseConfig): Promise<void> {
  // Oracle has no bare `SELECT 1` — it must select FROM DUAL.
  const probe = config.provider === "oracle" ? "SELECT 1 FROM DUAL" : "SELECT 1";
  await executeWarehouseQuery(config, probe, 1);
}
