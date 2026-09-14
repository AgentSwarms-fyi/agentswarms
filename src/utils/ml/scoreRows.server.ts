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
  joinPredictions,
  type ScorableModel,
  type ScoreRowsResult,
} from "@/lib/aiAnalyst";
import { headlineMetric } from "@/lib/mlToolResult";
import { keyedModelViews } from "@/utils/featureViews/keyed.server";
import { listModelsForUser } from "@/utils/ml/access.server";
import { runMlPredict, type AgentToolContext } from "@/utils/tools/registry.server";

/** The models a plan may score with: usable, with a production version, and not a forecast (which takes no rows). */
export async function scorableModelsForUser(userId: string): Promise<ScorableModel[]> {
  const models = (await listModelsForUser(userId)).filter(
    (m) => m.production_version_id && m.task !== "forecast",
  );
  if (models.length === 0) return [];
  const [keyed, { data: versions }] = await Promise.all([
    keyedModelViews(models),
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
}): Promise<ScoreRowsResult> {
  const rows = args.rows.slice(0, ANALYST_SCORE_CAP);
  if (rows.length === 0) return { ok: false, error: "The step returned no rows to score." };
  const models = await listModelsForUser(args.userId);
  const model = models.find((m) => m.name === args.model);
  if (!model) return { ok: false, error: `No model named "${args.model}" is available to you.` };
  const keyColumns = model.feature_view_id
    ? ((await keyedModelViews([model])).get(model.id)?.key_columns ?? null)
    : null;
  const byKey =
    !!keyColumns &&
    keyColumns.length > 0 &&
    rows.every((r) => keyColumns.every((k) => r[k] !== undefined && r[k] !== null));
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
    undefined,
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
  };
  if (typeof parsed.error === "string") return { ok: false, error: parsed.error };
  const predictions = (Array.isArray(parsed.predictions) ? parsed.predictions : []).filter(
    (p): p is Record<string, unknown> => !!p && typeof p === "object",
  );
  // Joined by key identity when scored by key, by position otherwise, and a
  // prediction column that collides with one the SQL returned is kept under
  // a prefix — the pure rule is in joinPredictions, where a test can reach it.
  const joined = joinPredictions(rows, predictions, byKey ? keyColumns : null);
  const { data: version } = await supabaseAdmin
    .from("ml_model_versions")
    .select("metrics")
    .eq("id", model.production_version_id as string)
    .maybeSingle();
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
    },
  };
}
