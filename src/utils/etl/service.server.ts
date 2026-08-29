// ETL pipeline execution service.
//
// A run is a batch kernel in the notebook runtime — the same sandbox, egress
// allow-list and reaper as every notebook and MCP server. Nothing here starts
// a new kind of process; it starts a batch session whose source bundle happens
// to be an ETL script.
//
// The credential path copies the MCP design decision verbatim: the sandbox
// fetches its resolved environment over HTTP with its session token (the
// "etl_env" part of the source route), so destination keys exist only in the
// sandbox process's memory — never in container env, never in the script text,
// and scrubbed from captured logs before they are persisted.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database, Json } from "@/integrations/supabase/types";
import { loadStorageConfig } from "@/utils/catalog/crawler.server";
import {
  previewRequirementsFor,
  compilePreview,
  nativeWarehouseTarget,
  dbFamily,
  envKey,
  normalizeGraph,
  type EtlNode,
} from "@/utils/etl/codegen";
import { loadWarehouseConnectionForUser } from "@/utils/warehouse/connections.server";
import type { WarehouseConfig } from "@/utils/warehouse/types";
import { auditEvent } from "@/utils/audit.server";
import { notifyUser } from "@/utils/notify.server";
import { startSession, stopSession, getSession } from "@/utils/notebookRuntime/service.server";
import { resolveSecretRefs } from "@/utils/secrets.server";

export type EtlPipelineRow = Database["public"]["Tables"]["etl_pipelines"]["Row"];
export type EtlRunRow = Database["public"]["Tables"]["etl_runs"]["Row"];

/** Same shape the MCP builder accepts: KEY={{secret:NAME}} lines only. */
const SECRET_BINDING_RE = /^([A-Za-z_][A-Za-z0-9_]*)=(\{\{\s*secret:[A-Za-z][A-Za-z0-9_]*\s*\}\})$/;

const MAX_CONCURRENT_RUNS_PER_USER = 3;
const LOG_CAP = 200_000;

// ── Environment resolution ──────────────────────────────────────────────────

/**
 * SQLAlchemy URL for a wire-family connection, for use INSIDE the sandbox.
 *
 * Only the three families a plain URL can express are supported; everything
 * else (IAM-auth Redshift, token-only Snowflake, BigQuery service accounts,
 * Databricks, Trino, Athena, Oracle, ClickHouse) refuses here with a message
 * that names the alternative, rather than failing inside a container after a
 * cold start.
 */
/**
 * The dlt-native credential payload for a warehouse target, shaped per
 * destination. Everything sensitive is listed in `secrets` so the log
 * scrubber erases it.
 */
export function nativeDestCreds(cfg: WarehouseConfig): {
  credentials: Record<string, unknown>;
  kwargs: Record<string, unknown>;
  secrets: string[];
} {
  if (cfg.provider === "snowflake") {
    return {
      // Programmatic access token over the OAuth authenticator — the same
      // token the catalog/BI connection stores; no separate password needed.
      credentials: {
        host: cfg.account,
        database: cfg.database,
        warehouse: cfg.warehouse,
        ...(cfg.role ? { role: cfg.role } : {}),
        authenticator: "oauth",
        token: cfg.token,
      },
      kwargs: {},
      secrets: [cfg.token],
    };
  }
  if (cfg.provider === "bigquery") {
    const sa = JSON.parse(cfg.service_account_json) as Record<string, unknown>;
    return {
      credentials: sa,
      kwargs: cfg.location ? { location: cfg.location } : {},
      secrets: [String(sa.private_key ?? "")].filter(Boolean),
    };
  }
  if (cfg.provider === "databricks") {
    return {
      credentials: {
        server_hostname: cfg.host.replace(/^https?:\/\//, ""),
        http_path: `/sql/1.0/warehouses/${cfg.warehouse_id}`,
        access_token: cfg.token,
        catalog: cfg.catalog ?? "hive_metastore",
      },
      kwargs: {},
      secrets: [cfg.token],
    };
  }
  throw new Error(`No native pipeline destination for provider "${cfg.provider}"`);
}

export function sqlalchemyUrlFor(cfg: WarehouseConfig): string {
  const fam = dbFamily(cfg.provider);
  if (!fam) {
    throw new Error(
      `Connections to ${cfg.provider} are not supported in pipelines this release. ` +
        `Supported: PostgreSQL, MySQL and SQL Server families. Stage through object storage instead.`,
    );
  }
  const c = cfg as unknown as {
    host: string;
    port?: string;
    database: string;
    username: string;
    password: string;
    ssl?: string;
  };
  const scheme =
    fam === "postgres"
      ? "postgresql+psycopg2"
      : fam === "mysql"
        ? "mysql+pymysql"
        : "mssql+pymssql";
  const defaultPort = fam === "postgres" ? 5432 : fam === "mysql" ? 3306 : 1433;
  const port = c.port?.trim() || String(defaultPort);
  const user = encodeURIComponent(c.username);
  const pass = encodeURIComponent(c.password);
  const sslQs = fam === "postgres" && c.ssl === "require" ? "?sslmode=require" : "";
  return `${scheme}://${user}:${pass}@${c.host}:${port}/${c.database}${sslQs}`;
}

/**
 * The env a run's sandbox receives, resolved fresh at fetch time (not at run
 * creation) so a rotated secret is picked up without editing the pipeline.
 * Returns the values alongside so the log scrubber knows what to erase.
 *
 * Per-node names: a visual graph's node n3 reads ETL_N3_* (envKey). Code-mode
 * pipelines keep the documented ETL_DEST_* contract from the pipeline-level
 * destination. Both paths resolve through the SAME connection stores the rest
 * of the product uses — catalog storage sources and warehouse connections —
 * so IAM-granted connections work here exactly as they do in BI.
 */
export async function resolveRunEnv(
  pipeline: EtlPipelineRow,
  opts?: { skipTargets?: boolean },
): Promise<{ env: Record<string, string>; secretValues: string[] }> {
  const env: Record<string, string> = {};
  const secretValues: string[] = [];

  const storageEnv = async (catalogSourceId: string, stem: string, shape: "source" | "target") => {
    const { data: src } = await supabaseAdmin
      .from("catalog_sources")
      .select("id, name, kind, credentials")
      .eq("id", catalogSourceId)
      .eq("user_id", pipeline.user_id)
      .maybeSingle();
    if (!src) throw new Error(`Catalog source ${catalogSourceId} not found for this user`);
    if (src.kind !== "object_storage") {
      throw new Error(`Catalog source "${src.name}" is not an object-storage source`);
    }
    const cfg = await loadStorageConfig(pipeline.user_id, src);
    const keyPrefix = (cfg.prefix ?? "").replace(/^\/+|\/+$/g, "");
    const scoped = `${cfg.bucket}${keyPrefix ? `/${keyPrefix}` : ""}`;
    // Targets take a bucket URL (what the loader wants); sources take the
    // bucket/prefix path (what globbing wants). Both stay scoped to the
    // source's configured prefix so a pipeline cannot reach outside the area
    // the operator pointed at.
    if (shape === "target") env[`${stem}_BUCKET_URL`] = `s3://${scoped}`;
    else env[`${stem}_BUCKET`] = scoped;
    if (cfg.endpoint) env[`${stem}_ENDPOINT_URL`] = cfg.endpoint;
    env[`${stem}_ACCESS_KEY_ID`] = cfg.access_key_id;
    env[`${stem}_SECRET_ACCESS_KEY`] = cfg.secret_access_key;
    secretValues.push(cfg.secret_access_key);
  };

  const databaseEnv = async (connectionId: string, stem: string, isTarget: boolean) => {
    const conn = await loadWarehouseConnectionForUser(
      supabaseAdmin,
      { connectionId },
      pipeline.user_id,
    );
    const native = isTarget ? nativeWarehouseTarget(conn.config.provider) : null;
    if (native) {
      const payload = nativeDestCreds(conn.config);
      env[`${stem}_DEST_CREDS`] = JSON.stringify(payload);
      for (const v of payload.secrets) secretValues.push(v);
      return;
    }
    const url = sqlalchemyUrlFor(conn.config);
    env[`${stem}_URL`] = url;
    secretValues.push(url);
  };

  // Visual graphs: every node that names a connection resolves under its own
  // env stem. A storage target with no explicit source falls back to the
  // pipeline-level destination, so the common one-bucket case needs choosing
  // it exactly once (in Settings).
  const graph = normalizeGraph(pipeline.graph);
  for (const node of graph?.nodes ?? []) {
    const c = (node as EtlNode).config as {
      type?: string;
      catalog_source_id?: string;
      connection_id?: string;
    };
    const stem = envKey(node.id);
    if (opts?.skipTargets && node.kind === "target") continue;
    if (c.type === "object_storage") {
      const sourceId =
        c.catalog_source_id ??
        (node.kind === "target" ? (pipeline.dest_catalog_source_id ?? undefined) : undefined);
      if (!sourceId) {
        throw new Error(
          `Node "${(node as EtlNode).label || node.id}" has no bucket selected (and no pipeline destination to fall back to)`,
        );
      }
      await storageEnv(sourceId, stem, node.kind === "target" ? "target" : "source");
    }
    if (c.type === "database") {
      if (!c.connection_id) {
        throw new Error(`Node "${(node as EtlNode).label || node.id}" has no connection selected`);
      }
      await databaseEnv(c.connection_id, stem, node.kind === "target");
    }
  }

  // Engine-managed incremental cursors: a source node marked incremental
  // reads its last high-water mark from ETL_<NODE>_CURSOR; the generated code
  // reports the new maximum in metrics.watermarks and finalizeEtlRun persists
  // it. Server-held state, so a pipeline cannot skip data by mis-editing a
  // bucket object — and an operator can inspect it in etl_pipeline_state.
  const incrementalNodes = (graph?.nodes ?? []).filter(
    (n) =>
      ((n as EtlNode).config as { incremental?: { cursor_column?: string } }).incremental
        ?.cursor_column,
  );
  if (incrementalNodes.length) {
    const { data: state } = await supabaseAdmin
      .from("etl_pipeline_state")
      .select("node_id, cursor_value")
      .eq("pipeline_id", pipeline.id);
    const cursors = new Map((state ?? []).map((r) => [r.node_id, r.cursor_value]));
    for (const node of incrementalNodes) {
      const value = cursors.get(node.id);
      if (value) env[`${envKey(node.id)}_CURSOR`] = value;
    }
  }

  // Schema-drift policies read last run's shape from ETL_<NODE>_SCHEMA; the
  // generated code reports the new shape in metrics.schemas and finalizeEtlRun
  // persists it under 'schema:<node>' rows in etl_pipeline_state.
  const driftNodes = (opts?.skipTargets ? [] : (graph?.nodes ?? [])).filter((n) => {
    const p = ((n as EtlNode).config as { schema_policy?: string }).schema_policy;
    return p === "warn" || p === "strict";
  });
  if (driftNodes.length) {
    const { data: state } = await supabaseAdmin
      .from("etl_pipeline_state")
      .select("node_id, cursor_value")
      .eq("pipeline_id", pipeline.id)
      .like("node_id", "schema:%");
    const schemas = new Map((state ?? []).map((r) => [r.node_id, r.cursor_value]));
    for (const node of driftNodes) {
      const value = schemas.get(`schema:${node.id}`);
      if (value) env[`${envKey(node.id)}_SCHEMA`] = value;
    }
  }

  // Code-mode contract (and a convenience for AI-generated scripts): the
  // pipeline-level destination is always exposed as ETL_DEST_*.
  if (pipeline.dest_catalog_source_id) {
    await storageEnv(pipeline.dest_catalog_source_id, "ETL_DEST", "target");
  }

  // User bindings: KEY={{secret:NAME}} lines, resolved as the owner. A binding
  // that fails to resolve is dropped, not fatal — the run proceeds and the
  // code that needed it reports a missing variable (the MCP rule, for the same
  // diagnosability reason).
  for (const line of (pipeline.secret_refs ?? "").split("\n")) {
    const m = line.trim().match(SECRET_BINDING_RE);
    if (!m) continue;
    try {
      const value = await resolveSecretRefs(pipeline.user_id, m[2]);
      if (value && value !== m[2]) {
        env[m[1]] = value;
        secretValues.push(value);
      }
    } catch {
      /* dropped */
    }
  }

  return { env, secretValues };
}

/** Replace every secret value with *** before logs are persisted or shown. */
export function scrubSecrets(text: string, secretValues: string[]): string {
  let out = text;
  for (const v of secretValues) {
    if (v && v.length >= 4) out = out.split(v).join("***");
  }
  return out;
}

// ── Bundle served to the sandbox ────────────────────────────────────────────

/**
 * Prelude prepended to every run's script. Fetches the resolved env over HTTP
 * (so secrets never appear in code), then pip-installs the pipeline's
 * requirements. Underscore-prefixed names keep the user's namespace clean.
 */
export function etlPrelude(): string {
  return [
    `import json as _j, os as _os, subprocess as _sp, sys as _sys`,
    `import httpx as _hx`,
    `_r = _hx.post(`,
    `    _os.environ['AGENTSWARMS_ORIGIN'].rstrip('/') + '/api/notebook/runtime/source',`,
    `    json={'part': 'etl_env'},`,
    `    headers={'Authorization': 'Bearer ' + _os.environ.get('AGENTSWARMS_TOKEN', '')},`,
    `    timeout=60,`,
    `)`,
    `_r.raise_for_status()`,
    `_bundle = _r.json()`,
    `_os.environ.update({k: str(v) for k, v in (_bundle.get('env') or {}).items()})`,
    `_reqs = [r for r in (_bundle.get('requirements') or []) if r.strip()]`,
    `if _reqs:`,
    `    print('[etl] installing ' + str(len(_reqs)) + ' package(s)')`,
    `    _sp.run(`,
    `        [_sys.executable, '-m', 'pip', 'install', '--user', '--no-input', '-q', *_reqs],`,
    `        check=True,`,
    `    )`,
    `    # The sandbox mounts an EMPTY tmpfs at ~/.local, so the user site dir`,
    `    # did not exist when this interpreter started and is NOT on sys.path --`,
    `    # pip just created it, so add it now or every install is invisible.`,
    `    import site as _site`,
    `    _site.addsitedir(_site.getusersitepackages())`,
    `    import importlib as _il`,
    `    _il.invalidate_caches()`,
    ``,
    ``,
  ].join("\n");
}

/** The code bundle for an ETL batch session (source route, default part). */
export async function etlBundleFor(
  etlRunId: string,
  userId: string,
): Promise<{ code: string } | { error: string }> {
  const { data: run } = await supabaseAdmin
    .from("etl_runs")
    .select("id, source_code, user_id")
    .eq("id", etlRunId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!run) return { error: "ETL run not found for this session" };
  return { code: etlPrelude() + run.source_code };
}

/** A preview session's stash inside notebook_runtime_sessions.inputs. */
export type EtlPreviewStash = { pipeline_id: string; node_id: string };

export function etlPreviewStashOf(inputs: unknown): EtlPreviewStash | null {
  const raw = (inputs as { __etl_preview?: unknown } | null)?.__etl_preview;
  if (!raw || typeof raw !== "object") return null;
  const p = raw as { pipeline_id?: unknown; node_id?: unknown };
  return typeof p.pipeline_id === "string" && typeof p.node_id === "string"
    ? { pipeline_id: p.pipeline_id, node_id: p.node_id }
    : null;
}

/** Preview bundle: freshly compiled sampled script for one node. */
export async function etlPreviewBundleFor(
  stash: EtlPreviewStash,
  userId: string,
): Promise<{ code: string } | { error: string }> {
  const { data: pipeline } = await supabaseAdmin
    .from("etl_pipelines")
    .select("*")
    .eq("id", stash.pipeline_id)
    .eq("user_id", userId)
    .maybeSingle();
  if (!pipeline) return { error: "Pipeline not found for this session" };
  const graph = normalizeGraph(pipeline.graph);
  if (!graph) return { error: "This pipeline has no visual graph to preview" };
  try {
    return { code: etlPrelude() + compilePreview(graph, stash.node_id) };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/** Preview env: source credentials only — no destinations, no drift baselines. */
export async function etlPreviewEnvFor(
  stash: EtlPreviewStash,
  userId: string,
): Promise<{ env: Record<string, string>; requirements: string[] } | { error: string }> {
  const { data: pipeline } = await supabaseAdmin
    .from("etl_pipelines")
    .select("*")
    .eq("id", stash.pipeline_id)
    .eq("user_id", userId)
    .maybeSingle();
  if (!pipeline) return { error: "Pipeline not found for this session" };
  const graph = normalizeGraph(pipeline.graph);
  if (!graph) return { error: "This pipeline has no visual graph to preview" };
  const { env } = await resolveRunEnv(pipeline, { skipTargets: true });
  const requirements = previewRequirementsFor(graph)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return { env, requirements };
}

/** Row ceiling for datasets served into a pipeline — beyond it, truncate loudly. */
const ETL_DATASET_MAX_ROWS = 200_000;

/**
 * The "etl_dataset" part: rows of one platform dataset the session's OWNER
 * holds, paged out of the row store. Grantee masking never applies because
 * only the owner's own tables resolve — the query is scoped to the token's
 * subject, exactly like every other part.
 */
export async function etlDatasetFor(
  tableId: string,
  userId: string,
): Promise<{ rows: Record<string, unknown>[]; truncated: boolean } | { error: string }> {
  const { data: table } = await supabaseAdmin
    .from("user_data_tables")
    .select("id")
    .eq("id", tableId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!table) return { error: "Dataset not found for this session" };
  const PAGE = 1000;
  const rows: Record<string, unknown>[] = [];
  let truncated = false;
  for (let start = 0; ; start += PAGE) {
    const { data: chunk, error } = await supabaseAdmin
      .from("user_data_rows")
      .select("row")
      .eq("table_id", tableId)
      .order("id", { ascending: true })
      .range(start, start + PAGE - 1);
    if (error) return { error: error.message };
    if (!chunk?.length) break;
    rows.push(...chunk.map((c) => c.row as Record<string, unknown>));
    if (chunk.length < PAGE) break;
    if (rows.length >= ETL_DATASET_MAX_ROWS) {
      truncated = true;
      break;
    }
  }
  return { rows, truncated };
}

/** The "etl_env" part: resolved env + requirements list. */
export async function etlEnvFor(
  etlRunId: string,
  userId: string,
): Promise<{ env: Record<string, string>; requirements: string[] } | { error: string }> {
  const { data: run } = await supabaseAdmin
    .from("etl_runs")
    .select("id, pipeline_id, user_id")
    .eq("id", etlRunId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!run) return { error: "ETL run not found for this session" };
  const { data: pipeline } = await supabaseAdmin
    .from("etl_pipelines")
    .select("*")
    .eq("id", run.pipeline_id)
    .maybeSingle();
  if (!pipeline) return { error: "Pipeline no longer exists" };
  const { env } = await resolveRunEnv(pipeline);
  const requirements = (pipeline.requirements ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  return { env, requirements };
}

// ── Run lifecycle ───────────────────────────────────────────────────────────

export async function startEtlRun(
  pipeline: EtlPipelineRow,
  trigger: "manual" | "schedule" | "trigger" | "chain",
  params?: Record<string, unknown>,
): Promise<{ ok: true; runId: string } | { ok: false; error: string }> {
  if (!pipeline.source_code.trim()) {
    return { ok: false, error: "Pipeline has no code to run" };
  }
  // Resolve the env now to fail fast on a missing destination — a run that
  // dies inside the sandbox on a config error costs a cold start to discover.
  try {
    await resolveRunEnv(pipeline);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }

  // Overlap policy. Append targets double-load under overlapping runs, so the
  // default refuses a second start while one is queued, running, or waiting
  // out a retry backoff — from ANY trigger, not just the schedule.
  if (!pipeline.allow_concurrent) {
    const { count: overlapping } = await supabaseAdmin
      .from("etl_runs")
      .select("id", { count: "exact", head: true })
      .eq("pipeline_id", pipeline.id)
      .in("status", ["queued", "running", "retrying"]);
    if ((overlapping ?? 0) > 0) {
      return {
        ok: false,
        error:
          "A run of this pipeline is already in progress. Enable “Allow concurrent runs” in Settings to permit overlap.",
      };
    }
  }

  const { count } = await supabaseAdmin
    .from("etl_runs")
    .select("id", { count: "exact", head: true })
    .eq("user_id", pipeline.user_id)
    .in("status", ["queued", "running"]);
  if ((count ?? 0) >= MAX_CONCURRENT_RUNS_PER_USER) {
    return {
      ok: false,
      error: `Concurrent run limit reached (${MAX_CONCURRENT_RUNS_PER_USER}). Wait for a running pipeline to finish.`,
    };
  }

  // Per-run params override pipeline defaults key-by-key; the merged object is
  // pinned on the run row (forensics) and handed to entrypoint(inputs).
  const mergedParams = {
    ...((pipeline.default_params as Record<string, unknown> | null) ?? {}),
    ...(params ?? {}),
  };

  const { data: run, error: insErr } = await supabaseAdmin
    .from("etl_runs")
    .insert({
      pipeline_id: pipeline.id,
      user_id: pipeline.user_id,
      status: "queued",
      trigger,
      source_code: pipeline.source_code,
      params: (Object.keys(mergedParams).length ? mergedParams : null) as Json,
      retries_remaining: pipeline.retry_count ?? 0,
      attempt: 1,
    })
    .select("*")
    .single();
  if (insErr || !run) return { ok: false, error: insErr?.message ?? "Failed to create run" };

  auditEvent({
    userId: pipeline.user_id,
    action: "etl.run.start",
    resourceType: "etl_pipeline",
    resourceId: pipeline.id,
    resourceName: pipeline.name,
    detail: {
      trigger,
      run_id: run.id,
      ...(Object.keys(mergedParams).length ? { params: mergedParams } : {}),
    },
  });

  const launched = await launchAttempt(run.id, pipeline, mergedParams, 1);
  return launched.ok ? { ok: true, runId: run.id } : launched;
}

/**
 * Start (or restart) the sandbox for one attempt of a run. A start failure —
 * runtime down, concurrency cap — flows through the same retry ladder as an
 * in-sandbox failure, because "the runtime was briefly unavailable" is
 * precisely the transient failure retries exist for.
 */
async function launchAttempt(
  runId: string,
  pipeline: EtlPipelineRow,
  params: Record<string, unknown>,
  attempt: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  // Record the attempt BEFORE trying to launch: a failed launch must count
  // against the ladder (and grow the backoff), which it silently did not when
  // the attempt number was only written on the success path.
  await supabaseAdmin.from("etl_runs").update({ attempt }).eq("id", runId);
  try {
    const { session } = await startSession({
      userId: pipeline.user_id,
      kind: "batch",
      etlRunId: runId,
      entrypoint: "entrypoint",
      inputs: params,
    });
    await supabaseAdmin
      .from("etl_runs")
      .update({
        status: "running",
        session_id: session.id,
        started_at: new Date().toISOString(),
      })
      .eq("id", runId);
    return { ok: true };
  } catch (e) {
    const message = (e as Error).message;
    await failOrRetry(runId, pipeline, `Attempt ${attempt} could not start: ${message}`);
    return { ok: false, error: message };
  }
}

/** Backoff: 60s, 2m, 4m, 8m, 16m. */
function backoffMs(attempt: number): number {
  return 60_000 * 2 ** Math.max(0, attempt - 1);
}

/**
 * A failed attempt either schedules the next one or finalises the run as
 * failed. The single place both failure paths (start failure, sandbox error)
 * converge, so the Runs tab and audit trail cannot disagree about what
 * happened.
 */
async function failOrRetry(
  runId: string,
  pipeline: EtlPipelineRow,
  errorMessage: string,
  extraLogs = "",
): Promise<void> {
  const { data: run } = await supabaseAdmin
    .from("etl_runs")
    .select("id, attempt, retries_remaining, logs, status")
    .eq("id", runId)
    .maybeSingle();
  if (!run || run.status === "cancelled") return;

  const stamp = new Date().toISOString();
  const attemptHeader = `\n\n===== attempt ${run.attempt} failed at ${stamp} =====\n${errorMessage}\n`;
  const logs = `${run.logs ?? ""}${extraLogs}${attemptHeader}`.slice(-LOG_CAP);

  if ((run.retries_remaining ?? 0) > 0) {
    const retryAt = new Date(Date.now() + backoffMs(run.attempt)).toISOString();
    await supabaseAdmin
      .from("etl_runs")
      .update({
        status: "retrying",
        retries_remaining: run.retries_remaining - 1,
        retry_at: retryAt,
        error: errorMessage.slice(0, 4000),
        logs,
      })
      .eq("id", runId);
    auditEvent({
      userId: pipeline.user_id,
      action: "etl.run.retry_scheduled",
      resourceType: "etl_pipeline",
      resourceId: pipeline.id,
      resourceName: pipeline.name,
      detail: { run_id: runId, attempt: run.attempt, retry_at: retryAt },
    });
    return;
  }

  await supabaseAdmin
    .from("etl_runs")
    .update({
      status: "failed",
      error: errorMessage.slice(0, 4000),
      logs,
      finished_at: stamp,
    })
    .eq("id", runId);
  await supabaseAdmin
    .from("etl_pipelines")
    .update({ last_run_at: stamp, last_run_status: "failed" })
    .eq("id", pipeline.id);
  auditEvent({
    userId: pipeline.user_id,
    action: "etl.run.failed",
    resourceType: "etl_pipeline",
    resourceId: pipeline.id,
    resourceName: pipeline.name,
    detail: { run_id: runId, attempts: run.attempt, error: errorMessage.slice(0, 500) },
  });
  void notifyUser(pipeline.user_id, {
    title: `Pipeline "${pipeline.name}" failed`,
    body: `${errorMessage.slice(0, 450)} (after ${run.attempt} attempt${run.attempt > 1 ? "s" : ""})`,
    link: "/etl",
  }).catch(() => {});
}

/**
 * Live log streaming: the batch runner posts its captured stdout periodically
 * while an ETL run executes; this replaces the running attempt's log tail so
 * the Logs dialog can follow along. Values that scrub at finalisation are
 * scrubbed here too — a secret must not be visible for twenty minutes and
 * redacted afterwards.
 */
export async function appendPartialLogs(etlRunId: string, logs: string): Promise<void> {
  const { data: run } = await supabaseAdmin
    .from("etl_runs")
    .select("id, pipeline_id, status")
    .eq("id", etlRunId)
    .maybeSingle();
  if (!run || run.status !== "running") return;
  const { data: pipeline } = await supabaseAdmin
    .from("etl_pipelines")
    .select("*")
    .eq("id", run.pipeline_id)
    .maybeSingle();
  let secretValues: string[] = [];
  if (pipeline) {
    try {
      secretValues = (await resolveRunEnv(pipeline)).secretValues;
    } catch {
      /* scrub what we can */
    }
  }
  await supabaseAdmin
    .from("etl_runs")
    .update({ logs: scrubSecrets(logs.slice(-LOG_CAP), secretValues) })
    .eq("id", etlRunId)
    .eq("status", "running");
}

/**
 * Finalise runs whose sandbox ended without a result callback — a crashed
 * container, a missed POST, or an app restart mid-run. Without this a run can
 * sit "running" forever while its session row plainly says error, which is
 * the one lie an observability surface must never tell. Success results are
 * recovered from the session row (the batch runner stores them there too);
 * anything else goes through the ordinary retry ladder.
 */
export async function reconcileOrphanedEtlRuns(): Promise<number> {
  const graceAgo = new Date(Date.now() - 2 * 60_000).toISOString();
  const { data: liveRuns } = await supabaseAdmin
    .from("etl_runs")
    .select("id, pipeline_id, session_id, status, created_at")
    .in("status", ["queued", "running"])
    .lt("created_at", graceAgo)
    .limit(20);
  let reconciled = 0;
  for (const run of liveRuns ?? []) {
    let outcome: { status: string; result?: unknown; logs?: string; error?: string | null } | null =
      null;
    if (run.session_id) {
      const { data: session } = await supabaseAdmin
        .from("notebook_runtime_sessions")
        .select("status, result, logs, error")
        .eq("id", run.session_id)
        .maybeSingle();
      if (!session) {
        outcome = { status: "error", error: "The run's sandbox session no longer exists." };
      } else if (session.status === "succeeded") {
        outcome = {
          status: "succeeded",
          result: session.result ?? undefined,
          logs: session.logs ?? "",
        };
      } else if (["error", "stopped"].includes(session.status)) {
        outcome = {
          status: "error",
          logs: session.logs ?? "",
          error: session.error ?? "The sandbox ended without reporting a result.",
        };
      } // starting/running/ready -> genuinely still going; leave it alone.
    } else if (run.status === "queued") {
      outcome = { status: "error", error: "The run never acquired a sandbox session." };
    }
    if (outcome) {
      await finalizeEtlRun(run.id, outcome);
      reconciled++;
    }
  }
  return reconciled;
}

/** The retry sweep's entry: begin the next attempt of a retrying run. */
export async function restartEtlAttempt(runId: string): Promise<boolean> {
  const { data: run } = await supabaseAdmin
    .from("etl_runs")
    .select("id, pipeline_id, attempt, params, status")
    .eq("id", runId)
    .eq("status", "retrying")
    .maybeSingle();
  if (!run) return false;
  const { data: pipeline } = await supabaseAdmin
    .from("etl_pipelines")
    .select("*")
    .eq("id", run.pipeline_id)
    .maybeSingle();
  if (!pipeline) return false;
  const launched = await launchAttempt(
    run.id,
    pipeline,
    (run.params as Record<string, unknown> | null) ?? {},
    run.attempt + 1,
  );
  return launched.ok;
}

/**
 * Called from the batch result callback when the finished session belongs to
 * an ETL run. Persists outcome (logs scrubbed), updates the pipeline's
 * last-run summary, kicks a catalog crawl of the destination, and notifies on
 * failure — a scheduled pipeline that fails silently at 3am is the exact
 * failure mode the runs table exists to prevent.
 */
export async function finalizeEtlRun(
  etlRunId: string,
  body: { status: string; result?: unknown; logs?: string; error?: string | null },
): Promise<void> {
  const { data: run } = await supabaseAdmin
    .from("etl_runs")
    .select("id, pipeline_id, user_id, status, logs")
    .eq("id", etlRunId)
    .maybeSingle();
  if (!run || run.status === "cancelled") return;

  const { data: pipeline } = await supabaseAdmin
    .from("etl_pipelines")
    .select("*")
    .eq("id", run.pipeline_id)
    .maybeSingle();

  let secretValues: string[] = [];
  if (pipeline) {
    try {
      secretValues = (await resolveRunEnv(pipeline)).secretValues;
    } catch {
      /* pipeline config changed mid-run; scrub what we can */
    }
  }

  const ok = body.status !== "error";
  const attemptLogs = scrubSecrets((body.logs ?? "").slice(0, LOG_CAP), secretValues);
  const error = body.error ? scrubSecrets(body.error, secretValues).slice(0, 4000) : null;
  const metrics = body.result && typeof body.result === "object" ? (body.result as Json) : null;
  const now = new Date().toISOString();

  // A sandbox failure goes through the same retry ladder as a start failure;
  // notifyUser fires only when the ladder is exhausted (inside failOrRetry).
  if (!ok) {
    if (pipeline) {
      await failOrRetry(
        etlRunId,
        pipeline,
        error ?? "The run ended with an error.",
        attemptLogs ? `\n${attemptLogs}` : "",
      );
    }
    return;
  }

  // Success. Attempt logs append to any prior attempts' logs so the whole
  // story of a retried run reads top to bottom in one place.
  const priorLogs = (run as { logs?: string | null }).logs ?? "";
  const logs = `${priorLogs}${priorLogs ? "\n" : ""}${attemptLogs}`.slice(-LOG_CAP);
  await supabaseAdmin
    .from("etl_runs")
    .update({ status: "succeeded", logs, error: null, metrics, finished_at: now })
    .eq("id", etlRunId);

  if (pipeline) {
    await supabaseAdmin
      .from("etl_pipelines")
      .update({ last_run_at: now, last_run_status: "succeeded" })
      .eq("id", pipeline.id);

    auditEvent({
      userId: run.user_id,
      action: "etl.run.succeeded",
      resourceType: "etl_pipeline",
      resourceId: pipeline.id,
      resourceName: pipeline.name,
      detail: { run_id: etlRunId, metrics: metrics ?? undefined },
    });

    // Engine-managed incremental: the generated code reports the maximum
    // cursor it loaded per node under metrics.watermarks; persisting AFTER a
    // durable load is what makes a crash-between-the-two safe (rows re-read,
    // never skipped).
    const watermarks = (metrics as { watermarks?: Record<string, unknown> } | null)?.watermarks;
    if (watermarks && typeof watermarks === "object") {
      for (const [nodeId, value] of Object.entries(watermarks)) {
        if (value === null || value === undefined) continue;
        await supabaseAdmin.from("etl_pipeline_state").upsert(
          {
            pipeline_id: pipeline.id,
            node_id: nodeId.slice(0, 64),
            user_id: pipeline.user_id,
            cursor_value: String(value).slice(0, 512),
            updated_at: now,
          },
          { onConflict: "pipeline_id,node_id" },
        );
      }
    }

    // Target schemas persist like watermarks: AFTER the durable load, keyed
    // 'schema:<node>' so cursors and shapes share the state table cleanly.
    const schemas = (metrics as { schemas?: Record<string, unknown> } | null)?.schemas;
    if (schemas && typeof schemas === "object") {
      for (const [nodeId, value] of Object.entries(schemas)) {
        if (!value || typeof value !== "object") continue;
        await supabaseAdmin.from("etl_pipeline_state").upsert(
          {
            pipeline_id: pipeline.id,
            node_id: `schema:${nodeId}`.slice(0, 64),
            user_id: pipeline.user_id,
            cursor_value: JSON.stringify(value),
            updated_at: now,
          },
          { onConflict: "pipeline_id,node_id" },
        );
      }
    }

    if (pipeline.dest_catalog_source_id) {
      // Fire-and-forget: the load is already durable; a crawl failure should
      // show up on the catalog source, not fail a succeeded run.
      void crawlDestination(pipeline).catch((e) =>
        console.warn("[etl] post-run crawl failed:", (e as Error).message),
      );

      // Catalog lineage: each source descriptor feeds each produced asset.
      // Scoped to source_system 'etl' so crawler-derived lineage (Databricks
      // system tables) and pipeline-derived lineage coexist per source.
      const targets = ((metrics as { targets?: { fqn?: string }[] } | null)?.targets ?? [])
        .map((t) => t.fqn)
        .filter((f): f is string => Boolean(f));
      const sources = [
        ...new Set(
          ((metrics as { lineage_sources?: unknown[] } | null)?.lineage_sources ?? []).map(String),
        ),
      ];
      if (targets.length) {
        // Wholesale replace of THIS pipeline's edges: targets can be renamed
        // between runs, so a delete keyed on the new fqns would strand the old.
        await supabaseAdmin
          .from("catalog_lineage")
          .delete()
          .eq("pipeline_id", pipeline.id)
          .eq("source_system", "etl");
        const edges = (sources.length ? sources : [`etl:${pipeline.name}`]).flatMap((up) =>
          targets.map((down) => ({
            user_id: pipeline.user_id,
            source_id: pipeline.dest_catalog_source_id as string,
            pipeline_id: pipeline.id,
            upstream_fqn: up.slice(0, 512),
            downstream_fqn: down,
            source_system: "etl",
          })),
        );
        await supabaseAdmin.from("catalog_lineage").insert(edges);
      }
    }

    // Chaining: pipelines configured to run after this one. Their own overlap
    // guards apply, and cycles are refused at save time, so a completion can
    // start at most the direct children.
    const { data: children } = await supabaseAdmin
      .from("etl_pipelines")
      .select("*")
      .eq("run_after", pipeline.id)
      .eq("is_active", true);
    for (const child of (children ?? []) as EtlPipelineRow[]) {
      const res = await startEtlRun(child, "chain");
      if (!res.ok) {
        console.warn(`[etl-chain] "${child.name}" did not start: ${res.error}`);
      }
    }
  }
}

/** Re-crawl the destination so what this run loaded appears as catalog assets. */
async function crawlDestination(pipeline: EtlPipelineRow): Promise<void> {
  const { runCrawl } = await import("@/utils/catalog/crawler.server");
  const { loadWarehouseConnectionForUser } = await import("@/utils/warehouse/connections.server");
  const { data: src } = await supabaseAdmin
    .from("catalog_sources")
    .select("*")
    .eq("id", pipeline.dest_catalog_source_id as string)
    .maybeSingle();
  if (!src) return;
  await runCrawl(
    pipeline.user_id,
    src,
    async (connectionId) =>
      (await loadWarehouseConnectionForUser(supabaseAdmin, { connectionId }, pipeline.user_id))
        .config,
    (s) => loadStorageConfig(pipeline.user_id, s),
  );
}

/** Cancel a queued/running run and tear its sandbox down. */
export async function cancelEtlRun(runId: string, userId: string): Promise<boolean> {
  const { data: run } = await supabaseAdmin
    .from("etl_runs")
    .select("id, user_id, status, session_id")
    .eq("id", runId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!run || !["queued", "running", "retrying"].includes(run.status)) return false;
  await supabaseAdmin
    .from("etl_runs")
    .update({ status: "cancelled", finished_at: new Date().toISOString() })
    .eq("id", runId);
  if (run.session_id) {
    const session = await getSession(userId, run.session_id);
    if (session) await stopSession(session).catch(() => {});
  }
  return true;
}
