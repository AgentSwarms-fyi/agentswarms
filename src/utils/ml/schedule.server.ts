// Scheduled ML work: retrain a model on a cadence and promote the result
// when it beats production; score a lakehouse table on a cadence. Runs in the
// same sweep as ETL pipelines and materialized views, under the same cron
// lease, with the same claim-by-clock pattern - so N app replicas start a due
// schedule exactly once, and a run that outlasts its interval skips a beat
// instead of queuing behind itself.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database } from "@/integrations/supabase/types";
import { auditEvent } from "@/utils/audit.server";
import { nextEtlRunAt } from "@/utils/etl/schedule.server";
import { notifyUser } from "@/utils/notify.server";
import type { MlModelRow, MlVersionRow } from "./access.server";
import {
  pickVersion,
  promoteVersion,
  startBatchPrediction,
  trainNewVersion,
  type MlTrainInput,
} from "./api.server";
import { ML_LOWER_IS_BETTER, ML_PRIMARY_METRIC, type MlTask } from "./types";

export type MlScheduleRow = Database["public"]["Tables"]["ml_schedules"]["Row"];

export type MlScheduleConfig = {
  /** retrain */
  time_budget_minutes?: number;
  max_rows?: number;
  tuning?: MlTrainInput["tuning"];
  /** batch_predict */
  input?: { schema: string; table: string; where?: string };
  output?: { schema: string; table: string };
};

const PER_SWEEP = 10;

/** Same vocabulary and arithmetic as an ETL pipeline's schedule. */
export function nextMlRunAt(
  schedule: string,
  cronExpr?: string | null,
  timezone?: string | null,
  from = new Date(),
): string | null {
  return nextEtlRunAt(schedule, from, cronExpr, timezone);
}

/** Is `candidate` better than `incumbent` on the task's primary metric? */
export function beatsProduction(
  task: string,
  candidate: MlVersionRow | null,
  incumbent: MlVersionRow | null,
): boolean {
  if (!candidate || candidate.status !== "ready") return false;
  if (!incumbent) return true;
  const metric = ML_PRIMARY_METRIC[task as MlTask];
  const c = (candidate.metrics as Record<string, number | null>)?.[metric];
  const p = (incumbent.metrics as Record<string, number | null>)?.[metric];
  if (typeof c !== "number") return false;
  if (typeof p !== "number") return true;
  return ML_LOWER_IS_BETTER.has(metric) ? c < p : c > p;
}

/**
 * Start one schedule now, as its owner. Records what it started and why it
 * could not, and audits the run either way.
 */
export async function runMlSchedule(
  s: MlScheduleRow,
  via: string,
): Promise<{ ok: true; refId: string } | { ok: false; error: string }> {
  const { data: model } = await supabaseAdmin
    .from("ml_models")
    .select("*")
    .eq("id", s.model_id)
    .eq("user_id", s.user_id)
    .maybeSingle();
  const cfg = (s.config ?? {}) as MlScheduleConfig;
  let outcome: { ok: true; refId: string; versionId?: string } | { ok: false; error: string };
  if (!model) {
    outcome = { ok: false, error: "The model no longer exists" };
  } else if (s.kind === "retrain") {
    const started = await trainNewVersion(
      model as MlModelRow,
      {
        time_budget_minutes: cfg.time_budget_minutes,
        max_rows: cfg.max_rows,
        tuning: cfg.tuning,
      },
      { userId: s.user_id, trigger: via },
    );
    outcome = started.ok
      ? { ok: true, refId: started.jobId, versionId: started.versionId }
      : started;
  } else if (!cfg.input || !cfg.output) {
    outcome = { ok: false, error: "The schedule has no input or output table" };
  } else {
    const version = await pickVersion(model.id, undefined, model.production_version_id);
    if (!version) {
      outcome = { ok: false, error: "No trained version to predict with" };
    } else {
      const started = await startBatchPrediction({
        userId: s.user_id,
        model: model as MlModelRow,
        version,
        input: cfg.input,
        output: cfg.output,
        via,
      });
      outcome = started.ok ? { ok: true, refId: started.predictionId } : started;
    }
  }
  await supabaseAdmin
    .from("ml_schedules")
    .update({
      last_run_at: new Date().toISOString(),
      last_status: outcome.ok ? "started" : "failed",
      last_error: outcome.ok ? null : outcome.error,
      last_ref_id: outcome.ok ? outcome.refId : null,
      ...(outcome.ok && outcome.versionId ? { last_version_id: outcome.versionId } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq("id", s.id);
  auditEvent({
    userId: s.user_id,
    action: outcome.ok ? "ml.schedule.run" : "ml.schedule.failed",
    resourceType: "ml_model",
    resourceId: s.model_id,
    resourceName: model?.name ?? undefined,
    detail: {
      schedule_id: s.id,
      kind: s.kind,
      via,
      ...(outcome.ok ? { ref_id: outcome.refId } : { error: outcome.error }),
    },
  });
  if (!outcome.ok) {
    await notifyUser(s.user_id, {
      title: `Schedule "${s.name}" could not start`,
      body: outcome.error,
      link: `/ml/${s.model_id}`,
    });
  }
  return outcome.ok ? { ok: true, refId: outcome.refId } : outcome;
}

/**
 * Judge the version a retrain schedule produced, once it is ready: promote it
 * when it beats production (if the schedule says so), and tell the owner
 * either way. Each version is judged exactly once.
 */
export async function evaluateScheduledVersions(): Promise<number> {
  const { data: pending } = await supabaseAdmin
    .from("ml_schedules")
    .select("*")
    .eq("kind", "retrain")
    .not("last_version_id", "is", null)
    .limit(PER_SWEEP * 2);
  let judged = 0;
  for (const s of (pending ?? []) as MlScheduleRow[]) {
    if (!s.last_version_id || s.evaluated_version_id === s.last_version_id) continue;
    const { data: candidate } = await supabaseAdmin
      .from("ml_model_versions")
      .select("*")
      .eq("id", s.last_version_id)
      .maybeSingle();
    if (!candidate || candidate.status === "training") continue; // still running
    const { data: model } = await supabaseAdmin
      .from("ml_models")
      .select("*")
      .eq("id", s.model_id)
      .maybeSingle();
    if (!model) continue;
    const { data: incumbent } = model.production_version_id
      ? await supabaseAdmin
          .from("ml_model_versions")
          .select("*")
          .eq("id", model.production_version_id)
          .maybeSingle()
      : { data: null };
    const better = beatsProduction(model.task, candidate, incumbent);
    let promoted = false;
    if (candidate.status === "ready" && s.promote_if_better && better) {
      await promoteVersion(model as MlModelRow, candidate.id, s.user_id);
      promoted = true;
    }
    await supabaseAdmin
      .from("ml_schedules")
      .update({
        evaluated_version_id: candidate.id,
        last_status: candidate.status === "ready" ? (promoted ? "promoted" : "kept") : "failed",
        updated_at: new Date().toISOString(),
      })
      .eq("id", s.id);
    const metric = ML_PRIMARY_METRIC[model.task as MlTask];
    const value = (candidate.metrics as Record<string, number | null>)?.[metric];
    await notifyUser(s.user_id, {
      title:
        candidate.status !== "ready"
          ? `Scheduled retrain of "${model.name}" failed`
          : promoted
            ? `"${model.name}" v${candidate.version} is now in production`
            : `"${model.name}" v${candidate.version} trained; production kept`,
      body:
        candidate.status !== "ready"
          ? (((candidate.warnings as string[] | null) ?? [])[0] ?? "See the job's logs.")
          : `${metric}: ${typeof value === "number" ? value.toFixed(4) : "n/a"}` +
            (incumbent
              ? ` vs production ${(() => {
                  const p = (incumbent.metrics as Record<string, number | null>)?.[metric];
                  return typeof p === "number" ? p.toFixed(4) : "n/a";
                })()}`
              : "") +
            (better ? " (better)" : " (not better)"),
      link: `/ml/${model.id}`,
    });
    judged++;
  }
  return judged;
}

/**
 * Start every active schedule whose next_run_at has passed. Called from the
 * ETL sweep so the whole platform has one clock, one lease and one reaper.
 */
export async function processDueMlSchedules(force = false): Promise<number> {
  const nowIso = new Date().toISOString();
  let query = supabaseAdmin
    .from("ml_schedules")
    .select("*")
    .eq("is_active", true)
    .order("next_run_at", { ascending: true })
    .limit(PER_SWEEP);
  if (!force) query = query.lte("next_run_at", nowIso);
  const { data: due } = await query;
  let started = 0;
  for (const s of (due ?? []) as MlScheduleRow[]) {
    // The clock advance doubles as a compare-and-set claim.
    let claim = supabaseAdmin
      .from("ml_schedules")
      .update({ next_run_at: nextMlRunAt(s.schedule, s.cron_expr, s.timezone) })
      .eq("id", s.id);
    claim =
      s.next_run_at === null
        ? claim.is("next_run_at", null)
        : claim.eq("next_run_at", s.next_run_at);
    const { data: won } = await claim.select("id");
    if (!won?.length) continue; // another replica claimed this tick
    const res = await runMlSchedule(s, "schedule");
    if (res.ok) started++;
    else console.warn(`[ml-schedule] "${s.name}" did not start: ${res.error}`);
  }
  await evaluateScheduledVersions().catch((e) =>
    console.warn("[ml-schedule] evaluation failed:", (e as Error).message),
  );
  return started;
}
