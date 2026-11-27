// What actually happened to an online prediction (R551).
//
// A batch run is measured against real outcomes by joining its scored table
// to the table where the answers land. An online request — the API, a warm
// endpoint — leaves no table, so a model answering online could stop being
// right and nothing would ever say so. Drift and missing inputs (R545, R549)
// warn that the rows look different; only the real answer says the model is
// wrong.
//
// So the caller that asked reports what happened, against the prediction_id
// it was given and the row it means, and the model's OWN metric is measured
// over the last thirty days of those answers — exactly as for a batch run:
// macro F1 for a classifier, RMSE for a regression, through the same two
// functions in `@/lib/mlEvaluation` that are held to scikit-learn's numbers.
//
// Pure: no database, no network.
import {
  classificationMetrics,
  regressionMetrics,
  type MlEvaluationMetrics,
} from "@/lib/mlEvaluation";
import { categoryText, numericValue } from "@/lib/mlTraffic";

/** Days of answers one online evaluation measures. */
export const ONLINE_WINDOW_DAYS = 30;
/**
 * Fewer answers than this and there is no verdict. A batch run's join has no
 * floor because it measures a whole table at once; a trickle of online
 * answers would otherwise swing the verdict on its first few.
 */
export const ONLINE_MIN_ANSWERS = 50;
/** At most this many answers are read for one evaluation, the newest first. */
export const ONLINE_MAX_ANSWERS = 50_000;
/** Outcomes one call may report: a request's own row limit. */
export const MAX_OUTCOMES_PER_CALL = 200;
/** What a label or a number may be, as text. */
const MAX_VALUE_CHARS = 500;

export type OnlineTask = "classification" | "regression";

/** The tasks an online answer can be measured for. A forecast answers from its stored forecast. */
export function onlineTask(task: string): OnlineTask | null {
  return task === "classification" || task === "regression" ? task : null;
}

export type ParsedOutcome = { row: number; actual: string };

/**
 * A report, checked: `{ prediction_id, outcomes: [{ row, actual }] }`. A
 * request of one row may leave `row` out. A label is text as Python spells it
 * (True/False); a number for a regression is a number or numeric text.
 */
export function parseOutcomes(
  body: unknown,
  task: OnlineTask,
  rowsInRequest: number,
): { ok: true; predictionId: string; outcomes: ParsedOutcome[] } | { ok: false; error: string } {
  const b = body as { prediction_id?: unknown; outcomes?: unknown } | null;
  const id = typeof b?.prediction_id === "string" ? b.prediction_id : "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return { ok: false, error: "prediction_id must be the id a prediction call returned" };
  }
  if (!Array.isArray(b?.outcomes) || b.outcomes.length === 0) {
    return { ok: false, error: "outcomes must be a non-empty array of { row, actual }" };
  }
  if (b.outcomes.length > MAX_OUTCOMES_PER_CALL) {
    return { ok: false, error: `At most ${MAX_OUTCOMES_PER_CALL} outcomes per call` };
  }
  const out: ParsedOutcome[] = [];
  const seen = new Set<number>();
  for (const [i, raw] of b.outcomes.entries()) {
    const o = raw as { row?: unknown; actual?: unknown } | null;
    if (!o || typeof o !== "object") return { ok: false, error: `outcomes[${i}] is not an object` };
    const row = o.row === undefined && rowsInRequest === 1 ? 0 : o.row;
    if (typeof row !== "number" || !Number.isInteger(row) || row < 0 || row >= rowsInRequest) {
      return {
        ok: false,
        error: `outcomes[${i}].row must be a row of that request, 0 to ${rowsInRequest - 1}`,
      };
    }
    if (seen.has(row)) return { ok: false, error: `Row ${row} is reported twice` };
    seen.add(row);
    let actual: string | null;
    if (task === "regression") {
      const n = numericValue(o.actual);
      actual = n === null ? null : String(n);
    } else {
      actual = categoryText(o.actual);
    }
    if (actual === null || actual === "") {
      return {
        ok: false,
        error:
          task === "regression"
            ? `outcomes[${i}].actual must be a number`
            : `outcomes[${i}].actual must be the label that actually happened`,
      };
    }
    if (actual.length > MAX_VALUE_CHARS) {
      return {
        ok: false,
        error: `outcomes[${i}].actual is longer than ${MAX_VALUE_CHARS} characters`,
      };
    }
    out.push({ row, actual });
  }
  return { ok: true, predictionId: id, outcomes: out };
}

/**
 * What the model answered for one row of a stored request: the `prediction`
 * column of the result the request kept. Null when the result holds no such
 * row (an older or failed request).
 */
export function predictedAt(result: unknown, row: number): string | null {
  const r = result as { columns?: unknown; sample?: unknown } | null;
  if (!r || !Array.isArray(r.columns) || !Array.isArray(r.sample)) return null;
  const col = r.columns.indexOf("prediction");
  const cells = r.sample[row];
  if (col < 0 || !Array.isArray(cells)) return null;
  const v = cells[col];
  if (v === null || v === undefined) return null;
  const text = typeof v === "number" ? String(v) : categoryText(v);
  return text && text.length <= MAX_VALUE_CHARS ? text : null;
}

/** How many rows a stored request answered, from its result. */
export function rowsAnswered(result: unknown): number {
  const r = result as { sample?: unknown } | null;
  return r && Array.isArray(r.sample) ? r.sample.length : 0;
}

export type OutcomePair = { predicted: string; actual: string };

/**
 * The model's own metric over answered rows, as a batch evaluation computes
 * it from its join. A regression pair whose texts are not both numbers is
 * left out. Null when no pair can be measured.
 */
export function onlineMetrics(task: OnlineTask, pairs: OutcomePair[]): MlEvaluationMetrics | null {
  if (task === "classification") {
    const counts = new Map<string, { predicted: string; actual: string; n: number }>();
    for (const p of pairs) {
      const k = `${p.predicted}\u0000${p.actual}`;
      const c = counts.get(k) ?? { predicted: p.predicted, actual: p.actual, n: 0 };
      c.n++;
      counts.set(k, c);
    }
    if (!counts.size) return null;
    return classificationMetrics([...counts.values()]);
  }
  let n = 0;
  let sse = 0;
  let sae = 0;
  let sy = 0;
  let syy = 0;
  for (const p of pairs) {
    const yhat = Number(p.predicted);
    const y = Number(p.actual);
    if (!Number.isFinite(yhat) || !Number.isFinite(y)) continue;
    const e = yhat - y;
    n++;
    sse += e * e;
    sae += Math.abs(e);
    sy += y;
    syy += y * y;
  }
  return n ? regressionMetrics({ n, sse, sae, sy, syy }) : null;
}

/** The day an online decay alert is for, so a version starts a workflow at most once a day for it. */
export function onlineAlertKey(versionId: string, now: Date): string {
  return `online:${versionId}:${now.toISOString().slice(0, 10)}`;
}
