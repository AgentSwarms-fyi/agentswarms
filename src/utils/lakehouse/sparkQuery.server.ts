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
import { createHmac, timingSafeEqual } from "node:crypto";

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
import { knownLakeSecrets, lakeCredentials } from "@/utils/lakehouse/lakeCredentials.server";
import { loadPolicies } from "./policies.server";
import { compileSparkQuery, type SparkQueryTable } from "./sparkQueryCodegen";
import type { IcebergCatalogRow } from "./iceberg.server";
import {
  compileIcebergMaintenance,
  icebergEnvKey,
  icebergMaintenanceSql,
  icebergSparkCatalog,
  maintenanceError,
  type IcebergMaintenance,
} from "./icebergSpark";
import { sparkRunToken } from "@/utils/etl/sparkConnectClient";

/** The key a Spark query session carries in its runtime session inputs. */
export const SPARK_QUERY_KEY = "__lakehouse_spark_query";
/**
 * The job id, and the seal of the plan as the server recorded it (R459). A
 * session started before seals existed carries none, and is refused.
 */
export type SparkQueryStash = { query_id: string; seal: string | null };

/** Pull the query id out of a session's inputs, or null for any other session. */
export function sparkQueryStashOf(inputs: unknown): SparkQueryStash | null {
  const raw = (inputs as { [SPARK_QUERY_KEY]?: unknown } | null)?.[SPARK_QUERY_KEY];
  if (!raw || typeof raw !== "object") return null;
  const id = (raw as { query_id?: unknown }).query_id;
  const seal = (raw as { seal?: unknown }).seal;
  return typeof id === "string" && id.length > 0
    ? { query_id: id, seal: typeof seal === "string" && seal.length > 0 ? seal : null }
    : null;
}

// ── The plan's seal (R459) ──────────────────────────────────────────────────
//
// FOUND IN R459: the row a sandbox is built from was writable by its owner
// (policy FOR ALL, and `authenticated` keeps UPDATE on public tables). Its
// `tables` column is the list of files the cluster reads, and the scoped
// credential is minted for the prefixes that list names, so a user who
// rewrote their queued query's list between the insert and the sandbox's
// start was handed a credential for, and the rows of, another user's files.
// Migration 20261112000000 makes the table server-written; the seal makes the
// code not depend on that: the plan is sealed with the runtime secret when it
// is recorded, the seal rides in the session's inputs, and the program and the
// env are built only from a row that still matches it.

/** JSON with object keys sorted, so a row read back from jsonb seals as it was written. */
export function canonicalJson(v: unknown): string {
  if (v === null || v === undefined || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  const o = v as Record<string, unknown>;
  return (
    "{" +
    Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => JSON.stringify(k) + ":" + canonicalJson(o[k]))
      .join(",") +
    "}"
  );
}

export type Sealable = {
  id: string;
  user_id: string;
  sql: string;
  tables: unknown;
  snapshot: number | string | null;
  row_cap: number;
};

/** What a seal covers: everything the program and the env are built from. */
export function sealInput(r: Sealable): string {
  return canonicalJson({
    id: r.id,
    user_id: r.user_id,
    sql: r.sql,
    tables: r.tables ?? [],
    snapshot: r.snapshot == null ? null : String(r.snapshot),
    row_cap: r.row_cap,
  });
}

/** The seal: an HMAC of the plan under the runtime's signing secret. */
export function sealWith(secret: string, r: Sealable): string {
  return createHmac("sha256", secret)
    .update("spark-plan:" + sealInput(r))
    .digest("hex");
}

async function sealPlan(r: Sealable): Promise<string> {
  const { getRuntimeSecret } = await import("@/utils/notebookRuntime/token.server");
  const secret = await getRuntimeSecret();
  if (!secret) throw new Error("The developer runtime has no signing secret yet.");
  return sealWith(secret, r);
}

/** Is this row the plan the server sealed? Constant-time on the digest. */
export function sealMatches(secret: string, r: Sealable, seal: string | null): boolean {
  if (!seal || !/^[0-9a-f]{64}$/.test(seal)) return false;
  const want = Buffer.from(sealWith(secret, r), "hex");
  const got = Buffer.from(seal, "hex");
  return want.length === got.length && timingSafeEqual(want, got);
}

async function sealHolds(r: Sealable, seal: string | null): Promise<boolean> {
  const { getRuntimeSecret } = await import("@/utils/notebookRuntime/token.server");
  const secret = await getRuntimeSecret();
  return Boolean(secret) && sealMatches(secret!, r, seal);
}

const SEAL_BROKEN =
  "This Spark job's plan is not the one the server recorded, so no sandbox is built from it. Run it again.";

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
  // DuckDB's own statements, which Spark SQL does not have. SUMMARIZE used to
  // reach the "reads no lakehouse table" refusal below by naming no table;
  // since R224 it names its table, so say what is actually wrong.
  const verb = /^\s*(DESCRIBE|SUMMARIZE|SHOW)\b/i.exec(
    sql.replace(/^\s*(--[^\n]*\n|\/\*[\s\S]*?\*\/)*/g, ""),
  );
  if (verb) {
    throw new Error(
      `${verb[1].toUpperCase()} is the lakehouse engine's; Spark SQL has no such statement — run it here.`,
    );
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
    // R459: an Iceberg mount is read by Spark from its own catalog, now that
    // the cluster has Iceberg (Spark 4.1). Only the caller's own mount: the
    // session is configured with the catalog's credentials, and a grantee's
    // job would be handed its owner's. A file mount still reads raw files
    // through server-authored view bodies, which Spark cannot run.
    const icebergSchemas = new Map<string, SchemaRow>();
    for (const schema of schemas) {
      const row = allowed.find((s) => s.name.toLowerCase() === schema.toLowerCase());
      if (row?.lake_source_id) {
        throw new Error(
          `"${schema}" is a mounted schema — its views read files in place through the lakehouse engine, which Spark cannot do. Query it here, or load it into a lakehouse table first.`,
        );
      }
      if (row?.iceberg_catalog_id) {
        if (row.user_id !== userId) {
          throw new Error(
            `"${schema}" is an Iceberg mount shared with you. Spark would read it with its owner's catalog credentials, which a job of yours is not given — query it here, where the lakehouse engine reads it for you.`,
          );
        }
        icebergSchemas.set(schema.toLowerCase(), row);
      }
    }
    const catalogRows = new Map<string, IcebergCatalogRow>();
    for (const s of icebergSchemas.values()) {
      const id = s.iceberg_catalog_id!;
      if (catalogRows.has(id)) continue;
      const { data: cat, error: catError } = await supabaseAdmin
        .from("iceberg_catalogs")
        .select("*")
        .eq("id", id)
        .eq("user_id", userId)
        .maybeSingle();
      if (catError) throw new Error(`Could not read the catalog: ${catError.message}`);
      if (!cat) throw new Error(`The catalog behind "${s.name}" is gone.`);
      catalogRows.set(id, cat as IcebergCatalogRow);
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
      const mount = icebergSchemas.get(ref.schema.toLowerCase());
      if (mount) {
        // The table behind the mount's view, at the snapshot current now:
        // the job reads exactly that one, however long it waits to start.
        const { icebergSparkTarget } = await import("@/utils/lakehouse/iceberg.server");
        const target = await icebergSparkTarget({
          row: catalogRows.get(mount.iceberg_catalog_id!)!,
          schemaName: mount.name,
          view: ref.table,
        });
        tables.push({
          schema: ref.schema,
          table: ref.table,
          columns: [],
          dataFiles: [],
          deleteFiles: [],
          iceberg: target,
        });
        continue;
      }
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
  return recordAndLaunch(userId, {
    sql,
    tables: planned.tables,
    snapshot: planned.snapshot,
    row_cap: rowCap,
  });
}

/**
 * Iceberg maintenance on Spark (R459): compaction, rewriting away deletes, or
 * expiring snapshots, on a table of the caller's own Iceberg mount. The same
 * job as a SELECT — recorded, sealed, launched, polled — whose plan names the
 * one table and the procedure. Only the catalog's owner may run it: it
 * commits to the catalog with the owner's credentials, and expiry deletes
 * files for good.
 */
export async function startIcebergMaintenance(
  userId: string,
  args: { schema: string; view: string; maintenance: IcebergMaintenance },
): Promise<{ id: string; sql: string }> {
  if (!lakehouseConfig()) throw new Error("The lakehouse is not configured on this deployment.");
  const problem = maintenanceError(args.maintenance);
  if (problem) throw new Error(problem);
  await assertSparkForQueries();
  const schema = (await accessibleSchemas(userId)).find((s) => s.name === args.schema);
  if (!schema) throw new Error(`No access to schema "${args.schema}"`);
  if (!schema.iceberg_catalog_id) throw new Error(`${args.schema} is not an Iceberg mount.`);
  if (schema.user_id !== userId) {
    throw new Error(
      "Only the owner of this mount can maintain its tables: maintenance commits to the catalog with the owner's credentials.",
    );
  }
  const { data: cat, error: catError } = await supabaseAdmin
    .from("iceberg_catalogs")
    .select("*")
    .eq("id", schema.iceberg_catalog_id)
    .eq("user_id", userId)
    .maybeSingle();
  if (catError) throw new Error(`Could not read the catalog: ${catError.message}`);
  if (!cat) throw new Error("The catalog behind this mount is gone.");
  const { icebergSparkTarget } = await import("@/utils/lakehouse/iceberg.server");
  const target = await icebergSparkTarget({
    row: cat as IcebergCatalogRow,
    schemaName: args.schema,
    view: args.view,
  });
  const m: IcebergMaintenance =
    args.maintenance.action === "expire"
      ? {
          action: "expire",
          older_than_days: args.maintenance.older_than_days ?? 7,
          retain_last: args.maintenance.retain_last ?? 20,
        }
      : { action: args.maintenance.action };
  const sql = icebergMaintenanceSql(
    icebergSparkCatalog(cat.id),
    target.namespace,
    target.table,
    m,
    new Date(),
  );
  const { id } = await recordAndLaunch(userId, {
    sql,
    tables: [
      {
        schema: args.schema,
        table: args.view,
        columns: [],
        dataFiles: [],
        deleteFiles: [],
        iceberg: { ...target, snapshot_id: null },
        maintain: m,
      },
    ],
    snapshot: null,
    row_cap: 100,
  });
  return { id, sql };
}

/**
 * Record a planned job and launch it. The seal is taken from the plan in
 * hand, not from the row read back, so nothing written in between is sealed.
 */
async function recordAndLaunch(
  userId: string,
  plan: { sql: string; tables: SparkQueryTable[]; snapshot: number | null; row_cap: number },
): Promise<{ id: string }> {
  const { data: row, error } = await supabaseAdmin
    .from("lakehouse_spark_queries")
    .insert({
      user_id: userId,
      sql: plan.sql,
      status: "queued",
      row_cap: plan.row_cap,
      tables: plan.tables as never,
      snapshot: plan.snapshot,
    })
    .select("id")
    .single();
  if (error || !row) throw new Error(error?.message ?? "Could not record the query");
  let seal: string;
  try {
    seal = await sealPlan({ id: row.id, user_id: userId, ...plan });
  } catch (e) {
    await markFailed(row.id, `Could not start: ${(e as Error).message}`, "");
    throw e;
  }
  void launch(row.id, userId, seal).catch((e) =>
    console.warn("[sparkq] launch failed:", (e as Error).message),
  );
  return { id: row.id };
}

async function launch(id: string, userId: string, seal: string): Promise<void> {
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
      inputs: { [SPARK_QUERY_KEY]: { query_id: id, seal } },
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
    .select("user_id, sql, tables, created_at")
    .maybeSingle();
  if (row) await recordHistory(row, "error", null, elapsedSince(row.created_at), error);
}

function elapsedSince(iso: string): number {
  return Math.max(0, Date.now() - new Date(iso).getTime());
}

/** The maintenance a job runs, or null for a SELECT. */
function maintenanceOf(tables: unknown): { t: SparkQueryTable; m: IcebergMaintenance } | null {
  const t = ((tables as SparkQueryTable[] | null) ?? [])[0];
  return t?.maintain ? { t, m: t.maintain } : null;
}

async function recordHistory(
  row: { user_id: string; sql: string; tables?: unknown },
  status: "ok" | "error",
  rowCount: number | null,
  durationMs: number,
  error?: string,
): Promise<void> {
  const userId = row.user_id;
  const job = maintenanceOf(row.tables);
  await supabaseAdmin
    .from("lakehouse_query_history")
    .insert({
      user_id: userId,
      sql: row.sql.slice(0, 8000),
      kind: job ? "maintenance" : STATEMENT_KIND,
      status,
      row_count: rowCount,
      duration_ms: durationMs,
      error: error ? redactLakehouseSecrets(error).slice(0, 2000) : null,
      engine: "spark",
    })
    .then(() => {});
  if (job) {
    auditEvent({
      userId,
      action: "lakehouse.iceberg.maintain",
      resourceType: "lakehouse_table",
      resourceName: `${job.t.schema}.${job.t.table}`,
      detail: {
        status,
        maintenance: job.m.action,
        ...(job.m.action === "expire"
          ? { older_than_days: job.m.older_than_days, retain_last: job.m.retain_last }
          : {}),
        namespace: job.t.iceberg?.namespace,
        table: job.t.iceberg?.table,
        duration_ms: durationMs,
        engine: "spark",
        ...(error ? { error: redactLakehouseSecrets(error).slice(0, 500) } : {}),
      },
    });
    return;
  }
  auditEvent({
    userId,
    action: "lakehouse.select",
    resourceType: "lakehouse",
    resourceName: "spark",
    detail: { status, rows: rowCount ?? undefined, duration_ms: durationMs, engine: "spark" },
  });
}

async function loadOwned(id: string, userId: string) {
  const { data, error } = await supabaseAdmin
    .from("lakehouse_spark_queries")
    .select("*")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();
  // R222: a read that failed is not a row that is absent. Returned as null,
  // the editor's poll took it for a query that had ended ("cancelled
  // elsewhere") and stopped watching one still running, and Cancel answered
  // "not cancelled" for a query it never looked at.
  if (error) throw new Error(`Could not read the Spark query: ${error.message}`);
  return data;
}

/** The code bundle for a query session (source route, default part). */
export async function sparkQueryBundleFor(
  stash: SparkQueryStash,
  userId: string,
): Promise<{ code: string } | { error: string }> {
  const sealed = await loadSealed(stash, userId);
  if ("refused" in sealed) return { error: sealed.refused };
  const row = sealed.row;
  const { etlPrelude } = await import("@/utils/etl/service.server");
  const tables = (row.tables as SparkQueryTable[] | null) ?? [];
  const catalogs = await jobCatalogs(userId, tables);
  const maintain = tables[0]?.maintain;
  if (maintain) {
    const t = tables[0]!;
    const cat = catalogs[0];
    if (!t.iceberg || !cat) return { error: "This maintenance job names no Iceberg table." };
    return {
      code:
        etlPrelude() +
        compileIcebergMaintenance({
          jobId: row.id,
          catalog: icebergSparkCatalog(cat.id),
          cfg: cat.cfg,
          sql: row.sql,
        }),
    };
  }
  const program = compileSparkQuery({
    queryId: row.id,
    sql: row.sql,
    tables,
    rowCap: row.row_cap,
    snapshot: row.snapshot == null ? null : Number(row.snapshot),
    catalogs: catalogs.map((c) => ({ id: c.id, cfg: c.cfg })),
  });
  return { code: etlPrelude() + program };
}

/** The job's row, if the session's seal still matches it. */
async function loadSealed(
  stash: SparkQueryStash,
  userId: string,
): Promise<{ row: NonNullable<Awaited<ReturnType<typeof loadOwned>>> } | { refused: string }> {
  const row = await loadOwned(stash.query_id, userId);
  if (!row) return { refused: "Spark query not found for this session" };
  if (!(await sealHolds(row, stash.seal))) {
    console.warn(`[sparkq] ${row.id}: the plan does not match its seal; refused`);
    return { refused: SEAL_BROKEN };
  }
  return { row };
}

/**
 * The Iceberg catalogs a job reads, in the order its tables first name them,
 * each the caller's own (a plan never names another's; checked again here).
 */
async function jobCatalogs(
  userId: string,
  tables: SparkQueryTable[],
): Promise<
  { id: string; row: IcebergCatalogRow; cfg: import("./iceberg").IcebergCatalogConfig }[]
> {
  const ids = [...new Set(tables.flatMap((t) => (t.iceberg ? [t.iceberg.catalog_id] : [])))];
  if (!ids.length) return [];
  const { configOf } = await import("@/utils/lakehouse/iceberg.server");
  const out = [];
  for (const id of ids) {
    const { data, error } = await supabaseAdmin
      .from("iceberg_catalogs")
      .select("*")
      .eq("id", id)
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throw new Error(`Could not read the catalog: ${error.message}`);
    if (!data) throw new Error("A catalog this job reads is gone, or is not yours.");
    out.push({ id, row: data as IcebergCatalogRow, cfg: configOf(data as IcebergCatalogRow) });
  }
  return out;
}

/** The env for a query session: the lake's credentials and the cluster's address. */
export async function sparkQueryEnvFor(
  stash: SparkQueryStash,
  userId: string,
): Promise<{ env: Record<string, string>; requirements: string[] } | { error: string }> {
  const sealed = await loadSealed(stash, userId);
  if ("refused" in sealed) return { error: sealed.refused };
  const row = sealed.row;
  const cfg = lakehouseConfig();
  if (!cfg) return { error: "The lakehouse is not configured on this deployment." };
  const tables = (row.tables as SparkQueryTable[] | null) ?? [];
  const { env } = await queryEnv(cfg, row.spark_connect_url, tables, row.id);
  Object.assign(env, (await icebergEnv(userId, cfg, tables, row.id)).env);
  return { env, requirements: [] };
}

/** A lake-bucket key prefix for an s3:// location, or null when it is elsewhere. */
function lakePrefix(bucket: string, location: string | null): string | null {
  const m = location ? /^s3a?:\/\/([^/]+)\/(.+)$/.exec(location) : null;
  if (!m || m[1] !== bucket) return null;
  return m[2]!.replace(/\/*$/, "/");
}

/**
 * The env an Iceberg job's catalogs need, as ETL_ICEBERG_<n>_* (the names
 * icebergSparkConf reads): the bearer token or the OAuth2 credential, resolved
 * from the owner's secrets toward the host that receives each (R419), and for
 * a catalog whose files are read with the lakehouse's keys, those keys, scoped
 * to the tables' own locations when the store can mint a scoped credential.
 * Maintenance writes; a read only reads.
 */
async function icebergEnv(
  userId: string,
  cfg: NonNullable<ReturnType<typeof lakehouseConfig>>,
  tables: SparkQueryTable[],
  jobId: string,
): Promise<{ env: Record<string, string>; secretValues: string[] }> {
  const env: Record<string, string> = {};
  const secretValues: string[] = [];
  const catalogs = await jobCatalogs(userId, tables);
  if (!catalogs.length) return { env, secretValues };
  const { icebergSparkCredentials } = await import("@/utils/lakehouse/iceberg.server");
  const writes = tables.some((t) => t.maintain);
  for (const [n, cat] of catalogs.entries()) {
    const creds = await icebergSparkCredentials(userId, cat.row);
    if (creds.token) {
      env[icebergEnvKey(n, "TOKEN")] = creds.token;
      secretValues.push(creds.token);
    }
    if (creds.client_id !== undefined) {
      const credential = `${creds.client_id}:${creds.client_secret ?? ""}`;
      env[icebergEnvKey(n, "CREDENTIAL")] = credential;
      secretValues.push(credential, creds.client_secret ?? "");
    }
    if (cat.cfg.storage !== "lakehouse") continue;
    const ep = cfg.s3.endpoint;
    if (ep) {
      env[icebergEnvKey(n, "S3_ENDPOINT")] = /:\/\//.test(ep)
        ? ep
        : `${cfg.s3.useSsl ? "https" : "http"}://${ep}`;
      env[icebergEnvKey(n, "S3_URL_STYLE")] = cfg.s3.urlStyle;
    }
    const { lakeTarget } = await import("@/utils/ml/experimentArtifacts.server");
    const { assumeScopedCredentials } = await import("@/utils/lakehouse/sts.server");
    const lt = await lakeTarget();
    const prefixes = tables
      .filter((t) => t.iceberg?.catalog_id === cat.id)
      .map((t) => (lt ? lakePrefix(lt.bucket, t.iceberg!.location) : null));
    let scoped = null;
    if (lt && prefixes.length && prefixes.every((p): p is string => Boolean(p))) {
      try {
        scoped = await assumeScopedCredentials({
          target: lt.target,
          scope: writes ? { write: prefixes } : { read: prefixes },
          label: `ice-${jobId.slice(0, 8)}`,
        });
      } catch (e) {
        console.warn(`[lakehouse] Iceberg job ${jobId}: ${(e as Error).message}`);
      }
    }
    if (scoped) {
      env[icebergEnvKey(n, "S3_KEY_ID")] = scoped.accessKeyId;
      env[icebergEnvKey(n, "S3_SECRET")] = scoped.secretAccessKey;
      env[icebergEnvKey(n, "S3_SESSION_TOKEN")] = scoped.sessionToken;
      secretValues.push(scoped.secretAccessKey, scoped.sessionToken);
    } else {
      // The lakehouse engine reads these tables with the same credentials,
      // temporary ones with their session token on the AWS chain (R465).
      const own = await lakeCredentials();
      env[icebergEnvKey(n, "S3_KEY_ID")] = own.accessKeyId;
      env[icebergEnvKey(n, "S3_SECRET")] = own.secretAccessKey;
      secretValues.push(own.secretAccessKey);
      if (own.sessionToken) {
        env[icebergEnvKey(n, "S3_SESSION_TOKEN")] = own.sessionToken;
        secretValues.push(own.sessionToken);
      }
    }
  }
  return { env, secretValues };
}

/**
 * The key prefixes a plan's files live under, for a scoped credential.
 *
 * Each table's files, not each file: a policy naming every file would be
 * enormous for a large table, and the directory is the table's own. Files are
 * taken as the plan resolved them, so a table whose files sit somewhere other
 * than the usual layout is still covered exactly.
 */
export function planFilePrefixes(bucket: string, tables: SparkQueryTable[]): string[] {
  const out = new Set<string>();
  for (const t of tables) {
    for (const f of [...t.dataFiles, ...t.deleteFiles]) {
      const m = /^s3a?:\/\/([^/]+)\/(.*)$/.exec(f);
      // A file outside the lake's own bucket cannot be covered by a policy on
      // it; the caller falls back rather than issue a credential that cannot
      // read what the query needs.
      if (!m || m[1] !== bucket) throw new Error(`"${f}" is not in the lakehouse's bucket`);
      const dir = m[2]!.replace(/[^/]*$/, "");
      if (dir) out.add(dir);
    }
  }
  return [...out];
}

async function queryEnv(
  cfg: NonNullable<ReturnType<typeof lakehouseConfig>>,
  storedUrl: string | null,
  tables: SparkQueryTable[],
  queryId: string,
): Promise<{ env: Record<string, string>; secretValues: string[] }> {
  // No catalog: the cluster reads the Parquet of one governed snapshot, which
  // the app resolved before the query was planned. It never attaches DuckLake.
  const env: Record<string, string> = {
    ETL_LAKEHOUSE_DATA_URL: cfg.dataUrl,
    ETL_LAKEHOUSE_S3_URL_STYLE: cfg.s3.urlStyle,
    ETL_LAKEHOUSE_S3_USE_SSL: cfg.s3.useSsl ? "true" : "false",
  };
  if (cfg.s3.endpoint) env.ETL_LAKEHOUSE_S3_ENDPOINT = cfg.s3.endpoint;
  const secretValues: string[] = [];
  // Read, and only of the files this query reads (R230).
  const { lakeTarget } = await import("@/utils/ml/experimentArtifacts.server");
  const { assumeScopedCredentials } = await import("@/utils/lakehouse/sts.server");
  const lt = await lakeTarget();
  // A job that reads no lakehouse file (an Iceberg table's maintenance, or a
  // query of Iceberg mounts only) is given no lakehouse credential at all:
  // its catalogs' own come from icebergEnv. Before R459 every plan read files.
  if (!tables.some((t) => t.dataFiles.length || t.deleteFiles.length)) {
    return withSpark(env, secretValues, storedUrl);
  }
  let scoped = null;
  try {
    scoped = lt
      ? await assumeScopedCredentials({
          target: lt.target,
          scope: { read: planFilePrefixes(lt.bucket, tables) },
          label: `lakeq-${queryId.slice(0, 8)}`,
        })
      : null;
  } catch (e) {
    // A plan whose files a policy cannot name, or a store that refused: the
    // query still runs, with the engine's credentials, and the reason is in
    // the log rather than in a failure the user cannot act on.
    console.warn(`[lakehouse] Spark query ${queryId}: ${(e as Error).message}`);
  }
  if (scoped) {
    env.ETL_LAKEHOUSE_S3_KEY_ID = scoped.accessKeyId;
    env.ETL_LAKEHOUSE_S3_SECRET = scoped.secretAccessKey;
    env.ETL_LAKEHOUSE_S3_SESSION_TOKEN = scoped.sessionToken;
    secretValues.push(scoped.secretAccessKey, scoped.sessionToken);
  } else {
    // The engine's own, with the session token when they are temporary (R465).
    const own = await lakeCredentials();
    env.ETL_LAKEHOUSE_S3_KEY_ID = own.accessKeyId;
    env.ETL_LAKEHOUSE_S3_SECRET = own.secretAccessKey;
    secretValues.push(own.secretAccessKey);
    if (own.sessionToken) {
      env.ETL_LAKEHOUSE_S3_SESSION_TOKEN = own.sessionToken;
      secretValues.push(own.sessionToken);
    }
  }
  return withSpark(env, secretValues, storedUrl);
}

/** The cluster's address and token, added to a job's env. */
async function withSpark(
  env: Record<string, string>,
  secretValues: string[],
  storedUrl: string | null,
): Promise<{ env: Record<string, string>; secretValues: string[] }> {
  const { sparkClusterSettings } = await import("@/utils/etl/sparkCluster.server");
  const { internalAppUrl, noProxyList } = await import("@/utils/notebookRuntime/service.server");
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
    // The static endpoint's pre-shared token (SPARK_CONNECT_TOKEN), as its own
    // variable so the URL stays clean; sparkRunToken returns null when the URL
    // already embeds one, or for a k8s run. The generated client reads either.
    const runToken = sparkRunToken(s.provider, s.token, url);
    if (runToken) {
      env.ETL_SPARK_CONNECT_TOKEN = runToken;
      secretValues.push(runToken);
    }
  }
  return { env, secretValues };
}

/**
 * The values a run's output must never carry, WITHOUT minting anything.
 *
 * Scrubbing happens on every poll of a live query, so it cannot go through
 * the env builder: that would issue a scoped credential per log line, and the
 * one it issued would not be the one the sandbox holds anyway. These are the
 * deployment's own values, which are what a stack trace can quote.
 */
async function staticSecrets(storedUrl: string | null): Promise<string[]> {
  const cfg = lakehouseConfig();
  if (!cfg) return [];
  // Every store secret and session token this process has used (R465).
  const out = [...knownLakeSecrets(), catalogUrlToLibpq(cfg.catalog)];
  const { sparkClusterSettings } = await import("@/utils/etl/sparkCluster.server");
  const s = await sparkClusterSettings();
  const url = s.provider === "k8s" ? storedUrl : s.staticUrl;
  const token = url ? /[;?&]token=([^;&\s]+)/i.exec(url) : null;
  if (token) out.push(decodeURIComponent(token[1]));
  // The static endpoint's pre-shared token, scrubbed from live output just like
  // a URL-embedded one — it reaches the run as ETL_SPARK_CONNECT_TOKEN.
  const runToken = sparkRunToken(s.provider, s.token, url ?? "");
  if (runToken) out.push(runToken);
  return out.filter(Boolean);
}

/**
 * An Iceberg job's catalog credentials, for scrubbing its output: resolved
 * once per job and kept a while, since live logs are scrubbed on every poll.
 */
const icebergSecretMemo = new Map<string, { at: number; values: string[] }>();

async function jobIcebergSecrets(row: {
  id: string;
  user_id: string;
  tables: unknown;
}): Promise<string[]> {
  const tables = (row.tables as SparkQueryTable[] | null) ?? [];
  if (!tables.some((t) => t.iceberg)) return [];
  const hit = icebergSecretMemo.get(row.id);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.values;
  const values: string[] = [];
  try {
    const { icebergSparkCredentials } = await import("@/utils/lakehouse/iceberg.server");
    for (const cat of await jobCatalogs(row.user_id, tables)) {
      const c = await icebergSparkCredentials(row.user_id, cat.row);
      for (const v of [c.token, c.client_secret]) if (v) values.push(v);
      if (c.client_id !== undefined) values.push(`${c.client_id}:${c.client_secret ?? ""}`);
    }
  } catch {
    /* a catalog that cannot be read now cannot have been given to the job either */
  }
  if (icebergSecretMemo.size > 500) icebergSecretMemo.clear();
  icebergSecretMemo.set(row.id, { at: Date.now(), values });
  return values;
}

async function scrubFor(
  row: { id?: string; user_id?: string; tables?: unknown; spark_connect_url: string | null },
  text: string,
): Promise<string> {
  const cfg = lakehouseConfig();
  if (!cfg) return redactLakehouseSecrets(text);
  const secretValues = await staticSecrets(row.spark_connect_url);
  if (row.id && row.user_id) {
    secretValues.push(
      ...(await jobIcebergSecrets({ id: row.id, user_id: row.user_id, tables: row.tables })),
    );
  }
  const { scrubSecrets } = await import("@/utils/etl/service.server");
  return redactLakehouseSecrets(scrubSecrets(text, secretValues));
}

/** Live output from the sandbox, shown while the query runs. */
export async function appendSparkQueryLogs(id: string, logs: string): Promise<void> {
  const { data: row } = await supabaseAdmin
    .from("lakehouse_spark_queries")
    .select("id, user_id, tables, status, spark_connect_url")
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
    .select(
      "id, user_id, sql, tables, status, spark_cluster_ref, spark_connect_url, created_at, row_cap",
    )
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
  await recordHistory(row, "ok", result.row_count, elapsedSince(row.created_at));
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
  await recordHistory(row, "error", null, elapsedSince(row.created_at), "cancelled");
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
