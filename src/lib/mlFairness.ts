// Does the model treat groups differently?
//
// NO IMPORTS, like src/lib/mlEvaluation.ts, and for the same reason: the
// editor, the scheduler and the tests read one set of rules.
//
// Two questions, and they are genuinely different:
//
//   SELECTION RATE asks how often each group gets the favourable answer. It
//   needs no ground truth, only the scored table, so it can be checked the
//   moment a batch runs. This is the one employment and lending law is written
//   about — the four-fifths rule below.
//
//   ERROR RATES ask whether the model is WRONG more often for one group. That
//   needs the real outcomes, so it rides on the same join an evaluation makes.
//   A model can have identical selection rates and still be far worse at one
//   group, which is why both are reported rather than one.
//
// ONE RULE ABOUT THE FAVOURABLE OUTCOME: it is named by a person, never
// inferred. Which label is the good one is a fact about the world — "approved"
// is favourable, "fraud" is not, and "churn" depends on who is asking — and a
// platform that guessed would put its guess in a compliance report.

/** What a fairness check is configured to look at. */
export type MlFairnessConfig = {
  /** Columns to slice by. Present in the scored table. */
  sensitive_columns: string[];
  /**
   * The predicted label that counts as the good outcome, for selection rate.
   * Null means selection rate is not reported — only error rates, and only
   * where outcomes exist.
   */
  favourable_label: string | null;
};

/** One group's numbers, as the statement returns them. */
export type MlGroupCount = {
  group: string;
  n: number;
  /** Rows predicted favourable. */
  selected: number;
};

/** One group's numbers when outcomes are known. */
export type MlGroupOutcome = {
  group: string;
  /** predicted favourable AND actually favourable */
  tp: number;
  /** predicted favourable, actually not */
  fp: number;
  /** predicted not favourable, actually favourable */
  fn: number;
  /** predicted not favourable, actually not */
  tn: number;
};

export type MlFairnessGroup = {
  group: string;
  n: number;
  selection_rate: number | null;
  /** Of those who actually were favourable, the share the model found. */
  true_positive_rate: number | null;
  /** Of those who actually were not, the share the model wrongly picked. */
  false_positive_rate: number | null;
  accuracy: number | null;
};

export type MlFairnessResult = {
  column: string;
  groups: MlFairnessGroup[];
  /** Lowest selection rate over highest. Null when rates are unavailable. */
  disparate_impact: number | null;
  /** Largest true-positive-rate gap between two groups. */
  equal_opportunity_gap: number | null;
  /** The group with the lowest selection rate, when there is one. */
  lowest_group: string | null;
};

/**
 * The four-fifths rule, as a default rather than a law.
 *
 * A selection rate below four fifths of the best group's is the threshold the
 * US EEOC's Uniform Guidelines use as prima facie evidence of adverse impact.
 * It is a rule of thumb with no statistical claim behind it, it is not the
 * standard everywhere, and a deployment may set its own — so it is the default
 * of a knob, and the docs say what it is rather than implying a verdict.
 */
export const FOUR_FIFTHS = 0.8;

/**
 * Groups smaller than this are reported but never drive a verdict.
 *
 * A selection rate over four people swings by 25% when one of them changes,
 * so a small group produces alarming ratios out of arithmetic rather than
 * unfairness — and one false alarm is enough for somebody to switch the whole
 * check off.
 */
export const MIN_GROUP_FOR_VERDICT = 30;

/** Cap on distinct groups, so a free-text column cannot become a report. */
export const MAX_GROUPS = 50;

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const qi = (name: string) => `"${name.replace(/"/g, '""')}"`;
const ql = (v: string) => `'${v.replace(/'/g, "''")}'`;

export function validateFairnessConfig(cfg: MlFairnessConfig): string | null {
  if (!cfg.sensitive_columns.length) return "Choose at least one column to compare groups by";
  if (cfg.sensitive_columns.length > 8) return "At most 8 columns";
  for (const c of cfg.sensitive_columns) {
    if (!IDENT_RE.test(c)) return `"${c}" is not a column name`;
  }
  if (new Set(cfg.sensitive_columns).size !== cfg.sensitive_columns.length) {
    return "A column is named twice";
  }
  return null;
}

/**
 * Rows and favourable predictions per group, from the scored table alone.
 *
 * `CAST(... AS VARCHAR)` on the group so a boolean or a number slices the same
 * way a string does, and a NULL group is reported as its own group rather than
 * dropped — "we did not record this person's ethnicity" is a group, and in
 * practice often the interesting one.
 */
export function selectionSql(
  scored: { schema: string; table: string },
  column: string,
  favourable: string | null,
  predictionColumn = "prediction",
): string {
  const t = `${qi(scored.schema)}.${qi(scored.table)}`;
  const g = `coalesce(CAST(${qi(column)} AS VARCHAR), '(not recorded)')`;
  const sel =
    favourable === null
      ? "0"
      : `sum(CASE WHEN CAST(${qi(predictionColumn)} AS VARCHAR) = ${ql(favourable)} THEN 1 ELSE 0 END)`;
  return (
    `SELECT ${g} AS grp, count(*) AS n, ${sel} AS selected ` +
    `FROM ${t} GROUP BY 1 ORDER BY 2 DESC LIMIT ${MAX_GROUPS + 1}`
  );
}

/**
 * The four cells of a per-group confusion matrix, against real outcomes.
 *
 * The same INNER join an evaluation makes, for the same reason: a prediction
 * whose answer has not arrived is not a mistake, and counting it as one would
 * make the newest group look worst.
 */
export function groupOutcomeSql(
  scored: { schema: string; table: string },
  outcome: { schema: string; table: string; key_columns: string[]; outcome_column: string },
  column: string,
  favourable: string,
  predictionColumn = "prediction",
): string {
  const p = `${qi(scored.schema)}.${qi(scored.table)}`;
  const a = `${qi(outcome.schema)}.${qi(outcome.table)}`;
  const on = outcome.key_columns.map((c) => `p.${qi(c)} = a.${qi(c)}`).join(" AND ");
  const g = `coalesce(CAST(p.${qi(column)} AS VARCHAR), '(not recorded)')`;
  const pf = `CAST(p.${qi(predictionColumn)} AS VARCHAR) = ${ql(favourable)}`;
  const af = `CAST(a.${qi(outcome.outcome_column)} AS VARCHAR) = ${ql(favourable)}`;
  return (
    `SELECT ${g} AS grp, ` +
    `sum(CASE WHEN ${pf} AND ${af} THEN 1 ELSE 0 END) AS tp, ` +
    `sum(CASE WHEN ${pf} AND NOT ${af} THEN 1 ELSE 0 END) AS fp, ` +
    `sum(CASE WHEN NOT ${pf} AND ${af} THEN 1 ELSE 0 END) AS fn, ` +
    `sum(CASE WHEN NOT ${pf} AND NOT ${af} THEN 1 ELSE 0 END) AS tn ` +
    `FROM ${p} AS p JOIN ${a} AS a ON ${on} ` +
    `WHERE a.${qi(outcome.outcome_column)} IS NOT NULL GROUP BY 1 LIMIT ${MAX_GROUPS + 1}`
  );
}

const rate = (num: number, den: number) => (den > 0 ? num / den : null);

/** Fold the statements' rows into one comparable result. */
export function fairnessResult(
  column: string,
  counts: MlGroupCount[],
  outcomes: MlGroupOutcome[] | null,
  favourable: string | null,
): MlFairnessResult {
  const byGroup = new Map(outcomes?.map((o) => [o.group, o]) ?? []);
  const groups: MlFairnessGroup[] = counts.map((c) => {
    const o = byGroup.get(c.group);
    const matched = o ? o.tp + o.fp + o.fn + o.tn : 0;
    return {
      group: c.group,
      n: c.n,
      selection_rate: favourable === null ? null : rate(c.selected, c.n),
      true_positive_rate: o ? rate(o.tp, o.tp + o.fn) : null,
      false_positive_rate: o ? rate(o.fp, o.fp + o.tn) : null,
      accuracy: o ? rate(o.tp + o.tn, matched) : null,
    };
  });

  // Only groups big enough to mean something drive the verdict, but every
  // group is still reported — hiding a small group is how a real problem
  // stays invisible for a quarter.
  const judged = groups.filter((g) => g.n >= MIN_GROUP_FOR_VERDICT);
  const rates = judged
    .map((g) => g.selection_rate)
    .filter((r): r is number => r !== null && Number.isFinite(r));
  const tprs = judged
    .map((g) => g.true_positive_rate)
    .filter((r): r is number => r !== null && Number.isFinite(r));

  const max = rates.length ? Math.max(...rates) : 0;
  const min = rates.length ? Math.min(...rates) : 0;
  const lowest = judged.find((g) => g.selection_rate === min && rates.length > 1);

  return {
    column,
    groups,
    disparate_impact: rates.length > 1 && max > 0 ? min / max : null,
    equal_opportunity_gap: tprs.length > 1 ? Math.max(...tprs) - Math.min(...tprs) : null,
    lowest_group: lowest?.group ?? null,
  };
}

export type MlFairnessVerdict = "even" | "review" | "unmeasurable";

/**
 * A word for the ratio — and deliberately not the word "fair".
 *
 * Nothing computable here decides whether a model is fair; that is a judgement
 * about a context this platform cannot see. What a ratio can say is that the
 * groups came out far enough apart to be worth a person's attention, which is
 * what "review" means.
 */
export function fairnessVerdict(result: MlFairnessResult, minRatio: number): MlFairnessVerdict {
  if (result.disparate_impact === null) return "unmeasurable";
  return result.disparate_impact < minRatio ? "review" : "even";
}
