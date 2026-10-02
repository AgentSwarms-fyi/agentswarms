// Ground truth: is the model still RIGHT?
//
// NO IMPORTS, so the editor, the scheduler and the tests all read one set of
// rules — the same shape as src/lib/featureViews.ts.
//
// Drift (PSI) answers a different question from this one, and the difference
// is the reason this file exists. PSI says the rows arriving now do not look
// like the rows the model trained on. That is a warning, not a verdict: inputs
// can shift while the model stays accurate, and inputs can sit perfectly still
// while the world changes underneath the label. The only way to know whether a
// model is still right is to wait for the answer and compare.
//
// So: a model may name an OUTCOME SOURCE — a table where the real answers turn
// up, keyed so a prediction can find its own. An evaluation joins a scored
// table to that table and recomputes the model's own training metric on the
// rows that have an answer yet.
//
// TWO RULES, both learned from how these things go wrong:
//
//   1. THE SQL AGGREGATES, THIS FILE COMPUTES. The statement returns a
//      confusion matrix (classification) or five sums (regression), and every
//      formula below is applied here. That keeps the arithmetic testable
//      without a database, and it keeps it identical to what the trainer
//      reported — a metric computed two ways is two metrics.
//
//   2. COVERAGE IS PART OF THE ANSWER. An f1 of 0.9 over 6% of the scored rows
//      is not the model's f1; it is the f1 of whoever answered first, and
//      those people are rarely a random sample. Every evaluation carries how
//      many rows it matched out of how many were scored, and one that matched
//      nothing is an error rather than a score of zero.

/** Where the real answers turn up, and how a prediction finds its own. */
export type MlOutcomeSource = {
  schema: string;
  table: string;
  /** 1 to 8 columns present in BOTH the scored table and this one. */
  key_columns: string[];
  /** The column holding what actually happened. */
  outcome_column: string;
};

/** One cell of the confusion matrix, as the statement returns it. */
export type MlClassCount = { predicted: string; actual: string; n: number };

/** The five sums a regression evaluation needs, as the statement returns them. */
export type MlRegressionAgg = {
  n: number;
  /** Σ (predicted − actual)² */
  sse: number;
  /** Σ |predicted − actual| */
  sae: number;
  /** Σ actual */
  sy: number;
  /** Σ actual² */
  syy: number;
};

export type MlEvaluationMetrics = {
  /** The model's primary metric, recomputed on rows that have an answer. */
  primary: number;
  primary_name: string;
  /** Everything else worth showing, by name. */
  extra: Record<string, number | null>;
  /** Rows that found an answer. */
  matched: number;
};

/** Same ceiling as a feature view's key: a composite, not a join plan. */
export const MAX_OUTCOME_KEY_COLUMNS = 8;

/**
 * How many (predicted, actual) pairs a confusion matrix may have.
 *
 * A free-text column joined by mistake produces one pair per row, and macro F1
 * over ten thousand "classes" is a number with no meaning that takes a while
 * to compute. Refusing is the honest answer.
 */
export const MAX_CONFUSION_PAIRS = 400;

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** Double-quote an identifier. Callers must ALSO have checked it. */
const qi = (name: string) => `"${name.replace(/"/g, '""')}"`;

export function validateOutcomeSource(src: MlOutcomeSource): string | null {
  if (!src.schema.trim() || !src.table.trim()) return "Choose the table holding the outcomes";
  for (const part of [src.schema, src.table, src.outcome_column, ...src.key_columns]) {
    if (!IDENT_RE.test(part)) return `"${part}" is not a column or table name`;
  }
  if (!src.key_columns.length) return "Name at least one key column";
  if (src.key_columns.length > MAX_OUTCOME_KEY_COLUMNS) {
    return `At most ${MAX_OUTCOME_KEY_COLUMNS} key columns`;
  }
  if (new Set(src.key_columns).size !== src.key_columns.length) {
    return "A key column is named twice";
  }
  if (src.key_columns.includes(src.outcome_column)) {
    return "The outcome column cannot also be a key column";
  }
  return null;
}

/**
 * The statement that measures one scored table against the outcomes.
 *
 * An INNER join, deliberately: a prediction whose answer has not arrived is
 * not a wrong prediction, and counting it as one would make every model look
 * worse the fresher its predictions are. Rows without an answer are counted
 * separately — see `coverageSql`.
 *
 * `predicted` and `actual` are compared as text for classification because
 * that is what the scored table holds (the trainer writes labels, not codes),
 * and as DOUBLE for regression. The KEYS are compared as they are: casting
 * them to text to be safe is how an integer key silently stops matching a
 * key stored as a decimal.
 */
export function evaluationSql(
  task: "classification" | "regression" | "forecast",
  scored: { schema: string; table: string },
  src: MlOutcomeSource,
  predictionColumn = "prediction",
): string {
  const p = `${qi(scored.schema)}.${qi(scored.table)}`;
  const a = `${qi(src.schema)}.${qi(src.table)}`;
  const on = src.key_columns.map((c) => `p.${qi(c)} = a.${qi(c)}`).join(" AND ");
  const pred = `p.${qi(predictionColumn)}`;
  const act = `a.${qi(src.outcome_column)}`;

  if (task === "classification") {
    return (
      `SELECT CAST(${pred} AS VARCHAR) AS predicted, CAST(${act} AS VARCHAR) AS actual, ` +
      `count(*) AS n FROM ${p} AS p JOIN ${a} AS a ON ${on} ` +
      `WHERE ${act} IS NOT NULL GROUP BY 1, 2`
    );
  }
  return (
    `SELECT count(*) AS n, ` +
    `sum((CAST(${pred} AS DOUBLE) - CAST(${act} AS DOUBLE)) * ` +
    `(CAST(${pred} AS DOUBLE) - CAST(${act} AS DOUBLE))) AS sse, ` +
    `sum(abs(CAST(${pred} AS DOUBLE) - CAST(${act} AS DOUBLE))) AS sae, ` +
    `sum(CAST(${act} AS DOUBLE)) AS sy, ` +
    `sum(CAST(${act} AS DOUBLE) * CAST(${act} AS DOUBLE)) AS syy ` +
    `FROM ${p} AS p JOIN ${a} AS a ON ${on} WHERE ${act} IS NOT NULL`
  );
}

/** How many rows were scored at all — the denominator of coverage. */
export function coverageSql(scored: { schema: string; table: string }): string {
  return `SELECT count(*) AS n FROM ${qi(scored.schema)}.${qi(scored.table)}`;
}

/**
 * Macro F1 and accuracy from a confusion matrix.
 *
 * Deliberately sklearn's `f1_score(average="macro")` with `zero_division=0`,
 * because the number this is compared against came from exactly that call at
 * training time. Two defensible definitions of the same metric produce a decay
 * alert the first time a model is evaluated, which teaches everyone to ignore
 * decay alerts.
 *
 * The classes averaged over are the union of those PREDICTED and those that
 * ACTUALLY occurred — again sklearn's rule. A class the model never predicts
 * scores zero and drags the mean down, which is the point of macro.
 */
export function classificationMetrics(counts: MlClassCount[]): MlEvaluationMetrics {
  const labels = new Set<string>();
  for (const c of counts) {
    labels.add(c.predicted);
    labels.add(c.actual);
  }
  let matched = 0;
  let correct = 0;
  for (const c of counts) {
    matched += c.n;
    if (c.predicted === c.actual) correct += c.n;
  }

  const f1s: number[] = [];
  for (const label of labels) {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (const c of counts) {
      if (c.predicted === label && c.actual === label) tp += c.n;
      else if (c.predicted === label) fp += c.n;
      else if (c.actual === label) fn += c.n;
    }
    const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
    const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
    f1s.push(precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall));
  }

  return {
    primary: f1s.length ? f1s.reduce((a, b) => a + b, 0) / f1s.length : 0,
    primary_name: "f1_macro",
    extra: {
      accuracy: matched ? correct / matched : 0,
      classes: labels.size,
    },
    matched,
  };
}

/**
 * RMSE, MAE and R² from the five sums.
 *
 * R² is null rather than 0 when every actual is the same value: there is no
 * variance to explain, so the ratio is undefined, and reporting 0 would read
 * as "explains nothing" when the truthful answer is "unanswerable here".
 */
export function regressionMetrics(agg: MlRegressionAgg): MlEvaluationMetrics {
  const n = agg.n;
  const rmse = n ? Math.sqrt(agg.sse / n) : 0;
  const sst = n ? agg.syy - (agg.sy * agg.sy) / n : 0;
  return {
    primary: rmse,
    primary_name: "rmse",
    extra: {
      mae: n ? agg.sae / n : 0,
      r2: n && sst > 0 ? 1 - agg.sse / sst : null,
    },
    matched: n,
  };
}

/** For these metrics, is a bigger number a better model? */
export function higherIsBetter(metricName: string): boolean {
  return metricName !== "rmse" && metricName !== "mae";
}

/**
 * How much worse than the baseline, as a fraction of the baseline.
 *
 * Positive means WORSE, for both directions of metric, so one threshold reads
 * the same way whatever the task. An f1 of 0.72 against a baseline of 0.80 is
 * 0.10; an RMSE of 11 against a baseline of 10 is also 0.10.
 *
 * Null when there is nothing to compare against, or when the baseline is zero
 * — a relative change from zero is not a number, and a model whose training
 * RMSE was 0 has a bigger problem than decay.
 */
export function decayRatio(
  current: number,
  baseline: number | null | undefined,
  metricName: string,
): number | null {
  if (baseline === null || baseline === undefined || !Number.isFinite(baseline)) return null;
  if (baseline === 0) return null;
  const worse = higherIsBetter(metricName) ? baseline - current : current - baseline;
  return worse / Math.abs(baseline);
}

export type MlEvaluationVerdict = "stable" | "degraded" | "improved";

/**
 * The word attached to a decay ratio.
 *
 * "improved" is its own answer rather than a flavour of stable, because a
 * model that got markedly BETTER than its own validation score is usually not
 * good news — it is the outcome column leaking into the features, or the
 * evaluation matching the wrong rows. It deserves a look, not a green tick.
 */
export function evaluationVerdict(
  decay: number | null,
  threshold: number,
): MlEvaluationVerdict | null {
  if (decay === null) return null;
  if (decay >= threshold) return "degraded";
  if (decay <= -threshold) return "improved";
  return "stable";
}

/** Fraction of scored rows that had an answer to be judged against. */
export function coverage(matched: number, scored: number): number {
  return scored > 0 ? matched / scored : 0;
}
