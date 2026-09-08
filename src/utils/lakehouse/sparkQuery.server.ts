// Lakehouse SELECTs on the Spark engine.
//
// Every lakehouse query ran on DuckDB inside one app worker — fast per core,
// spilling to disk, but never spanning machines, while the Spark engine
// served pipelines only. A query sent here is a job: the statement is
// governed exactly as it would be on DuckDB (classified, schema access,
// security policies), each table it reads is resolved to the Parquet files of
// one catalog snapshot, and a sandbox connects to the cluster, builds a view
// per table from those files, runs the statement and posts the rows back. The
// page polls the row this module keeps, the same shape a training job has.
//
// The cluster never talks to the catalog. That is deliberate: the catalog
// Postgres is the lakehouse's narrow point, and a hundred executors opening
// sessions against it would be the outage this feature exists to avoid.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { auditEvent } from "@/utils/audit.server";
import {
  accessibleSchemas,
  assertSchemasAllowed,
  catalogUrlToLibpq,
  classifyStatement,
  lakehouseConfig,
  lakehouseConnection,
  redactLakehouseSecrets,
  selectReferencedTables,
  type LakehouseResult,
  type SchemaRow,
} from "./core.server";
import { loadPolicies } from "./policies.server";
import { compileSparkQuery, type SparkQueryTable } from "./sparkQueryCodegen";

/** The key a Spark query session carries in its runtime session inputs. */
export const SPARK_QUERY_KEY = "__lakehouse_spark_query";
export type SparkQueryStash = { query_id: string };

/** Pull the query id out of a session's inputs, or null for any other session. */
export function sparkQueryStashOf(inputs: unknown): SparkQueryStash | null {
  const raw = (inputs as { [SPARK_QUERY_KEY]?: unknown } | null)?.[SPARK_QUERY_KEY];
  if (!raw || typeof raw !== "object") return null;
  const id = (raw as { query_id?: unknown }).query_id;
  return typeof id === "string" && id.length > 0 ? { query_id: id } : null;
}

export type SparkQueryStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
const LIVE: SparkQueryStatus[] = ["queued", "running"];
/** The one statement kind Spark ever answers (a history/result kind, not a session kind). */
const STATEMENT_KIND = "select" as const;
const LOG_CAP = 200_000;
/** Bytes of result JSON kept on the row; beyond it rows are dropped and the result marked cut. */
const RESULT_BYTES_CAP = 16_000_000;

/** What the page polls: the row, its rows when it is done, its logs when it is not. */
export type SparkQueryView = {
  id: string;
  status: SparkQueryStatus;
  sql: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  result:
    | (LakehouseResult & { engine: "spark"; spark_version?: string; snapshot?: number | null })
    | null;
  /** The tail of the sandbox's output, for a query that failed or is still running. */
  logs: string | null;
  tables: { schema: string; table: string; files: number; deletes: number }[];
  snapshot: number | null;
};

/**
 * Wall-clock ceiling for one query on Spark, in minutes. Env, then a default:
 * the batch sandbox's own limit is sized for training jobs and would let a
 * runaway query hold a cluster for two hours.
 */
export function sparkQueryMinutes(): number {
  return Number(process.env.LAKEHOUSE_SPARK_QUERY_MINUTES ?? "") || 30;
}

const sq = (v: string) => `'${v.replace(/'/g, "''")}'`;

type Planned = {
  tables: SparkQueryTable[];
  snapshot: number | null;
};

/**
 * Govern the statement and resolve what it reads. Everything DuckDB would
 * refuse, this refuses too; and three things DuckDB would allow are refused
 * because Spark cannot honour them — a mounted schema (its views read raw
 * files through server-authored bodies), a table under another owner's
 * security policy (the filter would not be applied), and encrypted files.
 */
export async function planSparkQuery(userId: string, sql: string): Promise<Planned> {
  const classified = classifyStatement(sql);
  if (classified.kind !== "select") {
    throw new Error("Only a SELECT can run on Spark — writes stay on the lakehouse engine.");
  }
  const allowed = await accessibleSchemas(userId);
  const c = await lakehouseConnection();
  try {
    const refs = await selectReferencedTables(c, sql);
    if (!refs.length) {
      throw new Error(
        "This statement reads no lakehouse table (schema.table), so there is nothing for Spark to do — run it here.",
      );
    }
    const schemas = [...new Set(refs.map((r) => r.schema))];
    assertSchemasAllowed(schemas, allowed);
    for (const schema of schemas) {
      const row = allowed.find((s) => s.name.toLowerCase() === schema.toLowerCase());
      if (row?.lake_source_id || row?.iceberg_catalog_id) {
        throw new Error(
          `"${schema}" is a mounted schema — its views read files in place through the lakehouse engine, which Spark cannot do. Query it here, or load it into a lakehouse table first.`,
        );
      }
    }
    // Owners see their own tables whole; everyone else reads through the
    // owner's policy, and Spark has no way to apply one.
    const foreign = allowed.filter((s) => s.user_id !== userId);
    if (foreign.length) {
      const policed = refs.filter((t) =>
        foreign.some((s) => s.name.toLowerCase() === t.schema.toLowerCase()),
      );
      const policies = await loadPolicies([...new Set(foreign.map((f) => f.user_id))], policed);
      if (policies.size) {
        const [first] = [...policies.values()];
        throw new Error(
          `"${first.schema_name}.${first.table_name}" has a security policy, which Spark cannot enforce — run this on the lakehouse engine, which applies it.`,
        );
      }
    }
    // Small writes stay inlined in the catalog until a flush; a file listing
    // taken without one would miss them, and a delete after a flush stays
    // inlined too. So: flush, then pin the snapshot every table is read at.
    try {
      await c.run("CALL ducklake_flush_inlined_data('lake')");
    } catch (e) {
      throw new Error(
        `Could not flush the catalog's inlined rows before reading on Spark: ${redactLakehouseSecrets((e as Error).message)}`,
      );
    }
    const snapRows = await (
      await c.run("SELECT max(snapshot_id) AS s FROM ducklake_snapshots('lake')")
    ).getRows();
    const snapshot = snapRows[0]?.[0] == null ? null : Number(snapRows[0][0]);
    const tables: SparkQueryTable[] = [];
    for (const ref of refs) {
      const key = `${ref.schema}.${ref.table}`;
      if (tables.some((t) => `${t.schema}.${t.table}` === key)) continue;
      const cols = await (
        await c.run(
          `SELECT column_name, data_type FROM duckdb_columns() WHERE database_name = 'lake' AND lower(schema_name) = lower(${sq(ref.schema)}) AND lower(table_name) = lower(${sq(ref.table)}) ORDER BY column_index`,
        )
      ).getRows();
      if (!cols.length) throw new Error(`Table "${key}" does not exist in the lakehouse.`);
      const pinned =
        snapshot === null ? "" : `, snapshot_version => ${Math.max(0, Math.floor(snapshot))}`;
      let files: unknown[][];
      try {
        files = await (
          await c.run(
            `SELECT data_file, delete_file, data_file_encryption_key, delete_file_encryption_key FROM ducklake_list_files('lake', ${sq(ref.table)}, schema => ${sq(ref.schema)}${pinned})`,
          )
        ).getRows();
      } catch {
        // An older DuckLake without the snapshot parameter lists the current
        // state; the snapshot recorded on the query is then informative only.
        files = await (
          await c.run(
            `SELECT data_file, delete_file, data_file_encryption_key, delete_file_encryption_key FROM ducklake_list_files('lake', ${sq(ref.table)}, schema => ${sq(ref.schema)})`,
          )
        ).getRows();
      }
      if (files.some((f) => f[2] != null || f[3] != null)) {
        throw new Error(
          `"${key}" is stored encrypted, and the Spark reader does not decrypt DuckLake files yet — run this on the lakehouse engine.`,
        );
      }
      const dataFiles = [...new Set(files.map((f) => String(f[0])).filter(Boolean))];
      const deleteFiles = [
        ...new Set(files.map((f) => (f[1] == null ? "" : String(f[1]))).filter(Boolean)),
      ];
      tables.push({
        schema: ref.schema,
        table: ref.table,
        columns: cols.map((r) => ({ name: String(r[0]), type: String(r[1]) })),
        dataFiles,
        deleteFiles,
      });
    }
    return { tables, snapshot };
  } finally {
    c.closeSync();
  }
}

/** Is the Spark engine reachable for queries at all? Throws the reason if not. */
async function assertSparkForQueries(): Promise<void> {
  const { sparkClusterSettings, inCluster } = await import("@/utils/etl/sparkCluster.server");
  const s = await sparkClusterSettings();
  if (s.provider === "static" && !s.staticUrl) {
    throw new Error(
      "No Spark Connect endpoint is configured (Admin → Developer runtime → Spark engine).",
    );
  }
  if (s.provider === "k8s" && !inCluster()) {
    throw new Error(
      "The Spark engine is set to create a cluster per job on Kubernetes, but this app is not running in a cluster.",
    );
  }
}

/**
 * Govern, plan, record, and launch — the launch detached, so the page gets
 * an id to poll at once rather than waiting on a container start.
 */
export async function startSparkQuery(
  userId: string,
  sql: string,
  opts?: { rowCap?: number },
): Promise<{ id: string }> {
  if (!lakehouseConfig()) throw new Error("The lakehouse is not configured on this deployment.");
  await assertSparkForQueries();
  const planned = await planSparkQuery(userId, sql);
  const rowCap = Math.min(Math.max(1, Math.floor(opts?.rowCap ?? 10_000)), 100_000);
  const { data: row, error } = await supabaseAdmin
    .from("lakehouse_spark_queries")
    .insert({
      user_id: userId,
      sql,
      status: "queued",
      row_cap: rowCap,
      tables: planned.tables as never,
      snapshot: planned.snapshot,
    })
    .select("id")
    .single();
  if (error || !row) throw new Error(error?.message ?? "Could not record the query");
  void launch(row.id, userId).catch((e) =>
    console.warn("[sparkq] launch failed:", (e as Error).message),
  );
  return { id: row.id };
}

async function launch(id: string, userId: string): Promise<void> {
  const { acquireSparkCluster, awaitSparkClusterReady, releaseSparkCluster } =
    await import("@/utils/etl/sparkCluster.server");
  const { startSession } = await import("@/utils/notebookRuntime/service.server");
  const minutes = sparkQueryMinutes();
  let ref: string | null = null;
  try {
    const cluster = await acquireSparkCluster({ runId: id, userId, timeoutMinutes: minutes });
    ref = cluster.ref;
    await supabaseAdmin
      .from("lakehouse_spark_queries")
      .update({ spark_cluster_ref: cluster.ref, spark_connect_url: cluster.url })
      .eq("id", id);
    await awaitSparkClusterReady(cluster.ref);
    // Cancelled while the cluster was coming up: nothing to start.
    const { data: still } = await supabaseAdmin
      .from("lakehouse_spark_queries")
      .select("status")
      .eq("id", id)
      .maybeSingle();
    if (still?.status !== "queued") {
      await releaseSparkCluster(ref).catch(() => {});
      return;
    }
    const { session } = await startSession({
      userId,
      kind: "batch",
      entrypoint: "entrypoint",
      inputs: { [SPARK_QUERY_KEY]: { query_id: id } },
      maxMinutes: minutes,
    });
    const { data: claimed } = await supabaseAdmin
      .from("lakehouse_spark_queries")
      .update({ status: "running", session_id: session.id, started_at: new Date().toISOString() })
      .eq("id", id)
      .eq("status", "queued")
      .select("id")
      .maybeSingle();
    if (!claimed) {
      // Cancelled while the sandbox was starting. Seen live: the cancel
      // landed before a session id existed, so it had nothing to stop, and
      // the container ran the whole query for nobody. Stop it here instead.
      const { stopSession } = await import("@/utils/notebookRuntime/service.server");
      await stopSession(session).catch(() => {});
      await releaseSparkCluster(ref).catch(() => {});
    }
  } catch (e) {
    await releaseSparkCluster(ref).catch(() => {});
    await markFailed(id, `Could not start: ${(e as Error).message}`, "");
  }
}

async function markFailed(id: string, error: string, logs: string): Promise<void> {
  const { data: row } = await supabaseAdmin
    .from("lakehouse_spark_queries")
    .update({
      status: "failed",
      error: redactLakehouseSecrets(error).slice(0, 4000),
      logs: logs.slice(-LOG_CAP) || null,
      finished_at: new Date().toISOString(),
    })
    .eq("id", id)
    .in("status", LIVE)
    .select("user_id, sql, created_at")
    .maybeSingle();
  if (row)
    await recordHistory(row.user_id, row.sql, "error", null, elapsedSince(row.created_at), error);
}

function elapsedSince(iso: string): number {
  return Math.max(0, Date.now() - new Date(iso).getTime());
}

async function recordHistory(
  userId: string,
  sql: string,
  status: "ok" | "error",
  rowCount: number | null,
  durationMs: number,
  error?: string,
): Promise<void> {
  await supabaseAdmin
    .from("lakehouse_query_history")
    .insert({
      user_id: userId,
      sql: sql.slice(0, 8000),
      kind: STATEMENT_KIND,
      status,
      row_count: rowCount,
      duration_ms: durationMs,
      error: error ? redactLakehouseSecrets(error).slice(0, 2000) : null,
      engine: "spark",
    })
    .then(() => {});
  auditEvent({
    userId,
    action: "lakehouse.select",
    resourceType: "lakehouse",
    resourceName: "spark",
    detail: { status, rows: rowCount ?? undefined, duration_ms: durationMs, engine: "spark" },
  });
}

async function loadOwned(id: string, userId: string) {
  const { data } = await supabaseAdmin
    .from("lakehouse_spark_queries")
    .select("*")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();
  return data;
}

/** The code bundle for a query session (source route, default part). */
export async function sparkQueryBundleFor(
  stash: SparkQueryStash,
  userId: string,
): Promise<{ code: string } | { error: string }> {
  const row = await loadOwned(stash.query_id, userId);
  if (!row) return { error: "Spark query not found for this session" };
  const { etlPrelude } = await import("@/utils/etl/service.server");
  const program = compileSparkQuery({
    queryId: row.id,
    sql: row.sql,
    tables: (row.tables as SparkQueryTable[] | null) ?? [],
    rowCap: row.row_cap,
    snapshot: row.snapshot == null ? null : Number(row.snapshot),
  });
  return { code: etlPrelude() + program };
}

/** The env for a query session: the lake's credentials and the cluster's address. */
export async function sparkQueryEnvFor(
  stash: SparkQueryStash,
  userId: string,
): Promise<{ env: Record<string, string>; requirements: string[] } | { error: string }> {
  const row = await loadOwned(stash.query_id, userId);
  if (!row) return { error: "Spark query not found for this session" };
  const cfg = lakehouseConfig();
  if (!cfg) return { error: "The lakehouse is not configured on this deployment." };
  const { env } = await queryEnv(cfg, row.spark_connect_url);
  return { env, requirements: [] };
}

async function queryEnv(
  cfg: NonNullable<ReturnType<typeof lakehouseConfig>>,
  storedUrl: string | null,
): Promise<{ env: Record<string, string>; secretValues: string[] }> {
  const { sparkClusterSettings } = await import("@/utils/etl/sparkCluster.server");
  const { internalAppUrl, noProxyList } = await import("@/utils/notebookRuntime/service.server");
  const env: Record<string, string> = {
    ETL_LAKEHOUSE_CATALOG: catalogUrlToLibpq(cfg.catalog),
    ETL_LAKEHOUSE_DATA_URL: cfg.dataUrl,
    ETL_LAKEHOUSE_S3_KEY_ID: cfg.s3.keyId,
    ETL_LAKEHOUSE_S3_SECRET: cfg.s3.secret,
    ETL_LAKEHOUSE_S3_URL_STYLE: cfg.s3.urlStyle,
    ETL_LAKEHOUSE_S3_USE_SSL: cfg.s3.useSsl ? "true" : "false",
  };
  if (cfg.s3.endpoint) env.ETL_LAKEHOUSE_S3_ENDPOINT = cfg.s3.endpoint;
  const secretValues = [env.ETL_LAKEHOUSE_CATALOG, cfg.s3.secret];
  const s = await sparkClusterSettings();
  const url = s.provider === "k8s" ? storedUrl : s.staticUrl;
  if (url) {
    env.ETL_SPARK_CONNECT_URL = url;
    // gRPC cannot go through the HTTP egress proxy: the endpoint's host joins
    // the no-proxy list, which the prelude applies before the client connects.
    let host = "";
    try {
      host = new URL(url.replace(/^sc:\/\//i, "http://")).hostname;
    } catch {
      /* an unparseable URL fails in the sandbox with Spark's own message */
    }
    const noProxy = noProxyList(internalAppUrl(), host ? [host] : []);
    env.NO_PROXY = noProxy;
    env.no_proxy = noProxy;
    const token = /[;?&]token=([^;&\s]+)/i.exec(url);
    if (token) secretValues.push(decodeURIComponent(token[1]));
  }
  return { env, secretValues };
}

async function scrubFor(row: { spark_connect_url: string | null }, text: string): Promise<string> {
  const cfg = lakehouseConfig();
  if (!cfg) return redactLakehouseSecrets(text);
  const { secretValues } = await queryEnv(cfg, row.spark_connect_url);
  const { scrubSecrets } = await import("@/utils/etl/service.server");
  return redactLakehouseSecrets(scrubSecrets(text, secretValues));
}

/** Live output from the sandbox, shown while the query runs. */
export async function appendSparkQueryLogs(id: string, logs: string): Promise<void> {
  const { data: row } = await supabaseAdmin
    .from("lakehouse_spark_queries")
    .select("id, status, spark_connect_url")
    .eq("id", id)
    .maybeSingle();
  if (!row || row.status !== "running") return;
  await supabaseAdmin
    .from("lakehouse_spark_queries")
    .update({ logs: (await scrubFor(row, logs)).slice(-LOG_CAP) })
    .eq("id", id)
    .eq("status", "running");
}

/** Keep a result under the byte cap by dropping rows from the end. */
export function capResultBytes<
  T extends { rows: unknown[][]; truncated: boolean; row_count: number },
>(result: T, cap = RESULT_BYTES_CAP): T {
  let out = result;
  while (out.rows.length && JSON.stringify(out).length > cap) {
    const keep = Math.max(0, Math.floor(out.rows.length * 0.6));
    out = { ...out, rows: out.rows.slice(0, keep), row_count: keep, truncated: true };
  }
  return out;
}

/** The sandbox's final callback: rows or the reason there are none. */
export async function finalizeSparkQuery(
  id: string,
  body: { status: string; result?: unknown; logs?: string; error?: string | null },
): Promise<void> {
  const { data: row } = await supabaseAdmin
    .from("lakehouse_spark_queries")
    .select("id, user_id, sql, status, spark_cluster_ref, spark_connect_url, created_at, row_cap")
    .eq("id", id)
    .maybeSingle();
  if (!row || !LIVE.includes(row.status as SparkQueryStatus)) return;
  const { releaseSparkCluster } = await import("@/utils/etl/sparkCluster.server");
  await releaseSparkCluster(row.spark_cluster_ref).catch(() => {});
  const logs = await scrubFor(row, body.logs ?? "");
  const r = body.result as Partial<LakehouseResult> & {
    spark_version?: string;
    snapshot?: number | null;
  };
  const ok = body.status !== "error" && r && Array.isArray(r.rows) && Array.isArray(r.columns);
  if (!ok) {
    const error = await scrubFor(
      row,
      body.error?.trim() ||
        (body.status === "error"
          ? "The query failed on Spark — see the logs."
          : "The query returned no result."),
    );
    await markFailed(id, error, logs);
    return;
  }
  const result = capResultBytes({
    columns: r.columns as LakehouseResult["columns"],
    rows: r.rows as LakehouseResult["rows"],
    row_count: r.rows!.length,
    truncated: Boolean(r.truncated),
    duration_ms: typeof r.duration_ms === "number" ? r.duration_ms : elapsedSince(row.created_at),
    kind: STATEMENT_KIND,
    engine: "spark" as const,
    spark_version: typeof r.spark_version === "string" ? r.spark_version : undefined,
    snapshot: typeof r.snapshot === "number" ? r.snapshot : null,
  });
  await supabaseAdmin
    .from("lakehouse_spark_queries")
    .update({
      status: "succeeded",
      result: result as never,
      logs: logs.slice(-LOG_CAP) || null,
      error: null,
      finished_at: new Date().toISOString(),
    })
    .eq("id", id)
    .in("status", LIVE);
  await recordHistory(row.user_id, row.sql, "ok", result.row_count, elapsedSince(row.created_at));
}

/** What the page polls. */
export async function getSparkQuery(userId: string, id: string): Promise<SparkQueryView | null> {
  const row = await loadOwned(id, userId);
  if (!row) return null;
  const tables = ((row.tables as SparkQueryTable[] | null) ?? []).map((t) => ({
    schema: t.schema,
    table: t.table,
    files: t.dataFiles?.length ?? 0,
    deletes: t.deleteFiles?.length ?? 0,
  }));
  return {
    id: row.id,
    status: row.status as SparkQueryStatus,
    sql: row.sql,
    created_at: row.created_at,
    started_at: row.started_at,
    finished_at: row.finished_at,
    error: row.error,
    result: (row.result as SparkQueryView["result"]) ?? null,
    logs: row.status === "succeeded" ? null : (row.logs?.slice(-6000) ?? null),
    tables,
    snapshot: row.snapshot == null ? null : Number(row.snapshot),
  };
}

/** Stop a live query: its sandbox, its cluster, its row. */
export async function cancelSparkQuery(userId: string, id: string): Promise<boolean> {
  const row = await loadOwned(id, userId);
  if (!row || !LIVE.includes(row.status as SparkQueryStatus)) return false;
  const { data: claimed } = await supabaseAdmin
    .from("lakehouse_spark_queries")
    .update({ status: "cancelled", finished_at: new Date().toISOString() })
    .eq("id", id)
    .in("status", LIVE)
    .select("id")
    .maybeSingle();
  if (!claimed) return false;
  if (row.session_id) {
    const { stopSession } = await import("@/utils/notebookRuntime/service.server");
    const { data: session } = await supabaseAdmin
      .from("notebook_runtime_sessions")
      .select("*")
      .eq("id", row.session_id)
      .maybeSingle();
    if (session) await stopSession(session).catch(() => {});
  }
  const { releaseSparkCluster } = await import("@/utils/etl/sparkCluster.server");
  await releaseSparkCluster(row.spark_cluster_ref).catch(() => {});
  await recordHistory(userId, row.sql, "error", null, elapsedSince(row.created_at), "cancelled");
  return true;
}

/** Queries this user ran on Spark, newest first — the page's own history. */
export async function listSparkQueries(
  userId: string,
  limit = 20,
): Promise<
  Pick<SparkQueryView, "id" | "status" | "sql" | "created_at" | "finished_at" | "error">[]
> {
  const { data } = await supabaseAdmin
    .from("lakehouse_spark_queries")
    .select("id, status, sql, created_at, finished_at, error")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);
  return (data ?? []).map((d) => ({ ...d, status: d.status as SparkQueryStatus }));
}

export type { SchemaRow };
