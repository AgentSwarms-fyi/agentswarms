// The Data science pages that look across models (R538): Model serving and
// ML operations. Each reads only the models the caller may open (owned or
// granted, the model page's own check), and returns rows the model page
// already shows one model at a time; nothing here is new data, only a view
// over many models at once.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { callerFailure } from "@/utils/callerLookup.server";
import { listModelsForUser, type MlModelRow } from "@/utils/ml/access.server";
import { ML_JOB_LIVE } from "@/utils/ml/types";
import {
  attentionItems,
  type AttentionItem,
  type EndpointView,
  type JobLite,
  type PredictionLite,
  type ScheduleLite,
} from "@/lib/mlConsole";

async function resolveCaller(accessToken: string): Promise<string> {
  const { data, error } = await supabaseAdmin.auth.getUser(accessToken);
  if (error || !data?.user) throw new Error(callerFailure(error, "Not signed in"));
  return data.user.id;
}

const TOKEN = z.object({ access_token: z.string().min(1) });
const DAY = 86_400_000;

/** Version id → its number, and whether it is an import, for the ids given. */
async function versionNumbers(
  ids: string[],
): Promise<Map<string, { version: number; import: boolean }>> {
  const out = new Map<string, { version: number; import: boolean }>();
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return out;
  const { data } = await supabaseAdmin
    .from("ml_model_versions")
    .select("id, version, config")
    .in("id", unique);
  for (const v of data ?? []) {
    const imp = (v.config as { import?: unknown } | null)?.import;
    out.set(v.id, { version: v.version, import: Boolean(imp && typeof imp === "object") });
  }
  return out;
}

/** Every warm endpoint of these models, as the serving page lists them. */
async function endpointsFor(
  models: Array<MlModelRow & { shared: boolean }>,
): Promise<EndpointView[]> {
  if (!models.length) return [];
  const byId = new Map(models.map((m) => [m.id, m]));
  const { data: deps } = await supabaseAdmin
    .from("ml_deployments")
    .select(
      "id, model_id, status, version_id, keep_warm, min_replicas, max_replicas, request_count, last_used_at, last_error, candidate_mode, candidate_version_id, candidate_percent, canary_rolled_back_at, canary_rollback_reason",
    )
    .in(
      "model_id",
      models.map((m) => m.id),
    );
  if (!deps?.length) return [];
  const [{ data: reps }, versions] = await Promise.all([
    supabaseAdmin
      .from("ml_deployment_replicas")
      .select("deployment_id, status, role, isvc_name, isvc_namespace")
      .in(
        "deployment_id",
        deps.map((d) => d.id),
      )
      .in("status", ["starting", "ready"]),
    versionNumbers([
      ...deps.map((d) => d.version_id ?? ""),
      ...deps.map((d) => d.candidate_version_id ?? ""),
      ...models.map((m) => m.production_version_id ?? ""),
    ]),
  ]);
  return deps.flatMap((d) => {
    const m = byId.get(d.model_id);
    if (!m) return [];
    const mine = (reps ?? []).filter((r) => r.deployment_id === d.id && r.role !== "candidate");
    const isvc = mine.find((r) => r.isvc_name && r.isvc_namespace);
    const view: EndpointView = {
      model: {
        id: m.id,
        name: m.name,
        task: m.task,
        shared: m.shared,
        production_version: m.production_version_id
          ? (versions.get(m.production_version_id)?.version ?? null)
          : null,
      },
      deployment_id: d.id,
      status: d.status as EndpointView["status"],
      version: d.version_id ? (versions.get(d.version_id)?.version ?? null) : null,
      stale: Boolean(m.production_version_id && d.version_id !== m.production_version_id),
      keep_warm: d.keep_warm,
      min_replicas: d.min_replicas,
      max_replicas: d.max_replicas,
      request_count: d.request_count ?? 0,
      last_used_at: d.last_used_at,
      last_error: d.last_error,
      candidate: {
        mode: (d.candidate_mode ?? "off") as EndpointView["candidate"]["mode"],
        version: d.candidate_version_id
          ? (versions.get(d.candidate_version_id)?.version ?? null)
          : null,
        percent: d.candidate_percent,
      },
      rollback: d.canary_rolled_back_at
        ? { at: d.canary_rolled_back_at, reason: d.canary_rollback_reason }
        : null,
      copies: {
        ready: mine.filter((r) => r.status === "ready").length,
        starting: mine.filter((r) => r.status === "starting").length,
      },
      runs_on: isvc
        ? { kind: "kserve", namespace: isvc.isvc_namespace!, name: isvc.isvc_name! }
        : { kind: "sandboxes" },
    };
    return [view];
  });
}

export type MlServingOverview = {
  endpoints: EndpointView[];
  /** Production versions with no endpoint: they answer batch and API calls cold. */
  undeployed: { id: string; name: string; production_version: number | null }[];
  serving_backend: "sandboxes" | "kserve";
};

export const mlServingOverview = createServerFn({ method: "POST" })
  .validator((input: unknown) => TOKEN.parse(input))
  .handler(async ({ data }): Promise<MlServingOverview> => {
    const userId = await resolveCaller(data.access_token);
    const models = await listModelsForUser(userId);
    const endpoints = await endpointsFor(models);
    // Any endpoint, stopped ones included: a stopped endpoint is listed as
    // stopped, and listing it again here said the same model twice (R538 UI
    // test). This list is the production versions never deployed.
    const served = new Set(endpoints.map((e) => e.model.id));
    const prodVersions = await versionNumbers(
      models.map((m) => m.production_version_id ?? "").filter(Boolean),
    );
    return {
      endpoints,
      undeployed: models
        .filter((m) => m.production_version_id && !served.has(m.id))
        .map((m) => ({
          id: m.id,
          name: m.name,
          production_version: prodVersions.get(m.production_version_id!)?.version ?? null,
        })),
      serving_backend: process.env.ML_SERVING_BACKEND === "kserve" ? "kserve" : "sandboxes",
    };
  });

export type MlOpsJob = JobLite & {
  model_name: string;
  /** Live jobs only: why it has not started yet, when the runtime says. */
  waiting: string | null;
  shards: number | null;
  phase: string | null;
};

export type MlOpsPrediction = PredictionLite & { model_name: string; version: number | null };

export type MlOperationsOverview = {
  attention: AttentionItem[];
  running: MlOpsJob[];
  predicting: MlOpsPrediction[];
  /** ML pipeline runs in progress (R540). */
  pipelineRunning: (MlPipelineRun & { name: string })[];
  upcoming: (ScheduleLite & { model_name: string })[];
  recent: (
    | ({ type: "job" } & MlOpsJob)
    | ({ type: "prediction" } & MlOpsPrediction)
    | ({ type: "pipeline" } & MlPipelineRun & { name: string; created_at: string })
  )[];
  compute: {
    backend: string;
    training_gpus: number;
    search_workers: number;
    trainings_per_person: number;
    time_budget_minutes: number;
  };
  models: number;
  pipelines: number;
};

export const mlOperationsOverview = createServerFn({ method: "POST" })
  .validator((input: unknown) => TOKEN.parse(input))
  .handler(async ({ data }): Promise<MlOperationsOverview> => {
    const userId = await resolveCaller(data.access_token);
    const models = await listModelsForUser(userId);
    const { getPlatformResources, getRuntimeSettings } =
      await import("@/utils/notebookRuntime/config.server");
    const [limits, runtime] = await Promise.all([getPlatformResources(), getRuntimeSettings()]);
    const compute = {
      backend: runtime.backend,
      training_gpus: limits.mlTrainGpus,
      search_workers: limits.mlTrainWorkers,
      trainings_per_person: limits.mlMaxConcurrentTrainingsPerUser,
      time_budget_minutes: limits.mlTrainTimeBudgetMinutes,
    };
    // ML pipelines (R540): their runs sit beside the jobs they start.
    const pipe = await pipelinesFor(userId);
    const pipeName = new Map(pipe.pipelines.map((p) => [p.id, p.name]));
    const pipeRuns = pipe.runs.map((r) => ({
      ...r,
      name: pipeName.get(r.workflow_id) ?? "Pipeline",
    }));
    const pipelineRunning = pipeRuns.filter((r) => r.state === "running");
    const pipelineRecent = pipeRuns
      .filter((r) => r.state !== "running")
      .slice(0, 15)
      .map((r) => ({ type: "pipeline" as const, ...r, created_at: r.started_at ?? "" }));
    const sinceRun = Date.now() - 7 * DAY;
    const failedPipelineRuns = pipeRuns.filter(
      (r) =>
        r.state === "failed" && new Date(r.finished_at ?? r.started_at ?? 0).getTime() >= sinceRun,
    );
    const empty: MlOperationsOverview = {
      attention: attentionItems({
        names: new Map(),
        failedJobs: [],
        failedPredictions: [],
        failedPipelineRuns,
        endpoints: [],
        schedules: [],
        health: new Map(),
      }),
      running: [],
      predicting: [],
      pipelineRunning,
      upcoming: [],
      recent: pipelineRecent,
      compute,
      models: 0,
      pipelines: pipe.pipelines.length,
    };
    if (!models.length) return empty;
    const ids = models.map((m) => m.id);
    const names = new Map(models.map((m) => [m.id, m.name]));
    const since = new Date(Date.now() - 7 * DAY).toISOString();
    const JOB =
      "id, model_id, version_id, status, trigger, error, created_at, started_at, finished_at, phase, shards";
    const PRED =
      "id, model_id, version_id, status, error, drift_score, row_count, created_at, finished_at";
    const [live, failed, recentJobs, livePreds, failedPreds, recentPreds, schedules, endpoints] =
      await Promise.all([
        supabaseAdmin
          .from("ml_training_jobs")
          .select(`${JOB}, logs`)
          .in("model_id", ids)
          .in("status", [...ML_JOB_LIVE])
          .order("created_at", { ascending: false })
          .limit(20),
        supabaseAdmin
          .from("ml_training_jobs")
          .select(JOB)
          .in("model_id", ids)
          .eq("status", "failed")
          .gte("created_at", since)
          .order("created_at", { ascending: false })
          .limit(20),
        supabaseAdmin
          .from("ml_training_jobs")
          .select(JOB)
          .in("model_id", ids)
          .in("status", ["succeeded", "failed", "cancelled"])
          .order("created_at", { ascending: false })
          .limit(15),
        supabaseAdmin
          .from("ml_predictions")
          .select(PRED)
          .in("model_id", ids)
          .eq("kind", "batch")
          .in("status", ["queued", "running"])
          .order("created_at", { ascending: false })
          .limit(20),
        supabaseAdmin
          .from("ml_predictions")
          .select(PRED)
          .in("model_id", ids)
          .eq("kind", "batch")
          .eq("status", "failed")
          .gte("created_at", since)
          .order("created_at", { ascending: false })
          .limit(20),
        supabaseAdmin
          .from("ml_predictions")
          .select(PRED)
          .in("model_id", ids)
          .eq("kind", "batch")
          .in("status", ["succeeded", "failed", "cancelled"])
          .order("created_at", { ascending: false })
          .limit(15),
        supabaseAdmin
          .from("ml_schedules")
          .select(
            "id, model_id, name, kind, is_active, next_run_at, last_run_at, last_status, last_error",
          )
          .in("model_id", ids)
          .order("next_run_at", { ascending: true, nullsFirst: false })
          .limit(50),
        endpointsFor(models),
      ]);
    const { modelHealthFor } = await import("@/utils/ml/health.server");
    const health = await modelHealthFor(models);
    const versions = await versionNumbers([
      ...(live.data ?? []).map((j) => j.version_id),
      ...(failed.data ?? []).map((j) => j.version_id),
      ...(recentJobs.data ?? []).map((j) => j.version_id),
      ...(livePreds.data ?? []).map((p) => p.version_id),
      ...(recentPreds.data ?? []).map((p) => p.version_id),
    ]);
    const { errorLead, waitingReason } = await import("@/lib/mlConsole");
    const job = (j: {
      id: string;
      model_id: string;
      version_id: string;
      status: string;
      trigger: string | null;
      error: string | null;
      created_at: string;
      started_at: string | null;
      finished_at: string | null;
      phase: string | null;
      shards: number | null;
      logs?: string | null;
    }): MlOpsJob => ({
      id: j.id,
      model_id: j.model_id,
      model_name: names.get(j.model_id) ?? "A model",
      version: versions.get(j.version_id)?.version ?? null,
      import: versions.get(j.version_id)?.import ?? false,
      status: j.status,
      trigger: j.trigger,
      error: j.error ? errorLead(j.error, 1000) : null,
      created_at: j.created_at,
      started_at: j.started_at,
      finished_at: j.finished_at,
      waiting: j.logs !== undefined ? waitingReason(j.logs) : null,
      shards: j.shards,
      phase: j.phase,
    });
    const pred = (p: {
      id: string;
      model_id: string;
      version_id: string;
      status: string;
      error: string | null;
      drift_score: number | null;
      row_count: number | null;
      created_at: string;
      finished_at: string | null;
    }): MlOpsPrediction => ({
      id: p.id,
      model_id: p.model_id,
      model_name: names.get(p.model_id) ?? "A model",
      version: versions.get(p.version_id)?.version ?? null,
      status: p.status,
      error: p.error ? errorLead(p.error, 1000) : null,
      drift_score: p.drift_score,
      row_count: p.row_count,
      created_at: p.created_at,
      finished_at: p.finished_at,
    });
    const healthAlerts = new Map<string, string[]>();
    for (const [id, h] of health) if (h.alerts.length) healthAlerts.set(id, h.alerts);
    const sched = (schedules.data ?? []).map((s) => ({
      ...(s as ScheduleLite),
      model_name: names.get(s.model_id) ?? "A model",
    }));
    const recent = [
      ...(recentJobs.data ?? []).map((j) => ({ type: "job" as const, ...job(j) })),
      ...(recentPreds.data ?? []).map((p) => ({ type: "prediction" as const, ...pred(p) })),
      ...pipelineRecent,
    ]
      .sort(
        (a, b) =>
          new Date(b.finished_at ?? b.created_at).getTime() -
          new Date(a.finished_at ?? a.created_at).getTime(),
      )
      .slice(0, 15);
    return {
      attention: attentionItems({
        names,
        failedJobs: (failed.data ?? []).map(job),
        failedPredictions: (failedPreds.data ?? []).map(pred),
        failedPipelineRuns,
        endpoints,
        schedules: sched,
        health: healthAlerts,
      }).slice(0, 30),
      running: (live.data ?? []).map(job),
      predicting: (livePreds.data ?? []).map(pred),
      pipelineRunning,
      upcoming: sched.filter((s) => s.is_active),
      recent,
      compute,
      models: models.length,
      pipelines: pipe.pipelines.length,
    };
  });

// ── ML pipelines (R540) ──────────────────────────────────────────────────────

export type MlPipelineRun = {
  id: string;
  workflow_id: string;
  state: string;
  trigger: string | null;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
};

export type MlPipelineView = {
  id: string;
  name: string;
  description: string | null;
  schedule: string;
  cron_expr: string | null;
  is_active: boolean;
  next_run_at: string | null;
  steps: string[];
  /** The models its ML schedule steps train or score, by name. */
  models: string[];
  /** The Kubeflow pipelines it runs, by name. */
  kubeflow: string[];
  last: MlPipelineRun | null;
  /** A CI job or another system can start it (a trigger token exists). */
  has_trigger_token: boolean;
  /** Which models' alerts start it, in words (R544); null when none do. */
  alert: string | null;
};

export type MlPipelinesOverview = {
  pipelines: MlPipelineView[];
  recent: (MlPipelineRun & { name: string })[];
  kubeflowConnections: number;
};

/** The caller's own workflows that do model work, with their last runs. */
async function pipelinesFor(userId: string): Promise<{
  pipelines: MlPipelineView[];
  runs: MlPipelineRun[];
}> {
  const { isMlPipeline, pipelineSteps, kubeflowPipelinesIn, mlSchedulesIn, mlModelsIn } =
    await import("@/lib/mlPipelines");
  const { alertTriggerOf, alertTriggerLine } = await import("@/lib/workflowAlerts");
  // Every column, so the alert trigger (R544) is read where the database has
  // it and simply absent where migration 20261206000000 is not applied yet.
  const { data: rows } = await supabaseAdmin
    .from("workflows")
    .select("*")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(200);
  const alertOf = (w: Record<string, unknown>) => alertTriggerOf(w.alert_trigger);
  // A workflow that answers a model's alert is model work too, whatever its steps.
  const ml = (rows ?? []).filter(
    (w) =>
      isMlPipeline(w.graph as unknown as import("@/lib/workflows").WorkflowGraph) ||
      alertOf(w as Record<string, unknown>) !== null,
  );
  if (!ml.length) return { pipelines: [], runs: [] };
  const graphs = new Map(
    ml.map((w) => [w.id, w.graph as unknown as import("@/lib/workflows").WorkflowGraph]),
  );
  const scheduleIds = [...new Set(ml.flatMap((w) => mlSchedulesIn(graphs.get(w.id)!)))].filter(
    (id) => /^[0-9a-f-]{36}$/i.test(id),
  );
  const [{ data: runs }, { data: schedules }] = await Promise.all([
    supabaseAdmin
      .from("workflow_runs")
      .select("id, workflow_id, state, trigger, error, started_at, finished_at")
      .eq("user_id", userId)
      .in(
        "workflow_id",
        ml.map((w) => w.id),
      )
      .order("started_at", { ascending: false })
      .limit(60),
    scheduleIds.length
      ? supabaseAdmin
          .from("ml_schedules")
          .select("id, model_id")
          .eq("user_id", userId)
          .in("id", scheduleIds)
      : Promise.resolve({ data: [] as { id: string; model_id: string }[] }),
  ]);
  // The models the schedules train, and those a Promote or Deploy step names
  // directly (R542); owner-scoped, like every other read here.
  const modelIds = [
    ...new Set([
      ...(schedules ?? []).map((s) => s.model_id),
      ...ml.flatMap((w) => mlModelsIn(graphs.get(w.id)!)),
      ...ml.flatMap((w) => alertOf(w as Record<string, unknown>)?.models ?? []),
    ]),
  ].filter((id) => /^[0-9a-f-]{36}$/i.test(id));
  const { data: models } = modelIds.length
    ? await supabaseAdmin
        .from("ml_models")
        .select("id, name")
        .eq("user_id", userId)
        .in("id", modelIds)
    : { data: [] as { id: string; name: string }[] };
  const modelName = new Map((models ?? []).map((m) => [m.id, m.name]));
  const scheduleModel = new Map((schedules ?? []).map((s) => [s.id, modelName.get(s.model_id)]));
  const { errorLead } = await import("@/lib/mlConsole");
  const allRuns: MlPipelineRun[] = (runs ?? []).map((r) => ({
    id: r.id,
    workflow_id: r.workflow_id,
    state: r.state,
    trigger: r.trigger,
    error: r.error ? errorLead(r.error, 600) : null,
    started_at: r.started_at,
    finished_at: r.finished_at,
  }));
  const pipelines: MlPipelineView[] = ml.map((w) => {
    const g = graphs.get(w.id)!;
    return {
      id: w.id,
      name: w.name,
      description: w.description,
      schedule: w.schedule,
      cron_expr: w.cron_expr,
      is_active: w.is_active,
      next_run_at: w.next_run_at,
      steps: pipelineSteps(g),
      models: [
        ...new Set(
          [
            ...mlSchedulesIn(g).map((id) => scheduleModel.get(id)),
            ...mlModelsIn(g).map((id) => modelName.get(id)),
          ].filter((n): n is string => Boolean(n)),
        ),
      ],
      kubeflow: kubeflowPipelinesIn(g),
      last: allRuns.find((r) => r.workflow_id === w.id) ?? null,
      has_trigger_token: Boolean(w.trigger_token_hash),
      alert:
        alertTriggerLine(alertOf(w as Record<string, unknown>), (id) => modelName.get(id)) || null,
    };
  });
  return { pipelines, runs: allRuns };
}

// ── What starts when a model alerts (R544) ─────────────────────────────────

export type ModelAlertWorkflow = {
  id: string;
  name: string;
  is_active: boolean;
  events: import("@/lib/workflowAlerts").AlertEvent[];
  cooldownHours: number;
  last: import("@/lib/workflowAlerts").AlertNote | null;
};

/**
 * The caller's workflows that start when this model alerts, for the model's
 * Automation tab. Only the OWNER's: their workflows are the only ones an
 * alert on their model can start, so a person the model is shared with is
 * shown none.
 */
export const modelAlertWorkflows = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z.object({ access_token: z.string().min(1), modelId: z.string().uuid() }).parse(input),
  )
  .handler(
    async ({
      data,
    }): Promise<{ ok: true; workflows: ModelAlertWorkflow[] } | { ok: false; error: string }> => {
      const userId = await resolveCaller(data.access_token);
      const { alertTriggerOf, alertNoteOf } = await import("@/lib/workflowAlerts");
      const { data: model } = await supabaseAdmin
        .from("ml_models")
        .select("id")
        .eq("id", data.modelId)
        .eq("user_id", userId)
        .maybeSingle();
      if (!model) return { ok: true, workflows: [] };
      const { data: rows, error } = await supabaseAdmin
        .from("workflows")
        .select("*")
        .eq("user_id", userId)
        .order("name")
        .limit(200);
      if (error) return { ok: false, error: error.message };
      const out: ModelAlertWorkflow[] = [];
      for (const w of rows ?? []) {
        const t = alertTriggerOf((w as Record<string, unknown>).alert_trigger);
        if (!t || !t.models.includes(data.modelId)) continue;
        out.push({
          id: String(w.id),
          name: String(w.name),
          is_active: Boolean(w.is_active),
          events: t.events,
          cooldownHours: t.cooldownHours,
          last: alertNoteOf((w as Record<string, unknown>).alert_last),
        });
      }
      return { ok: true, workflows: out };
    },
  );

export const mlPipelinesOverview = createServerFn({ method: "POST" })
  .validator((input: unknown) => TOKEN.parse(input))
  .handler(async ({ data }): Promise<MlPipelinesOverview> => {
    const userId = await resolveCaller(data.access_token);
    const [{ pipelines, runs }, { count }] = await Promise.all([
      pipelinesFor(userId),
      supabaseAdmin
        .from("integrations")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .eq("type", "kubeflow"),
    ]);
    const names = new Map(pipelines.map((p) => [p.id, p.name]));
    return {
      pipelines,
      recent: runs
        .slice(0, 15)
        .map((r) => ({ ...r, name: names.get(r.workflow_id) ?? "Pipeline" })),
      kubeflowConnections: count ?? 0,
    };
  });

/**
 * A new ML pipeline: a workflow with the starter graph (retrain, then score),
 * named "ML pipeline", or "ML pipeline 2" and so on when that name is taken.
 * The editor opens on it; its steps' schedules are picked there.
 */
export const mlPipelineCreate = createServerFn({ method: "POST" })
  .validator((input: unknown) => TOKEN.parse(input))
  .handler(async ({ data }): Promise<{ ok: true; id: string } | { ok: false; error: string }> => {
    const userId = await resolveCaller(data.access_token);
    const { mlPipelineStarter, ML_PIPELINE_DESCRIPTION } = await import("@/lib/mlPipelines");
    const { data: taken } = await supabaseAdmin
      .from("workflows")
      .select("name")
      .eq("user_id", userId)
      .ilike("name", "ML pipeline%");
    const names = new Set((taken ?? []).map((t) => t.name));
    let name = "ML pipeline";
    for (let i = 2; names.has(name) && i < 1000; i++) name = `ML pipeline ${i}`;
    const { data: row, error } = await supabaseAdmin
      .from("workflows")
      .insert({
        user_id: userId,
        name,
        description: ML_PIPELINE_DESCRIPTION,
        graph: mlPipelineStarter() as unknown as import("@/integrations/supabase/types").Json,
      })
      .select("id")
      .single();
    if (error || !row) return { ok: false, error: error?.message ?? "Could not create it" };
    return { ok: true, id: String(row.id) };
  });

// ── Live traffic (R545) ──────────────────────────────────────────────────────

export type LiveTrafficVersion = {
  versionId: string;
  version: number | null;
  production: boolean;
  requests: number;
  rows: number;
  /** Null below the window's minimum rows. */
  score: number | null;
  features: Record<string, number>;
  ownerRows: number;
  ownerScore: number | null;
  truncated: boolean;
};

export type LiveTrafficView = {
  windowHours: number;
  minRows: number;
  threshold: number;
  versions: LiveTrafficVersion[];
  /** When the hourly check last looked, if it has (needs migration 20261207000000). */
  checkedAt: string | null;
  /**
   * The production version's number when it holds no training distribution
   * (trained before drift was recorded, or imported): its traffic cannot be
   * measured. FOUND FROM THE UI (R545): the card said "no online requests" for
   * a model that had just answered one.
   */
  productionUnmeasured: number | null;
};

/**
 * A model's online traffic over the last day, measured against its training
 * data, for the model page. Its OWNER only: the window sums every caller's
 * requests, and a person the model is shared with is not shown how other
 * callers' inputs are distributed.
 */
export const mlLiveTraffic = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z.object({ access_token: z.string().min(1), modelId: z.string().uuid() }).parse(input),
  )
  .handler(
    async ({
      data,
    }): Promise<{ ok: true; traffic: LiveTrafficView | null } | { ok: false; error: string }> => {
      const userId = await resolveCaller(data.access_token);
      const { data: model } = await supabaseAdmin
        .from("ml_models")
        .select("id, user_id, production_version_id")
        .eq("id", data.modelId)
        .eq("user_id", userId)
        .maybeSingle();
      if (!model) return { ok: true, traffic: null };
      const { liveTraffic } = await import("@/utils/ml/traffic.server");
      const { TRAFFIC_MIN_ROWS, TRAFFIC_WINDOW_HOURS } = await import("@/lib/mlTraffic");
      const { getPlatformResources } = await import("@/utils/notebookRuntime/config.server");
      let traffic: Awaited<ReturnType<typeof liveTraffic>>;
      try {
        traffic = await liveTraffic(model);
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
      const ids = [
        ...new Set([
          ...traffic.map((t) => t.versionId),
          ...(model.production_version_id ? [model.production_version_id] : []),
        ]),
      ];
      const [{ data: versions }, checks, limits] = await Promise.all([
        ids.length
          ? supabaseAdmin
              .from("ml_model_versions")
              .select("id, version, has_stats:feature_stats")
              .in("id", ids)
          : Promise.resolve({
              data: [] as { id: string; version: number; has_stats: unknown }[],
            }),
        // Before the migration there is no table: the page still measures.
        supabaseAdmin
          .from("ml_traffic_checks")
          .select("checked_at")
          .in("model_id", [model.id])
          .order("checked_at", { ascending: false })
          .limit(1),
        getPlatformResources(),
      ]);
      const number = new Map((versions ?? []).map((v) => [v.id, v.version]));
      const production = (versions ?? []).find((v) => v.id === model.production_version_id);
      return {
        ok: true,
        traffic: {
          windowHours: TRAFFIC_WINDOW_HOURS,
          minRows: TRAFFIC_MIN_ROWS,
          threshold: limits.mlDriftAlertPsi,
          checkedAt: checks.error ? null : (checks.data?.[0]?.checked_at ?? null),
          productionUnmeasured:
            production && !production.has_stats ? (production.version ?? null) : null,
          versions: traffic.map((t) => ({
            versionId: t.versionId,
            version: number.get(t.versionId) ?? null,
            production: t.versionId === model.production_version_id,
            requests: t.requests,
            rows: t.rows,
            score: t.drift?.score ?? null,
            features: t.drift?.features ?? {},
            ownerRows: t.ownerRows,
            ownerScore: t.ownerDrift?.score ?? null,
            truncated: t.truncated,
          })),
        },
      };
    },
  );
