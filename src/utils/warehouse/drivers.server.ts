// Warehouse query drivers — one per provider, all speaking the vendor's
// official API:
//   redshift      → Redshift Data API (SigV4-signed JSON, works for
//                   serverless workgroups and provisioned clusters)
//   snowflake     → SQL API v2 (/api/v2/statements) with a programmatic
//                   access token
//   databricks    → SQL Statement Execution API (/api/2.0/sql/statements)
//   bigquery      → BigQuery REST (jobs.query) with a service-account JWT
//   azure_synapse → TDS via the pure-JS `tedious` driver (dynamic import —
//                   Node/Docker deployments only; Synapse has no REST SQL API)
//
// All drivers enforce read-only SQL, cap returned rows, and normalise
// results to { columns, rows } with numeric coercion driven by column types.

import type {
  WarehouseColumn,
  WarehouseConfig,
  WarehouseQueryResult,
  WarehouseTable,
} from "./types";

export const MAX_WAREHOUSE_ROWS = 1000;
// Schema listings need more headroom than data queries (one row per column).
const ABS_MAX_ROWS = 5000;
const POLL_INTERVAL_MS = 750;
const POLL_TIMEOUT_MS = 60_000;

// ── Guards + helpers ─────────────────────────────────────────────────────────

/**
 * Read-only enforcement: one statement, starting with SELECT/WITH/SHOW/
 * DESCRIBE/EXPLAIN after comments are stripped. Warehouse-side permissions
 * remain the real boundary — connect read-only credentials.
 */
export function assertReadOnlySql(sql: string): string {
  const stripped = sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .trim()
    .replace(/;+\s*$/, "");
  if (!stripped) throw new Error("Empty SQL statement");
  if (stripped.includes(";")) {
    throw new Error("Only a single SQL statement is allowed per query");
  }
  const first = stripped.split(/\s+/)[0]?.toUpperCase();
  if (!["SELECT", "WITH", "SHOW", "DESCRIBE", "DESC", "EXPLAIN"].includes(first ?? "")) {
    throw new Error("Only read-only queries (SELECT/WITH/SHOW/DESCRIBE/EXPLAIN) are allowed");
  }
  return stripped;
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
  let res = await fetch(`${base}/api/v2/statements`, {
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
    res = await fetch(`${base}/api/v2/statements/${statementHandle}`, { headers });
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
  const submit = await fetch(`${base}/api/2.0/sql/statements`, {
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
    const poll = await fetch(`${base}/api/2.0/sql/statements/${body.statement_id}`, { headers });
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

function b64url(input: string | Uint8Array): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function googleAccessToken(serviceAccountJson: string): Promise<string> {
  let sa: { client_email?: string; private_key?: string; token_uri?: string };
  try {
    sa = JSON.parse(serviceAccountJson);
  } catch {
    throw new Error("BigQuery: service account key is not valid JSON");
  }
  if (!sa.client_email || !sa.private_key) {
    throw new Error("BigQuery: service account key is missing client_email/private_key");
  }
  const tokenUri = sa.token_uri || "https://oauth2.googleapis.com/token";
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: "https://www.googleapis.com/auth/bigquery",
      aud: tokenUri,
      iat: now,
      exp: now + 3600,
    }),
  );
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(`${header}.${claims}`),
  );
  const jwt = `${header}.${claims}.${b64url(new Uint8Array(sig))}`;
  const res = await fetch(tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${encodeURIComponent(jwt)}`,
  });
  if (!res.ok) throw new Error(await readError(res, "BigQuery auth"));
  const { access_token } = (await res.json()) as { access_token: string };
  return access_token;
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
  const res = await fetch(
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
    const poll = await fetch(
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

  const res = await fetch(`https://${host}/`, {
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

// ── Azure Synapse (TDS via tedious — Node runtimes only) ─────────────────────

type SynapseConfig = Extract<WarehouseConfig, { provider: "azure_synapse" }>;

async function synapseQuery(
  cfg: SynapseConfig,
  sql: string,
  maxRows: number,
): Promise<{ columns: WarehouseColumn[]; data: unknown[][]; truncated: boolean }> {
  let tedious: typeof import("tedious");
  try {
    tedious = await import(/* @vite-ignore */ "tedious");
  } catch {
    throw new Error(
      "Azure Synapse connections need a Node deployment (Docker/bare Node) — the TDS driver is not available in this runtime.",
    );
  }
  const { Connection, Request } = tedious;

  return new Promise((resolve, reject) => {
    const connection = new Connection({
      server: cfg.server,
      authentication: {
        type: "default",
        options: { userName: cfg.username, password: cfg.password },
      },
      options: {
        database: cfg.database,
        encrypt: true,
        rowCollectionOnRequestCompletion: false,
        trustServerCertificate: false,
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
        reject(new Error(`Azure Synapse: ${err.message}`));
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

// ── Public entry points ──────────────────────────────────────────────────────

export async function executeWarehouseQuery(
  config: WarehouseConfig,
  sql: string,
  maxRows = MAX_WAREHOUSE_ROWS,
): Promise<WarehouseQueryResult> {
  const safeSql = assertReadOnlySql(sql);
  const cappedRows = Math.min(Math.max(1, maxRows), ABS_MAX_ROWS);
  const started = Date.now();

  let raw: { columns: WarehouseColumn[]; data: unknown[][]; truncated: boolean };
  switch (config.provider) {
    case "snowflake":
      raw = await snowflakeQuery(config, safeSql, cappedRows);
      break;
    case "databricks":
      raw = await databricksQuery(config, safeSql, cappedRows);
      break;
    case "bigquery":
      raw = await bigqueryQuery(config, safeSql, cappedRows);
      break;
    case "redshift":
      raw = await redshiftQuery(config, safeSql, cappedRows);
      break;
    case "azure_synapse":
      raw = await synapseQuery(config, safeSql, cappedRows);
      break;
  }

  return {
    columns: raw.columns,
    rows: toObjects(raw.columns, raw.data),
    row_count: raw.data.length,
    truncated: raw.truncated,
    duration_ms: Date.now() - started,
  };
}

export async function listWarehouseTables(config: WarehouseConfig): Promise<WarehouseTable[]> {
  let sql: string;
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
    case "azure_synapse":
      sql = COLUMNS_QUERY("information_schema.columns");
      break;
  }
  const result = await executeWarehouseQuery(config, sql, ABS_MAX_ROWS);
  // Normalise column-name casing across dialects before grouping.
  const rows = result.rows.map((r) => {
    const lower: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) lower[k.toLowerCase()] = v;
    return lower;
  });
  return rowsToTables(rows);
}

/** Cheap connectivity probe used by the "Test connection" button. */
export async function testWarehouseConnection(config: WarehouseConfig): Promise<void> {
  await executeWarehouseQuery(config, "SELECT 1", 1);
}
