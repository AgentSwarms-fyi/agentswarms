// The built-in lakehouse: DuckDB attached to a DuckLake catalog.
//
// ARCHITECTURE. Table data is zstd Parquet in shared object storage; the
// transactional catalog (schemas, tables, file manifests, snapshots) is a
// Postgres the deployment provides (LAKEHOUSE_CATALOG_URL). Every app replica
// runs the same stateless attach, so the lakehouse scales exactly like the
// app: queries land on any replica, commits serialise through the catalog,
// and no replica owns files on disk. A single query's working set is still
// bounded by one replica — vectorised columnar execution is the speed story,
// not a cluster.
//
// GOVERNANCE. DuckDB has no per-user ACLs, so access control happens HERE,
// before any SQL reaches the engine:
//   * one statement per request, classified (select / dml / ddl) — anything
//     outside the classifier (ATTACH, COPY, SET, PRAGMA, INSTALL, …) is
//     refused by construction;
//   * SELECTs are parsed to an AST via json_serialize_sql and every base
//     table's schema is checked against the caller's owned + granted set;
//   * writes must be schema-qualified and hit an allowed schema;
//   * table functions (read_parquet et al) are refused — raw lake access
//     goes through governed lake views, not ad-hoc paths, because the S3
//     secret is engine-level and would otherwise let any user read any
//     bucket the deployment can.
// The audit trail and the query history are written for every statement.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { auditEvent } from "@/utils/audit.server";
import { applyTablePolicies, loadPolicies } from "@/utils/lakehouse/policies.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

import type { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";

export type LakehouseConfig = {
  catalog: string;
  dataUrl: string;
  s3: {
    endpoint?: string;
    keyId: string;
    secret: string;
    region?: string;
    useSsl: boolean;
    urlStyle: string;
  };
};

export function lakehouseConfig(): LakehouseConfig | null {
  const url = process.env.LAKEHOUSE_CATALOG_URL?.trim();
  const dataUrl = process.env.LAKEHOUSE_DATA_URL?.trim();
  if (!url || !dataUrl) return null;
  return {
    catalog: url,
    dataUrl,
    s3: {
      endpoint: process.env.LAKEHOUSE_S3_ENDPOINT?.trim() || undefined,
      keyId: process.env.LAKEHOUSE_S3_KEY_ID ?? "",
      secret: process.env.LAKEHOUSE_S3_SECRET ?? "",
      region: process.env.LAKEHOUSE_S3_REGION?.trim() || undefined,
      useSsl: (process.env.LAKEHOUSE_S3_USE_SSL ?? "true").toLowerCase() !== "false",
      urlStyle: process.env.LAKEHOUSE_S3_URL_STYLE?.trim() || "vhost",
    },
  };
}

export function lakehouseEnabled(): boolean {
  return lakehouseConfig() !== null;
}

/** postgres:// URL → the libpq keyword string DuckLake's ATTACH wants. */
export function catalogUrlToLibpq(raw: string): string {
  const u = new URL(raw);
  const kv: string[] = [];
  kv.push(`dbname=${u.pathname.replace(/^\//, "") || "postgres"}`);
  kv.push(`host=${u.hostname}`);
  if (u.port) kv.push(`port=${u.port}`);
  if (u.username) kv.push(`user=${decodeURIComponent(u.username)}`);
  if (u.password) kv.push(`password=${decodeURIComponent(u.password)}`);
  for (const [k, v] of u.searchParams) kv.push(`${k}=${v}`);
  return kv.join(" ");
}

// ── Engine lifecycle ────────────────────────────────────────────────────────

let enginePromise: Promise<DuckDBInstance> | null = null;

/** SQL-string escape for values interpolated into setup DDL (secrets, attach). */
function sq(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

async function createEngine(cfg: LakehouseConfig): Promise<DuckDBInstance> {
  const { DuckDBInstance } = await import("@duckdb/node-api");
  // Admin -> Developer runtime wins, then the env var, then the default. The
  // old form clamped threads to 2-8 regardless, which meant a 16-core host
  // could never be told to use more than half of itself.
  const { getPlatformResources } = await import("@/utils/notebookRuntime/config.server");
  const resources = await getPlatformResources();
  const instance = await DuckDBInstance.create(":memory:", {
    threads: String(Math.max(1, resources.lakehouseThreads)),
  });
  const c = await instance.connect();
  try {
    await c.run("INSTALL ducklake; INSTALL postgres; INSTALL httpfs;");
    await c.run("LOAD ducklake; LOAD postgres; LOAD httpfs;");
    const s3parts = [
      "TYPE s3",
      `KEY_ID ${sq(cfg.s3.keyId)}`,
      `SECRET ${sq(cfg.s3.secret)}`,
      ...(cfg.s3.endpoint ? [`ENDPOINT ${sq(cfg.s3.endpoint)}`] : []),
      ...(cfg.s3.region ? [`REGION ${sq(cfg.s3.region)}`] : []),
      `URL_STYLE ${sq(cfg.s3.urlStyle)}`,
      `USE_SSL ${cfg.s3.useSsl ? "true" : "false"}`,
    ];
    // MEMORY AND SPILL. Without these a query larger than RAM kills the
    // process — DuckDB's default is "fail rather than spill" when no temp
    // directory is set. A bounded memory limit plus a spill directory turns
    // that class of failure into a slower query, which is the only acceptable
    // behaviour for a shared engine.
    const spillDir = path.join(os.tmpdir(), "agentswarms-lakehouse-spill");
    await fs.mkdir(spillDir, { recursive: true }).catch(() => {});
    await c.run(`SET memory_limit=${sq(resources.lakehouseMemoryLimit)};`);
    await c.run(`SET temp_directory=${sq(spillDir.replace(/\\/g, "/"))};`);
    await c.run(
      `SET max_temp_directory_size=${sq(process.env.LAKEHOUSE_SPILL_LIMIT?.trim() || "20GB")};`,
    );
    // DuckLake retries a losing commit itself before giving up. Those knobs
    // ship at defaults (10 attempts / 100ms / 1.5x) and are invisible; expose
    // them so an operator facing heavy write contention can tune them without
    // patching us.
    const retryCount = Number(process.env.LAKEHOUSE_COMMIT_RETRIES ?? "") || 10;
    const retryWait = Number(process.env.LAKEHOUSE_COMMIT_RETRY_WAIT_MS ?? "") || 100;
    await c.run(`SET ducklake_max_retry_count=${Math.max(0, Math.min(50, retryCount))};`);
    await c.run(`SET ducklake_retry_wait_ms=${Math.max(10, Math.min(5_000, retryWait))};`);

    // PARQUET METADATA CACHE. Reading remote Parquet costs a footer round trip
    // per file per query; caching that on the shared engine measured ~20%
    // faster across DIFFERENT queries over the same files (231/233/239ms vs
    // 252/290/320ms), which is the case the result cache does not cover.
    //
    // It is safe because DuckLake never rewrites a data file: a write adds new
    // UUID-named paths and the catalog decides which are live, so content at a
    // cached path cannot change. Foreign files behind a lake mount CAN be
    // overwritten, and those were checked separately — DuckDB validated the
    // entry and returned the new content.
    //
    // Its siblings were measured and rejected: enable_http_metadata_cache was
    // slower and less consistent, prefetch_all_parquet_files bought nothing.
    if (process.env.LAKEHOUSE_METADATA_CACHE !== "false") {
      await c.run("SET parquet_metadata_cache=true;");
    }
    await c.run(`CREATE OR REPLACE SECRET lakehouse_s3 (${s3parts.join(", ")});`);
    await c.run(
      // The postgres: prefix is LOAD-BEARING: without it DuckLake treats the
      // libpq string as a FILE PATH and quietly creates a single-writer
      // duckdb-file catalog — the exact opposite of the multi-replica design.
      `ATTACH IF NOT EXISTS 'ducklake:postgres:${catalogUrlToLibpq(cfg.catalog).replace(/'/g, "''")}' AS lake (DATA_PATH ${sq(cfg.dataUrl)});`,
    );
    // zstd everywhere: the compression half of "warehouse-grade".
    await c.run("CALL lake.set_option('parquet_compression', 'zstd');").catch(() => {});
    // Data-lake mounts: each mounted storage source gets its own scoped
    // credential so a view can read ITS bucket and nothing else.
    await ensureLakeSecrets(c);
  } finally {
    c.closeSync();
  }
  return instance;
}

/**
 * Create one scoped S3 secret per mounted lake source. SCOPE confines each
 * credential to its own bucket/prefix, so a view over source A cannot read
 * source B's files even though both live in one engine.
 */
export async function ensureLakeSecrets(c: DuckDBConnection): Promise<void> {
  const { data: mounts } = await supabaseAdmin
    .from("lakehouse_schemas")
    .select("id, name, user_id, lake_source_id")
    .not("lake_source_id", "is", null);
  if (!mounts?.length) return;
  const { loadStorageConfig } = await import("@/utils/catalog/crawler.server");
  for (const mount of mounts) {
    try {
      const { data: src } = await supabaseAdmin
        .from("catalog_sources")
        .select("id, name, credentials")
        .eq("id", mount.lake_source_id as string)
        .maybeSingle();
      if (!src) continue;
      const cfg = await loadStorageConfig(mount.user_id, src);
      const scope = `s3://${cfg.bucket}${cfg.prefix ? `/${cfg.prefix.replace(/^\/+|\/+$/g, "")}` : ""}`;
      const parts = [
        "TYPE s3",
        `KEY_ID ${sq(cfg.access_key_id)}`,
        `SECRET ${sq(cfg.secret_access_key)}`,
        ...(cfg.endpoint ? [`ENDPOINT ${sq(cfg.endpoint.replace(/^https?:\/\//, ""))}`] : []),
        ...(cfg.region ? [`REGION ${sq(cfg.region)}`] : []),
        `URL_STYLE ${sq(cfg.path_style === false ? "vhost" : "path")}`,
        `USE_SSL ${cfg.endpoint?.startsWith("http://") ? "false" : "true"}`,
        `SCOPE ${sq(scope)}`,
      ];
      await c.run(
        `CREATE OR REPLACE SECRET lake_mount_${mount.id.replace(/-/g, "")} (${parts.join(", ")});`,
      );
    } catch (e) {
      console.warn(
        `[lakehouse] lake mount "${mount.name}" credential failed:`,
        (e as Error).message,
      );
    }
  }
}

/**
 * Strip credentials out of an engine error before it can reach a browser.
 *
 * FOUND FROM THE UI. The ATTACH embeds the catalog's whole libpq string, so
 * DuckDB's "connection refused" quotes it back verbatim — `password=...`
 * included — and that message was already being shown to any signed-in user as
 * a toast. The catalog password is deployment infrastructure; a workspace
 * member should not be able to read it off a page, transiently or otherwise.
 *
 * Belt and braces: the shapes a connection string takes, AND the configured
 * values themselves, in case a driver formats them some way not matched below.
 */
export function redactLakehouseSecrets(message: string): string {
  let out = message
    // libpq: password=secret / password='secret'
    .replace(/(password\s*=\s*)('[^']*'|"[^"]*"|\S+)/gi, "$1[redacted]")
    // URL: postgres://user:secret@host
    .replace(/(\b[a-z+]+:\/\/[^:@\s/]+:)[^@\s]+(@)/gi, "$1[redacted]$2");

  const cfg = lakehouseConfig();
  for (const secret of [cfg?.s3.secret, catalogPassword(cfg?.catalog)]) {
    // Short values would redact innocuous substrings and make the error
    // unreadable, which is its own kind of failure.
    if (secret && secret.length >= 6) out = out.split(secret).join("[redacted]");
  }
  return out;
}

/**
 * A data file the catalog still lists, that object storage no longer has.
 *
 * DuckDB reports this as a bare HTTP 404 quoting the full S3 URL — which names
 * the operator's endpoint and says nothing about what went wrong or what to do.
 * The condition is specific and worth naming: the DuckLake catalog and the
 * object store have diverged, which happens when a bucket is recreated or
 * emptied while the catalog database survives. The rows are gone; the catalog
 * is the only thing still claiming otherwise.
 *
 * Returns null for anything else, so ordinary errors pass through untouched.
 */
export function describeMissingDataFile(message: string): string | null {
  // Both signals required. A 404 alone could be any HTTP call; a .parquet
  // mention alone is most of the lakehouse's error surface.
  const missing = /NoSuchKey|specified key does not exist/i.test(message);
  const notFound = /\b404\b/.test(message);
  if (!(missing || notFound)) return null;
  const file = /([A-Za-z0-9._-]+\.parquet)/.exec(message);
  if (!file) return null;
  // The BASENAME only — the surrounding URL carries the endpoint host.
  return (
    `A data file this table refers to is missing from object storage (${file[1]}). ` +
    `The lakehouse catalog and the object store have diverged — usually because the ` +
    `bucket was recreated or emptied while the catalog database survived. Those rows ` +
    `cannot be read back from here: re-import the table, or drop it if it is no longer ` +
    `needed. Other tables are unaffected.`
  );
}

/** The password inside a libpq URL/keyword string, if it has one. */
function catalogPassword(catalog: string | undefined): string | null {
  if (!catalog) return null;
  const url = /\b[a-z+]+:\/\/[^:@\s/]+:([^@\s]+)@/i.exec(catalog);
  if (url) return decodeURIComponent(url[1]);
  const kw = /password\s*=\s*('([^']*)'|"([^"]*)"|(\S+))/i.exec(catalog);
  return kw ? (kw[2] ?? kw[3] ?? kw[4] ?? null) : null;
}

/** The shared engine: attached once per process, connections per request. */
export async function lakehouseEngine(): Promise<DuckDBInstance> {
  const cfg = lakehouseConfig();
  if (!cfg) throw new Error("The lakehouse is not configured (LAKEHOUSE_CATALOG_URL).");
  if (!enginePromise) {
    enginePromise = createEngine(cfg).catch((e: unknown) => {
      enginePromise = null; // a failed boot must not poison every later call
      // Re-thrown redacted: this is the error that carries the ATTACH string,
      // and it travels all the way to the browser.
      const err = e instanceof Error ? e : new Error(String(e));
      err.message = redactLakehouseSecrets(err.message);
      throw err;
    });
  }
  return enginePromise;
}

export async function lakehouseConnection(): Promise<DuckDBConnection> {
  const engine = await lakehouseEngine();
  const c = await engine.connect();
  await c.run("USE lake;");
  return c;
}

// ── Maintenance ─────────────────────────────────────────────────────────────

export type LakehouseMaintenanceResult = {
  ran: boolean;
  steps: { step: string; ok: boolean; ms: number; error?: string }[];
};

/** Snapshots older than this are expired; their files are then removable. */
const SNAPSHOT_RETENTION_DAYS = 7;

/**
 * Keep the lakehouse fast and small. Four steps, in the only order that is
 * safe: flush rows still inlined in the catalog into Parquet, merge the small
 * files that incremental loads produce (the single biggest lever on scan
 * speed), expire snapshots past the retention window, then delete the files
 * only those snapshots referenced. Each step is independent — one failing
 * never blocks the rest, because a half-maintained lakehouse still serves
 * queries correctly.
 */
export async function runLakehouseMaintenance(): Promise<LakehouseMaintenanceResult> {
  if (!lakehouseEnabled()) return { ran: false, steps: [] };
  const steps: LakehouseMaintenanceResult["steps"] = [];
  const c = await lakehouseConnection();
  try {
    const calls: [string, string][] = [
      ["flush_inlined", "CALL ducklake_flush_inlined_data('lake')"],
      ["merge_files", "CALL ducklake_merge_adjacent_files('lake')"],
      [
        "expire_snapshots",
        `CALL ducklake_expire_snapshots('lake', older_than => now() - INTERVAL ${SNAPSHOT_RETENTION_DAYS} DAY)`,
      ],
      ["cleanup_files", "CALL ducklake_cleanup_old_files('lake', cleanup_all => true)"],
    ];
    for (const [step, sql] of calls) {
      const started = Date.now();
      try {
        await c.run(sql);
        steps.push({ step, ok: true, ms: Date.now() - started });
      } catch (e) {
        steps.push({ step, ok: false, ms: Date.now() - started, error: (e as Error).message });
      }
    }
  } finally {
    c.closeSync();
  }
  const failed = steps.filter((st) => !st.ok);
  if (failed.length) {
    console.warn(
      "[lakehouse] maintenance steps failed:",
      failed.map((f) => `${f.step}: ${f.error}`).join("; "),
    );
  }
  return { ran: true, steps };
}

// ── Statement classification ────────────────────────────────────────────────

export type StatementKind = "select" | "dml" | "ddl";
export type Classified = {
  kind: StatementKind;
  /** Schemas the statement writes to (empty for selects). */
  writeSchemas: string[];
  /** Tables the statement writes to, unqualified (empty for selects). */
  writeTables: string[];
  verb: string;
};

const IDENT = String.raw`(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)`;
const QUALIFIED = new RegExp(`^(${IDENT})\\.(${IDENT})`);

export function stripSqlComments(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .trim();
}

function unquote(ident: string): string {
  return ident.startsWith('"') ? ident.slice(1, -1) : ident.toLowerCase();
}

/**
 * Classify ONE statement. Throws for anything outside the allowed surface —
 * refusal is the default, allowance is the exception.
 */
export function classifyStatement(rawSql: string): Classified {
  const sql = stripSqlComments(rawSql).replace(/;\s*$/, "");
  if (!sql) throw new Error("Empty statement");
  if (sql.includes(";")) {
    throw new Error("One statement per request — split multi-statement SQL");
  }
  const head = sql.slice(0, 40).toUpperCase();

  if (/^(SELECT|WITH|FROM|DESCRIBE|SUMMARIZE|SHOW)\b/.test(head)) {
    return { kind: "select", writeSchemas: [], writeTables: [], verb: head.split(/\s+/)[0] };
  }

  const writeShapes: { re: RegExp; verb: string; kind: StatementKind }[] = [
    { re: /^INSERT\s+INTO\s+/i, verb: "INSERT", kind: "dml" },
    { re: /^UPDATE\s+/i, verb: "UPDATE", kind: "dml" },
    { re: /^DELETE\s+FROM\s+/i, verb: "DELETE", kind: "dml" },
    { re: /^MERGE\s+INTO\s+/i, verb: "MERGE", kind: "dml" },
    { re: /^TRUNCATE\s+(TABLE\s+)?/i, verb: "TRUNCATE", kind: "dml" },
    {
      re: /^CREATE\s+(OR\s+REPLACE\s+)?TABLE\s+(IF\s+NOT\s+EXISTS\s+)?/i,
      verb: "CREATE TABLE",
      kind: "ddl",
    },
    { re: /^CREATE\s+(OR\s+REPLACE\s+)?VIEW\s+/i, verb: "CREATE VIEW", kind: "ddl" },
    { re: /^DROP\s+TABLE\s+(IF\s+EXISTS\s+)?/i, verb: "DROP TABLE", kind: "ddl" },
    { re: /^DROP\s+VIEW\s+(IF\s+EXISTS\s+)?/i, verb: "DROP VIEW", kind: "ddl" },
    { re: /^ALTER\s+TABLE\s+(IF\s+EXISTS\s+)?/i, verb: "ALTER TABLE", kind: "ddl" },
  ];
  for (const shape of writeShapes) {
    const m = shape.re.exec(sql);
    if (!m) continue;
    const rest = sql.slice(m[0].length).trim();
    const qm = QUALIFIED.exec(rest);
    if (!qm) {
      throw new Error(
        `${shape.verb} must target a schema-qualified table (schema.table) in the lakehouse`,
      );
    }
    return {
      kind: shape.kind,
      writeSchemas: [unquote(qm[1])],
      writeTables: [unquote(qm[2])],
      verb: shape.verb,
    };
  }

  const verb = head.split(/\s+/)[0] || "statement";
  throw new Error(
    `${verb} is not available here. The lakehouse accepts SELECT/WITH/DESCRIBE/SUMMARIZE/SHOW, ` +
      `INSERT/UPDATE/DELETE/MERGE/TRUNCATE, and CREATE/DROP/ALTER TABLE or VIEW. ` +
      `Schemas are managed from the sidebar; imports have their own action.`,
  );
}

// ── SELECT reference extraction (AST, not regex) ────────────────────────────

type AstRef = { catalog: string; schema: string; table: string };

function walkAst(nodeIn: unknown, refs: AstRef[], ctes: Set<string>, tableFns: string[]): void {
  if (Array.isArray(nodeIn)) {
    for (const item of nodeIn) walkAst(item, refs, ctes, tableFns);
    return;
  }
  if (!nodeIn || typeof nodeIn !== "object") return;
  const node = nodeIn as Record<string, unknown>;
  if (node.cte_map && typeof node.cte_map === "object") {
    const map = (node.cte_map as { map?: { key?: string }[] }).map ?? [];
    for (const entry of map) if (entry.key) ctes.add(String(entry.key).toLowerCase());
  }
  if (node.type === "BASE_TABLE") {
    refs.push({
      catalog: String(node.catalog_name ?? "").toLowerCase(),
      schema: String(node.schema_name ?? "").toLowerCase(),
      table: String(node.table_name ?? "").toLowerCase(),
    });
  }
  if (node.type === "TABLE_FUNCTION") {
    const fn = String(
      (node.function as { function_name?: string } | undefined)?.function_name ?? "table function",
    ).toLowerCase();
    // Pure generators read nothing — refusing them buys no safety and breaks
    // ordinary SQL. Everything that can touch files or foreign systems stays
    // refused (read_parquet, read_csv, read_json, postgres_scan, glob, …).
    const SAFE = new Set(["range", "generate_series", "unnest"]);
    if (!SAFE.has(fn)) tableFns.push(fn);
  }
  for (const value of Object.values(node)) walkAst(value, refs, ctes, tableFns);
}

/**
 * Every real table a SELECT reads, schema-qualified. Same walk as
 * selectReferencedSchemas — security policies need the table names too, not
 * only the schemas.
 */
export async function selectReferencedTables(
  c: DuckDBConnection,
  sql: string,
): Promise<{ schema: string; table: string }[]> {
  const cleaned = stripSqlComments(sql).replace(/;\s*$/, "");
  if (/^(DESCRIBE|SUMMARIZE|SHOW)\b/.test(cleaned.slice(0, 20).toUpperCase())) return [];
  const rows = await (await c.run(`SELECT json_serialize_sql(${sq(cleaned)})`)).getRows();
  const parsed = JSON.parse(String(rows[0][0])) as { error?: boolean };
  if (parsed.error) return [];
  const refs: AstRef[] = [];
  const ctes = new Set<string>();
  walkAst(parsed, refs, ctes, []);
  const out: { schema: string; table: string }[] = [];
  for (const ref of refs) {
    if (!ref.schema && ctes.has(ref.table)) continue;
    if (ref.schema) out.push({ schema: ref.schema, table: ref.table });
  }
  return out;
}

/**
 * Every schema a SELECT reads, resolved through DuckDB's own parser. CTE
 * names are excluded; unqualified real tables and table functions are
 * refused — governance needs to know exactly what a query touches.
 */
export async function selectReferencedSchemas(c: DuckDBConnection, sql: string): Promise<string[]> {
  const cleaned = stripSqlComments(sql).replace(/;\s*$/, "");
  const head = cleaned.slice(0, 20).toUpperCase();
  // DESCRIBE/SUMMARIZE/SHOW take one target; serialize only handles SELECTs.
  if (/^(DESCRIBE|SUMMARIZE|SHOW)\b/.test(head)) {
    const m = new RegExp(`(${IDENT})\\.(${IDENT})`).exec(cleaned);
    return m ? [unquote(m[1])] : [];
  }
  // json_serialize_sql needs a CONSTANT varchar — a bound parameter is
  // rejected — so the statement rides in as an escaped literal.
  const rows = await (await c.run(`SELECT json_serialize_sql(${sq(cleaned)})`)).getRows();
  const parsed = JSON.parse(String(rows[0][0])) as { error?: boolean; error_message?: string };
  if (parsed.error) throw new Error(`SQL parse error: ${parsed.error_message ?? "invalid SQL"}`);

  const refs: AstRef[] = [];
  const ctes = new Set<string>();
  const tableFns: string[] = [];
  walkAst(parsed, refs, ctes, tableFns);
  if (tableFns.length) {
    throw new Error(
      `${tableFns[0]}() is not available here — query lakehouse tables, or use a lake view for raw files`,
    );
  }
  const schemas = new Set<string>();
  for (const ref of refs) {
    if (!ref.schema && ctes.has(ref.table)) continue;
    if (ref.catalog && ref.catalog !== "lake") {
      throw new Error(`Catalog "${ref.catalog}" is not accessible from the lakehouse`);
    }
    if (!ref.schema) {
      throw new Error(`Qualify "${ref.table}" as schema.table — unqualified names are ambiguous`);
    }
    schemas.add(ref.schema);
  }
  return [...schemas];
}

// ── Access ──────────────────────────────────────────────────────────────────

export type SchemaRow = {
  id: string;
  name: string;
  user_id: string;
  description: string | null;
  /** Set = this schema is a READ-ONLY mount of a catalog storage source. */
  lake_source_id?: string | null;
};

/** Schemas this user owns or holds a grant on. */
export async function accessibleSchemas(userId: string): Promise<SchemaRow[]> {
  const { data: all } = await supabaseAdmin
    .from("lakehouse_schemas")
    .select("id, name, user_id, description, lake_source_id")
    .order("name");
  const out: SchemaRow[] = [];
  for (const row of all ?? []) {
    if (row.user_id === userId) {
      out.push(row);
      continue;
    }
    const { data: ok } = await supabaseAdmin.rpc("has_resource_access", {
      rtype: "lakehouse_schema",
      rid: row.id,
      uid: userId,
    });
    if (ok) out.push(row);
  }
  return out;
}

export function assertSchemasAllowed(schemas: string[], allowed: SchemaRow[]): void {
  const names = new Set(allowed.map((s) => s.name));
  for (const schema of schemas) {
    if (!names.has(schema)) {
      throw new Error(
        `No access to schema "${schema}" — it doesn't exist, or nobody shared it with you`,
      );
    }
  }
}

/** The reader's email, for `@me` in a policy filter. Cached per process. */
const EMAIL_CACHE = new Map<string, string | null>();

async function readerEmail(userId: string): Promise<string | null> {
  if (EMAIL_CACHE.has(userId)) return EMAIL_CACHE.get(userId) ?? null;
  const { data } = await supabaseAdmin.auth.admin.getUserById(userId);
  const email = data?.user?.email ?? null;
  EMAIL_CACHE.set(userId, email);
  return email;
}

// ── Result cache ────────────────────────────────────────────────────────────
//
// Keyed on (user, sql, catalog snapshot). The snapshot id is the whole trick:
// DuckLake bumps it on every commit, so a write invalidates cached results by
// making their key unreachable — no TTL guesswork, no stale answers.
//
// The cache is in-memory and per PROCESS, and the app forks one worker process
// per CPU, so a repeated query only hits when it lands on the same worker.
// That costs hit rate, never correctness: a miss re-runs the query. Restarting
// simply re-earns it.

type CacheEntry = { at: number; snapshot: string; result: LakehouseResult };

const RESULT_CACHE = new Map<string, CacheEntry>();
const CACHE_MAX_ENTRIES = 200;
const CACHE_TTL_MS = 10 * 60_000;
/** Results bigger than this are not worth the memory on a shared process. */
const CACHE_MAX_ROWS = 5_000;

export function lakehouseCacheSize(): number {
  return RESULT_CACHE.size;
}

/** Test seam: drop everything (a fresh process starts empty anyway). */
export function clearLakehouseCache(): void {
  RESULT_CACHE.clear();
}

/**
 * The lakehouse's current snapshot, for recording at the start of a decision.
 *
 * DuckLake can re-run a query AT a snapshot, so this one integer is what makes
 * an answer reproducible rather than merely recorded. Null when the lakehouse
 * is not configured or cannot be reached -- an honest "not reproducible", and
 * never an exception, because provenance must not fail the thing it describes.
 */
export async function lakehouseSnapshotId(): Promise<string | null> {
  if (!lakehouseConfig()) return null;
  let c: DuckDBConnection | null = null;
  try {
    c = await lakehouseConnection();
    const id = await currentSnapshotId(c);
    return id.startsWith("nosnap") ? null : id;
  } catch {
    return null;
  } finally {
    c?.closeSync();
  }
}

async function currentSnapshotId(c: DuckDBConnection): Promise<string> {
  try {
    const rows = await (
      await c.run("SELECT coalesce(max(snapshot_id), 0)::VARCHAR FROM lake.snapshots()")
    ).getRows();
    return String(rows[0][0]);
  } catch {
    // No snapshot function (older catalog): behave as if every query missed.
    return `nosnap-${Date.now()}`;
  }
}

function cacheKey(userId: string, sql: string, snapshot: string): string {
  return `${userId}\u0000${snapshot}\u0000${stripSqlComments(sql).replace(/\s+/g, " ").trim()}`;
}

function cacheGet(key: string): LakehouseResult | null {
  const hit = RESULT_CACHE.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    RESULT_CACHE.delete(key);
    return null;
  }
  return hit.result;
}

function cachePut(key: string, snapshot: string, result: LakehouseResult): void {
  if (result.rows.length > CACHE_MAX_ROWS) return;
  if (RESULT_CACHE.size >= CACHE_MAX_ENTRIES) {
    // Oldest-first eviction: insertion order is Map order.
    const oldest = RESULT_CACHE.keys().next().value;
    if (oldest) RESULT_CACHE.delete(oldest);
  }
  RESULT_CACHE.set(key, { at: Date.now(), snapshot, result });
}

// ── Write conflicts ─────────────────────────────────────────────────────────
//
// Two replicas writing the same rows is the one case DuckLake cannot merge.
// The loser's COMMIT fails and — verified live against two independent
// engines — applies NOTHING: a 500-row insert bundled into the losing
// transaction left zero rows behind. That atomicity is what makes a
// statement-level retry safe rather than a duplication risk: because this
// chokepoint runs exactly one autocommit statement per request, a failed
// commit means the statement did not happen, so running it again on a fresh
// snapshot applies it exactly once.
//
// DuckLake already retries internally, but only inside one attempt's
// transaction. A retry here re-reads the catalog first, which is what a stale
// read-modify-write actually needs.

/** Attempts BEYOND the first, for writes only. */
const WRITE_RETRIES = Math.max(
  0,
  Math.min(10, Number(process.env.LAKEHOUSE_WRITE_RETRIES ?? "") || 3),
);

export function isWriteConflict(message: string): boolean {
  return /failed to commit ducklake transaction|transaction conflict|conflict detected|write-write conflict/i.test(
    message,
  );
}

function retryDelayMs(attempt: number): number {
  // 120ms, 240ms, 480ms … plus jitter, so replicas that collided once do not
  // line up and collide again on the retry.
  const base = 120 * Math.pow(2, attempt - 1);
  return Math.round(base * (0.5 + Math.random()));
}

// ── Execution ───────────────────────────────────────────────────────────────

export type LakehouseCell = string | number | boolean | null;

export type LakehouseResult = {
  columns: { name: string; type: string }[];
  rows: LakehouseCell[][];
  row_count: number;
  truncated: boolean;
  duration_ms: number;
  kind: StatementKind;
  /** Served from the result cache rather than re-executed. */
  cached?: boolean;
  /** Times this write lost a commit race and was re-run. */
  retries?: number;
};

const ROW_CAP = 10_000;
const TIMEOUT_MS = 60_000;

function jsValue(v: unknown): LakehouseCell {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "string") return v;
  if (typeof v === "bigint") {
    return v >= Number.MIN_SAFE_INTEGER && v <= Number.MAX_SAFE_INTEGER ? Number(v) : v.toString();
  }
  if (v instanceof Date) return v.toISOString();
  // DECIMAL, INTERVAL, LIST, STRUCT, … — every DuckDB value type prints.
  return String(v);
}

/**
 * Run ONE governed statement for a user. Classification, access checks,
 * execution with a row cap and an interrupt-based timeout, audit and history
 * — the single chokepoint every caller (UI, BI, agents, NL2SQL) goes through.
 */
export async function runLakehouseStatement(
  userId: string,
  sql: string,
  opts?: { rowCap?: number; timeoutMs?: number; auditVia?: string; useCache?: boolean },
): Promise<LakehouseResult> {
  const started = Date.now();
  const rowCap = Math.min(opts?.rowCap ?? ROW_CAP, 100_000);
  const classified = classifyStatement(sql);
  const allowed = await accessibleSchemas(userId);
  /** Tables whose security policy was applied to this statement. */
  let policyTables: string[] = [];

  const record = (
    status: string,
    rowCount: number | null,
    error?: string,
    extra?: { cached?: boolean; retries?: number },
  ) => {
    void supabaseAdmin
      .from("lakehouse_query_history")
      .insert({
        user_id: userId,
        sql: sql.slice(0, 8000),
        kind: classified.kind,
        status,
        row_count: rowCount,
        duration_ms: Date.now() - started,
        error: error?.slice(0, 2000) ?? null,
        cached: extra?.cached ?? false,
        retries: extra?.retries ?? 0,
      })
      .then(() => {});
    auditEvent({
      userId,
      action: `lakehouse.${classified.kind}`,
      resourceType: "lakehouse",
      resourceName: classified.verb,
      detail: {
        status,
        rows: rowCount ?? undefined,
        duration_ms: Date.now() - started,
        via: opts?.auditVia,
        cached: extra?.cached ? true : undefined,
        retries: extra?.retries || undefined,
        policies_applied: policyTables.length ? policyTables : undefined,
        schemas: classified.writeSchemas.length ? classified.writeSchemas : undefined,
      },
    });
  };

  let c: DuckDBConnection | null = null;
  try {
    if (classified.kind !== "select") {
      assertSchemasAllowed(classified.writeSchemas, allowed);
      // A lake mount is a window onto someone else's files: the views are
      // server-authored and the bytes belong to the storage source, so the
      // lakehouse never writes through one.
      for (const schema of classified.writeSchemas) {
        const row = allowed.find((sch) => sch.name === schema);
        if (row?.lake_source_id) {
          throw new Error(
            `Schema "${schema}" is a read-only data-lake mount — query it, or write to a regular schema`,
          );
        }
        // A reader who only sees part of a table must not be able to write to
        // it: they could overwrite or delete rows the policy hides from them,
        // with no way to notice.
        if (row && row.user_id !== userId) {
          const { data: policed } = await supabaseAdmin
            .from("lakehouse_table_policies")
            .select("table_name")
            .eq("user_id", row.user_id)
            .eq("schema_name", schema);
          if ((policed ?? []).length) {
            const names = new Set((policed ?? []).map((x) => String(x.table_name).toLowerCase()));
            const target = classified.writeTables?.find((t) => names.has(t.toLowerCase()));
            if (target) {
              throw new Error(
                `"${schema}.${target}" has a security policy, so it is read-only for you — ask its owner to make the change`,
              );
            }
          }
        }
      }
    }
    // Writes get a bounded retry; reads never need one. Each attempt opens a
    // fresh connection so it reads the catalog as it is NOW — retrying on the
    // stale snapshot that just lost would simply lose again.
    for (let attempt = 0; ; attempt++) {
      c = await lakehouseConnection();
      let cacheSlot: { key: string; snapshot: string } | null = null;
      // Security policies rewrite the statement; everything downstream must
      // run the rewritten text, while history and the cache key keep the SQL
      // the user actually wrote.
      let effectiveSql = sql;
      if (classified.kind === "select") {
        const schemas = await selectReferencedSchemas(c, sql);
        assertSchemasAllowed(schemas, allowed);

        // Owners see their own tables whole — a filter they cannot see
        // through would be impossible to debug. Everyone else reads through
        // the owner's policy.
        const foreign = allowed.filter((sch) => sch.user_id !== userId);
        if (foreign.length) {
          const tables = (await selectReferencedTables(c, sql)).filter((t) =>
            foreign.some((sch) => sch.name.toLowerCase() === t.schema),
          );
          const policies = await loadPolicies([...new Set(foreign.map((f) => f.user_id))], tables);
          if (policies.size) {
            const rewrite = await applyTablePolicies(
              c,
              stripSqlComments(sql).replace(/;\s*$/, ""),
              policies,
              {
                id: userId,
                email: await readerEmail(userId),
              },
            );
            if (rewrite) {
              effectiveSql = rewrite.sql;
              policyTables = rewrite.applied;
            }
          }
        }
        // Cache lookup happens AFTER the access check, never before: a cached
        // row must not be reachable by someone whose grant was revoked.
        if (opts?.useCache !== false) {
          const snapshot = await currentSnapshotId(c);
          // The key is per user already, so a policy rewrite cannot leak
          // across readers; including it keeps a policy edit from being
          // served a pre-policy result.
          const key = cacheKey(userId, `${policyTables.join(",")}|${effectiveSql}`, snapshot);
          const hit = cacheGet(key);
          if (hit) {
            const result = { ...hit, cached: true, duration_ms: Date.now() - started };
            record("ok", result.row_count, undefined, { cached: true });
            return result;
          }
          cacheSlot = { key, snapshot };
        }
      }

      const conn = c;
      const timer = setTimeout(() => {
        try {
          conn.interrupt();
        } catch {
          /* already finished */
        }
      }, opts?.timeoutMs ?? TIMEOUT_MS);

      try {
        const reader = await conn.runAndReadUntil(stripSqlComments(effectiveSql), rowCap + 1);
        const names = reader.columnNames();
        const types = reader.columnTypes();
        const raw = reader.getRows();
        const truncated = raw.length > rowCap;
        const rows = (truncated ? raw.slice(0, rowCap) : raw).map((r) => r.map(jsValue));
        const result: LakehouseResult = {
          columns: names.map((name, i) => ({ name, type: String(types[i]) })),
          rows,
          row_count: rows.length,
          truncated,
          duration_ms: Date.now() - started,
          kind: classified.kind,
          retries: attempt || undefined,
        };
        if (cacheSlot) cachePut(cacheSlot.key, cacheSlot.snapshot, result);
        record("ok", rows.length, undefined, { retries: attempt });
        return result;
      } catch (e) {
        const message = (e as Error).message;
        const retryable =
          classified.kind !== "select" && isWriteConflict(message) && attempt < WRITE_RETRIES;
        if (!retryable) {
          if (isWriteConflict(message)) {
            // The raw engine text ("Failed to commit DuckLake transaction")
            // tells a user nothing about what to do next.
            throw new Error(
              `Another write reached this table first, so your statement was rolled back — nothing was applied. Retried ${attempt} time(s); run it again.`,
            );
          }
          throw e;
        }
        c.closeSync();
        c = null;
        await new Promise((r) => setTimeout(r, retryDelayMs(attempt + 1)));
      } finally {
        clearTimeout(timer);
      }
    }
  } catch (e) {
    // Redact HERE, not only on engine boot. Every query error travels to the
    // browser and into lakehouse_query_history, and object-store failures quote
    // the full endpoint URL — which is the operator's internal address.
    const message = redactLakehouseSecrets(
      describeMissingDataFile((e as Error).message) ?? (e as Error).message,
    );
    record("error", null, message);
    throw new Error(message);
  } finally {
    c?.closeSync();
  }
}
