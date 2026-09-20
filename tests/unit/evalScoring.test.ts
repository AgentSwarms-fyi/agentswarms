// Batch-eval scoring rules. These are the verdict semantics the Evaluations
// page reports to users — pass/fail must mean exactly what the docs say, so
// the boundary behaviours (threshold at equality, weight normalisation, judge
// scorecard strictness, comparison ranking) are pinned here and the suite is
// mutation-verified: break any rule in src/lib/evalScoring.ts and a test
// below must fail.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import {
  isComparableRun,
  compareRuns,
  DEFAULT_JUDGE_METRICS,
  deterministicVerdict,
  judgeVerdict,
  parseScorecard,
  validateEvaluator,
  weightedOverall,
  type EvalEvaluator,
  type EvalJudgeMetric,
  type EvalResultLite,
} from "@/lib/evalScoring";

const M = (id: string, weight: number): EvalJudgeMetric => ({
  id,
  name: id,
  description: id,
  weight,
});

const judge = (
  threshold: number,
  metrics = DEFAULT_JUDGE_METRICS,
): Extract<EvalEvaluator, { kind: "llm_judge" }> => ({ kind: "llm_judge", metrics, threshold });

describe("validateEvaluator", () => {
  it("accepts the default judge and rejects broken configs", () => {
    expect(validateEvaluator(judge(0.7))).toBeNull();
    expect(validateEvaluator(judge(0.7, []))).toMatch(/at least one metric/);
    expect(validateEvaluator(judge(0.7, [M("a", 0)]))).toMatch(/positive/);
    expect(validateEvaluator(judge(0.7, [M("a", 1), M("a", 2)]))).toMatch(/unique/);
    expect(validateEvaluator(judge(1.5))).toMatch(/between 0 and 1/);
    expect(validateEvaluator(judge(-0.1))).toMatch(/between 0 and 1/);
  });

  it("validates regex patterns", () => {
    expect(validateEvaluator({ kind: "regex", pattern: "^ok" })).toBeNull();
    expect(validateEvaluator({ kind: "regex", pattern: "(" })).toMatch(/Invalid pattern/);
    expect(validateEvaluator({ kind: "regex", pattern: "" })).toMatch(/needs a pattern/);
  });
});

describe("parseScorecard", () => {
  const metrics = [M("correctness", 3), M("clarity", 1)];

  it("parses clean and fenced JSON", () => {
    const raw =
      '{"metrics":{"correctness":{"score":0.9,"reason":"solid"},"clarity":{"score":0.5}},"summary":"ok"}';
    const clean = parseScorecard(raw, metrics);
    expect(clean.metrics.correctness.score).toBe(0.9);
    expect(clean.metrics.correctness.reason).toBe("solid");
    expect(clean.metrics.clarity.score).toBe(0.5);
    expect(clean.summary).toBe("ok");
    const fenced = parseScorecard("Here you go:\n```json\n" + raw + "\n```", metrics);
    expect(fenced.metrics.correctness.score).toBe(0.9);
  });

  it("rejects a scorecard that skipped a metric — no silent zero", () => {
    expect(() => parseScorecard('{"metrics":{"correctness":{"score":1}}}', metrics)).toThrow(
      /clarity/,
    );
  });

  it("rejects out-of-range and non-numeric scores", () => {
    expect(() =>
      parseScorecard('{"metrics":{"correctness":{"score":1.2},"clarity":{"score":0.5}}}', metrics),
    ).toThrow();
    expect(() =>
      parseScorecard(
        '{"metrics":{"correctness":{"score":"high"},"clarity":{"score":0.5}}}',
        metrics,
      ),
    ).toThrow();
  });

  it("rejects non-JSON output", () => {
    expect(() => parseScorecard("I would rate this highly.", metrics)).toThrow(/no JSON/);
  });
});

describe("weightedOverall + judgeVerdict", () => {
  it("weights the average by metric weight, not per-metric equally", () => {
    const metrics = [M("a", 3), M("b", 2), M("c", 1)];
    const overall = weightedOverall(metrics, {
      metrics: { a: { score: 1 }, b: { score: 0.5 }, c: { score: 0 } },
    });
    // (1*3 + 0.5*2 + 0*1) / 6 = 4/6 — equal weighting would give 0.5.
    expect(overall).toBeCloseTo(4 / 6, 10);
  });

  it("passes AT the threshold (>=), fails just below", () => {
    const e = judge(0.7, [M("a", 1)]);
    expect(judgeVerdict(e, { metrics: { a: { score: 0.7 } } }).status).toBe("pass");
    expect(judgeVerdict(e, { metrics: { a: { score: 0.6999 } } }).status).toBe("fail");
  });

  it("ignores the judge's own pass/overall fields — verdict is recomputed", () => {
    // A scorecard whose scores average 0.2 must fail a 0.7 threshold no matter
    // what the judge claimed elsewhere (those fields never reach the verdict).
    const e = judge(0.7, [M("a", 1)]);
    const v = judgeVerdict(e, { metrics: { a: { score: 0.2 } } });
    expect(v.status).toBe("fail");
    expect(v.score).toBeCloseTo(0.2, 6);
  });
});

describe("deterministicVerdict", () => {
  it("contains: case-insensitive by default, case-sensitive on request", () => {
    const insensitive = deterministicVerdict({ kind: "contains" }, "The Answer is 42.", "answer");
    expect(insensitive.status).toBe("pass");
    const sensitive = deterministicVerdict(
      { kind: "contains", caseSensitive: true },
      "The Answer is 42.",
      "answer",
    );
    expect(sensitive.status).toBe("fail");
  });

  it("contains: falls back to the evaluator value, fails with no needle at all", () => {
    expect(deterministicVerdict({ kind: "contains", value: "42" }, "it is 42", null).status).toBe(
      "pass",
    );
    expect(deterministicVerdict({ kind: "contains" }, "anything", null).status).toBe("fail");
  });

  it("exact: trims, ignores case by default, and never passes an empty expectation", () => {
    expect(deterministicVerdict({ kind: "exact" }, "  Yes \n", "yes").status).toBe("pass");
    expect(deterministicVerdict({ kind: "exact", caseSensitive: true }, "Yes", "yes").status).toBe(
      "fail",
    );
    expect(deterministicVerdict({ kind: "exact" }, "", null).status).toBe("fail");
    expect(deterministicVerdict({ kind: "exact" }, "", "").status).toBe("fail");
  });

  it("regex: dot matches newlines so multi-line outputs are testable", () => {
    expect(
      deterministicVerdict({ kind: "regex", pattern: "start.*end" }, "start\nmiddle\nend", null)
        .status,
    ).toBe("pass");
  });
});

describe("compareRuns", () => {
  const r = (
    id: string | null,
    status: EvalResultLite["status"],
    score: number | null,
    input = id ?? "x",
  ): EvalResultLite => ({ case_id: id, case_name: id ?? input, case_input: input, status, score });

  it("classifies verdict flips and leaves score-only moves as 'same'", () => {
    const baseline = [r("c1", "fail", 0.4), r("c2", "pass", 0.9), r("c3", "pass", 0.8)];
    const candidate = [r("c1", "pass", 0.8), r("c2", "fail", 0.3), r("c3", "pass", 0.6)];
    const deltas = compareRuns(baseline, candidate);
    const byKey = new Map(deltas.map((d) => [d.key, d]));
    expect(byKey.get("c1")?.change).toBe("improved");
    expect(byKey.get("c2")?.change).toBe("regressed");
    expect(byKey.get("c3")?.change).toBe("same");
    expect(byKey.get("c3")?.scoreDelta).toBeCloseTo(-0.2, 6);
  });

  it("treats error → fail as an improvement (it at least ran)", () => {
    const deltas = compareRuns([r("c1", "error", null)], [r("c1", "fail", 0.2)]);
    expect(deltas[0].change).toBe("improved");
    expect(deltas[0].scoreDelta).toBeNull();
  });

  it("pairs by input text when the case row was deleted since", () => {
    const deltas = compareRuns(
      [r(null, "fail", 0.1, "same question")],
      [r(null, "pass", 0.9, "same question")],
    );
    expect(deltas).toHaveLength(1);
    expect(deltas[0].change).toBe("improved");
  });

  it("reports unmatched cases on either side", () => {
    const deltas = compareRuns([r("only-in-a", "pass", 1)], [r("only-in-b", "pass", 1)]);
    expect(deltas.map((d) => d.change).sort()).toEqual(["only_a", "only_b"]);
  });
});

describe("which runs can serve as a baseline", () => {
  // The page used to pick baselines by filtering the fifty most recent runs
  // ACROSS every dataset. On a busy account a perfectly good baseline falls off
  // the end of that list, and the compare control then vanished entirely — no
  // picker and no message, so "there is nothing to compare" looked exactly like
  // "your baseline is run fifty-one".
  const run = (over: Partial<Parameters<typeof isComparableRun>[0]> = {}) => ({
    id: "a",
    dataset_id: "d1",
    evaluator: { kind: "contains" },
    ...over,
  });

  it("accepts another run on the same dataset with the same evaluator", () => {
    expect(isComparableRun(run({ id: "b" }), run())).toBe(true);
  });

  it("never compares a run against itself", () => {
    expect(isComparableRun(run(), run())).toBe(false);
  });

  it("refuses a run on a different dataset", () => {
    expect(isComparableRun(run({ id: "b", dataset_id: "d2" }), run())).toBe(false);
  });

  it("refuses a different evaluator kind, whose scores are on another scale", () => {
    // `contains` scores 0 or 1; a judge scores a continuous 0-1. A delta
    // between them measures the scale change, not the swarm.
    expect(isComparableRun(run({ id: "b", evaluator: { kind: "llm_judge" } }), run())).toBe(false);
  });

  it("refuses when either run has no dataset at all", () => {
    // Two runs that both have `dataset_id: null` are not on the same dataset;
    // they are each on no dataset, and pairing them invents a comparison.
    expect(isComparableRun(run({ id: "b", dataset_id: null }), run())).toBe(false);
    expect(isComparableRun(run({ id: "b" }), run({ dataset_id: null }))).toBe(false);
    expect(isComparableRun(run({ id: "b", dataset_id: null }), run({ dataset_id: null }))).toBe(
      false,
    );
  });

  it("treats a missing evaluator as its own kind, matching only another missing one", () => {
    expect(isComparableRun(run({ id: "b", evaluator: null }), run({ evaluator: null }))).toBe(true);
    expect(isComparableRun(run({ id: "b", evaluator: null }), run())).toBe(false);
  });

  it("is chosen by a query scoped to the dataset, not by filtering a global list", () => {
    // The rule above is only half the fix. The other half is asking the
    // database for runs on THIS dataset — filtering a capped list of recent
    // runs would still lose an older baseline however correct the rule is.
    const src = readFileSync("src/routes/_authenticated/evaluations.tsx", "utf8");
    expect(src).toContain('.eq("dataset_id", run.dataset_id)');
    expect(src).toContain('.neq("id", run.id)');
    expect(src).toContain("isComparableRun(r, run)");
    // And the old global filter is gone.
    expect(src).not.toMatch(/runs\.filter\(\s*\(r\) =>/);
    // The picker's own bound is disclosed rather than silent, and an empty
    // result now says so instead of removing the control.
    // The COMPUTATION, not the identifier: asserting that `olderThanShown`
    // merely appears was satisfied by a mutant that always set it to 0, which
    // silences the disclosure while leaving the variable in place.
    expect(src).toContain("setOlderThanShown(Math.max(0, (count ?? 0) - (data?.length ?? 0)));");
    expect(src).toContain("there is nothing to compare");
    // And a FAILED read must not arrive at that same sentence. The shared
    // failed-read guard only checks that an error setter sits near the
    // emptying line, which both of these mutants preserved — so the branch and
    // its rendering are pinned here.
    expect(src).toContain("if (error) {");
    expect(src).toContain("setCompareError(error.message);");
    expect(src).toContain("{compareError !== null && (");
  });
});
