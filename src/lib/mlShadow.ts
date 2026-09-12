// Does the candidate version agree with the one in production?
//
// NO IMPORTS, like the other src/lib/ml*.ts modules, so the scorer, the panel
// and the tests read one set of rules.
//
// A new version is normally tried by SWITCHING to it, which means the first
// evidence that it behaves differently is production behaving differently.
// Shadowing answers the question first: every request is mirrored to the
// candidate, its answer is thrown away, and the two are compared. Nobody
// waits for it and nobody is served by it.
//
// WHAT "AGREE" MEANS IS NOT THE SAME QUESTION FOR EVERY MODEL, and pretending
// it is would make the number meaningless:
//
//   A CLASSIFICATION either gives the same label or it does not. Agreement is
//   a proportion and reads exactly as it looks.
//
//   A REGRESSION almost never gives the identical float, so counting exact
//   matches would report 0% agreement on two models that are indistinguishable
//   in practice. What matters is whether the numbers differ ENOUGH TO ACT ON,
//   so the comparison is a tolerance and the headline is the typical gap.
//
// Nothing here is a decision. It measures; a person switches.

/** One row, as the two versions answered it. */
export type MlAnswerPair = {
  primary: unknown;
  candidate: unknown;
};

export type MlShadowTask = "classification" | "regression";

/** What one mirrored request produced. */
export type MlShadowComparison = {
  rows: number;
  /** Same label, or within tolerance for a regression. */
  agreed: number;
  /** Rows where the two versions would have led to different action. */
  disagreed: number;
  /**
   * Mean absolute difference, for a regression. Null for a classification,
   * where the idea does not apply and a zero would read as "identical".
   */
  meanAbsoluteDifference: number | null;
  /** A few rows that differed, for a person to look at rather than a count. */
  examples: { index: number; primary: unknown; candidate: unknown }[];
};

/**
 * How far two numbers may differ before it counts as a disagreement.
 *
 * Relative, because a £2 gap on a £4 prediction is a different event from a
 * £2 gap on a £40,000 one, and an absolute floor so that two predictions eps
 * apart from zero are not reported as infinitely different.
 */
export const REGRESSION_TOLERANCE = 0.01;
const ABSOLUTE_FLOOR = 1e-9;

const MAX_EXAMPLES = 5;

function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Same label, or near enough not to matter. */
export function rowsAgree(task: MlShadowTask, a: unknown, b: unknown): boolean {
  if (task === "classification") {
    // Compared as strings: the scorer returns whatever the label was in the
    // training data, and 1 and "1" are the same class.
    return String(a) === String(b);
  }
  const x = asNumber(a);
  const y = asNumber(b);
  // A number that cannot be read is not agreement. Treating it as agreement
  // would hide exactly the case worth catching: a candidate returning
  // something the primary never would.
  if (x === null || y === null) return false;
  const scale = Math.max(Math.abs(x), Math.abs(y), ABSOLUTE_FLOOR);
  return Math.abs(x - y) / scale <= REGRESSION_TOLERANCE;
}

/** Compare one mirrored request, row by row. */
export function compareAnswers(task: MlShadowTask, pairs: MlAnswerPair[]): MlShadowComparison {
  let agreed = 0;
  let diffSum = 0;
  let diffCount = 0;
  const examples: MlShadowComparison["examples"] = [];

  for (let i = 0; i < pairs.length; i++) {
    const { primary, candidate } = pairs[i];
    if (rowsAgree(task, primary, candidate)) {
      agreed++;
    } else if (examples.length < MAX_EXAMPLES) {
      examples.push({ index: i, primary, candidate });
    }
    if (task === "regression") {
      const x = asNumber(primary);
      const y = asNumber(candidate);
      if (x !== null && y !== null) {
        diffSum += Math.abs(x - y);
        diffCount++;
      }
    }
  }

  return {
    rows: pairs.length,
    agreed,
    disagreed: pairs.length - agreed,
    meanAbsoluteDifference: diffCount > 0 ? diffSum / diffCount : null,
    examples,
  };
}

/** The running totals a deployment keeps while a candidate is shadowed. */
export type MlShadowTotals = {
  requests: number;
  rows: number;
  agreed: number;
  /** Mirrored calls the candidate failed or never answered. */
  errors: number;
};

/** Share of compared rows the two versions answered the same way. */
export function agreementRate(totals: MlShadowTotals): number | null {
  if (totals.rows <= 0) return null;
  return totals.agreed / totals.rows;
}

export type MlShadowVerdict = "waiting" | "agrees" | "differs" | "failing";

/**
 * How much traffic is enough to say anything.
 *
 * Below this the agreement rate is a number about a handful of rows, and
 * showing it beside a verdict would invite a decision nobody has evidence for.
 */
export const MIN_ROWS_FOR_VERDICT = 100;

/**
 * How far apart is too far.
 *
 * A band rather than a threshold anyone should treat as a standard: two
 * versions of the same model on the same data usually agree on the large
 * majority of rows, and a tenth of traffic answering differently is a real
 * change worth looking at before it is switched on.
 */
export const AGREEMENT_FLOOR = 0.9;

/**
 * What to tell a reader.
 *
 * "failing" outranks everything: a candidate that errors is not a candidate
 * whose agreement is interesting, and reporting 98% agreement on the calls it
 * managed to answer would be the most misleading thing on the page.
 */
export function shadowVerdict(totals: MlShadowTotals): MlShadowVerdict {
  if (totals.errors > 0 && totals.errors >= Math.max(1, totals.requests * 0.05)) return "failing";
  const rate = agreementRate(totals);
  if (rate === null || totals.rows < MIN_ROWS_FOR_VERDICT) return "waiting";
  return rate >= AGREEMENT_FLOOR ? "agrees" : "differs";
}

/** Rows still needed before the verdict means anything. */
export function rowsUntilVerdict(totals: MlShadowTotals): number {
  return Math.max(0, MIN_ROWS_FOR_VERDICT - totals.rows);
}

/**
 * Merge one request's comparison into the running totals.
 *
 * Addition rather than a recomputed average, because the totals outlive any
 * one request and re-deriving them would mean keeping every comparison.
 *
 * THE SERVER DOES NOT CALL THIS. A read-modify-write would lose counts under
 * concurrent requests, so `record_ml_shadow_result` applies the same four
 * additions inside one statement. This is the readable statement of the rule
 * and the oracle the SQL is held to; tests/unit/mlShadowWiring.test.ts checks
 * the two agree, because the arithmetic now lives in two places.
 */
export function addComparison(
  totals: MlShadowTotals,
  c: MlShadowComparison | null,
): MlShadowTotals {
  if (!c) return { ...totals, requests: totals.requests + 1, errors: totals.errors + 1 };
  return {
    requests: totals.requests + 1,
    rows: totals.rows + c.rows,
    agreed: totals.agreed + c.agreed,
    errors: totals.errors,
  };
}
