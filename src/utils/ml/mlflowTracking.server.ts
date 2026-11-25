// ML models tracked on an MLflow server (R534).
//
// A model linked to one of its owner's MLflow connections sends each ready
// version there: a run in the model's experiment with the version's
// parameters, metrics and provenance tags, the version's model folder (the
// same one the MLflow export downloads) as the run's `model` artifact, and a
// version of a registered model whose alias follows production here.
//
// From the app server, never from a sandbox: the token stays out of model
// code, and no egress allow-list is needed. Nothing here can fail a training
// run or a promotion: a sync that does not finish records why on the version,
// keeps the run it made for the retry, and is audited.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { auditEvent } from "@/utils/audit.server";
import { MLFLOW_TASKS } from "@/lib/mlflowTasks";
import {
  parseModelTracking,
  parseVersionTracking,
  type ModelTracking,
  type VersionTracking,
} from "@/lib/mlflowTracking";
import type { Json } from "@/integrations/supabase/types";
import type { MlModelRow, MlVersionRow } from "./access.server";
import {
  MlflowError,
  mlflowBase,
  mlflowCall,
  mlflowUpload,
  proxiedArtifactPath,
  safeId,
  type MlflowConnection,
} from "./mlflowClient.server";

export type SyncOutcome =
  | { ok: true; tracking: VersionTracking }
  | { ok: false; skipped: string }
  | { ok: false; error: string; tracking: VersionTracking };

type Trigger = "trained" | "promoted" | "manual" | "linked";

/** At most this many versions are sent by one "send all". */
export const BACKFILL_MAX = 50;

// ── Names MLflow takes ──────────────────────────────────────────────────────

/** A param, metric or tag key as MLflow accepts it. */
export function mlflowKey(k: string): string {
  return (
    k
      .replace(/[^A-Za-z0-9_.\- /]+/g, "_")
      .replace(/\.{2,}/g, ".")
      .replace(/^\/+/, "")
      .slice(0, 250) || "_"
  );
}

const value = (v: unknown) => String(v ?? "").slice(0, 500);

type Param = { key: string; value: string };
type Metric = { key: string; value: number; timestamp: number; step: number };

/** What a version says about how it was made, as MLflow params (immutable once logged). */
export function runParams(model: MlModelRow, version: MlVersionRow): Param[] {
  const cfg = (version.config ?? {}) as Record<string, unknown>;
  const imp = cfg.import as { flavor?: string } | undefined;
  const schema = (Array.isArray(version.feature_schema) ? version.feature_schema : []) as {
    name?: string;
    role?: string;
  }[];
  const features = schema.filter((f) => f.role === "feature").map((f) => String(f.name ?? ""));
  const source = (model.source ?? {}) as { schema?: string; table?: string };
  const out: [string, unknown][] = [
    ["task", model.task],
    ["algorithm", version.algorithm],
    ["target_column", model.target_column],
    [
      "source_table",
      source.table ? `${source.schema ? `${source.schema}.` : ""}${source.table}` : null,
    ],
    ["feature_count", features.length],
    ["features", features.join(", ")],
    ["training_rows", imp ? null : version.training_rows],
    ["training_sampled", imp ? null : version.training_sampled],
    ["time_budget_minutes", imp ? null : cfg.time_budget_minutes],
    ["tuning", imp ? null : cfg.tuning],
    ["validation_fraction", imp ? null : cfg.validation_fraction],
    ["imported_from", imp ? `MLflow (${imp.flavor ?? "unknown"})` : null],
  ];
  return out
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => ({ key: mlflowKey(k), value: value(v) }));
}

/** The version's scalar metrics, as MLflow metrics at its training time. */
export function runMetrics(version: MlVersionRow, at: number): Metric[] {
  const m = (version.metrics ?? {}) as Record<string, unknown>;
  return Object.entries(m)
    .filter(([, v]) => typeof v === "number" && Number.isFinite(v))
    .slice(0, 200)
    .map(([k, v]) => ({ key: mlflowKey(k), value: v as number, timestamp: at, step: 0 }));
}

/** Provenance and the current decision line, as tags (tags may change; params may not). */
export function runTags(model: MlModelRow, version: MlVersionRow): Param[] {
  const tags: [string, unknown][] = [
    ["mlflow.source.name", "AgentSwarms"],
    ["mlflow.source.type", "JOB"],
    // Never the person's email: the server is theirs, but the field is shown
    // to everyone who can read the experiment.
    ["mlflow.user", "agentswarms"],
    ["agentswarms.model_id", model.id],
    ["agentswarms.model_name", model.name],
    ["agentswarms.version", version.version],
    ["agentswarms.version_id", version.id],
    ["agentswarms.artifact_sha256", version.artifact_sha256],
    ["agentswarms.lake_snapshot", version.training_snapshot_id],
    ["agentswarms.decision_threshold", version.decision_threshold],
    ["agentswarms.positive_label", version.positive_label],
  ];
  return tags
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => ({ key: k, value: value(v) }));
}

// ── Loading ─────────────────────────────────────────────────────────────────

type Context = {
  model: MlModelRow;
  version: MlVersionRow;
  link: ModelTracking;
  conn: MlflowConnection;
  prior: VersionTracking | null;
};

type Loaded =
  | { ok: true; ctx: Context }
  | { ok: false; skipped: string }
  | { ok: false; fail: string; model: MlModelRow; version: MlVersionRow };

/**
 * The model's MLflow connection, by the model OWNER's id. The link on the
 * model is owner-writable, so an id in it proves nothing by itself: a row
 * that is not the owner's, or not an MLflow connection, is not found.
 */
/** One of this person's own MLflow connections, resolved: the import from a server uses it (R535). */
export function mlflowConnectionOf(
  userId: string,
  integrationId: string,
): Promise<{ ok: true; conn: MlflowConnection } | { ok: false; error: string }> {
  return connectionFor({ user_id: userId }, { integration_id: integrationId } as ModelTracking);
}

async function connectionFor(
  model: Pick<MlModelRow, "user_id">,
  link: Pick<ModelTracking, "integration_id">,
): Promise<{ ok: true; conn: MlflowConnection } | { ok: false; error: string }> {
  const { data: row, error } = await supabaseAdmin
    .from("integrations")
    .select("id, config, is_active")
    .eq("id", link.integration_id)
    .eq("user_id", model.user_id)
    .eq("type", "mlflow")
    .maybeSingle();
  if (error) return { ok: false, error: `Could not read the MLflow connection: ${error.message}` };
  if (!row) {
    return {
      ok: false,
      error:
        "The MLflow connection this model is tracked with was removed. Choose another on the Versions tab.",
    };
  }
  if (!row.is_active)
    return { ok: false, error: "The MLflow connection this model uses is turned off." };
  const { resolveIntegrationConfig } = await import("@/utils/providers/integrationConfig.server");
  const { integrationHosts } = await import("@/utils/providers/integrationHosts");
  const cfg = (await resolveIntegrationConfig(
    model.user_id,
    "mlflow",
    (row.config ?? {}) as Record<string, unknown>,
    {
      sendTo: integrationHosts("mlflow"),
    },
  )) as Record<string, unknown>;
  const s = (k: string) => (typeof cfg[k] === "string" ? (cfg[k] as string) : "");
  if (!mlflowBase(s("tracking_uri"))) {
    return { ok: false, error: "The MLflow connection has no usable tracking URL." };
  }
  return {
    ok: true,
    conn: {
      tracking_uri: s("tracking_uri"),
      auth: s("auth") || undefined,
      username: s("username"),
      token: s("token"),
      password: s("password"),
    },
  };
}

async function load(versionId: string): Promise<Loaded> {
  const { data: version } = await supabaseAdmin
    .from("ml_model_versions")
    .select("*")
    .eq("id", versionId)
    .maybeSingle();
  if (!version) return { ok: false, skipped: "version not found" };
  const { data: model } = await supabaseAdmin
    .from("ml_models")
    .select("*")
    .eq("id", version.model_id)
    .maybeSingle();
  if (!model) return { ok: false, skipped: "model not found" };
  const link = parseModelTracking(model.tracking);
  if (!link || !link.enabled) return { ok: false, skipped: "not tracked" };
  if (!(MLFLOW_TASKS as readonly string[]).includes(model.task)) {
    return { ok: false, skipped: `a ${model.task} model is not sent to MLflow` };
  }
  if (version.status !== "ready") return { ok: false, skipped: "version not ready" };
  const c = await connectionFor(model, link);
  if (!c.ok) return { ok: false, fail: c.error, model, version };
  return {
    ok: true,
    ctx: { model, version, link, conn: c.conn, prior: parseVersionTracking(version.tracking) },
  };
}

// ── The sync ────────────────────────────────────────────────────────────────

async function ensureExperiment(
  conn: MlflowConnection,
  name: string,
  again = true,
): Promise<string> {
  try {
    const r = await mlflowCall<{
      experiment?: { experiment_id?: string; lifecycle_stage?: string };
    }>(
      conn,
      "GET",
      `/api/2.0/mlflow/experiments/get-by-name?experiment_name=${encodeURIComponent(name)}`,
    );
    if (r.experiment?.lifecycle_stage === "deleted") {
      throw new MlflowError(
        `The experiment "${name}" is in MLflow's trash. Restore it there, or track this model under another experiment.`,
      );
    }
    return safeId(r.experiment?.experiment_id, "experiment id");
  } catch (e) {
    if (!(e instanceof MlflowError) || e.code !== "RESOURCE_DOES_NOT_EXIST") throw e;
  }
  try {
    const r = await mlflowCall<{ experiment_id?: string }>(
      conn,
      "POST",
      "/api/2.0/mlflow/experiments/create",
      { name },
    );
    return safeId(r.experiment_id, "experiment id");
  } catch (e) {
    // Created by someone else between the two calls.
    if (again && e instanceof MlflowError && e.code === "RESOURCE_ALREADY_EXISTS") {
      return ensureExperiment(conn, name, false);
    }
    throw e;
  }
}

type RunInfo = {
  run_id?: string;
  artifact_uri?: string;
  lifecycle_stage?: string;
  experiment_id?: string;
};

async function existingRun(
  conn: MlflowConnection,
  runId: string,
  experimentId: string,
): Promise<RunInfo | null> {
  try {
    const r = await mlflowCall<{ run?: { info?: RunInfo } }>(
      conn,
      "GET",
      `/api/2.0/mlflow/runs/get?run_id=${encodeURIComponent(runId)}`,
    );
    const info = r.run?.info;
    if (!info || info.lifecycle_stage !== "active" || String(info.experiment_id) !== experimentId)
      return null;
    return info;
  } catch (e) {
    if (e instanceof MlflowError && (e.status === 404 || e.code === "RESOURCE_DOES_NOT_EXIST"))
      return null;
    throw e;
  }
}

async function ensureRegisteredVersion(
  conn: MlflowConnection,
  name: string,
  source: string,
  runId: string,
  ctx: Context,
): Promise<string> {
  const prior = ctx.prior;
  if (prior?.registered_version && prior.registered_model === name && prior.run_id === runId) {
    try {
      await mlflowCall(
        conn,
        "GET",
        `/api/2.0/mlflow/model-versions/get?name=${encodeURIComponent(name)}&version=${encodeURIComponent(prior.registered_version)}`,
      );
      return prior.registered_version;
    } catch (e) {
      if (!(e instanceof MlflowError) || (e.status !== 404 && e.code !== "RESOURCE_DOES_NOT_EXIST"))
        throw e;
    }
  }
  try {
    await mlflowCall(conn, "POST", "/api/2.0/mlflow/registered-models/create", {
      name,
      description: `Versions of "${ctx.model.name}", sent from AgentSwarms.`,
    });
  } catch (e) {
    if (!(e instanceof MlflowError) || e.code !== "RESOURCE_ALREADY_EXISTS") throw e;
  }
  const r = await mlflowCall<{ model_version?: { version?: string } }>(
    conn,
    "POST",
    "/api/2.0/mlflow/model-versions/create",
    {
      name,
      source,
      run_id: runId,
      description: `${ctx.model.name}, version ${ctx.version.version} in AgentSwarms.`,
      tags: [
        { key: "agentswarms.version", value: String(ctx.version.version) },
        { key: "agentswarms.version_id", value: ctx.version.id },
      ],
    },
  );
  const v = String(r.model_version?.version ?? "");
  if (!/^\d{1,9}$/.test(v))
    throw new MlflowError("The MLflow server returned an unexpected model version.");
  return v;
}

async function writeTracking(versionId: string, t: VersionTracking): Promise<void> {
  const { error } = await supabaseAdmin
    .from("ml_model_versions")
    .update({ tracking: t as unknown as Json })
    .eq("id", versionId);
  if (error)
    console.warn(`[ml-mlflow] version ${versionId}: could not record the sync: ${error.message}`);
}

async function runSync(ctx: Context, trigger: Trigger): Promise<SyncOutcome> {
  const { model, version, link, conn } = ctx;
  const server = mlflowBase(conn.tracking_uri) ?? "";
  const prior = ctx.prior?.server === server ? ctx.prior : null;
  const t: VersionTracking = { server };
  try {
    const experimentId = await ensureExperiment(conn, link.experiment);
    t.experiment_id = experimentId;
    const at = Date.parse(version.trained_at ?? version.created_at) || Date.now();

    let info = prior?.run_id ? await existingRun(conn, prior.run_id, experimentId) : null;
    const reused = Boolean(info);
    if (!info) {
      const r = await mlflowCall<{ run?: { info?: RunInfo } }>(
        conn,
        "POST",
        "/api/2.0/mlflow/runs/create",
        {
          experiment_id: experimentId,
          run_name: `v${version.version}`,
          start_time: at,
          tags: runTags(model, version),
        },
      );
      info = r.run?.info ?? null;
    }
    const runId = safeId(info?.run_id, "run id");
    t.run_id = runId;

    // Params never change once logged, so a reused run that has them is not
    // sent them again; tags (the decision line among them) are.
    const logged = reused && prior?.logged === true;
    await mlflowCall(conn, "POST", "/api/2.0/mlflow/runs/log-batch", {
      run_id: runId,
      params: logged ? [] : runParams(model, version),
      metrics: logged ? [] : runMetrics(version, at),
      tags: runTags(model, version),
    });
    t.logged = true;

    const artifactPath = proxiedArtifactPath(info?.artifact_uri);
    if (artifactPath) {
      if (!(reused && prior?.artifacts)) {
        const { buildMlflowFolder } = await import("./mlflow.server");
        const built = await buildMlflowFolder(model, version);
        if (!built.ok) throw new MlflowError(built.error);
        for (const [file, bytes] of Object.entries(built.files)) {
          await mlflowUpload(conn, artifactPath, `model/${file}`, bytes);
        }
      }
      t.artifacts = true;
    } else {
      t.note =
        "This MLflow server keeps artifacts in a store the app does not write to, so the run has the version's parameters and metrics but not its model, and it was not registered. Export the version to log its model yourself.";
    }

    await mlflowCall(conn, "POST", "/api/2.0/mlflow/runs/update", {
      run_id: runId,
      status: "FINISHED",
      end_time: Math.max(at, Date.now()),
    });

    if (t.artifacts && typeof info?.artifact_uri === "string") {
      t.registered_model = link.registered_model;
      t.registered_version = await ensureRegisteredVersion(
        conn,
        link.registered_model,
        `${info.artifact_uri.replace(/\/+$/, "")}/model`,
        runId,
        ctx,
      );
    }
    t.synced_at = new Date().toISOString();
    await writeTracking(version.id, t);
    auditEvent({
      userId: model.user_id,
      action: "ml.mlflow.synced",
      resourceType: "ml_model",
      resourceId: model.id,
      resourceName: model.name,
      decisionId: version.id,
      detail: {
        trigger,
        version: version.version,
        server,
        experiment_id: t.experiment_id,
        run_id: t.run_id,
        artifacts: Boolean(t.artifacts),
        registered_model: t.registered_model ?? null,
        registered_version: t.registered_version ?? null,
      },
    });
    // The alias follows production: set it now if THIS version is production
    // (read again: a promotion may have landed while it was sending). Another
    // version's alias is not this sync's business.
    const { data: now } = await supabaseAdmin
      .from("ml_models")
      .select("production_version_id")
      .eq("id", model.id)
      .maybeSingle();
    if (now?.production_version_id === version.id) {
      await moveMlflowAlias(model.id, { from: version.id }).catch((e) =>
        console.warn(`[ml-mlflow] alias for model ${model.id}: ${(e as Error).message}`),
      );
    }
    return { ok: true, tracking: t };
  } catch (e) {
    const message =
      e instanceof MlflowError ? e.message : `The sync stopped: ${(e as Error).message}`;
    const failed: VersionTracking = {
      // What it had before stays (a link to an earlier good run is still true),
      // with this run, when one was made, kept for the retry.
      ...(prior ?? {}),
      ...t,
      logged: t.logged ?? prior?.logged,
      error: message.slice(0, 500),
      failed_at: new Date().toISOString(),
    };
    await writeTracking(version.id, failed);
    auditEvent({
      userId: model.user_id,
      action: "ml.mlflow.sync_failed",
      resourceType: "ml_model",
      resourceId: model.id,
      resourceName: model.name,
      decisionId: version.id,
      detail: { trigger, version: version.version, server, error: message.slice(0, 300) },
    });
    return { ok: false, error: message, tracking: failed };
  }
}

const inflight = new Map<string, Promise<SyncOutcome>>();

/**
 * Send one version to its model's MLflow server. A sync already running for
 * the version is joined, not started twice (a promotion right after training
 * would otherwise make a second run).
 */
export function syncVersionToMlflow(versionId: string, trigger: Trigger): Promise<SyncOutcome> {
  const running = inflight.get(versionId);
  if (running) return running;
  const p = (async (): Promise<SyncOutcome> => {
    const loaded = await load(versionId);
    if (!loaded.ok) {
      if ("skipped" in loaded) return { ok: false, skipped: loaded.skipped };
      const failed: VersionTracking = {
        ...(parseVersionTracking(loaded.version.tracking) ?? {}),
        error: loaded.fail,
        failed_at: new Date().toISOString(),
      };
      await writeTracking(loaded.version.id, failed);
      auditEvent({
        userId: loaded.model.user_id,
        action: "ml.mlflow.sync_failed",
        resourceType: "ml_model",
        resourceId: loaded.model.id,
        resourceName: loaded.model.name,
        decisionId: loaded.version.id,
        detail: { trigger, version: loaded.version.version, error: loaded.fail },
      });
      return { ok: false, error: loaded.fail, tracking: failed };
    }
    return runSync(loaded.ctx, trigger);
  })().finally(() => inflight.delete(versionId));
  inflight.set(versionId, p);
  return p;
}

/** After a training or import job: send the new version if its model is tracked. */
export function afterVersionReady(versionId: string): void {
  void syncVersionToMlflow(versionId, "trained").catch((e) =>
    console.warn(`[ml-mlflow] version ${versionId}: ${(e as Error).message}`),
  );
}

/**
 * Point the model's alias at its production version's registered version, or
 * take it away when production has none (so the alias never names a version
 * that is no longer production here). Waits for a sync of the production
 * version already running; syncs it first when it was never sent.
 */
export async function moveMlflowAlias(
  modelId: string,
  opts: { from?: string } = {},
): Promise<
  | { ok: true; alias: string; version: string | null }
  | { ok: false; skipped: string }
  | { ok: false; error: string }
> {
  const { data: model } = await supabaseAdmin
    .from("ml_models")
    .select("*")
    .eq("id", modelId)
    .maybeSingle();
  if (!model) return { ok: false, skipped: "model not found" };
  const link = parseModelTracking(model.tracking);
  if (!link || !link.enabled) return { ok: false, skipped: "not tracked" };

  // FOUND BEFORE THE UI TEST. A move that failed (the server down during a
  // promotion) was only logged: MLflow kept the alias on the old version and
  // nothing here said so. Where the alias points, or why it could not be
  // moved, is now on the model's link, which the Versions tab shows.
  const record = async (patch: Record<string, unknown>) => {
    // Read again: the link may have been changed or removed meanwhile, and
    // this must neither bring an old one back nor overwrite a new one.
    const { data: fresh } = await supabaseAdmin
      .from("ml_models")
      .select("tracking")
      .eq("id", model.id)
      .maybeSingle();
    const cur = parseModelTracking(fresh?.tracking);
    if (
      !cur ||
      cur.integration_id !== link.integration_id ||
      cur.registered_model !== link.registered_model ||
      cur.alias !== link.alias
    ) {
      return;
    }
    const next: Record<string, unknown> = {
      ...(fresh!.tracking as Record<string, unknown>),
      ...patch,
    };
    for (const [k, v] of Object.entries(patch)) if (v === undefined) delete next[k];
    await supabaseAdmin
      .from("ml_models")
      .update({ tracking: next as unknown as Json })
      .eq("id", model.id);
  };
  const fail = async (error: string) => {
    await record({ alias_error: error.slice(0, 500), alias_failed_at: new Date().toISOString() });
    auditEvent({
      userId: model.user_id,
      action: "ml.mlflow.alias_failed",
      resourceType: "ml_model",
      resourceId: model.id,
      resourceName: model.name,
      decisionId: model.production_version_id ?? undefined,
      detail: {
        registered_model: link.registered_model,
        alias: link.alias,
        error: error.slice(0, 300),
      },
    });
    return { ok: false as const, error };
  };

  const prodId = model.production_version_id;
  if (prodId && prodId !== opts.from) {
    const pending = inflight.get(prodId);
    if (pending) await pending.catch(() => null);
  }
  let target: VersionTracking | null = null;
  if (prodId) {
    const { data: prod } = await supabaseAdmin
      .from("ml_model_versions")
      .select("id, version, status, tracking")
      .eq("id", prodId)
      .maybeSingle();
    target = parseVersionTracking(prod?.tracking);
    if (prod && prod.status === "ready" && !target?.synced_at && prodId !== opts.from) {
      // Never sent: sending it moves the alias at its end.
      const out = await syncVersionToMlflow(prodId, "promoted");
      if (out.ok)
        return { ok: true, alias: link.alias, version: out.tracking.registered_version ?? null };
      if ("skipped" in out) return { ok: false, skipped: out.skipped };
      return fail(
        `v${prod.version} could not be sent, so the alias was not moved to it: ${out.error}`,
      );
    }
  }
  const c = await connectionFor(model, link);
  if (!c.ok) return fail(c.error);
  const registered =
    target?.registered_version && target.registered_model === link.registered_model
      ? target.registered_version
      : null;
  try {
    if (registered) {
      await mlflowCall(c.conn, "POST", "/api/2.0/mlflow/registered-models/alias", {
        name: link.registered_model,
        alias: link.alias,
        version: registered,
      });
    } else {
      try {
        await mlflowCall(c.conn, "DELETE", "/api/2.0/mlflow/registered-models/alias", {
          name: link.registered_model,
          alias: link.alias,
        });
      } catch (e) {
        if (
          !(e instanceof MlflowError) ||
          (e.status !== 404 && e.code !== "RESOURCE_DOES_NOT_EXIST")
        )
          throw e;
      }
    }
  } catch (e) {
    return fail(
      e instanceof MlflowError ? e.message : `The alias was not moved: ${(e as Error).message}`,
    );
  }
  await record({ alias_version: registered, alias_error: undefined, alias_failed_at: undefined });
  auditEvent({
    userId: model.user_id,
    action: "ml.mlflow.alias",
    resourceType: "ml_model",
    resourceId: model.id,
    resourceName: model.name,
    decisionId: prodId ?? undefined,
    detail: {
      registered_model: link.registered_model,
      alias: link.alias,
      registered_version: registered,
      removed: !registered,
    },
  });
  return { ok: true, alias: link.alias, version: registered };
}

/** After any promotion: move the alias, in the background. */
export function afterPromotion(modelId: string): void {
  void moveMlflowAlias(modelId).catch((e) =>
    console.warn(`[ml-mlflow] alias for model ${modelId}: ${(e as Error).message}`),
  );
}

/**
 * Send every ready version not yet sent (or whose last sync failed), oldest
 * first, one at a time; at most BACKFILL_MAX.
 */
export async function syncModelToMlflow(
  modelId: string,
  trigger: Trigger,
): Promise<{ sent: number; failed: number; left: number }> {
  const { data: versions } = await supabaseAdmin
    .from("ml_model_versions")
    .select("id, tracking")
    .eq("model_id", modelId)
    .eq("status", "ready")
    .order("version", { ascending: true });
  const todo = (versions ?? []).filter((v) => {
    const t = parseVersionTracking(v.tracking);
    return !t?.synced_at || Boolean(t.error);
  });
  let sent = 0;
  let failed = 0;
  for (const v of todo.slice(0, BACKFILL_MAX)) {
    const out = await syncVersionToMlflow(v.id, trigger);
    if (out.ok) sent++;
    else if ("error" in out) failed++;
  }
  return { sent, failed, left: Math.max(0, todo.length - BACKFILL_MAX) };
}
