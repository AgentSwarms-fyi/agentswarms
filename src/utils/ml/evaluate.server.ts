// Measuring a model against what actually happened.
//
// Everything else in this directory asks the model a question. This asks the
// world, and compares. A prediction run wrote a table; the outcomes turn up
// later somewhere else; an evaluation joins the two and recomputes the model's
// OWN training metric on the rows that have an answer yet.
//
// NO SANDBOX. The arithmetic is a confusion matrix or five sums, and both are
// a GROUP BY — so this runs one statement through the governed lakehouse
// chokepoint and does the formula in TypeScript (src/lib/mlEvaluation.ts,
// which is checked against sklearn's own numbers). Starting a container to
// divide two numbers would cost twenty-five seconds and buy nothing, and a
// second implementation of f1_macro is a second definition of f1_macro.
//
// AS THE MODEL'S OWNER, like training and prediction: the outcome table is
// read through `runLakehouseStatement` with the owner's id, so the same schema
// grants apply and the read is audited. A grantee triggering an evaluation
// cannot use it to read a schema they could not read themselves, because they
// never name the table — the model's own configuration does.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database, Json } from "@/integrations/supabase/types";
import { auditEvent } from "@/utils/audit.server";
import { notifyUser } from "@/utils/notify.server";
import { runLakehouseStatement } from "@/utils/lakehouse/core.server";
import { getPlatformResources } from "@/utils/notebookRuntime/config.server";
import {
  MAX_CONFUSION_PAIRS,
  classificationMetrics,
  coverage,
  coverageSql,
  decayRatio,
  evaluationSql,
  evaluationVerdict,
  regressionMetrics,
  validateOutcomeSource,
  type MlClassCount,
  type MlEvaluationMetrics,
  type MlOutcomeSource,
} from "@/lib/mlEvaluation";
import { ML_PRIMARY_METRIC } from "./types";

export type MlEvaluationRow = Database["public"]["Tables"]["ml_evaluations"]["Row"];

/** Ground truth only means something where there is a truth to compare to. */
const EVALUABLE = new Set(["classification", "regression", "forecast"]);

/**
 * How many predictions one sweep evaluates.
 *
 * A cadence bound rather than a resource cap, and the same shape as the other
 * sweeps (WORKFLOW_RUNS_PER_SWEEP, ETL_PIPELINES_PER_SWEEP): the work is one
 * statement per prediction, so this is about not monopolising a minute.
 */
const perSweep = () => {
  const n = Number(process.env.ML_EVALUATIONS_PER_SWEEP);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 20;
};

/**
 * A prediction stops being re-measured once it is this old.
 *
 * Answers arrive over hours or weeks, so one evaluation is never the last
 * word — but a run from last quarter is history, and re-reading it every day
 * for ever would be a scheduled way to waste a warehouse.
 */
const EVALUATE_WITHIN_DAYS = 30;

/** And no more often than this, so a sweep every minute does not mean this. */
const REEVALUATE_AFTER_HOURS = 24;

export function readOutcomeSource(raw: Json | null): MlOutcomeSource | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const src: MlOutcomeSource = {
    schema: String(o.schema ?? ""),
    table: String(o.table ?? ""),
    key_columns: Array.isArray(o.key_columns) ? o.key_columns.map(String) : [],
    outcome_column: String(o.outcome_column ?? ""),
  };
  // A configuration that no longer validates is treated as absent rather than
  // run: the alternative is putting a half-written jsonb into a statement.
  return validateOutcomeSource(src) === null ? src : null;
}

/** The number the evaluation will be compared against, or null. */
export function baselineFor(metrics: Json | null, metricName: string): number | null {
  if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) return null;
  const v = (metrics as Record<string, unknown>)[metricName];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

type EvaluateOutcome =
  | { ok: true; evaluation: MlEvaluationRow }
  | { ok: false; error: string; evaluation?: MlEvaluationRow };

/**
 * Measure one prediction run against the outcomes, and record the result.
 *
 * `triggeredBy` is who asked — it owns the row, so a grantee's manual
 * evaluation is theirs while the model owner still sees it through the second
 * RLS policy. The lakehouse read is always the OWNER's.
 */
export async function evaluatePrediction(
  predictionId: string,
  triggeredBy: string,
  via = "ui",
): Promise<EvaluateOutcome> {
  const { data: prediction } = await supabaseAdmin
    .from("ml_predictions")
    .select("*")
    .eq("id", predictionId)
    .maybeSingle();
  if (!prediction) return { ok: false, error: "Prediction not found" };

  const { data: model } = await supabaseAdmin
    .from("ml_models")
    .select("*")
    .eq("id", prediction.model_id)
    .maybeSingle();
  if (!model) return { ok: false, error: "Model not found" };
  if (!EVALUABLE.has(model.task)) {
    return { ok: false, error: `A ${model.task} model has no outcome to be measured against` };
  }

  const src = readOutcomeSource(model.outcome_source);
  if (!src) {
    return {
      ok: false,
      error: "This model does not say where its real outcomes land. Set an outcome source first.",
    };
  }

  const output = prediction.output as { schema?: string; table?: string } | null;
  if (!output?.schema || !output?.table) {
    return {
      ok: false,
      error:
        "That run wrote no table to measure. Only a batch prediction into the lakehouse can be evaluated.",
    };
  }
  if (prediction.status !== "succeeded") {
    return { ok: false, error: `That run ${prediction.status}; there is nothing to measure` };
  }

  const { data: version } = await supabaseAdmin
    .from("ml_model_versions")
    .select("*")
    .eq("id", prediction.version_id)
    .maybeSingle();

  const task = model.task as "classification" | "regression" | "forecast";
  const metricName = ML_PRIMARY_METRIC[task];
  const owner = model.user_id;

  let metrics: MlEvaluationMetrics;
  let scoredRows = 0;
  try {
    const scored = { schema: output.schema, table: output.table };
    const counted = await runLakehouseStatement(owner, coverageSql(scored), {
      auditVia: "ml.evaluate",
    });
    scoredRows = Number(counted.rows[0]?.[0] ?? 0);

    const measured = await runLakehouseStatement(owner, evaluationSql(task, scored, src), {
      auditVia: "ml.evaluate",
      rowCap: MAX_CONFUSION_PAIRS + 1,
    });

    if (task === "classification") {
      if (measured.row_count > MAX_CONFUSION_PAIRS) {
        return {
          ok: false,
          error:
            `The join produced more than ${MAX_CONFUSION_PAIRS} prediction/outcome pairs. ` +
            `That usually means "${src.outcome_column}" is free text rather than a label.`,
        };
      }
      const counts: MlClassCount[] = measured.rows.map((r) => ({
        predicted: String(r[0] ?? ""),
        actual: String(r[1] ?? ""),
        n: Number(r[2] ?? 0),
      }));
      metrics = classificationMetrics(counts);
    } else {
      const r = measured.rows[0] ?? [];
      metrics = regressionMetrics({
        n: Number(r[0] ?? 0),
        sse: Number(r[1] ?? 0),
        sae: Number(r[2] ?? 0),
        sy: Number(r[3] ?? 0),
        syy: Number(r[4] ?? 0),
      });
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }

  if (metrics.matched === 0) {
    // Zero matches is a broken join, not a score of zero — and recording it as
    // a metric would draw a line on the chart that means "nobody answered".
    return {
      ok: false,
      error:
        `No scored row found an outcome in ${src.schema}.${src.table}. ` +
        `Check that ${src.key_columns.join(", ")} holds the same values in both tables.`,
    };
  }

  const baseline = baselineFor(version?.metrics ?? null, metricName);
  const decay = decayRatio(metrics.primary, baseline, metricName);
  const limits = await getPlatformResources();
  const verdict = evaluationVerdict(decay, limits.mlDecayAlertRatio);

  const { data: row, error: insertError } = await supabaseAdmin
    .from("ml_evaluations")
    .insert({
      model_id: model.id,
      version_id: prediction.version_id,
      prediction_id: predictionId,
      user_id: triggeredBy,
      metric_name: metrics.primary_name,
      metric_value: metrics.primary,
      baseline_value: baseline,
      decay_ratio: decay,
      verdict,
      matched_rows: metrics.matched,
      scored_rows: scoredRows,
      extra: { ...metrics.extra, coverage: coverage(metrics.matched, scoredRows) } as Json,
    })
    .select()
    .single();
  if (insertError || !row) {
    return { ok: false, error: insertError?.message ?? "Could not record the evaluation" };
  }

  auditEvent({
    userId: triggeredBy,
    action: "ml.evaluate",
    resourceType: "ml_model",
    resourceId: model.id,
    resourceName: model.name,
    detail: {
      prediction_id: predictionId,
      version: version?.version ?? null,
      metric: metrics.primary_name,
      value: metrics.primary,
      baseline,
      decay_ratio: decay,
      verdict,
      matched_rows: metrics.matched,
      scored_rows: scoredRows,
      via,
    },
  });

  if (verdict === "degraded") {
    auditEvent({
      userId: triggeredBy,
      action: "ml.decay.alert",
      resourceType: "ml_model",
      resourceId: model.id,
      resourceName: model.name,
      detail: {
        prediction_id: predictionId,
        metric: metrics.primary_name,
        value: metrics.primary,
        baseline,
        decay_ratio: decay,
        threshold: limits.mlDecayAlertRatio,
      },
    });
    const pct = decay === null ? "" : ` (${(decay * 100).toFixed(0)}% worse)`;
    void notifyUser(model.user_id, {
      title: `"${model.name}" is scoring worse than it trained${pct}`,
      body:
        `Measured against real outcomes: ${metrics.primary_name} ${metrics.primary.toFixed(3)} ` +
        `against ${baseline?.toFixed(3) ?? "—"} at training, over ${metrics.matched} of ` +
        `${scoredRows} scored rows. Retraining is the usual answer.`,
      link: `/ml/${model.id}`,
    });
  }

  return { ok: true, evaluation: row };
}

/**
 * The platform clock's share of this: measure what is worth measuring again.
 *
 * Deliberately driven from the PREDICTIONS rather than from a schedule of its
 * own. An evaluation is only ever about one run's output table, so "what
 * should be evaluated" is exactly "which recent runs have gone long enough
 * without being looked at" — a second schedule would be a second thing to
 * keep in step with the first.
 */
export async function runDueEvaluations(): Promise<{ evaluated: number; failed: number }> {
  const since = new Date(Date.now() - EVALUATE_WITHIN_DAYS * 86_400_000).toISOString();
  const staleBefore = new Date(Date.now() - REEVALUATE_AFTER_HOURS * 3_600_000).toISOString();

  const { data: models } = await supabaseAdmin
    .from("ml_models")
    .select("id")
    .not("outcome_source", "is", null);
  const modelIds = (models ?? []).map((m) => m.id);
  if (!modelIds.length) return { evaluated: 0, failed: 0 };

  const { data: candidates } = await supabaseAdmin
    .from("ml_predictions")
    .select("id, model_id, user_id, created_at")
    .in("model_id", modelIds)
    .eq("kind", "batch")
    .eq("status", "succeeded")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(perSweep() * 4);
  if (!candidates?.length) return { evaluated: 0, failed: 0 };

  const { data: recent } = await supabaseAdmin
    .from("ml_evaluations")
    .select("prediction_id, created_at")
    .in(
      "prediction_id",
      candidates.map((c) => c.id),
    )
    .gte("created_at", staleBefore);
  const measuredLately = new Set((recent ?? []).map((r) => r.prediction_id));

  let evaluated = 0;
  let failed = 0;
  for (const c of candidates) {
    if (measuredLately.has(c.id)) continue;
    if (evaluated + failed >= perSweep()) break;
    // The sweep acts as the run's own user, so the evaluation belongs to
    // whoever asked for the prediction rather than to nobody.
    const res = await evaluatePrediction(c.id, c.user_id, "schedule");
    if (res.ok) evaluated++;
    else {
      failed++;
      // A model whose outcomes have not arrived yet fails every sweep, which
      // is normal and not worth an alert — it is logged and nothing else.
      console.log(`[ml-evaluate] ${JSON.stringify({ prediction_id: c.id, skipped: res.error })}`);
    }
  }
  return { evaluated, failed };
}
