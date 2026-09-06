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
import { algorithmOf, checkRegistrable, promotableMetrics } from "@/lib/experiments";
import { auditEvent } from "@/utils/audit.server";
import { loadModelForUser } from "@/utils/ml/access.server";
import { registerExternalVersion } from "@/utils/ml/api.server";

type Fail = { ok: false; error: string };

async function resolveCaller(accessToken: string): Promise<string> {
  const { data, error } = await supabaseAdmin.auth.getUser(accessToken);
  if (error || !data?.user) throw new Error("Not signed in");
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
};

export const experimentsList = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ accessToken: z.string().min(1) }).parse(input))
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
          .select("id, name, task")
          .eq("user_id", userId)
          .order("name"),
      ]);
      if (error) return { ok: false, error: error.message };

      const byExp = new Map<string, { runs: number; running: number; last: string | null }>();
      for (const r of runs ?? []) {
        const agg = byExp.get(r.experiment_id) ?? { runs: 0, running: 0, last: null };
        agg.runs += 1;
        if (r.status === "running") agg.running += 1;
        if (!agg.last || r.started_at > agg.last) agg.last = r.started_at;
        byExp.set(r.experiment_id, agg);
      }

      return {
        ok: true,
        experiments: (exps ?? []).map((e) => {
          const agg = byExp.get(e.id);
          return {
            ...e,
            runs: agg?.runs ?? 0,
            running: agg?.running ?? 0,
            last_run_at: agg?.last ?? null,
          };
        }),
        models: models ?? [],
      };
    },
  );

export const experimentRunsList = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ accessToken: z.string().min(1), experimentId: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }): Promise<Fail | { ok: true; runs: RunRow[] }> => {
    const userId = await resolveCaller(data.accessToken);
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
    return { ok: true, runs: (runs ?? []) as RunRow[] };
  });

export const experimentSave = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
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
  .inputValidator((input: unknown) =>
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
  .inputValidator((input: unknown) =>
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
  .inputValidator((input: unknown) =>
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
