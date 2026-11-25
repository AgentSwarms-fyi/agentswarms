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
  upcoming: (ScheduleLite & { model_name: string })[];
  recent: (({ type: "job" } & MlOpsJob) | ({ type: "prediction" } & MlOpsPrediction))[];
  compute: {
    backend: string;
    training_gpus: number;
    search_workers: number;
    trainings_per_person: number;
    time_budget_minutes: number;
  };
  models: number;
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
    const empty: MlOperationsOverview = {
      attention: [],
      running: [],
      predicting: [],
      upcoming: [],
      recent: [],
      compute,
      models: 0,
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
        endpoints,
        schedules: sched,
        health: healthAlerts,
      }).slice(0, 30),
      running: (live.data ?? []).map(job),
      predicting: (livePreds.data ?? []).map(pred),
      upcoming: sched.filter((s) => s.is_active),
      recent,
      compute,
      models: models.length,
    };
  });
