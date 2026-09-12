// Server functions for a model's operations: schedules (retrain, batch
// predict) and the model card. Schedules belong to the model's owner; the
// card is readable by anyone who can see the model.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database, Json } from "@/integrations/supabase/types";
import { loadModelForUser, type MlVersionRow } from "@/utils/ml/access.server";
import { ML_TUNINGS } from "@/utils/ml/types";

type Fail = { ok: false; error: string };

async function resolveCaller(accessToken: string): Promise<string> {
  const { data, error } = await supabaseAdmin.auth.getUser(accessToken);
  if (error || !data?.user) throw new Error("Not signed in");
  return data.user.id;
}

const IDENT = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/);
const TABLE_NAME = /^[a-z_][a-z0-9_]{0,127}$/;

export type MlScheduleView = {
  id: string;
  name: string;
  kind: "retrain" | "batch_predict";
  schedule: "hourly" | "daily" | "weekly" | "cron";
  cron_expr: string | null;
  timezone: string | null;
  config: Json;
  promote_if_better: boolean;
  is_active: boolean;
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: string | null;
  last_error: string | null;
  last_ref_id: string | null;
  last_version_id: string | null;
  created_at: string;
};

const SCHEDULE_COLUMNS =
  "id, name, kind, schedule, cron_expr, timezone, config, promote_if_better, is_active, next_run_at, last_run_at, last_status, last_error, last_ref_id, last_version_id, created_at";

export const mlSchedulesList = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ access_token: z.string().min(1), model_id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }): Promise<{ schedules: MlScheduleView[] }> => {
    const userId = await resolveCaller(data.access_token);
    const { model, shared } = await loadModelForUser(data.model_id, userId);
    if (shared) return { schedules: [] };
    const { data: rows } = await supabaseAdmin
      .from("ml_schedules")
      .select(SCHEDULE_COLUMNS)
      .eq("model_id", model.id)
      .eq("user_id", userId)
      .order("created_at", { ascending: false });
    return { schedules: (rows ?? []) as MlScheduleView[] };
  });

export const mlScheduleCreate = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        model_id: z.string().uuid(),
        name: z.string().min(1).max(120),
        kind: z.enum(["retrain", "batch_predict"]),
        schedule: z.enum(["hourly", "daily", "weekly", "cron"]),
        cron_expr: z.string().max(120).optional(),
        timezone: z.string().max(64).optional(),
        promote_if_better: z.boolean().optional(),
        time_budget_minutes: z.number().int().min(1).optional(),
        max_rows: z.number().int().min(100).optional(),
        tuning: z.enum(ML_TUNINGS).optional(),
        input: z
          .object({ schema: IDENT, table: IDENT, where: z.string().max(2000).optional() })
          .optional(),
        output: z.object({ schema: IDENT, table: z.string().regex(TABLE_NAME) }).optional(),
      })
      .parse(input),
  )
  .handler(
    async ({ data }): Promise<Fail | { ok: true; id: string; next_run_at: string | null }> => {
      const userId = await resolveCaller(data.access_token);
      const { model } = await loadModelForUser(data.model_id, userId, { write: true });
      if (data.kind === "batch_predict" && (!data.input || !data.output)) {
        return {
          ok: false,
          error: "A batch prediction schedule needs an input and an output table",
        };
      }
      if (data.kind === "batch_predict" && model.task === "forecast") {
        return {
          ok: false,
          error:
            "Forecast models are served from their training forecast; schedule a retrain instead",
        };
      }
      if (data.schedule === "cron" && !data.cron_expr?.trim()) {
        return { ok: false, error: "A cron schedule needs an expression" };
      }
      const { nextMlRunAt } = await import("@/utils/ml/schedule.server");
      const next = nextMlRunAt(data.schedule, data.cron_expr ?? null, data.timezone ?? null);
      if (!next) return { ok: false, error: "That schedule never runs; check the cron expression" };
      const config =
        data.kind === "retrain"
          ? {
              time_budget_minutes: data.time_budget_minutes,
              max_rows: data.max_rows,
              tuning: data.tuning,
            }
          : { input: data.input, output: data.output };
      const { data: row, error } = await supabaseAdmin
        .from("ml_schedules")
        .insert({
          user_id: userId,
          model_id: model.id,
          name: data.name,
          kind: data.kind,
          schedule: data.schedule,
          cron_expr: data.schedule === "cron" ? (data.cron_expr ?? null) : null,
          timezone: data.timezone ?? null,
          config: config as Json,
          promote_if_better: data.promote_if_better ?? true,
          next_run_at: next,
        })
        .select("id, next_run_at")
        .single();
      if (error || !row)
        return { ok: false, error: error?.message ?? "Could not save the schedule" };
      return { ok: true, id: row.id, next_run_at: row.next_run_at };
    },
  );

export const mlScheduleUpdate = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        id: z.string().uuid(),
        is_active: z.boolean().optional(),
        promote_if_better: z.boolean().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<Fail | { ok: true }> => {
    const userId = await resolveCaller(data.access_token);
    const { data: s } = await supabaseAdmin
      .from("ml_schedules")
      .select("id, schedule, cron_expr, timezone, is_active")
      .eq("id", data.id)
      .eq("user_id", userId)
      .maybeSingle();
    if (!s) return { ok: false, error: "Schedule not found" };
    const patch: Database["public"]["Tables"]["ml_schedules"]["Update"] = {
      updated_at: new Date().toISOString(),
    };
    if (typeof data.promote_if_better === "boolean")
      patch.promote_if_better = data.promote_if_better;
    if (typeof data.is_active === "boolean") {
      patch.is_active = data.is_active;
      if (data.is_active && !s.is_active) {
        // Resuming: schedule from now, never from the missed past.
        const { nextMlRunAt } = await import("@/utils/ml/schedule.server");
        patch.next_run_at = nextMlRunAt(s.schedule, s.cron_expr, s.timezone);
      }
    }
    const { error } = await supabaseAdmin.from("ml_schedules").update(patch).eq("id", s.id);
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  });

export const mlScheduleDelete = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ access_token: z.string().min(1), id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }): Promise<Fail | { ok: true }> => {
    const userId = await resolveCaller(data.access_token);
    const { error } = await supabaseAdmin
      .from("ml_schedules")
      .delete()
      .eq("id", data.id)
      .eq("user_id", userId);
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  });

/** Start a schedule now, as the owner; the cadence is unchanged. */
export const mlScheduleRunNow = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ access_token: z.string().min(1), id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }): Promise<Fail | { ok: true; ref_id: string }> => {
    const userId = await resolveCaller(data.access_token);
    const { data: s } = await supabaseAdmin
      .from("ml_schedules")
      .select("*")
      .eq("id", data.id)
      .eq("user_id", userId)
      .maybeSingle();
    if (!s) return { ok: false, error: "Schedule not found" };
    const { runMlSchedule } = await import("@/utils/ml/schedule.server");
    const res = await runMlSchedule(s, "manual");
    return res.ok ? { ok: true, ref_id: res.refId } : res;
  });

/** The Markdown model card of a version (production by default). */
export const mlModelCard = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        model_id: z.string().uuid(),
        version_id: z.string().uuid().optional(),
        origin: z.string().max(200).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<Fail | { ok: true; markdown: string; version: number }> => {
    const userId = await resolveCaller(data.access_token);
    const { model } = await loadModelForUser(data.model_id, userId);
    const { pickVersion } = await import("@/utils/ml/api.server");
    const version = await pickVersion(model.id, data.version_id, model.production_version_id);
    if (!version) return { ok: false, error: "No trained version to describe" };
    const { count } = await supabaseAdmin
      .from("iam_resource_grants")
      .select("id", { count: "exact", head: true })
      .eq("resource_type", "ml_model")
      .eq("resource_id", model.id);
    const { buildModelCard } = await import("@/utils/ml/modelCard.server");
    return {
      ok: true,
      version: version.version,
      markdown: buildModelCard({
        model,
        version,
        origin: data.origin ?? "https://your-instance",
        sharedWith: count ?? 0,
      }),
    };
  });

/**
 * A model's warm endpoint, as the model page shows it.
 *
 * Readable by anyone who can read the model — whether an endpoint is up is the
 * same kind of disclosure the version list already makes — while every write
 * below requires ownership.
 */
export type MlDeploymentView = {
  status: "starting" | "ready" | "failed" | "stopped";
  version_id: string | null;
  /** The version number actually loaded, for "serving v2 while v3 is production". */
  version: number | null;
  /** True when the model's production version is not the one being served. */
  stale: boolean;
  keep_warm: boolean;
  idle_ttl_minutes: number;
  last_used_at: string | null;
  last_error: string | null;
  request_count: number;
  caps: { perUser: number; total: number };
  /** What the owner set: how many copies this endpoint may have. */
  min_replicas: number;
  max_replicas: number;
  /** Why the endpoint is the size it is, in the scaler's own words. */
  last_scale_reason: string | null;
  last_scaled_at: string | null;
  /** A version being tried alongside, and what has been learned about it. */
  candidate: {
    /** Shadowing answers nobody; a canary answers `percent` of real callers. */
    mode: "shadow" | "canary";
    version_id: string;
    version: number | null;
    started_at: string | null;
    percent: number;
    /** Agreement — what a SHADOW measures. Both versions answered the row. */
    shadow: {
      requests: number;
      rows: number;
      agreed: number;
      errors: number;
      last_error: string | null;
      /** A few rows the two answered differently, most recent first. */
      disagreements: { primary: string | null; candidate: string | null; at: string }[];
    };
    /**
     * Failure — what a CANARY measures, on BOTH sides.
     *
     * There is no agreement figure here and there cannot be: each row was
     * answered once, by one version, so there is no second answer to compare
     * it against. Production's figures sit beside the candidate's because the
     * question is never "is it failing" but "is it failing worse than what it
     * would replace".
     */
    canary: {
      primaryRequests: number;
      primaryErrors: number;
      requests: number;
      errors: number;
      last_error: string | null;
    };
  } | null;
  /**
   * The last automatic rollback, if there was one.
   *
   * OUTSIDE the candidate block on purpose: a rollback removes the candidate,
   * so anything nested inside it would vanish at the moment it became the most
   * important thing on the panel. Somebody arriving to an endpoint serving its
   * old version needs to find out why from the endpoint.
   */
  rollback: { at: string; reason: string | null } | null;
  /** One entry per copy actually running, quietest first. */
  replicas: {
    id: string;
    status: "starting" | "ready" | "failed" | "stopped";
    last_used_at: string | null;
    last_started_at: string | null;
    request_count: number;
    last_error: string | null;
  }[];
};

export const mlDeploymentGet = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ accessToken: z.string().min(1), modelId: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }): Promise<Fail | { ok: true; deployment: MlDeploymentView | null }> => {
    const userId = await resolveCaller(data.accessToken);
    const { model } = await loadModelForUser(data.modelId, userId);
    if (!model) return { ok: false, error: "Model not found" };
    const { getDeployment, deploymentCaps, listReplicas } = await import("@/utils/ml/serve.server");
    const [dep, caps] = await Promise.all([getDeployment(model.id), deploymentCaps()]);
    if (!dep) return { ok: true, deployment: null };
    // PRIMARY only. SEEN ON SCREEN: with a candidate running, the panel said
    // "2 of 2 copies answering" directly above "The candidate has never
    // answered a caller" — the two halves of the same card contradicting each
    // other, and the wrong half was the one a person counts containers with.
    // The candidate is reported by the shadow block below, as what it is.
    const replicas = await listReplicas(dep.id, true, "primary");

    // The candidate's own version number and the rows it disagreed on. Only
    // fetched when something is actually being shadowed — the overwhelming
    // majority of endpoints are not.
    let candidate: MlDeploymentView["candidate"] = null;
    if (dep.candidate_mode !== "off" && dep.candidate_version_id) {
      const [{ data: cv }, { data: diffs }] = await Promise.all([
        supabaseAdmin
          .from("ml_model_versions")
          .select("version")
          .eq("id", dep.candidate_version_id)
          .maybeSingle(),
        supabaseAdmin
          .from("ml_shadow_disagreements")
          .select("primary_answer, candidate_answer, created_at")
          .eq("deployment_id", dep.id)
          .order("created_at", { ascending: false })
          .limit(10),
      ]);
      candidate = {
        mode: dep.candidate_mode,
        version_id: dep.candidate_version_id,
        version: cv?.version ?? null,
        started_at: dep.candidate_started_at,
        percent: dep.candidate_percent,
        shadow: {
          requests: dep.shadow_requests,
          rows: dep.shadow_rows,
          agreed: dep.shadow_agreed,
          errors: dep.shadow_errors,
          last_error: dep.shadow_last_error,
          disagreements: (diffs ?? []).map((d) => ({
            primary: d.primary_answer,
            candidate: d.candidate_answer,
            at: d.created_at,
          })),
        },
        canary: {
          primaryRequests: dep.canary_primary_requests,
          primaryErrors: dep.canary_primary_errors,
          requests: dep.canary_requests,
          errors: dep.canary_errors,
          last_error: dep.canary_last_error,
        },
      };
    }
    const { data: version } = await supabaseAdmin
      .from("ml_model_versions")
      .select("version")
      .eq("id", dep.version_id ?? "")
      .maybeSingle();
    return {
      ok: true,
      deployment: {
        status: dep.status,
        version_id: dep.version_id,
        version: version?.version ?? null,
        stale: Boolean(
          model.production_version_id && dep.version_id !== model.production_version_id,
        ),
        keep_warm: dep.keep_warm,
        idle_ttl_minutes: dep.idle_ttl_minutes,
        last_used_at: dep.last_used_at,
        last_error: dep.last_error,
        request_count: dep.request_count,
        caps,
        min_replicas: dep.min_replicas,
        max_replicas: dep.max_replicas,
        candidate,
        rollback: dep.canary_rolled_back_at
          ? { at: dep.canary_rolled_back_at, reason: dep.canary_rollback_reason }
          : null,
        last_scale_reason: dep.last_scale_reason,
        last_scaled_at: dep.last_scaled_at,
        // Quietest first, the order the scorer picks in and the scaler stops
        // in — so what a reader sees is the order things will happen.
        replicas: [...replicas]
          .sort(
            (a, b) =>
              new Date(a.last_used_at ?? 0).getTime() - new Date(b.last_used_at ?? 0).getTime(),
          )
          .map((r) => ({
            id: r.id,
            status: r.status,
            last_used_at: r.last_used_at,
            last_started_at: r.last_started_at,
            request_count: r.request_count,
            last_error: r.last_error,
          })),
      },
    };
  });

/**
 * Bring the endpoint up on a version, and wait until it can actually score.
 *
 * Waits rather than returning "starting", because the useful answer to "is it
 * deployed" is whether the next request will be fast, and a row that says
 * ready before the model is loaded would be a lie the first caller pays for.
 */
export const mlDeploy = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        accessToken: z.string().min(1),
        modelId: z.string().uuid(),
        versionId: z.string().uuid().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<Fail | { ok: true; version: number }> => {
    const userId = await resolveCaller(data.accessToken);
    const { model } = await loadModelForUser(data.modelId, userId, { write: true });
    if (!model) return { ok: false, error: "Model not found" };
    const { pickVersion } = await import("@/utils/ml/api.server");
    const version = await pickVersion(model.id, data.versionId, model.production_version_id);
    if (!version) return { ok: false, error: "No trained version to serve" };
    const { ensureDeployment } = await import("@/utils/ml/serve.server");
    const res = await ensureDeployment({ model, version, userId });
    if (!res.ok) return { ok: false, error: res.error };
    return { ok: true, version: version.version };
  });

export const mlUndeploy = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ accessToken: z.string().min(1), modelId: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }): Promise<Fail | { ok: true }> => {
    const userId = await resolveCaller(data.accessToken);
    const { model } = await loadModelForUser(data.modelId, userId, { write: true });
    if (!model) return { ok: false, error: "Model not found" };
    const { undeploy } = await import("@/utils/ml/serve.server");
    await undeploy(model.id, userId);
    return { ok: true };
  });

/** Keep it warm through idle periods, or change how long idle is allowed. */
/**
 * Try a version on real traffic without serving anybody from it.
 *
 * Passing no version stops shadowing and leaves the totals to be read; the
 * candidate's copies come down either way.
 */
export const mlShadowSet = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        accessToken: z.string().min(1),
        modelId: z.string().uuid(),
        versionId: z.string().uuid().nullable(),
        // Shadowing answers nobody; a canary answers `percent` of real
        // callers. Validated here rather than trusted, because the difference
        // between the two is whether an unapproved model reaches a person.
        mode: z.enum(["shadow", "canary"]).optional(),
        percent: z.number().int().min(0).max(100).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<Fail | { ok: true }> => {
    const userId = await resolveCaller(data.accessToken);
    // Write access: starting a candidate spends a container and changes what
    // the endpoint is doing, even though it never changes an answer.
    const { model } = await loadModelForUser(data.modelId, userId, { write: true });
    if (!model) return { ok: false, error: "Model not found" };

    let version: MlVersionRow | null = null;
    if (data.versionId) {
      const { data: v } = await supabaseAdmin
        .from("ml_model_versions")
        .select("*")
        .eq("id", data.versionId)
        .eq("model_id", model.id)
        .maybeSingle();
      if (!v) return { ok: false, error: "Version not found on this model" };
      version = v as MlVersionRow;
    }

    const { setCandidate } = await import("@/utils/ml/serve.server");
    return setCandidate({ model, userId, version, mode: data.mode, percent: data.percent });
  });

export const mlDeploymentUpdate = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        accessToken: z.string().min(1),
        modelId: z.string().uuid(),
        keep_warm: z.boolean().optional(),
        idle_ttl_minutes: z.number().int().min(1).max(1440).optional(),
        // The ceiling matches the table's own CHECK, so an impossible number
        // is refused here with a readable message rather than by Postgres.
        min_replicas: z.number().int().min(0).max(64).optional(),
        max_replicas: z.number().int().min(1).max(64).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<Fail | { ok: true }> => {
    const userId = await resolveCaller(data.accessToken);
    const { model } = await loadModelForUser(data.modelId, userId, { write: true });
    if (!model) return { ok: false, error: "Model not found" };
    const patch: {
      keep_warm?: boolean;
      idle_ttl_minutes?: number;
      min_replicas?: number;
      max_replicas?: number;
      updated_at: string;
    } = { updated_at: new Date().toISOString() };
    if (data.keep_warm !== undefined) patch.keep_warm = data.keep_warm;
    if (data.idle_ttl_minutes !== undefined) patch.idle_ttl_minutes = data.idle_ttl_minutes;
    if (data.min_replicas !== undefined) patch.min_replicas = data.min_replicas;
    if (data.max_replicas !== undefined) patch.max_replicas = data.max_replicas;

    // Checked HERE as well as by the table, because the table's constraint
    // reads both columns and a request that changes only one would otherwise
    // be judged against the other's old value — sending max=1 to an endpoint
    // whose min is 3 fails with a constraint name instead of a sentence.
    if (patch.min_replicas !== undefined || patch.max_replicas !== undefined) {
      const { data: current } = await supabaseAdmin
        .from("ml_deployments")
        .select("min_replicas, max_replicas")
        .eq("model_id", model.id)
        .maybeSingle();
      const min = patch.min_replicas ?? current?.min_replicas ?? 1;
      const max = patch.max_replicas ?? current?.max_replicas ?? 1;
      if (min > max) {
        return {
          ok: false,
          error: `A minimum of ${min} copies cannot sit above a maximum of ${max}`,
        };
      }
    }
    const { error } = await supabaseAdmin
      .from("ml_deployments")
      .update(patch)
      .eq("model_id", model.id)
      .eq("user_id", userId);
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  });
