// Visual ETL graph → Python compiler.
//
// The graph is a DAG (Glue-style): any number of sources, transforms that can
// join and branch, any number of targets. Pure module — the canvas uses it for
// the live code preview, the server compiles on save so `source_code` is
// always the executable truth, and the tests exercise it directly.
//
// Every user-authored string that reaches the generated Python goes through
// pyStr()/pyIdent() — the same discipline the agent/swarm exporters learned
// the hard way. A pipeline graph can arrive from anywhere (a shared catalog
// source name, an imported definition), so a column name is an injection
// surface exactly as much as a swarm label was.
//
// The generated script's contract with the batch runner:
//   - top-level code does no work (imports only);
//   - `entrypoint(inputs)` performs the run and returns a JSON-able metrics
//     dict, which lands in etl_runs.metrics;
//   - credentials come only from environment variables the sandbox fetched
//     over HTTP at start — per-node names derived by envKey(); the code never
//     contains a credential.

// ── Graph model ─────────────────────────────────────────────────────────────

export type SourceFileFormat = "csv" | "tsv" | "json" | "jsonl" | "parquet" | "xlsx";
export type TargetFileFormat = "parquet" | "csv" | "jsonl";

export type EtlSourceConfig =
  | {
      type: "object_storage";
      /** Catalog storage source supplying credentials (resolved server-side). */
      catalog_source_id?: string;
      /** Key or glob within the bucket, e.g. raw/orders/*.csv */
      path: string;
      format: SourceFileFormat;
      /** Engine-managed incremental: only rows with cursor_column above the
       *  stored watermark survive; the engine persists the new maximum after
       *  each durable load. */
      incremental?: { cursor_column: string };
    }
  | {
      type: "database";
      /** Warehouse connection supplying credentials (resolved server-side). */
      connection_id?: string;
      /** Cached at selection time so the compiler can pick the right driver. */
      provider?: string;
      /** cdc: Postgres logical replication (wal2json slot, batch-consumed). */
      mode: "table" | "query" | "cdc";
      table?: string;
      query?: string;
      /** cdc only: full table read on first run (slot created first, so no gap). */
      initial_snapshot?: boolean;
      /** Engine-managed incremental — pushed down as a WHERE on the cursor. */
      incremental?: { cursor_column: string };
    }
  | { type: "http_api"; url: string; records_path?: string }
  | {
      /** Rows pushed to /api/etl/ingest under the trigger token; drained here. */
      type: "ingest";
    }
  | { type: "python"; code: string }
  | {
      /** A dataset already on the platform: uploaded, prep-flow output, or synced from a SaaS connector. */
      type: "platform_dataset";
      table_id: string;
      /** Display + lineage label; the id is what is fetched. */
      table_name?: string;
    }
  | {
      /** The built-in lakehouse, read through its own engine in the sandbox. */
      type: "lakehouse";
      schema: string;
      mode: "table" | "query";
      table?: string;
      query?: string;
    };

export type QualityCheck =
  | "not_null"
  | "unique"
  | "range"
  | "regex"
  | "allowed_values"
  | "row_count_min";

export type QualityRule = {
  check: QualityCheck;
  /** Every check but row_count_min targets a column. */
  column?: string;
  min?: number;
  max?: number;
  pattern?: string;
  values?: string[];
  /** fail aborts the run, warn logs and continues, drop removes offending rows. */
  severity: "fail" | "warn" | "drop";
};

export type EtlTransformConfig =
  | { type: "filter"; expr: string }
  | { type: "select"; columns: string[] }
  | { type: "rename"; mapping: Record<string, string> }
  | { type: "derive"; column: string; expr: string }
  | { type: "dedupe"; columns?: string[] }
  | { type: "limit"; n: number }
  | { type: "sort"; by: string[]; descending?: boolean }
  | { type: "aggregate"; group_by: string[]; aggs: { column: string; fn: AggFn; as: string }[] }
  | { type: "fill_nulls"; value: string; columns?: string[] }
  | { type: "drop_nulls"; columns?: string[] }
  | {
      type: "join";
      how: "inner" | "left" | "right" | "outer";
      left_on: string[];
      right_on: string[];
      left_node?: string;
    }
  | { type: "union" }
  | { type: "sql"; query: string }
  | { type: "python"; code: string }
  | { type: "quality_gate"; rules: QualityRule[] };

export type EtlTargetConfig =
  | {
      type: "object_storage";
      catalog_source_id?: string;
      dataset: string;
      table: string;
      format: TargetFileFormat;
      /** Open-table formats on top of the bucket; plain files when absent. */
      table_format?: "none" | "delta" | "iceberg";
      write_mode: "replace" | "append" | "merge";
      primary_key?: string[];
      /** evolve (default) loads whatever arrives; warn logs drift; strict aborts. */
      schema_policy?: "evolve" | "warn" | "strict";
    }
  | {
      type: "database";
      connection_id?: string;
      provider?: string;
      /** Target schema/dataset name. */
      dataset: string;
      table: string;
      write_mode: "replace" | "append" | "merge";
      primary_key?: string[];
      /** evolve (default) loads whatever arrives; warn logs drift; strict aborts. */
      schema_policy?: "evolve" | "warn" | "strict";
    }
  | {
      /** Load into the built-in lakehouse — ACID, snapshotted, catalogued. */
      type: "lakehouse";
      schema: string;
      table: string;
      write_mode: "replace" | "append" | "merge";
      primary_key?: string[];
    }
  | {
      /** Reverse ETL: push rows into an external API in JSON batches. */
      type: "http_api";
      url: string;
      method?: "POST" | "PUT" | "PATCH";
      /** Env var carrying a bearer token — bind one via a secret in Settings. */
      auth_env?: string;
      batch_size?: number;
      /** Wrap each batch as {<wrap_key>: rows}; bare array when empty. */
      wrap_key?: string;
    };

export type EtlNode = {
  /** Stable short id (n1, n2, …) — also the basis of its env-var names. */
  id: string;
  kind: "source" | "transform" | "target";
  label?: string;
  config: EtlSourceConfig | EtlTransformConfig | EtlTargetConfig;
  /** Canvas position; the compiler ignores it. */
  position?: { x: number; y: number };
};

export type EtlEdge = { id: string; from: string; to: string };

export type EtlGraph = { nodes: EtlNode[]; edges: EtlEdge[] };

export const AGG_FNS = [
  "sum",
  "mean",
  "min",
  "max",
  "count",
  "nunique",
  "median",
  "first",
  "last",
] as const;
export type AggFn = (typeof AGG_FNS)[number];

// ── Database provider families ──────────────────────────────────────────────
// Mirrors PROVIDER_FAMILY in warehouse/types.ts, restricted to what a sandbox
// can reach over a plain SQLAlchemy URL. Redshift (IAM Data API), Snowflake
// (token-only PAT), BigQuery, Databricks, Trino, Athena, Oracle and ClickHouse
// authenticate in ways a URL cannot carry — those refuse at save time with a
// message, rather than failing inside a container.

const DB_FAMILY: Record<string, "postgres" | "mysql" | "tds"> = {
  postgres: "postgres",
  cockroachdb: "postgres",
  timescaledb: "postgres",
  alloydb: "postgres",
  greenplum: "postgres",
  yugabytedb: "postgres",
  mysql: "mysql",
  mariadb: "mysql",
  singlestore: "mysql",
  starrocks: "mysql",
  doris: "mysql",
  planetscale: "mysql",
  sqlserver: "tds",
  azure_synapse: "tds",
};

export function dbFamily(provider: string | undefined): "postgres" | "mysql" | "tds" | null {
  return provider ? (DB_FAMILY[provider] ?? null) : null;
}

/**
 * Warehouses loaded through dlt's NATIVE destinations (bulk staging, not
 * row-by-row SQLAlchemy inserts). Targets only: reading still goes through
 * the SQL families above or object storage.
 */
const NATIVE_WAREHOUSE_TARGETS = ["snowflake", "bigquery", "databricks"] as const;

export function nativeWarehouseTarget(
  provider: string | undefined,
): (typeof NATIVE_WAREHOUSE_TARGETS)[number] | null {
  return (NATIVE_WAREHOUSE_TARGETS as readonly string[]).includes(provider ?? "")
    ? (provider as (typeof NATIVE_WAREHOUSE_TARGETS)[number])
    : null;
}

/** Driver packages a family needs inside the sandbox. */
const FAMILY_DRIVER: Record<"postgres" | "mysql" | "tds", string> = {
  postgres: "psycopg2-binary",
  mysql: "pymysql",
  tds: "pymssql",
};

// ── String hygiene ──────────────────────────────────────────────────────────

/** Python string literal — single-quoted, everything meaningful escaped. */
export function pyStr(s: string): string {
  return (
    "'" +
    String(s)
      .replace(/\\/g, "\\\\")
      .replace(/'/g, "\\'")
      .replace(/\r/g, "\\r")
      .replace(/\n/g, "\\n")
      // NUL would truncate the literal in CPython; strip without a
      // control-char regex (no-control-regex).
      .split("\u0000")
      .join("") +
    "'"
  );
}

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Identifier position (dataset/table names, merge keys). Refusing beats
 * sanitising: a silently rewritten table name would load data somewhere the
 * user did not name.
 */
export function pyIdent(s: string, what: string): string {
  if (!IDENT_RE.test(s)) {
    throw new Error(
      `${what} must be a valid identifier (letters, digits, _): got ${JSON.stringify(s)}`,
    );
  }
  return s;
}

/** Env-var stem for a node: n3 → ETL_N3. Node ids are compiler-issued. */
export function envKey(nodeId: string): string {
  const clean = nodeId.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  if (!clean) throw new Error(`Node id ${JSON.stringify(nodeId)} cannot name env variables`);
  return `ETL_${clean}`;
}

function indent(code: string, pad: string): string {
  return code
    .split("\n")
    .map((l) => (l.trim() ? pad + l : l))
    .join("\n");
}

// ── Validation + ordering ───────────────────────────────────────────────────

type Analysis = {
  order: EtlNode[];
  incoming: Map<string, string[]>; // nodeId -> upstream ids, edge order preserved
};

export function analyzeGraph(graph: EtlGraph): Analysis {
  const nodes = graph.nodes ?? [];
  const edges = graph.edges ?? [];
  if (!nodes.length) throw new Error("The pipeline is empty — add a source and a target");

  const byId = new Map(nodes.map((n) => [n.id, n]));
  if (byId.size !== nodes.length) throw new Error("Duplicate node ids in the graph");
  for (const e of edges) {
    if (!byId.has(e.from) || !byId.has(e.to)) throw new Error("An edge references a missing node");
  }

  const incoming = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  const outgoing = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  for (const e of edges) {
    incoming.get(e.to)!.push(e.from);
    outgoing.get(e.from)!.push(e.to);
  }

  const name = (n: EtlNode) => n.label || n.id;
  const sources = nodes.filter((n) => n.kind === "source");
  const targets = nodes.filter((n) => n.kind === "target");
  if (!sources.length) throw new Error("Add at least one source node");
  if (!targets.length) throw new Error("Add at least one target node");

  for (const n of nodes) {
    const ins = incoming.get(n.id)!.length;
    const outs = outgoing.get(n.id)!.length;
    if (n.kind === "source" && ins > 0) throw new Error(`Source "${name(n)}" cannot have inputs`);
    if (n.kind === "source" && outs === 0) throw new Error(`Source "${name(n)}" is not connected`);
    if (n.kind === "target" && ins !== 1)
      throw new Error(`Target "${name(n)}" needs exactly one input`);
    if (n.kind === "target" && outs > 0) throw new Error(`Target "${name(n)}" cannot have outputs`);
    if (n.kind === "transform") {
      const t = n.config as EtlTransformConfig;
      if (t.type === "join" && ins !== 2)
        throw new Error(`Join "${name(n)}" needs exactly two inputs (has ${ins})`);
      if (t.type === "union" && ins < 2)
        throw new Error(`Union "${name(n)}" needs at least two inputs`);
      if (t.type !== "join" && t.type !== "union" && ins !== 1)
        throw new Error(`Transform "${name(n)}" needs exactly one input (has ${ins})`);
      if (outs === 0) throw new Error(`Transform "${name(n)}" is not connected to anything`);
    }
  }

  // Kahn's algorithm; leftovers mean a cycle.
  const degree = new Map(nodes.map((n) => [n.id, incoming.get(n.id)!.length]));
  const queue = nodes.filter((n) => degree.get(n.id) === 0).map((n) => n.id);
  const order: EtlNode[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(byId.get(id)!);
    for (const next of outgoing.get(id)!) {
      degree.set(next, degree.get(next)! - 1);
      if (degree.get(next) === 0) queue.push(next);
    }
  }
  if (order.length !== nodes.length) throw new Error("The graph contains a cycle");

  return { order, incoming };
}

// ── Per-node code ───────────────────────────────────────────────────────────

const READERS: Record<SourceFileFormat, string> = {
  csv: "pd.read_csv(f)",
  tsv: "pd.read_csv(f, sep='\\t')",
  json: "pd.read_json(f)",
  jsonl: "pd.read_json(f, lines=True)",
  parquet: "pd.read_parquet(f)",
  xlsx: "pd.read_excel(f)",
};

function sourceFn(node: EtlNode): string {
  const c = node.config as EtlSourceConfig;
  const key = envKey(node.id);
  const head = `def _src_${node.id}():`;
  if (c.type === "lakehouse") {
    const schema = pyIdent(c.schema, "Lakehouse schema");
    const sql =
      c.mode === "table"
        ? `SELECT * FROM "${schema}"."${pyIdent(c.table ?? "", "Lakehouse table")}"`
        : (c.query ?? "");
    if (!sql.trim()) throw new Error(`Lakehouse source "${node.label || node.id}" has no query`);
    return [
      head,
      `    # Built-in lakehouse: columnar read straight into a frame.`,
      `    con = _lakehouse_con()`,
      `    try:`,
      `        return con.execute(${pyStr(sql)}).df()`,
      `    finally:`,
      `        con.close()`,
    ].join("\n");
  }
  if (c.type === "ingest") {
    return [
      head,
      `    # Streamed rows: drain the pipeline's ingest staging over the`,
      `    # session's own channel. Rows the previous run durably loaded (id`,
      `    # <= the engine cursor) are deleted server-side first; everything`,
      `    # newer comes back — the CDC consume/peek shape, same guarantees.`,
      `    global _ingest_last_${node.id}`,
      `    import requests`,
      `    resp = requests.post(`,
      `        os.environ['AGENTSWARMS_ORIGIN'].rstrip('/') + '/api/notebook/runtime/source',`,
      `        json={`,
      `            'part': 'etl_ingest',`,
      `            'cursor': os.environ.get('${envKey(node.id)}_CURSOR'),`,
      `            'consume': os.environ.get('AGENTSWARMS_ETL_PREVIEW') != '1',`,
      `        },`,
      `        headers={'Authorization': 'Bearer ' + os.environ.get('AGENTSWARMS_TOKEN', '')},`,
      `        timeout=300,`,
      `    )`,
      `    resp.raise_for_status()`,
      `    _payload = resp.json()`,
      `    _ingest_last_${node.id} = _payload.get('max_id')`,
      `    print('[etl] ingest: ' + str(len(_payload['rows'])) + ' streamed row(s)')`,
      `    return pd.DataFrame(_payload['rows'])`,
    ].join("\n");
  }
  if (c.type === "platform_dataset") {
    return [
      head,
      `    # Platform dataset: served by the app over the sandbox's own session`,
      `    # token, so ownership is enforced server-side and nothing is signed.`,
      `    import requests`,
      `    resp = requests.post(`,
      `        os.environ['AGENTSWARMS_ORIGIN'].rstrip('/') + '/api/notebook/runtime/source',`,
      `        json={'part': 'etl_dataset', 'table_id': ${pyStr(c.table_id)}},`,
      `        headers={'Authorization': 'Bearer ' + os.environ.get('AGENTSWARMS_TOKEN', '')},`,
      `        timeout=300,`,
      `    )`,
      `    resp.raise_for_status()`,
      `    _payload = resp.json()`,
      `    if _payload.get('truncated'):`,
      `        print('[etl] WARN dataset ${pyStr(c.table_name ?? c.table_id).slice(1, -1)} truncated to ' + str(len(_payload['rows'])) + ' row(s)')`,
      `    return pd.DataFrame(_payload['rows'])`,
    ].join("\n");
  }
  if (c.type === "object_storage") {
    return [
      head,
      `    import fsspec`,
      `    fs = fsspec.filesystem(`,
      `        's3',`,
      `        key=os.environ.get('${key}_ACCESS_KEY_ID', ''),`,
      `        secret=os.environ.get('${key}_SECRET_ACCESS_KEY', ''),`,
      `        endpoint_url=os.environ.get('${key}_ENDPOINT_URL') or None,`,
      `    )`,
      `    base = os.environ['${key}_BUCKET'].rstrip('/')`,
      `    path = ${pyStr(c.path)}.lstrip('/')`,
      `    keys = [p for p in fs.glob(f"{base}/{path}")] or [f"{base}/{path}"]`,
      `    frames = []`,
      `    for k in keys:`,
      `        with fs.open(k, 'rb') as f:`,
      `            frames.append(${READERS[c.format]})`,
      `    out = pd.concat(frames, ignore_index=True) if len(frames) > 1 else frames[0]`,
      ...(c.incremental?.cursor_column
        ? [
            `    # Engine-managed incremental: rows at or below the stored`,
            `    # watermark were loaded by an earlier run. Files are still`,
            `    # read in full (object stores cannot push a row filter down),`,
            `    # so keep incremental storage sources on partitioned paths.`,
            `    cursor = os.environ.get('${key}_CURSOR')`,
            `    if cursor:`,
            `        out = out[out[${pyStr(c.incremental.cursor_column)}].astype(str) > cursor]`,
          ]
        : []),
      `    return out`,
    ].join("\n");
  }
  if (c.type === "database" && c.mode === "cdc") {
    const table = (c.table ?? "").replace(/[^A-Za-z0-9_.]/g, "");
    const snapshot = c.initial_snapshot !== false;
    return [
      head,
      `    # Log-based CDC: a wal2json logical slot is peeked (never consumed`,
      `    # blind) each run; what the PREVIOUS run durably loaded — its LSN`,
      `    # rides the engine cursor — is consumed first. Crash between peek`,
      `    # and load re-reads the same changes: at-least-once, never lost.`,
      `    global _cdc_last_${node.id}`,
      `    import json as _json`,
      `    import sqlalchemy as sa`,
      `    engine = sa.create_engine(os.environ['${key}_URL'])`,
      `    slot = os.environ.get('${key}_SLOT', 'aswarm_${node.id.toLowerCase().replace(/[^a-z0-9_]/g, "")}')`,
      `    consumed = os.environ.get('${key}_CURSOR')`,
      `    rows = []`,
      `    with engine.connect().execution_options(isolation_level='AUTOCOMMIT') as con:`,
      `        exists = con.execute(sa.text("SELECT 1 FROM pg_replication_slots WHERE slot_name = :s"), {'s': slot}).scalar()`,
      `        if not exists:`,
      `            con.execute(sa.text("SELECT pg_create_logical_replication_slot(:s, 'wal2json')"), {'s': slot})`,
      `            print('[etl] cdc: created slot ' + slot)`,
      ...(snapshot
        ? [
            `            snap = pd.read_sql(sa.text(${pyStr(`SELECT * FROM ${table}`)}), con)`,
            `            snap['_cdc_action'] = 'I'`,
            `            snap['_cdc_deleted'] = False`,
            `            snap['_cdc_lsn'] = '0/0'`,
            `            print('[etl] cdc: initial snapshot ' + str(len(snap)) + ' row(s)')`,
            `            _cdc_last_${node.id} = None`,
            `            return snap`,
          ]
        : []),
      `        elif consumed:`,
      `            con.execute(sa.text("SELECT count(*) FROM pg_logical_slot_get_changes(:s, CAST(:lsn AS pg_lsn), NULL, 'format-version', '2', 'add-tables', :t)"), {'s': slot, 'lsn': consumed, 't': ${pyStr(table)}})`,
      `        res = con.execute(sa.text("SELECT lsn::text, data FROM pg_logical_slot_peek_changes(:s, NULL, NULL, 'format-version', '2', 'add-tables', :t)"), {'s': slot, 't': ${pyStr(table)}})`,
      `        last = None`,
      `        for lsn, data in res:`,
      `            ch = _json.loads(data)`,
      `            last = lsn`,
      `            if ch.get('action') not in ('I', 'U', 'D'):`,
      `                continue`,
      `            cols = ch.get('columns') or ch.get('identity') or []`,
      `            row = {c['name']: c['value'] for c in cols}`,
      `            row['_cdc_action'] = ch['action']`,
      `            row['_cdc_deleted'] = ch['action'] == 'D'`,
      `            row['_cdc_lsn'] = lsn`,
      `            rows.append(row)`,
      `    _cdc_last_${node.id} = last`,
      `    print('[etl] cdc: ' + str(len(rows)) + ' change(s) from slot ' + slot)`,
      `    return pd.DataFrame(rows, columns=(list(rows[0].keys()) if rows else ['_cdc_action', '_cdc_deleted', '_cdc_lsn']))`,
    ].join("\n");
  }
  if (c.type === "database") {
    const sql = c.mode === "table" ? `SELECT * FROM ${c.table ?? ""}` : (c.query ?? "");
    if (c.incremental?.cursor_column) {
      // Pushed-down incremental: the base query becomes a subquery filtered on
      // the cursor. The cursor VALUE rides a bind parameter; the column name
      // is the user's own identifier against their own database.
      const col = c.incremental.cursor_column;
      return [
        head,
        `    import sqlalchemy as sa`,
        `    engine = sa.create_engine(os.environ['${key}_URL'])`,
        `    base_sql = ${pyStr(sql)}`,
        `    cursor = os.environ.get('${key}_CURSOR')`,
        `    with engine.connect() as conn:`,
        `        if cursor:`,
        `            wrapped = f"SELECT * FROM ({base_sql}) _inc WHERE ${col.replace(/[^A-Za-z0-9_."]/g, "")} > :cursor"`,
        `            return pd.read_sql(sa.text(wrapped), conn, params={'cursor': cursor})`,
        `        return pd.read_sql(sa.text(base_sql), conn)`,
      ].join("\n");
    }
    return [
      head,
      `    import sqlalchemy as sa`,
      `    engine = sa.create_engine(os.environ['${key}_URL'])`,
      `    with engine.connect() as conn:`,
      `        return pd.read_sql(sa.text(${pyStr(sql)}), conn)`,
    ].join("\n");
  }
  if (c.type === "http_api") {
    const dig = (c.records_path ?? "")
      .split(".")
      .filter(Boolean)
      .map((part) => `    data = data[${pyStr(part)}]`)
      .join("\n");
    return [
      head,
      `    import requests`,
      `    resp = requests.get(${pyStr(c.url)}, timeout=60)`,
      `    resp.raise_for_status()`,
      `    data = resp.json()`,
      dig,
      `    return pd.DataFrame(data)`,
    ]
      .filter(Boolean)
      .join("\n");
  }
  return [head, indent(c.code, "    ") || "    return []"].join("\n");
}

const QUALITY_CHECKS: QualityCheck[] = [
  "not_null",
  "unique",
  "range",
  "regex",
  "allowed_values",
  "row_count_min",
];

/** Human-readable rule name, embedded in logs, metrics and error messages. */
function ruleDesc(r: QualityRule): string {
  if (r.check === "row_count_min") return `row_count_min(${r.min ?? 0})`;
  return `${r.check}(${r.column ?? "?"})`;
}

/** The boolean violation mask for a column rule. Nulls violate range/regex. */
function ruleMask(r: QualityRule): string {
  const col = `df[${pyStr(r.column ?? "")}]`;
  switch (r.check) {
    case "not_null":
      return `${col}.isna()`;
    case "unique":
      return `df.duplicated(subset=[${pyStr(r.column ?? "")}], keep=False)`;
    case "range": {
      const lo = r.min != null && Number.isFinite(r.min) ? Number(r.min) : null;
      const hi = r.max != null && Number.isFinite(r.max) ? Number(r.max) : null;
      if (lo != null && hi != null) return `~${col}.between(${lo}, ${hi})`;
      if (lo != null) return `~(${col} >= ${lo})`;
      if (hi != null) return `~(${col} <= ${hi})`;
      throw new Error("Range rule needs a min, a max, or both");
    }
    case "regex":
      return `~${col}.astype("string").str.fullmatch(${pyStr(r.pattern ?? "")}, na=False)`;
    case "allowed_values":
      return `~${col}.isin([${(r.values ?? []).map((v) => pyStr(v)).join(", ")}])`;
    default:
      throw new Error(`Unknown quality check "${r.check}"`);
  }
}

/**
 * A quality gate compiles into a function: rules run in order over the frame,
 * every rule's outcome is appended to the run-level _quality metric, and the
 * severity decides what a violation does — abort, log, or drop the rows.
 */
function gateFn(node: EtlNode): string {
  const c = node.config as Extract<EtlTransformConfig, { type: "quality_gate" }>;
  const label = (node.label ?? node.id).replace(/[\r\n]/g, " ");
  const rules = c.rules ?? [];
  if (!rules.length) throw new Error(`Quality gate "${label}" has no rules`);
  const lines = [`def _gate_${node.id}(df):`];
  rules.forEach((r, i) => {
    if (!QUALITY_CHECKS.includes(r.check))
      throw new Error(`Unknown quality check "${r.check}" in gate "${label}"`);
    if (r.check !== "row_count_min" && !r.column)
      throw new Error(`Rule ${ruleDesc(r)} in gate "${label}" needs a column`);
    const desc = ruleDesc(r);
    const sev = r.severity === "drop" || r.severity === "warn" ? r.severity : "fail";
    if (r.check === "row_count_min") {
      const min = Math.max(0, Math.floor(r.min ?? 0));
      lines.push(
        `    _n${i} = ${min} - int(len(df)) if len(df) < ${min} else 0`,
        `    _quality.append({'gate': ${pyStr(label)}, 'rule': ${pyStr(desc)}, 'violations': _n${i}, 'severity': ${pyStr(sev)}, 'rows': int(len(df))})`,
        `    if _n${i}:`,
        // A short frame has no rows to drop; anything but warn aborts.
        ...(sev === "warn"
          ? [
              `        print(f"[quality] WARN {${pyStr(desc)}}: {int(len(df))} row(s), need ${min}")`,
            ]
          : [
              `        raise RuntimeError(f"Quality gate {${pyStr(label)}}: {${pyStr(desc)}} failed — {int(len(df))} row(s), need ${min}")`,
            ]),
      );
      return;
    }
    lines.push(
      `    _m${i} = ${ruleMask(r)}`,
      `    _n${i} = int(_m${i}.sum())`,
      `    _quality.append({'gate': ${pyStr(label)}, 'rule': ${pyStr(desc)}, 'violations': _n${i}, 'severity': ${pyStr(sev)}, 'rows': int(len(df))})`,
      `    if _n${i}:`,
    );
    if (sev === "fail") {
      lines.push(
        `        raise RuntimeError(f"Quality gate {${pyStr(label)}}: {${pyStr(desc)}} failed for {_n${i}} row(s)")`,
      );
    } else if (sev === "drop") {
      lines.push(
        `        print(f"[quality] DROP {${pyStr(desc)}}: removing {_n${i}} row(s)")`,
        `        df = df[~_m${i}].reset_index(drop=True)`,
      );
    } else {
      lines.push(`        print(f"[quality] WARN {${pyStr(desc)}}: {_n${i}} row(s) violate")`);
    }
  });
  lines.push(`    return df`);
  return lines.join("\n");
}

/**
 * The sandbox-side lakehouse attach. Credentials arrive as env (resolved
 * server-side, never in code text) exactly like every other connector; the
 * engine here is the SAME DuckLake catalog the app uses, so a pipeline's
 * writes are ordinary ACID commits other readers see immediately.
 */
function lakehouseAttachFn(): string {
  return [
    `def _lakehouse_con():`,
    `    import duckdb`,
    `    # Extension directory. The sandbox's HOME is READ-ONLY (so DuckDB's`,
    `    # default ~/.duckdb fails) and /tmp is mounted NOEXEC (so a .so there`,
    `    # downloads fine but cannot be mapped). ~/.local is the one path that`,
    `    # is both writable and executable — it is where pip --user puts`,
    `    # compiled wheels, which the interpreter already loads.`,
    `    _ext = os.path.join(os.path.expanduser('~'), '.local', 'duckdb')`,
    `    os.makedirs(_ext, exist_ok=True)`,
    `    con = duckdb.connect(config={'home_directory': _ext, 'extension_directory': _ext})`,
    `    con.execute("INSTALL ducklake; INSTALL postgres; INSTALL httpfs;")`,
    `    con.execute("LOAD ducklake; LOAD postgres; LOAD httpfs;")`,
    `    _ep = os.environ.get('ETL_LAKEHOUSE_S3_ENDPOINT')`,
    `    _sec = ["TYPE s3", "KEY_ID '" + os.environ['ETL_LAKEHOUSE_S3_KEY_ID'] + "'",`,
    `            "SECRET '" + os.environ['ETL_LAKEHOUSE_S3_SECRET'] + "'",`,
    `            "URL_STYLE '" + os.environ.get('ETL_LAKEHOUSE_S3_URL_STYLE', 'path') + "'",`,
    `            "USE_SSL " + os.environ.get('ETL_LAKEHOUSE_S3_USE_SSL', 'false')]`,
    `    if _ep:`,
    `        _sec.append("ENDPOINT '" + _ep + "'")`,
    `    con.execute("CREATE OR REPLACE SECRET lh (" + ", ".join(_sec) + ")")`,
    `    con.execute(`,
    `        "ATTACH 'ducklake:postgres:" + os.environ['ETL_LAKEHOUSE_CATALOG'] +`,
    `        "' AS lake (DATA_PATH '" + os.environ['ETL_LAKEHOUSE_DATA_URL'] + "')"`,
    `    )`,
    `    # Make 'lake' the current catalog so schema.table resolves the way it`,
    `    # does everywhere else in the product.`,
    `    con.execute("USE lake")`,
    `    return con`,
    ``,
  ].join("\n");
}

/** The expression list for pandas named aggregation. */
function aggArgs(aggs: { column: string; fn: AggFn; as: string }[]): string {
  return aggs
    .map((a) => {
      if (!AGG_FNS.includes(a.fn)) throw new Error(`Unknown aggregate function "${a.fn}"`);
      return `${pyIdent(a.as, "Aggregate output name")}=(${pyStr(a.column)}, ${pyStr(a.fn)})`;
    })
    .join(", ");
}

function transformExpr(node: EtlNode, ins: string[]): string {
  const c = node.config as EtlTransformConfig;
  const f = (id: string) => `f_${id}`;
  const one = f(ins[0]);
  switch (c.type) {
    case "filter":
      return `${one}.query(${pyStr(c.expr)})`;
    case "select":
      return `${one}[[${c.columns.map((x) => pyStr(x)).join(", ")}]]`;
    case "rename": {
      const pairs = Object.entries(c.mapping)
        .map(([a, b]) => `${pyStr(a)}: ${pyStr(b)}`)
        .join(", ");
      return `${one}.rename(columns={${pairs}})`;
    }
    case "derive":
      return `${one}.assign(**{${pyStr(c.column)}: ${one}.eval(${pyStr(c.expr)})})`;
    case "dedupe":
      return c.columns?.length
        ? `${one}.drop_duplicates(subset=[${c.columns.map((x) => pyStr(x)).join(", ")}]).reset_index(drop=True)`
        : `${one}.drop_duplicates().reset_index(drop=True)`;
    case "limit":
      return `${one}.head(${Math.max(0, Math.floor(c.n))})`;
    case "sort":
      return `${one}.sort_values([${c.by.map((x) => pyStr(x)).join(", ")}], ascending=${c.descending ? "False" : "True"}).reset_index(drop=True)`;
    case "aggregate":
      return `${one}.groupby([${c.group_by.map((x) => pyStr(x)).join(", ")}], dropna=False).agg(${aggArgs(c.aggs)}).reset_index()`;
    case "fill_nulls": {
      const raw = c.value ?? "";
      const num = Number(raw);
      const lit = raw !== "" && Number.isFinite(num) ? String(num) : pyStr(raw);
      return c.columns?.length
        ? `${one}.fillna({${c.columns.map((x) => `${pyStr(x)}: ${lit}`).join(", ")}})`
        : `${one}.fillna(${lit})`;
    }
    case "drop_nulls":
      return c.columns?.length
        ? `${one}.dropna(subset=[${c.columns.map((x) => pyStr(x)).join(", ")}]).reset_index(drop=True)`
        : `${one}.dropna().reset_index(drop=True)`;
    case "join": {
      // Left side: explicit choice, else the first incoming edge.
      const left = c.left_node && ins.includes(c.left_node) ? c.left_node : ins[0];
      const right = ins.find((x) => x !== left) ?? ins[1];
      return `${f(left)}.merge(${f(right)}, how=${pyStr(c.how)}, left_on=[${c.left_on.map((x) => pyStr(x)).join(", ")}], right_on=[${c.right_on.map((x) => pyStr(x)).join(", ")}])`;
    }
    case "union":
      return `pd.concat([${ins.map((x) => f(x)).join(", ")}], ignore_index=True)`;
    case "sql":
      return `_sql_over(${one}, ${pyStr(c.query)})`;
    case "python":
      return `_fn_${node.id}(${one})`;
    case "quality_gate":
      return `_gate_${node.id}(${one})`;
  }
}

function targetBlock(node: EtlNode, input: string, cdcInput = false): string {
  const c = node.config as EtlTargetConfig;
  if (c.type === "lakehouse") {
    const schema = pyIdent(c.schema, "Lakehouse schema");
    const table = pyIdent(c.table, "Lakehouse table");
    const fq = `"${schema}"."${table}"`;
    if (c.write_mode === "merge" && !c.primary_key?.length) {
      throw new Error(`Merge into "${node.label || node.id}" needs primary key columns`);
    }
    const load =
      c.write_mode === "replace"
        ? [`        con.execute('CREATE OR REPLACE TABLE ${fq} AS SELECT * FROM _src')`]
        : c.write_mode === "append"
          ? [
              `        con.execute('CREATE TABLE IF NOT EXISTS ${fq} AS SELECT * FROM _src WHERE false')`,
              `        con.execute('INSERT INTO ${fq} SELECT * FROM _src')`,
            ]
          : [
              // Upsert: delete the incoming keys, then insert — one transaction,
              // so a reader never sees the gap between the two.
              `        con.execute('CREATE TABLE IF NOT EXISTS ${fq} AS SELECT * FROM _src WHERE false')`,
              `        con.execute('BEGIN TRANSACTION')`,
              `        con.execute(${pyStr(
                `DELETE FROM ${fq} WHERE (${(c.primary_key ?? [])
                  .map((k) => `"${pyIdent(k, "Primary key column")}"`)
                  .join(", ")}) IN (SELECT ${(c.primary_key ?? [])
                  .map((k) => `"${pyIdent(k, "Primary key column")}"`)
                  .join(", ")} FROM _src)`,
              )})`,
              `        con.execute('INSERT INTO ${fq} SELECT * FROM _src')`,
              `        con.execute('COMMIT')`,
            ];
    return [
      `    # target ${node.id}: lakehouse → ${schema}.${table} (${c.write_mode})`,
      `    _src = ${input}`,
      `    con = _lakehouse_con()`,
      `    try:`,
      `        con.register('_src', _src)`,
      ...load,
      `    finally:`,
      `        con.close()`,
      `    _loads.append({'target': '${schema}.${table}', 'fqn': '${schema}.${table}', 'rows': int(len(${input})), 'load_id': None})`,
    ].join("\n");
  }
  if (c.type === "http_api") {
    const method = c.method === "PUT" || c.method === "PATCH" ? c.method : "POST";
    const batch = Math.min(5000, Math.max(1, Math.floor(c.batch_size ?? 500)));
    const wrap = (c.wrap_key ?? "").trim();
    if (!c.url?.trim()) throw new Error(`HTTP target "${node.label || node.id}" needs a URL`);
    return [
      `    # target ${node.id}: reverse ETL → ${method} ${c.url}`,
      `    import requests`,
      `    _hdrs = {'Content-Type': 'application/json'}`,
      ...(c.auth_env
        ? [
            `    if os.environ.get(${pyStr(c.auth_env)}):`,
            `        _hdrs['Authorization'] = 'Bearer ' + os.environ[${pyStr(c.auth_env)}]`,
          ]
        : []),
      `    _records = json.loads(${input}.to_json(orient='records', date_format='iso'))`,
      `    _sent = 0`,
      `    for _i in range(0, len(_records), ${batch}):`,
      `        _chunk = _records[_i:_i + ${batch}]`,
      wrap ? `        _body = {${pyStr(wrap)}: _chunk}` : `        _body = _chunk`,
      `        _resp = requests.request(${pyStr(method)}, ${pyStr(c.url)}, json=_body, headers=_hdrs, timeout=120)`,
      `        _resp.raise_for_status()`,
      `        _sent += len(_chunk)`,
      `        print('[etl] http target: ' + str(_sent) + '/' + str(len(_records)) + ' row(s) sent')`,
      `    _loads.append({'target': ${pyStr(c.url)}, 'fqn': ${pyStr(`http:${c.url}`)}, 'rows': int(len(${input})), 'load_id': None})`,
    ].join("\n");
  }
  const key = envKey(node.id);
  const dataset = pyIdent(c.dataset, "Target dataset");
  const table = pyIdent(c.table, "Target table");
  if (c.write_mode === "merge" && !c.primary_key?.length) {
    throw new Error(`Merge on target "${node.label || node.id}" needs primary key columns`);
  }
  const tableFormat =
    c.type === "object_storage" && (c.table_format === "delta" || c.table_format === "iceberg")
      ? c.table_format
      : null;
  const resourceArgs = [
    `        name='${table}',`,
    // Open-table formats: dlt's filesystem destination writes a Delta table
    // (delta-rs) or an Iceberg table (pyiceberg) instead of loose files.
    ...(tableFormat ? [`        table_format='${tableFormat}',`] : []),
    // A merge target fed by CDC applies the log correctly: latest event per
    // key wins (dedup on LSN, descending) and delete events delete the row.
    ...(cdcInput && c.write_mode === "merge"
      ? [
          `        columns={'_cdc_lsn': {'dedup_sort': 'desc'}, '_cdc_deleted': {'hard_delete': True}},`,
        ]
      : []),
    c.write_mode === "merge"
      ? // Delta only implements the upsert merge strategy — and upsert is also
        // what makes the hard_delete hint actually delete rows.
        `        write_disposition={'disposition': 'merge'${tableFormat === "delta" ? ", 'strategy': 'upsert'" : ""}},\n        primary_key=[${(c.primary_key ?? []).map((k) => pyStr(k)).join(", ")}],`
      : `        write_disposition=${pyStr(c.write_mode)},`,
  ].join("\n");

  const policy =
    c.schema_policy === "warn" || c.schema_policy === "strict" ? c.schema_policy : "evolve";
  const driftLines = [
    // The frame's schema, captured for every target: metrics.schemas answers
    // "what shape did this run load" even when no policy is set.
    `    _schemas['${node.id}'] = {str(c): str(t) for c, t in zip(${input}.columns, ${input}.dtypes)}`,
    ...(policy !== "evolve"
      ? [
          `    _prev_raw = os.environ.get('${envKey(node.id)}_SCHEMA')`,
          `    if _prev_raw:`,
          `        _prev = json.loads(_prev_raw)`,
          `        _cur = _schemas['${node.id}']`,
          `        _added = sorted(c for c in _cur if c not in _prev)`,
          `        _removed = sorted(c for c in _prev if c not in _cur)`,
          `        _retyped = sorted(f"{c}: {_prev[c]} -> {_cur[c]}" for c in _cur if c in _prev and _prev[c] != _cur[c])`,
          `        if _added or _removed or _retyped:`,
          `            _parts = []`,
          `            if _added: _parts.append('added ' + ', '.join(_added))`,
          `            if _removed: _parts.append('removed ' + ', '.join(_removed))`,
          `            if _retyped: _parts.append('retyped ' + ', '.join(_retyped))`,
          `            _msg = 'schema drift on ${dataset}.${table}: ' + '; '.join(_parts)`,
          ...(policy === "strict"
            ? [`            raise RuntimeError('[schema] ' + _msg)`]
            : [`            print('[schema] WARN ' + _msg)`]),
        ]
      : []),
  ].join("\n");

  const native = c.type === "database" ? nativeWarehouseTarget(c.provider) : null;
  const dest =
    c.type === "object_storage"
      ? [
          `    dest = filesystem(`,
          `        bucket_url=os.environ['${key}_BUCKET_URL'],`,
          `        credentials={`,
          `            'aws_access_key_id': os.environ.get('${key}_ACCESS_KEY_ID', ''),`,
          `            'aws_secret_access_key': os.environ.get('${key}_SECRET_ACCESS_KEY', ''),`,
          `            'endpoint_url': os.environ.get('${key}_ENDPOINT_URL') or None,`,
          `        },`,
          `    )`,
        ].join("\n")
      : native
        ? [
            // The engine hands over one JSON env var per native target:
            // {'credentials': ..., 'kwargs': {...}} shaped for the destination.
            `    _dc = json.loads(os.environ['${key}_DEST_CREDS'])`,
            `    dest = dlt.destinations.${native}(credentials=_dc['credentials'], **_dc.get('kwargs', {}))`,
          ].join("\n")
        : `    dest = sqlalchemy_dest(os.environ['${key}_URL'])`;

  const run =
    c.type === "object_storage"
      ? tableFormat
        ? `    info = pipe.run(resource, loader_file_format='parquet')`
        : `    info = pipe.run(resource, loader_file_format=${pyStr(c.format)})`
      : `    info = pipe.run(resource)`;

  const cdcDeltaApply =
    cdcInput && c.write_mode === "merge" && tableFormat === "delta"
      ? [
          // dlt's delta upsert has no hard-delete path (checked: its merge
          // builder only ever update/inserts), so delete events land as rows
          // flagged _cdc_deleted — this transactional delete applies them.
          `    from dlt.common.libs.deltalake import get_delta_tables`,
          `    get_delta_tables(pipe, '${table}')['${table}'].delete("_cdc_deleted = true")`,
          `    print('[etl] cdc: applied hard deletes to ${dataset}.${table}')`,
        ].join("\n")
      : null;

  return [
    driftLines,
    `    # target ${node.id}: ${c.type === "object_storage" ? "object storage" : "database"} → ${dataset}.${table}`,
    dest,
    `    pipe = dlt.pipeline(pipeline_name='${dataset}_${table}', destination=dest, dataset_name='${dataset}')`,
    `    resource = dlt.resource(`,
    `        ${input}.to_dict('records'),`,
    resourceArgs,
    `    )`,
    run,
    ...(cdcDeltaApply ? [cdcDeltaApply] : []),
    `    _loads.append({'target': '${dataset}.${table}', 'fqn': ${
      c.type === "object_storage"
        ? tableFormat === "iceberg"
          ? `'${dataset}/${table}/data/*.parquet'`
          : tableFormat === "delta"
            ? `'${dataset}/${table}/*.parquet'`
            : `'${dataset}/${table}/*.${c.format === "jsonl" ? "ndjson" : c.format}'`
        : `'${dataset}.${table}'`
    }, 'rows': int(len(${input})), 'load_id': str(info.loads_ids[0]) if info.loads_ids else None})`,
  ].join("\n");
}

// ── Compile ─────────────────────────────────────────────────────────────────

export function compileGraph(graph: EtlGraph): string {
  const { order, incoming } = analyzeGraph(graph);

  const needsSql = order.some(
    (n) => n.kind === "transform" && (n.config as EtlTransformConfig).type === "sql",
  );
  const pyFns = order.filter(
    (n) => n.kind === "transform" && (n.config as EtlTransformConfig).type === "python",
  );
  const hasDbTarget = order.some(
    (n) => n.kind === "target" && (n.config as EtlTargetConfig).type === "database",
  );
  const hasStorageTarget = order.some(
    (n) => n.kind === "target" && (n.config as EtlTargetConfig).type === "object_storage",
  );

  // Refuse unsupported database providers at compile time, not in a container.
  for (const n of order) {
    const c = n.config as { type?: string; provider?: string; mode?: string; table?: string };
    if (c.type !== "database") continue;
    if (n.kind === "source" && c.mode === "cdc") {
      if (dbFamily(c.provider) !== "postgres")
        throw new Error(
          `CDC source "${n.label || n.id}" needs a PostgreSQL-family connection — logical replication is what feeds it.`,
        );
      if (!c.table?.trim())
        throw new Error(`CDC source "${n.label || n.id}" needs a table (schema.table)`);
    }
    if (!c.provider) continue;
    const okAsTarget = n.kind === "target" && nativeWarehouseTarget(c.provider) !== null;
    if (!dbFamily(c.provider) && !okAsTarget) {
      throw new Error(
        n.kind === "target"
          ? `Connection provider "${c.provider}" is not supported as a pipeline target in this release. ` +
              `Supported: PostgreSQL, MySQL and SQL Server families, plus Snowflake, BigQuery and Databricks.`
          : `Connection provider "${c.provider}" is not supported as a pipeline source in this release. ` +
              `Supported: PostgreSQL, MySQL and SQL Server families. Stage through object storage instead.`,
      );
    }
  }

  const lines: string[] = [
    `# Generated by the AgentSwarms pipeline builder. Edits here are overwritten`,
    `# on the next visual save — switch the pipeline to code mode to make this`,
    `# file the source of truth.`,
    `import json`,
    `import os`,
    ``,
    `import pandas as pd`,
    ``,
  ];

  if (needsSql) {
    lines.push(
      ``,
      `def _sql_over(df, query):`,
      `    # SQL step: the incoming frame is table 't'.`,
      `    import ibis`,
      `    con = ibis.duckdb.connect()`,
      `    con.create_table('t', df, overwrite=True)`,
      `    return con.sql(query).to_pandas()`,
      ``,
    );
  }
  for (const n of pyFns) {
    const c = n.config as Extract<EtlTransformConfig, { type: "python" }>;
    lines.push(``, `def _fn_${n.id}(df):`, indent(c.code, "    "), `    return df`, ``);
  }
  if (order.some((n) => (n.config as { type?: string }).type === "lakehouse")) {
    lines.push(``, lakehouseAttachFn());
  }
  const gates = order.filter(
    (n) => n.kind === "transform" && (n.config as { type?: string }).type === "quality_gate",
  );
  if (gates.length) {
    // Rule outcomes accumulate here and surface as the run's `quality` metric.
    lines.push(``, `_quality = []`);
    for (const n of gates) lines.push(``, gateFn(n), ``);
  }
  for (const n of order.filter((x) => x.kind === "source")) {
    lines.push(``, sourceFn(n), ``);
  }
  for (const n of order.filter(
    (x) => x.kind === "source" && (x.config as { mode?: string }).mode === "cdc",
  )) {
    lines.push(`_cdc_last_${n.id} = None`);
  }
  for (const n of order.filter(
    (x) => x.kind === "source" && (x.config as { type?: string }).type === "ingest",
  )) {
    lines.push(`_ingest_last_${n.id} = None`);
  }

  const incremental = order.filter(
    (n) =>
      n.kind === "source" &&
      ((n.config as { incremental?: { cursor_column?: string } }).incremental?.cursor_column ||
        (n.config as { mode?: string }).mode === "cdc" ||
        (n.config as { type?: string }).type === "ingest"),
  );
  const cdcNodes = order.filter(
    (n) => n.kind === "source" && (n.config as { mode?: string }).mode === "cdc",
  );

  // Upstream descriptors for catalog lineage: close enough to the crawler's
  // asset fqns that storage-to-storage flows connect end to end, and honest
  // labels (url, table, "python") where no asset exists to point at.
  const lineageSources = order
    .filter((n) => n.kind === "source")
    .map((n) => {
      const c = n.config as {
        type: string;
        path?: string;
        table?: string;
        table_id?: string;
        table_name?: string;
        schema?: string;
        mode?: string;
        url?: string;
      };
      if (c.type === "object_storage") return c.path ?? "";
      if (c.type === "database")
        return c.mode === "table"
          ? (c.table ?? "")
          : c.mode === "cdc"
            ? `cdc:${c.table ?? ""}`
            : "sql-query";
      if (c.type === "http_api") return c.url ?? "";
      if (c.type === "platform_dataset") return `platform:${c.table_name ?? c.table_id ?? ""}`;
      if (c.type === "ingest") return "webhook-ingest";
      if (c.type === "lakehouse")
        return `lakehouse:${c.schema ?? ""}${c.table ? `.${c.table}` : ""}`;
      return "python";
    })
    .filter(Boolean);

  lines.push(``, `def entrypoint(inputs=None):`);
  if (incremental.length) lines.push(`    _watermarks = {}`);
  for (const n of order) {
    const ins = incoming.get(n.id)!;
    if (n.kind === "source") {
      lines.push(`    f_${n.id} = _src_${n.id}()`);
      lines.push(
        `    if not isinstance(f_${n.id}, pd.DataFrame):`,
        `        f_${n.id} = pd.DataFrame(f_${n.id})`,
      );
      if ((n.config as { type?: string }).type === "ingest") {
        lines.push(
          `    if _ingest_last_${n.id} is not None:`,
          `        _watermarks['${n.id}'] = str(_ingest_last_${n.id})`,
        );
      }
      if ((n.config as { mode?: string }).mode === "cdc") {
        // The source fn stashes the last peeked LSN; reporting it as the
        // watermark is what lets the NEXT run consume up to it.
        lines.push(
          `    if _cdc_last_${n.id}:`,
          `        _watermarks['${n.id}'] = _cdc_last_${n.id}`,
        );
      }
      const inc = (n.config as { incremental?: { cursor_column?: string } }).incremental;
      if (inc?.cursor_column) {
        // Report the new high-water mark; on an empty read, report nothing so
        // the engine keeps the previous cursor.
        lines.push(
          `    if len(f_${n.id}):`,
          `        _watermarks['${n.id}'] = str(f_${n.id}[${pyStr(inc.cursor_column)}].max())`,
        );
      }
    } else if (n.kind === "transform") {
      lines.push(`    f_${n.id} = ${transformExpr(n, ins)}`);
    }
  }

  // dlt is imported only when a target actually loads through it — a
  // lakehouse- or HTTP-only pipeline neither installs nor imports it.
  if (hasStorageTarget || hasDbTarget) lines.push(``, `    import dlt`);
  if (hasStorageTarget) lines.push(`    from dlt.destinations import filesystem`);
  if (hasDbTarget) lines.push(`    from dlt.destinations import sqlalchemy as sqlalchemy_dest`);
  lines.push(`    _loads = []`);
  lines.push(`    _schemas = {}`);
  for (const n of order.filter((x) => x.kind === "target")) {
    const inputId = incoming.get(n.id)![0];
    const inputNode = order.find((x) => x.id === inputId);
    const cdcInput = (inputNode?.config as { mode?: string } | undefined)?.mode === "cdc";
    lines.push(``, targetBlock(n, `f_${inputId}`, cdcInput));
  }

  lines.push(
    ``,
    `    metrics = {`,
    `        'rows_loaded': sum(l['rows'] for l in _loads),`,
    `        'targets': _loads,`,
    `        'schemas': _schemas,`,
    `        'lineage_sources': ${JSON.stringify(lineageSources)},`.replace(/"/g, "'"),
    ...(order.some(
      (n) => n.kind === "transform" && (n.config as { type?: string }).type === "quality_gate",
    )
      ? [`        'quality': _quality,`]
      : []),
    ...(incremental.length ? [`        'watermarks': _watermarks,`] : []),
    `    }`,
    `    print('[etl] ' + json.dumps(metrics))`,
    `    return metrics`,
  );
  return lines.join("\n") + "\n";
}

// ── Node preview ────────────────────────────────────────────────────────────

/** Source-row cap for previews: enough to make transforms meaningful. */
const PREVIEW_SAMPLE_ROWS = 500;
/** Rows actually returned to the panel. */
const PREVIEW_RESULT_ROWS = 50;

/**
 * Compile a PREVIEW script: run the pipeline's ancestors of one node on
 * sampled data and return that node's frame (a target previews its input)
 * as {columns, rows} — no dlt, no writes, no watermark movement. The full
 * graph is validated first so a preview never "works" on a graph that can't
 * save.
 */
export function compilePreview(graph: EtlGraph, nodeId: string): string {
  const { order, incoming } = analyzeGraph(graph);
  const selected = order.find((n) => n.id === nodeId);
  if (!selected) throw new Error("Node not found in this graph");

  // The frame to show: a target shows what would be loaded into it.
  const frameNode = selected.kind === "target" ? (incoming.get(selected.id) ?? [])[0] : selected.id;
  if (!frameNode) throw new Error("This target has no input to preview yet");

  // Ancestors of the frame node, selected included.
  const keep = new Set<string>([frameNode]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const id of [...keep]) {
      for (const up of incoming.get(id) ?? []) {
        if (!keep.has(up)) {
          keep.add(up);
          grew = true;
        }
      }
    }
  }
  const slice = order.filter((n) => keep.has(n.id));

  const needsSql = slice.some(
    (n) => n.kind === "transform" && (n.config as EtlTransformConfig).type === "sql",
  );
  const pyFns = slice.filter(
    (n) => n.kind === "transform" && (n.config as EtlTransformConfig).type === "python",
  );
  const gates = slice.filter(
    (n) => n.kind === "transform" && (n.config as { type?: string }).type === "quality_gate",
  );

  const lines: string[] = [
    `# Preview build: sampled sources, no loads. Generated per request.`,
    `import json`,
    `import os`,
    ``,
    `import pandas as pd`,
    ``,
  ];
  if (needsSql) {
    lines.push(
      ``,
      `def _sql_over(df, query):`,
      `    import ibis`,
      `    con = ibis.duckdb.connect()`,
      `    con.create_table('t', df, overwrite=True)`,
      `    return con.sql(query).to_pandas()`,
      ``,
    );
  }
  for (const n of pyFns) {
    const c = n.config as Extract<EtlTransformConfig, { type: "python" }>;
    lines.push(``, `def _fn_${n.id}(df):`, indent(c.code, "    "), `    return df`, ``);
  }
  if (gates.length) {
    lines.push(``, `_quality = []`);
    for (const n of gates) lines.push(``, gateFn(n), ``);
  }
  for (const n of slice.filter((x) => x.kind === "source")) {
    lines.push(``, sourceFn(n), ``);
  }

  lines.push(``, `def entrypoint(inputs):`);
  for (const n of slice) {
    const ins = incoming.get(n.id)!.filter((x) => keep.has(x));
    if (n.kind === "source") {
      lines.push(`    f_${n.id} = _src_${n.id}().head(${PREVIEW_SAMPLE_ROWS})`);
    } else if (n.kind === "transform") {
      lines.push(`    f_${n.id} = ${transformExpr(n, ins)}`);
    }
  }
  lines.push(
    `    _pv = f_${frameNode}.head(${PREVIEW_RESULT_ROWS})`,
    `    preview = {`,
    `        'columns': [{'name': str(c), 'type': str(t)} for c, t in zip(_pv.columns, _pv.dtypes)],`,
    `        'rows': json.loads(_pv.to_json(orient='records', date_format='iso')),`,
    `        'total_sampled': int(len(f_${frameNode})),`,
    `    }`,
    `    print('[etl] preview: ' + str(len(_pv)) + ' row(s), ' + str(len(_pv.columns)) + ' column(s)')`,
    `    return {'preview': preview}`,
  );
  return lines.join("\n") + "\n";
}

/** What a preview run needs installed — the load-side packages stay out. */
export function previewRequirementsFor(graph: EtlGraph): string {
  return requirementsFor(graph)
    .split("\n")
    .filter((l) => !l.startsWith("dlt"))
    .join("\n");
}

// ── Requirements ────────────────────────────────────────────────────────────

export function requirementsFor(graph: EtlGraph): string {
  const reqs = new Set<string>(["pandas", "pyarrow"]);
  let anyDlt = false;
  for (const n of graph.nodes ?? []) {
    const c = n.config as { type?: string; format?: string; provider?: string };
    if (n.kind === "source") {
      if (c.type === "object_storage") {
        reqs.add("s3fs");
        if (c.format === "xlsx") reqs.add("openpyxl");
      }
      if (c.type === "http_api") reqs.add("requests");
      if (c.type === "platform_dataset") reqs.add("requests");
      if (c.type === "ingest") reqs.add("requests");
      if (c.type === "lakehouse") reqs.add("duckdb>=1.4");
      if (c.type === "database") {
        reqs.add("sqlalchemy");
        const fam = dbFamily(c.provider);
        if (fam) reqs.add(FAMILY_DRIVER[fam]);
      }
    }
    if (n.kind === "transform" && c.type === "sql") reqs.add("ibis-framework[duckdb]");
    if (n.kind === "target" && c.type === "http_api") {
      reqs.add("requests");
      continue;
    }
    if (n.kind === "target" && c.type === "lakehouse") {
      reqs.add("duckdb>=1.4");
      continue;
    }
    if (n.kind === "target") {
      anyDlt = true;
      if (c.type === "object_storage") {
        reqs.add("dlt[filesystem]>=1.3");
        const tf = (c as { table_format?: string }).table_format;
        if (tf === "delta") reqs.add("dlt[deltalake]>=1.3");
        if (tf === "iceberg") reqs.add("dlt[pyiceberg]>=1.3");
      }
      if (c.type === "database") {
        const native = nativeWarehouseTarget(c.provider);
        if (native) {
          reqs.add(`dlt[${native}]>=1.3`);
        } else {
          reqs.add("dlt[sqlalchemy]>=1.3");
          const fam = dbFamily(c.provider);
          if (fam) reqs.add(FAMILY_DRIVER[fam]);
        }
      }
    }
  }
  // The dlt fallback exists for graphs whose targets the compiler cannot see
  // (code mode). A graph with targets that need NO dlt — lakehouse, HTTP —
  // must not pay for a large install it never imports.
  const hasNonDltTarget = (graph.nodes ?? []).some(
    (n) =>
      n.kind === "target" &&
      ["lakehouse", "http_api"].includes((n.config as { type?: string }).type ?? ""),
  );
  if (!anyDlt && !hasNonDltTarget) reqs.add("dlt[filesystem]>=1.3");
  return [...reqs].sort().join("\n");
}

// ── Starters ────────────────────────────────────────────────────────────────

/**
 * Accept any stored graph shape. Pipelines saved before the canvas existed
 * used a linear {source, steps, destination}; they convert to an equivalent
 * chain so an old pipeline opens on the canvas instead of crashing it.
 */
export function normalizeGraph(raw: unknown): EtlGraph | null {
  if (!raw || typeof raw !== "object") return null;
  const g = raw as Record<string, unknown>;
  if (Array.isArray(g.nodes) && Array.isArray(g.edges)) {
    // Graphs written by scripts or the API often carry bare {from, to} edges;
    // the editor's schema wants stable ids, so synthesize the missing ones.
    for (const e of g.edges as { id?: string; from?: string; to?: string }[]) {
      if (!e.id) e.id = `e_${e.from}_${e.to}`;
    }
    return raw as EtlGraph;
  }

  if (g.source && g.destination) {
    const legacySteps = Array.isArray(g.steps) ? (g.steps as Record<string, unknown>[]) : [];
    const src = g.source as Record<string, unknown>;
    const dst = g.destination as Record<string, unknown>;
    const nodes: EtlNode[] = [
      {
        id: "n1",
        kind: "source",
        label: "Source",
        // Old shape used kind:"object_store"; new uses type:"object_storage".
        config: {
          ...src,
          type:
            src.kind === "object_store" ? "object_storage" : ((src.kind as string) ?? "http_api"),
          kind: undefined,
        } as unknown as EtlSourceConfig,
        position: { x: 80, y: 160 },
      },
      ...legacySteps.map(
        (step, i): EtlNode => ({
          id: `n${i + 2}`,
          kind: "transform",
          label: (step.kind as string) ?? "step",
          config: { ...step, type: step.kind, kind: undefined } as unknown as EtlTransformConfig,
          position: { x: 80 + 220 * (i + 1), y: 160 },
        }),
      ),
      {
        id: `n${legacySteps.length + 2}`,
        kind: "target",
        label: "Target",
        config: {
          ...dst,
          type: "object_storage",
          kind: undefined,
        } as unknown as EtlTargetConfig,
        position: { x: 80 + 220 * (legacySteps.length + 1), y: 160 },
      },
    ];
    const edges: EtlEdge[] = nodes
      .slice(0, -1)
      .map((n, i) => ({ id: `e${i + 1}`, from: n.id, to: nodes[i + 1].id }));
    return { nodes, edges };
  }
  return null;
}

/** A minimal two-node starter graph for a new visual pipeline. */
export function starterGraph(): EtlGraph {
  return {
    nodes: [
      {
        id: "n1",
        kind: "source",
        label: "API source",
        config: { type: "http_api", url: "https://api.example.com/items", records_path: "" },
        position: { x: 80, y: 160 },
      },
      {
        id: "n2",
        kind: "target",
        label: "Storage target",
        config: {
          type: "object_storage",
          dataset: "etl",
          table: "items",
          format: "parquet",
          write_mode: "replace",
        },
        position: { x: 520, y: 160 },
      },
    ],
    edges: [{ id: "e1", from: "n1", to: "n2" }],
  };
}

/** Starter template for a code-mode pipeline. */
export function codeTemplate(): string {
  return [
    `# AgentSwarms ETL pipeline.`,
    `#`,
    `# Contract:`,
    `#   - define entrypoint(inputs) and return a JSON-able metrics dict;`,
    `#   - destination credentials arrive as environment variables:`,
    `#       ETL_DEST_BUCKET_URL, ETL_DEST_ENDPOINT_URL,`,
    `#       ETL_DEST_ACCESS_KEY_ID, ETL_DEST_SECRET_ACCESS_KEY`,
    `#   - packages listed under Settings -> Requirements are pip-installed`,
    `#     before this script runs.`,
    `import json`,
    `import os`,
    ``,
    `import pandas as pd`,
    ``,
    ``,
    `def entrypoint(inputs=None):`,
    `    df = pd.DataFrame([{'id': 1, 'name': 'example'}])`,
    ``,
    `    import dlt`,
    `    from dlt.destinations import filesystem`,
    ``,
    `    dest = filesystem(`,
    `        bucket_url=os.environ['ETL_DEST_BUCKET_URL'],`,
    `        credentials={`,
    `            'aws_access_key_id': os.environ.get('ETL_DEST_ACCESS_KEY_ID', ''),`,
    `            'aws_secret_access_key': os.environ.get('ETL_DEST_SECRET_ACCESS_KEY', ''),`,
    `            'endpoint_url': os.environ.get('ETL_DEST_ENDPOINT_URL') or None,`,
    `        },`,
    `    )`,
    `    pipe = dlt.pipeline(pipeline_name='my_pipeline', destination=dest, dataset_name='etl')`,
    `    info = pipe.run(df.to_dict('records'), table_name='example', loader_file_format='parquet')`,
    ``,
    `    metrics = {'rows_loaded': int(len(df)), 'load_id': str(info.loads_ids[0]) if info.loads_ids else None}`,
    `    print('[etl] ' + json.dumps(metrics))`,
    `    return metrics`,
  ].join("\n");
}
