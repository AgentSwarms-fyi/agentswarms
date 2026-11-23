// Server functions behind ML Models → Experiments: read what was tried, and
// promote the attempt worth keeping into the registry.
//
// Writing runs is NOT here. A run is logged from wherever the training happens
// — a sandbox kernel, a script — through /api/ml/experiments, which
// authenticates a session token as well as a user JWT. These functions are the
// reading half plus the one write the UI owns: promotion, which is the moment
// an experiment stops being a record and becomes something servable.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import {
  algorithmOf,
  checkRegistrable,
  isModelExperiment,
  MODEL_EXPERIMENT,
  promotableMetrics,
  withVersionRuns,
  type TrainedVersion,
  type VersionRun,
} from "@/lib/experiments";
import { auditEvent } from "@/utils/audit.server";
import { loadModelForUser } from "@/utils/ml/access.server";
import { registerExternalVersion } from "@/utils/ml/api.server";
import { callerFailure } from "@/utils/callerLookup.server";

type Fail = { ok: false; error: string };

async function resolveCaller(accessToken: string): Promise<string> {
  const { data, error } = await supabaseAdmin.auth.getUser(accessToken);
  if (error || !data?.user) throw new Error(callerFailure(error, "Not signed in"));
  return data.user.id;
}

export type ExperimentRow = {
  id: string;
  name: string;
  description: string | null;
  model_id: string | null;
  created_at: string;
  runs: number;
  running: number;
  last_run_at: string | null;
  /** Of `runs`, how many are versions the model trained here (R527). */
  trained_versions: number;
  /** A model's own training shown as an experiment: nothing to describe or delete. */
  from_model: boolean;
};

export type RunRow = {
  id: string;
  name: string | null;
  status: string;
  params: Json;
  metrics: Json;
  tags: string[];
  notes: string | null;
  source: string;
  session_id: string | null;
  artifact_uri: string | null;
  artifact_sha256: string | null;
  registered_version_id: string | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  /** Set when the row is a model version, not a logged run (R527). */
  version?: VersionRun["version"];
};

const VERSION_FIELDS =
  "id, model_id, version, status, stage, algorithm, metrics, config, training_rows, warnings, external, created_at, trained_at";

/** Every version of these models, the caller's own only. */
async function versionsOf(userId: string, modelIds: string[]): Promise<TrainedVersion[]> {
  if (modelIds.length === 0) return [];
  const { data } = await supabaseAdmin
    .from("ml_model_versions")
    .select(VERSION_FIELDS)
    .eq("user_id", userId)
    .in("model_id", modelIds)
    .order("version", { ascending: false })
    .limit(2000);
  const versions = (data ?? []) as TrainedVersion[];
  if (versions.length === 0) return versions;
  // The job behind each version: what started it, and the error a failed
  // one ended with (found in the UI test: a failed version said only
  // "Training failed." while its job held the reason).
  const { data: jobs } = await supabaseAdmin
    .from("ml_training_jobs")
    .select("version_id, trigger, error, created_at")
    .eq("user_id", userId)
    .in(
      "version_id",
      versions.map((v) => v.id),
    )
    .order("created_at", { ascending: true });
  const jobOf = new Map((jobs ?? []).map((j) => [j.version_id, j]));
  return versions.map((v) => {
    const j = jobOf.get(v.id);
    return j ? { ...v, job: { trigger: j.trigger, error: j.error } } : v;
  });
}

export const experimentsList = createServerFn({ method: "POST" })
  .validator((input: unknown) => z.object({ accessToken: z.string().min(1) }).parse(input))
  .handler(
    async ({
      data,
    }): Promise<
      | Fail
      | {
          ok: true;
          experiments: ExperimentRow[];
          /** Models a run can be promoted into. */
          models: { id: string; name: string; task: string }[];
        }
    > => {
      const userId = await resolveCaller(data.accessToken);
      const [{ data: exps, error }, { data: runs }, { data: models }] = await Promise.all([
        supabaseAdmin
          .from("ml_experiments")
          .select("id, name, description, model_id, created_at")
          .eq("user_id", userId)
          .order("created_at", { ascending: false }),
        supabaseAdmin
          .from("ml_experiment_runs")
          .select("experiment_id, status, started_at")
          .eq("user_id", userId),
        supabaseAdmin
          .from("ml_models")
          .select("id, name, task, created_at")
          .eq("user_id", userId)
          .order("name"),
      ]);
      if (error) return { ok: false, error: error.message };
      const ownModels = models ?? [];
      // Light: status and dates only, to count. The runs list reads the rest.
      const { data: versions } = ownModels.length
        ? await supabaseAdmin
            .from("ml_model_versions")
            .select("model_id, status, created_at")
            .eq("user_id", userId)
            .in(
              "model_id",
              ownModels.map((m) => m.id),
            )
        : { data: [] as { model_id: string; status: string; created_at: string }[] };
      const byModel = new Map<string, { runs: number; running: number; last: string | null }>();
      for (const v of versions ?? []) {
        const agg = byModel.get(v.model_id) ?? { runs: 0, running: 0, last: null };
        agg.runs += 1;
        if (v.status === "training") agg.running += 1;
        if (!agg.last || v.created_at > agg.last) agg.last = v.created_at;
        byModel.set(v.model_id, agg);
      }

      const byExp = new Map<string, { runs: number; running: number; last: string | null }>();
      for (const r of runs ?? []) {
        const agg = byExp.get(r.experiment_id) ?? { runs: 0, running: 0, last: null };
        agg.runs += 1;
        if (r.status === "running") agg.running += 1;
        if (!agg.last || r.started_at > agg.last) agg.last = r.started_at;
        byExp.set(r.experiment_id, agg);
      }

      const linked = new Set((exps ?? []).map((e) => e.model_id).filter(Boolean));
      const latest = (a: string | null, b: string | null) => (!a ? b : !b ? a : a > b ? a : b);
      const logged: ExperimentRow[] = (exps ?? []).map((e) => {
        const agg = byExp.get(e.id);
        const trained = (e.model_id && byModel.get(e.model_id)) || null;
        return {
          ...e,
          runs: (agg?.runs ?? 0) + (trained?.runs ?? 0),
          running: (agg?.running ?? 0) + (trained?.running ?? 0),
          last_run_at: latest(agg?.last ?? null, trained?.last ?? null),
          trained_versions: trained?.runs ?? 0,
          from_model: false,
        };
      });
      // A model that trained and has no experiment linked to it is one.
      const trainedHere: ExperimentRow[] = ownModels
        .filter((m) => !linked.has(m.id) && byModel.has(m.id))
        .map((m) => {
          const agg = byModel.get(m.id)!;
          return {
            id: `${MODEL_EXPERIMENT}${m.id}`,
            name: m.name,
            description: null,
            model_id: m.id,
            created_at: m.created_at,
            runs: agg.runs,
            running: agg.running,
            last_run_at: agg.last,
            trained_versions: agg.runs,
            from_model: true,
          };
        });
      const when = (e: ExperimentRow) => e.last_run_at ?? e.created_at;
      return {
        ok: true,
        experiments: [...logged, ...trainedHere].sort((a, b) => (when(a) < when(b) ? 1 : -1)),
        models: ownModels.map(({ id, name, task }) => ({ id, name, task })),
      };
    },
  );

export const experimentRunsList = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z
      .object({
        accessToken: z.string().min(1),
        // An experiment's id, or `model:<id>` for a model's own training (R527).
        experimentId: z.string().regex(/^(model:)?[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<Fail | { ok: true; runs: RunRow[] }> => {
    const userId = await resolveCaller(data.accessToken);
    if (isModelExperiment(data.experimentId)) {
      const modelId = data.experimentId.slice(MODEL_EXPERIMENT.length);
      const { data: model } = await supabaseAdmin
        .from("ml_models")
        .select("id")
        .eq("id", modelId)
        .eq("user_id", userId)
        .maybeSingle();
      if (!model) return { ok: false, error: "Model not found" };
      return { ok: true, runs: withVersionRuns([], await versionsOf(userId, [model.id])) };
    }
    const { data: exp } = await supabaseAdmin
      .from("ml_experiments")
      .select("model_id")
      .eq("id", data.experimentId)
      .eq("user_id", userId)
      .maybeSingle();
    const { data: runs, error } = await supabaseAdmin
      .from("ml_experiment_runs")
      .select(
        "id, name, status, params, metrics, tags, notes, source, session_id, artifact_uri, artifact_sha256, registered_version_id, error, started_at, finished_at, duration_ms",
      )
      .eq("user_id", userId)
      .eq("experiment_id", data.experimentId)
      .order("started_at", { ascending: false })
      .limit(500);
    if (error) return { ok: false, error: error.message };
    // The model this experiment is about: its versions sit beside the runs.
    const versions = exp?.model_id ? await versionsOf(userId, [exp.model_id]) : [];
    return { ok: true, runs: withVersionRuns((runs ?? []) as RunRow[], versions) as RunRow[] };
  });

export const experimentSave = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z
      .object({
        accessToken: z.string().min(1),
        id: z.string().uuid(),
        description: z.string().max(2000).nullable(),
        model_id: z.string().uuid().nullable(),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<Fail | { ok: true }> => {
    const userId = await resolveCaller(data.accessToken);
    const { error } = await supabaseAdmin
      .from("ml_experiments")
      .update({
        description: data.description,
        model_id: data.model_id,
        updated_at: new Date().toISOString(),
      })
      .eq("id", data.id)
      .eq("user_id", userId);
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  });

export const experimentDelete = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z.object({ accessToken: z.string().min(1), id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }): Promise<Fail | { ok: true; deletedRuns: number }> => {
    const userId = await resolveCaller(data.accessToken);
    // Say how much history goes with it — an experiment row looks small and
    // takes every run it holds with it.
    const { count } = await supabaseAdmin
      .from("ml_experiment_runs")
      .select("id", { count: "exact", head: true })
      .eq("experiment_id", data.id)
      .eq("user_id", userId);
    const { error } = await supabaseAdmin
      .from("ml_experiments")
      .delete()
      .eq("id", data.id)
      .eq("user_id", userId);
    if (error) return { ok: false, error: error.message };
    return { ok: true, deletedRuns: count ?? 0 };
  });

export const experimentRunDelete = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z.object({ accessToken: z.string().min(1), id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }): Promise<Fail | { ok: true }> => {
    const userId = await resolveCaller(data.accessToken);
    const { error } = await supabaseAdmin
      .from("ml_experiment_runs")
      .delete()
      .eq("id", data.id)
      .eq("user_id", userId);
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  });

/**
 * Promote a run into the registry as a model version.
 *
 * This is the seam the whole feature exists for: twenty runs happened, one is
 * worth serving, and it becomes a version through the SAME path an external
 * registration takes — same artifact-digest check, same audit event, same
 * promotion rules. Nothing here is a shortcut around the registry.
 */
export const experimentRunRegister = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z
      .object({
        accessToken: z.string().min(1),
        runId: z.string().uuid(),
        modelId: z.string().uuid(),
        promote: z.boolean().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<Fail | { ok: true; versionId: string; version: number }> => {
    const userId = await resolveCaller(data.accessToken);
    const { data: run } = await supabaseAdmin
      .from("ml_experiment_runs")
      .select(
        "id, name, experiment_id, params, metrics, artifact_uri, artifact_sha256, registered_version_id, status",
      )
      .eq("id", data.runId)
      .eq("user_id", userId)
      .maybeSingle();
    if (!run) return { ok: false, error: "Run not found" };
    // A run without BOTH artifact fields is a record of what was measured, not
    // something that can be served — nothing to load, or nothing to verify what
    // was loaded with.
    const registrable = checkRegistrable(run);
    if (!registrable.ok) return { ok: false, error: registrable.error };

    const loaded = await loadModelForUser(data.modelId, userId);
    if (!loaded.model) return { ok: false, error: "Model not found" };
    if (loaded.model.user_id !== userId) {
      // Registering a version changes what a model serves. Read access
      // through a share is not enough to do that.
      return { ok: false, error: "Only the model's owner can register a version" };
    }

    // Only the plain numeric metrics travel: `loss@7` is a point on a curve,
    // and a leaderboard that mixed those with final scores would rank steps
    // against runs.
    const metrics = promotableMetrics(run.metrics);

    const done = await registerExternalVersion(
      loaded.model,
      {
        artifact_uri: registrable.artifactUri,
        artifact_sha256: registrable.artifactSha256,
        algorithm: algorithmOf(run.params),
        metrics,
        promote: data.promote,
      },
      { userId, apiKeyId: null },
    );
    if (!done.ok) return { ok: false, error: done.error };

    await supabaseAdmin
      .from("ml_experiment_runs")
      .update({ registered_version_id: done.versionId })
      .eq("id", run.id);

    auditEvent({
      userId,
      action: "ml.experiment.promote",
      resourceType: "ml_model",
      resourceId: loaded.model.id,
      resourceName: loaded.model.name,
      detail: {
        run_id: run.id,
        run_name: run.name,
        experiment_id: run.experiment_id,
        version: done.version,
        version_id: done.versionId,
      },
    });

    return { ok: true, versionId: done.versionId, version: done.version };
  });
