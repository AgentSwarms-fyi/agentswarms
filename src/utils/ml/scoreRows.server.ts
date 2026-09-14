// Scoring for the AI Analyst: the models a plan may name, and the scoring
// of one step's rows — the SAME implementation the agent tool and the canvas
// node run (runMlPredict), reached with a third caller name.
//
// The analyst's loop runs in the browser or in the server-side embed runner;
// either way scoring is injected as a callback that lands here, under the
// asking user's id (or the analyst's owner's, for an embed). Rows are the
// step's own sample, at most ANALYST_SCORE_CAP, and the answer is the rows
// with the prediction columns joined on — by KEY when the model has a
// feature view and every row carries the key column(s), which is the path
// that removes the caller's arithmetic; by ROWS otherwise.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  ANALYST_SCORE_CAP,
  type ForecastResult,
  joinPredictions,
  type ScorableModel,
  type ScoreRowsResult,
} from "@/lib/aiAnalyst";
import { headlineMetric } from "@/lib/mlToolResult";
import { keyedModelViews } from "@/utils/featureViews/keyed.server";
import { healthLine } from "@/lib/mlHealth";
import { listModelsForUser } from "@/utils/ml/access.server";
import { modelHealthFor } from "@/utils/ml/health.server";
import {
  mlModelsAllowed,
  runMlPredict,
  type AgentToolContext,
} from "@/utils/tools/registry.server";

/**
 * The models a plan may use: every usable model with a production version.
 * Forecast models are in the list too — they take no rows, so the planner
 * is told to give them a FORECAST step rather than a scored one. Measured
 * live with them filtered out: "use a trained forecast model if one fits"
 * was answered with the regression model and an invented projection.
 */
export async function scorableModelsForUser(
  userId: string,
  /** The analyst's own choice (ai_analysts.ml_model_names): null = every model, a list = exactly those. */
  allow?: string[] | null,
): Promise<ScorableModel[]> {
  const models = mlModelsAllowed(
    (await listModelsForUser(userId)).filter((m) => m.production_version_id),
    allow ?? undefined,
  );
  if (models.length === 0) return [];
  const [keyed, health, { data: versions }] = await Promise.all([
    keyedModelViews(models),
    modelHealthFor(models),
    supabaseAdmin
      .from("ml_model_versions")
      .select("id, version, algorithm, metrics, feature_schema")
      .in(
        "id",
        models.map((m) => m.production_version_id as string),
      ),
  ]);
  const byId = new Map((versions ?? []).map((v) => [v.id, v]));
  return models.map((m) => {
    const v = byId.get(m.production_version_id as string);
    const schema = (v?.feature_schema ?? []) as { name: string; role: string }[];
    return {
      name: m.name,
      task: m.task,
      target: m.target_column ?? null,
      version: v?.version ?? null,
      algorithm: v?.algorithm ?? null,
      metric: headlineMetric(m.task, v?.metrics ?? null),
      keyColumns: keyed.get(m.id)?.key_columns ?? null,
      features: schema.filter((e) => e.role === "feature").map((e) => e.name),
      health: healthLine(health.get(m.id)),
    };
  });
}

/**
 * Score one step's rows. The prediction columns are appended to every input
 * row (null where a key matched nothing), so the step's table keeps the
 * columns the SQL produced and gains what the model added.
 */
export async function scoreRowsForAnalyst(args: {
  userId: string;
  model: string;
  rows: Record<string, unknown>[];
  decisionId?: string | null;
  /** The analyst's own choice; a model outside it is refused here, whatever the planner was shown. */
  allow?: string[] | null;
}): Promise<ScoreRowsResult> {
  const rows = args.rows.slice(0, ANALYST_SCORE_CAP);
  if (rows.length === 0) return { ok: false, error: "The step returned no rows to score." };
  const models = await listModelsForUser(args.userId);
  const model = models.find((m) => m.name === args.model);
  if (!model) return { ok: false, error: `No model named "${args.model}" is available to you.` };
  if (mlModelsAllowed([model], args.allow ?? undefined).length === 0) {
    return { ok: false, error: `"${model.name}" is not enabled for this analyst.` };
  }
  if (model.task === "forecast") {
    return {
      ok: false,
      error: `"${model.name}" is a forecast model: it takes no rows — plan a forecast step instead.`,
    };
  }
  const keyColumns = model.feature_view_id
    ? ((await keyedModelViews([model])).get(model.id)?.key_columns ?? null)
    : null;
  const byKey =
    !!keyColumns &&
    keyColumns.length > 0 &&
    rows.every((r) => keyColumns.every((k) => r[k] !== undefined && r[k] !== null));
  // The version's metrics and features, and the model's health, read once
  // before scoring: the features decide whether these rows can be scored
  // honestly at all. Measured live: a step selected customer_name alone for
  // a seven-feature model and the scorer imputed the other six in silence
  // — five "most at risk" customers with identical distances.
  const [{ data: version }, modelHealth] = await Promise.all([
    supabaseAdmin
      .from("ml_model_versions")
      .select("metrics, feature_schema")
      .eq("id", model.production_version_id as string)
      .maybeSingle(),
    modelHealthFor([model]),
  ]);
  const features = ((version?.feature_schema ?? []) as { name: string; role: string }[])
    .filter((e) => e.role === "feature")
    .map((e) => e.name);
  const notes: string[] = [];
  if (!byKey && features.length > 0) {
    const present = new Set(rows.flatMap((r) => Object.keys(r)));
    const missing = features.filter((f) => !present.has(f));
    if (missing.length * 2 >= features.length) {
      return {
        ok: false,
        error:
          `The step's rows carry ${features.length - missing.length} of the model's ${features.length} ` +
          `feature columns (missing ${missing.join(", ")}); the SQL must select the feature columns ` +
          `for the model to score anything real.`,
      };
    }
    if (missing.length > 0) {
      notes.push(
        `Feature column${missing.length === 1 ? "" : "s"} not in the rows and imputed by the scorer: ${missing.join(", ")}.`,
      );
    }
  }
  const ctx: AgentToolContext = {
    userId: args.userId,
    sb: supabaseAdmin as never,
    scopeUserId: args.userId,
    decisionId: args.decisionId ?? undefined,
  };
  const raw = await runMlPredict(
    ctx,
    byKey
      ? {
          model: model.name,
          keys: rows.map((r) => Object.fromEntries(keyColumns!.map((k) => [k, r[k]]))),
        }
      : { model: model.name, rows },
    args.allow ?? undefined,
    "ai_analyst",
  );
  const parsed = JSON.parse(raw) as {
    error?: unknown;
    version?: unknown;
    task?: unknown;
    algorithm?: unknown;
    predictions?: unknown;
    keys_not_found?: unknown;
    features_served_from?: unknown;
    notes?: unknown;
  };
  if (typeof parsed.error === "string") return { ok: false, error: parsed.error };
  // What the tool said about the columns and the model — class meanings,
  // group profiles, the trainer's warnings — travels with the disclosure,
  // so the write-up can describe a group. The health line is `health`.
  const toolNotes = (Array.isArray(parsed.notes) ? parsed.notes : []).filter(
    (n): n is string => typeof n === "string" && !/^Health:/.test(n),
  );
  const predictions = (Array.isArray(parsed.predictions) ? parsed.predictions : []).filter(
    (p): p is Record<string, unknown> => !!p && typeof p === "object",
  );
  // Joined by key identity when scored by key, by position otherwise, and a
  // prediction column that collides with one the SQL returned is kept under
  // a prefix — the pure rule is in joinPredictions, where a test can reach it.
  const joined = joinPredictions(rows, predictions, byKey ? keyColumns : null);
  return {
    ok: true,
    columns: joined.columns,
    rows: joined.rows,
    scored: {
      model: model.name,
      version: typeof parsed.version === "number" ? parsed.version : null,
      task: typeof parsed.task === "string" ? parsed.task : model.task,
      algorithm: typeof parsed.algorithm === "string" ? parsed.algorithm : null,
      metric: headlineMetric(model.task, version?.metrics ?? null),
      keys: byKey,
      featuresServedFrom:
        typeof parsed.features_served_from === "string" ? parsed.features_served_from : null,
      rowsScored: predictions.length,
      keysNotFound: Array.isArray(parsed.keys_not_found)
        ? parsed.keys_not_found.filter((k): k is string => typeof k === "string")
        : [],
      columns: joined.added,
      health: healthLine(modelHealth.get(model.id)),
      notes: [...toolNotes, ...notes],
    },
  };
}

/**
 * A forecast model's projection for a forecast step — the SAME runner the
 * agent tool and the canvas node use, with the analyst as the caller. One
 * row per projected period: the point and its interval.
 */
export async function forecastForAnalyst(args: {
  userId: string;
  model: string;
  decisionId?: string | null;
  /** The analyst's own choice; a model outside it is refused here. */
  allow?: string[] | null;
}): Promise<ForecastResult> {
  const models = await listModelsForUser(args.userId);
  const model = models.find((m) => m.name === args.model);
  if (!model) return { ok: false, error: `No model named "${args.model}" is available to you.` };
  if (mlModelsAllowed([model], args.allow ?? undefined).length === 0) {
    return { ok: false, error: `"${model.name}" is not enabled for this analyst.` };
  }
  if (model.task !== "forecast") {
    return {
      ok: false,
      error: `"${model.name}" is a ${model.task} model, not a forecast — score rows with it instead.`,
    };
  }
  const ctx: AgentToolContext = {
    userId: args.userId,
    sb: supabaseAdmin as never,
    scopeUserId: args.userId,
    decisionId: args.decisionId ?? undefined,
  };
  const [raw, { data: version }, modelHealth] = await Promise.all([
    runMlPredict(ctx, { model: model.name }, args.allow ?? undefined, "ai_analyst"),
    supabaseAdmin
      .from("ml_model_versions")
      .select("metrics")
      .eq("id", model.production_version_id as string)
      .maybeSingle(),
    modelHealthFor([model]),
  ]);
  const parsed = JSON.parse(raw) as {
    error?: unknown;
    version?: unknown;
    algorithm?: unknown;
    period?: unknown;
    aggregation?: unknown;
    last_observed_period?: unknown;
    forecast?: unknown;
    notes?: unknown;
  };
  if (typeof parsed.error === "string") return { ok: false, error: parsed.error };
  const points = (Array.isArray(parsed.forecast) ? parsed.forecast : []).filter(
    (p): p is { period: string; yhat: number; lo?: number | null; hi?: number | null } =>
      !!p && typeof p === "object" && typeof (p as { period?: unknown }).period === "string",
  );
  if (points.length === 0) {
    return {
      ok: false,
      error: `"${model.name}" has no projected periods stored for its production version.`,
    };
  }
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  return {
    ok: true,
    columns: ["period", "forecast", "lower", "upper"],
    rows: points.map((p) => ({
      period: p.period,
      forecast: p.yhat,
      lower: p.lo ?? null,
      upper: p.hi ?? null,
    })),
    scored: {
      model: model.name,
      version: typeof parsed.version === "number" ? parsed.version : null,
      task: "forecast",
      algorithm: typeof parsed.algorithm === "string" ? parsed.algorithm : null,
      metric: headlineMetric("forecast", version?.metrics ?? null),
      keys: false,
      featuresServedFrom: null,
      rowsScored: points.length,
      keysNotFound: [],
      columns: ["forecast", "lower", "upper"],
      health: healthLine(modelHealth.get(model.id)),
      notes: (Array.isArray(parsed.notes) ? parsed.notes : []).filter(
        (n): n is string => typeof n === "string" && !/^Health:/.test(n),
      ),
      forecast: {
        period: str(parsed.period),
        aggregation: str(parsed.aggregation),
        lastObserved: str(parsed.last_observed_period),
      },
    },
  };
}
