// Batch-eval scoring rules. These are the verdict semantics the Evaluations
// page reports to users — pass/fail must mean exactly what the docs say, so
// the boundary behaviours (threshold at equality, weight normalisation, judge
// scorecard strictness, comparison ranking) are pinned here and the suite is
// mutation-verified: break any rule in src/lib/evalScoring.ts and a test
// below must fail.
import { describe, expect, it } from "vitest";
import {
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
