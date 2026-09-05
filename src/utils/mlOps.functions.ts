// Server functions for a model's operations: schedules (retrain, batch
// predict) and the model card. Schedules belong to the model's owner; the
// card is readable by anyone who can see the model.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database, Json } from "@/integrations/supabase/types";
import { loadModelForUser } from "@/utils/ml/access.server";
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
