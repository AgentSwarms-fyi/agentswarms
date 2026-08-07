// Batch-eval scoring: evaluator config, scorecard parsing and verdicts.
//
// PURE module — no Supabase, no fetch — shared by the server executor (which
// scores real runs) and the unit tests (which mutation-verify the rules).
//
// One run has ONE evaluator, so every result in a run is scored the same way
// and runs over the same dataset stay comparable:
//   llm_judge — an LLM scores each output 0–1 per metric; the OVERALL score is
//               recomputed here from the per-metric scores and weights. The
//               judge's own `pass`/`overall_score` fields are display hints,
//               never trusted for the verdict.
//   contains  — output must contain the case's expected text (or the
//               evaluator's fixed value when the case has none).
//   exact     — output equals expected after trimming.
//   regex     — evaluator's pattern must match the output.

export type EvalJudgeMetric = {
  id: string;
  name: string;
  description: string;
  weight: number;
};

export type EvalEvaluator =
  | {
      kind: "llm_judge";
      metrics: EvalJudgeMetric[];
      rubric?: string;
      /** Overall score at or above this passes. */
      threshold: number;
      provider?: string;
      model?: string;
    }
  | { kind: "contains"; value?: string; caseSensitive?: boolean }
  | { kind: "exact"; caseSensitive?: boolean }
  | { kind: "regex"; pattern: string };

export type EvalScorecard = {
  metrics: Record<string, { score: number; reason?: string }>;
  summary?: string;
};

export type EvalVerdict = {
  status: "pass" | "fail";
  /** 0–1. Judge: recomputed weighted overall. Deterministic: 1 or 0. */
  score: number;
  scorecard?: EvalScorecard;
};

export const DEFAULT_JUDGE_METRICS: EvalJudgeMetric[] = [
  {
    id: "correctness",
    name: "Correctness",
    weight: 3,
    description:
      "Is the output factually right and consistent with the reference when one is given?",
  },
  {
    id: "completeness",
    name: "Completeness",
    weight: 2,
    description: "Does it cover everything the input asked for, without significant omissions?",
  },
  {
    id: "clarity",
    name: "Clarity",
    weight: 1,
    description: "Is it well-structured, unambiguous and free of filler?",
  },
];

export const DEFAULT_JUDGE_THRESHOLD = 0.7;

export function validateEvaluator(e: EvalEvaluator): string | null {
  if (e.kind === "llm_judge") {
    if (!Array.isArray(e.metrics) || e.metrics.length === 0)
      return "The judge needs at least one metric.";
    for (const m of e.metrics) {
      if (!m.id.trim() || !m.name.trim()) return "Every metric needs an id and a name.";
      if (!Number.isFinite(m.weight) || m.weight <= 0)
        return `Metric "${m.name}": weight must be a positive number.`;
    }
    const ids = new Set(e.metrics.map((m) => m.id));
    if (ids.size !== e.metrics.length) return "Metric ids must be unique.";
    if (!Number.isFinite(e.threshold) || e.threshold < 0 || e.threshold > 1)
      return "Threshold must be between 0 and 1.";
    return null;
  }
  if (e.kind === "regex") {
    if (!e.pattern) return "The regex evaluator needs a pattern.";
    try {
      new RegExp(e.pattern);
    } catch (err) {
      return `Invalid pattern: ${(err as Error).message}`;
    }
    return null;
  }
  return null;
}

/**
 * Parse the judge's JSON scorecard. Tolerates markdown fences and leading
 * prose, but every configured metric must be present with a numeric score in
 * [0, 1] — a judge that skipped a metric did not do the job, and treating the
 * gap as 0 would silently fail candidates for the judge's mistake.
 */
export function parseScorecard(raw: string, metrics: EvalJudgeMetric[]): EvalScorecard {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("judge returned no JSON object");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new Error("judge returned invalid JSON");
  }
  const obj = parsed as {
    metrics?: Record<string, { score?: unknown; reason?: unknown }>;
    summary?: unknown;
  };
  if (!obj.metrics || typeof obj.metrics !== "object")
    throw new Error("judge scorecard has no metrics object");
  const out: EvalScorecard = {
    metrics: {},
    summary: typeof obj.summary === "string" ? obj.summary : undefined,
  };
  for (const m of metrics) {
    const entry = obj.metrics[m.id];
    const score = entry ? Number(entry.score) : NaN;
    if (!Number.isFinite(score) || score < 0 || score > 1)
      throw new Error(`judge scorecard is missing a valid score for metric "${m.id}"`);
    out.metrics[m.id] = {
      score,
      reason: typeof entry?.reason === "string" ? entry.reason : undefined,
    };
  }
  return out;
}

/** Weighted average of per-metric scores. Weights are normalised here. */
export function weightedOverall(metrics: EvalJudgeMetric[], scorecard: EvalScorecard): number {
  let total = 0;
  let weightSum = 0;
  for (const m of metrics) {
    const s = scorecard.metrics[m.id]?.score;
    if (s === undefined) continue;
    total += s * m.weight;
    weightSum += m.weight;
  }
  if (weightSum === 0) return 0;
  return total / weightSum;
}

/** Deterministic verdicts; llm_judge verdicts go through judgeVerdict. */
export function deterministicVerdict(
  e: Exclude<EvalEvaluator, { kind: "llm_judge" }>,
  output: string,
  expected: string | null,
): EvalVerdict {
  if (e.kind === "contains") {
    const needle = (expected ?? "").trim() || (e.value ?? "").trim();
    if (!needle) return { status: "fail", score: 0 };
    const hay = e.caseSensitive ? output : output.toLowerCase();
    const n = e.caseSensitive ? needle : needle.toLowerCase();
    const ok = hay.includes(n);
    return { status: ok ? "pass" : "fail", score: ok ? 1 : 0 };
  }
  if (e.kind === "exact") {
    const want = (expected ?? "").trim();
    const got = output.trim();
    const ok = e.caseSensitive ? got === want : got.toLowerCase() === want.toLowerCase();
    return { status: ok && want !== "" ? "pass" : "fail", score: ok && want !== "" ? 1 : 0 };
  }
  // regex
  const ok = new RegExp(e.pattern, "s").test(output);
  return { status: ok ? "pass" : "fail", score: ok ? 1 : 0 };
}

export function judgeVerdict(
  e: Extract<EvalEvaluator, { kind: "llm_judge" }>,
  scorecard: EvalScorecard,
): EvalVerdict {
  const overall = weightedOverall(e.metrics, scorecard);
  return {
    status: overall >= e.threshold ? "pass" : "fail",
    score: Math.round(overall * 10000) / 10000,
    scorecard,
  };
}

// ── Run comparison ───────────────────────────────────────────────────────────

export type EvalResultLite = {
  case_id: string | null;
  case_name: string;
  case_input: string;
  status: "pass" | "fail" | "error";
  score: number | null;
};

export type EvalCaseDelta = {
  key: string;
  case_name: string;
  case_input: string;
  a: EvalResultLite | null;
  b: EvalResultLite | null;
  scoreDelta: number | null;
  /** improved / regressed track VERDICT flips; score moves alone are "same". */
  change: "improved" | "regressed" | "same" | "only_a" | "only_b";
};

const rank = (s: EvalResultLite["status"]) => (s === "pass" ? 2 : s === "fail" ? 1 : 0);

/**
 * Pair two runs' results case-by-case (by case id, falling back to the
 * denormalised input text for cases deleted since) and classify each pair.
 * `a` is the baseline, `b` the candidate: a case that fails in `a` and passes
 * in `b` is an improvement.
 */
export function compareRuns(a: EvalResultLite[], b: EvalResultLite[]): EvalCaseDelta[] {
  const keyOf = (r: EvalResultLite) => r.case_id ?? `input:${r.case_input}`;
  const bIndex = new Map(b.map((r) => [keyOf(r), r]));
  const seen = new Set<string>();
  const out: EvalCaseDelta[] = [];
  for (const ra of a) {
    const key = keyOf(ra);
    seen.add(key);
    const rb = bIndex.get(key) ?? null;
    if (!rb) {
      out.push({
        key,
        case_name: ra.case_name,
        case_input: ra.case_input,
        a: ra,
        b: null,
        scoreDelta: null,
        change: "only_a",
      });
      continue;
    }
    const scoreDelta =
      ra.score !== null && rb.score !== null
        ? Math.round((rb.score - ra.score) * 10000) / 10000
        : null;
    const change =
      rank(rb.status) > rank(ra.status)
        ? "improved"
        : rank(rb.status) < rank(ra.status)
          ? "regressed"
          : "same";
    out.push({
      key,
      case_name: ra.case_name,
      case_input: ra.case_input,
      a: ra,
      b: rb,
      scoreDelta,
      change,
    });
  }
  for (const rb of b) {
    const key = keyOf(rb);
    if (seen.has(key)) continue;
    out.push({
      key,
      case_name: rb.case_name,
      case_input: rb.case_input,
      a: null,
      b: rb,
      scoreDelta: null,
      change: "only_b",
    });
  }
  return out;
}
