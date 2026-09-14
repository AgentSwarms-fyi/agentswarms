// What an ML tool result looks like to a PERSON.
//
// The tool loop hands the model the full JSON and the Playground a 400-char
// preview — which for a prediction is the model name, the version and the
// first row's probabilities cut off mid-number. A person reading the panel
// wants the table: which entity, what was predicted, how sure, what was not
// found, where the features came from. This module turns the tool's JSON into
// that, bounded, on the server at the point of execution (the only place the
// full result exists), and the Playground renders it. Pure and dependency-free
// so both sides can import it and a test can feed it strings.

export type MlPredictData = {
  kind: "predict";
  model: string;
  version: number | null;
  task: string;
  algorithm: string | null;
  /** Column order: key columns first (as the tool wrote them), then the rest. */
  columns: string[];
  rows: Record<string, unknown>[];
  row_count: number;
  feature_view: string | null;
  keys_not_found: string[];
  features_served_from: string | null;
  /** Forecast models return periods instead of rows. */
  forecast: { period: string; yhat: number; lo: number | null; hi: number | null }[];
  warnings: string[];
  notes: string[];
};

export type MlModelsData = {
  kind: "models";
  models: {
    name: string;
    task: string;
    target: string | null;
    version: number | null;
    algorithm: string | null;
    feature_view: { name: string; key_columns: string[] } | null;
    features: number;
    /** One headline metric, named, e.g. "accuracy 0.94" — or null. */
    metric: string | null;
  }[];
};

export type MlErrorData = { kind: "error"; error: string };

export type MlToolData = MlPredictData | MlModelsData | MlErrorData;

/** Rows the panel will show; the tool itself scores at most fifty. */
export const ML_RESULT_MAX_ROWS = 50;
/** Forecast points the panel will show. */
export const ML_RESULT_MAX_POINTS = 120;

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/** Metric keys in the order a person would quote them, per task. */
const HEADLINE: Record<string, string[]> = {
  classification: ["accuracy", "f1_macro", "roc_auc", "f1"],
  regression: ["r2", "mae", "rmse", "mape"],
  forecast: ["mape", "mae", "rmse"],
  clustering: ["silhouette"],
  anomaly: ["anomaly_rate", "contamination"],
  recommendation: ["precision_at_k", "hit_rate", "coverage"],
};

export function headlineMetric(task: string, metrics: unknown): string | null {
  if (!isObj(metrics)) return null;
  for (const k of HEADLINE[task] ?? []) {
    const v = num(metrics[k]);
    if (v !== null) return `${k} ${formatNumber(v)}`;
  }
  for (const [k, v] of Object.entries(metrics)) {
    const n = num(v);
    if (n !== null) return `${k} ${formatNumber(n)}`;
  }
  return null;
}

/** Numbers as a table cell shows them: probabilities to 3 places, ids as they are. */
export function formatNumber(v: number): string {
  if (Number.isInteger(v)) return String(v);
  return Math.abs(v) < 1000 ? v.toFixed(3).replace(/\.?0+$/, "") || "0" : v.toFixed(1);
}

/**
 * The structured view of an ML tool's result, or null when the result is not
 * one of the two ML tools' or is not JSON — the panel then keeps the preview.
 */
export function mlToolData(toolName: string, result: string): MlToolData | null {
  if (toolName !== "ml_predict" && toolName !== "ml_list_models") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch {
    return null;
  }
  if (!isObj(parsed)) return null;
  const error = str(parsed.error);
  if (error !== null) return { kind: "error", error };

  if (toolName === "ml_list_models") {
    const models = Array.isArray(parsed.models) ? parsed.models.filter(isObj) : [];
    return {
      kind: "models",
      models: models.map((m) => {
        const task = str(m.task) ?? "?";
        const fv = isObj(m.feature_view) ? m.feature_view : null;
        return {
          name: str(m.name) ?? "?",
          task,
          target: str(m.target),
          version: num(m.version),
          algorithm: str(m.algorithm),
          feature_view: fv
            ? { name: str(fv.name) ?? "?", key_columns: strs(fv.key_columns) }
            : null,
          features: Array.isArray(m.features) ? m.features.length : 0,
          metric: headlineMetric(task, m.metrics),
        };
      }),
    };
  }

  // ml_predict — rows for every task but forecast, which returns periods.
  const predictions = Array.isArray(parsed.predictions)
    ? parsed.predictions.filter(isObj).slice(0, ML_RESULT_MAX_ROWS)
    : [];
  const columns: string[] = [];
  for (const row of predictions)
    for (const k of Object.keys(row)) if (!columns.includes(k)) columns.push(k);
  const forecast = Array.isArray(parsed.forecast)
    ? parsed.forecast
        .filter(isObj)
        .slice(0, ML_RESULT_MAX_POINTS)
        .map((p) => ({
          period: str(p.period) ?? "",
          yhat: num(p.yhat) ?? 0,
          lo: num(p.lo),
          hi: num(p.hi),
        }))
    : [];
  return {
    kind: "predict",
    model: str(parsed.model) ?? "?",
    version: num(parsed.version),
    task: str(parsed.task) ?? "?",
    algorithm: str(parsed.algorithm),
    columns,
    rows: predictions,
    row_count: num(parsed.row_count) ?? predictions.length,
    feature_view: str(parsed.feature_view),
    keys_not_found: strs(parsed.keys_not_found),
    features_served_from: str(parsed.features_served_from),
    forecast,
    warnings: strs(parsed.warnings),
    notes: strs(parsed.notes),
  };
}
