// Grading for the NL-to-SQL evaluation.
//
// Graded on EXECUTION ACCURACY, not SQL text. Many different statements answer
// the same question correctly, so comparing strings would score paraphrases as
// failures and teach the prompt to imitate one author's style rather than to
// be right. Each question ships a REFERENCE query; the candidate passes when
// its result set matches the reference's on the same data.
//
// This is the standard used by Spider and BIRD for the same reason.

import { canonRows } from "../../tests/differential/engines";

export type Verdict =
  | { outcome: "pass" }
  | { outcome: "wrong"; expected: string; actual: string }
  | { outcome: "error"; error: string }
  | { outcome: "refused"; error: string };

export type GradeInput = {
  /** Rows the reference query returned. */
  expected: Record<string, unknown>[];
  /** Rows the model's query returned, or the error it raised. */
  actual: Record<string, unknown>[] | { error: string };
  /** True when the question's answer depends on row order (a ranking). */
  ordered: boolean;
};

/**
 * Compare a candidate result against the reference.
 *
 * Column NAMES are ignored: "SELECT SUM(sales) AS total" and "... AS
 * total_sales" are the same answer, and penalising the alias would measure
 * naming taste. Column VALUES are compared exactly, after the same
 * canonicalisation the differential harness uses (so 100 and "100" match, but
 * 100 and 101 never do).
 */
export function grade(input: GradeInput): Verdict {
  if (!Array.isArray(input.actual)) {
    const error = input.actual.error;
    // A refusal to emit SQL at all is a different failure from SQL that ran
    // and returned the wrong thing; they need different fixes.
    const refused = /only read-only|not a select|refus|cannot|no such (table|column)/i.test(error);
    return refused ? { outcome: "refused", error } : { outcome: "error", error };
  }

  const expected = canonValues(input.expected, input.ordered);
  const actual = canonValues(input.actual, input.ordered);
  if (expected === actual) return { outcome: "pass" };
  return { outcome: "wrong", expected, actual };
}

/** Canonical form with column names stripped, so aliases don't matter. */
function canonValues(rows: Record<string, unknown>[], ordered: boolean): string {
  const positional = rows.map((r) => {
    // Sort by key so column ORDER doesn't matter either; only the multiset of
    // values in each row does.
    const keys = Object.keys(r).sort();
    return Object.fromEntries(keys.map((k, i) => [`c${i}`, r[k]]));
  });
  return canonRows(positional, ordered);
}

export type Summary = {
  total: number;
  passed: number;
  wrong: number;
  errored: number;
  refused: number;
  accuracy: number;
  byCategory: Record<string, { total: number; passed: number }>;
};

export function summarize(results: { category: string; verdict: Verdict }[]): Summary {
  const s: Summary = {
    total: results.length,
    passed: 0,
    wrong: 0,
    errored: 0,
    refused: 0,
    accuracy: 0,
    byCategory: {},
  };
  for (const r of results) {
    const cat = (s.byCategory[r.category] ??= { total: 0, passed: 0 });
    cat.total++;
    if (r.verdict.outcome === "pass") {
      s.passed++;
      cat.passed++;
    } else if (r.verdict.outcome === "wrong") s.wrong++;
    else if (r.verdict.outcome === "refused") s.refused++;
    else s.errored++;
  }
  s.accuracy = s.total === 0 ? 0 : s.passed / s.total;
  return s;
}
