// Parsing + aggregation for Evaluate-node scorecards (quality trends).
//
// An `evaluate` node runs LLM-as-a-judge and stores a JSON scorecard as the
// swarm_run_step `output` text:
//   { "metrics": { "<id>": { "score": 0..1, "reason": "…" }, … },
//     "overall_score": 0..1, "pass": <bool>, "summary": "…" }
//
// The judge is instructed to emit clean JSON, but models drift (code fences,
// leading prose, a missing field). Everything here is defensive: a row that
// can't be parsed is skipped, never thrown, so one bad scorecard can't break
// the quality view. Pure + framework-free so it can be unit-tested directly.

export interface EvalScorecard {
  overall: number | null; // 0..1
  pass: boolean | null;
  metrics: Record<string, number>; // metricId → score 0..1
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/** Best-effort JSON extraction: direct parse, then fenced block, then brace span. */
function looseJson(text: string): unknown | null {
  const attempts: string[] = [text];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) attempts.push(fenced[1]);
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last > first) attempts.push(text.slice(first, last + 1));
  for (const a of attempts) {
    try {
      const v = JSON.parse(a.trim());
      if (v && typeof v === "object") return v;
    } catch {
      /* try next strategy */
    }
  }
  return null;
}

/**
 * Parse an evaluate-node output into a scorecard, or null if nothing usable.
 * `overall` falls back to the mean of per-metric scores when `overall_score`
 * is absent; a scorecard with neither an overall nor any metric is dropped.
 */
export function parseEvalScorecard(output: string | null | undefined): EvalScorecard | null {
  if (!output || typeof output !== "string") return null;
  const obj = looseJson(output) as Record<string, unknown> | null;
  if (!obj) return null;

  const metrics: Record<string, number> = {};
  const rawMetrics = obj.metrics;
  if (rawMetrics && typeof rawMetrics === "object") {
    for (const [id, m] of Object.entries(rawMetrics as Record<string, unknown>)) {
      const score = m && typeof m === "object" ? (m as { score?: unknown }).score : m;
      const n = Number(score);
      if (Number.isFinite(n)) metrics[id] = clamp01(n);
    }
  }

  let overall: number | null = null;
  const rawOverall = Number(obj.overall_score);
  if (Number.isFinite(rawOverall)) overall = clamp01(rawOverall);
  else {
    const vals = Object.values(metrics);
    if (vals.length) overall = clamp01(vals.reduce((s, v) => s + v, 0) / vals.length);
  }

  if (overall == null && Object.keys(metrics).length === 0) return null;

  const pass = typeof obj.pass === "boolean" ? obj.pass : null;
  return { overall, pass, metrics };
}

// ── aggregation ────────────────────────────────────────────────────────────
export interface QualityItem {
  started_at: string;
  swarm_name: string;
  overall: number | null;
  pass: boolean | null;
  metrics: Record<string, number>;
}

export interface QualityTrends {
  total: number;
  avgOverall: number | null; // 0..1 over items with an overall score
  passRate: number | null; // 0..1 over items where pass is known
  /** last-7d avg minus prior-7d avg, in score points (−1..1); null if a window is empty. */
  delta: number | null;
  byDay: { day: string; avg: number; count: number }[]; // ascending by day
  bySwarm: { name: string; avg: number | null; passRate: number | null; count: number }[];
  byMetric: { metric: string; avg: number; count: number }[]; // worst first
}

function mean(nums: number[]): number | null {
  return nums.length ? nums.reduce((s, v) => s + v, 0) / nums.length : null;
}

/** Roll up parsed scorecards into the summary/day/swarm/metric shapes the UI renders. */
export function buildQualityTrends(items: QualityItem[], now: number = Date.now()): QualityTrends {
  const withOverall = items.filter((i) => i.overall != null) as (QualityItem & {
    overall: number;
  })[];
  const withPass = items.filter((i) => i.pass != null);

  // by day
  const dayMap = new Map<string, number[]>();
  for (const i of withOverall) {
    const day = i.started_at.slice(0, 10); // YYYY-MM-DD (ISO)
    const arr = dayMap.get(day);
    if (arr) arr.push(i.overall);
    else dayMap.set(day, [i.overall]);
  }
  const byDay = [...dayMap.entries()]
    .map(([day, vals]) => ({ day, avg: mean(vals) as number, count: vals.length }))
    .sort((a, b) => a.day.localeCompare(b.day));

  // by swarm
  const swarmMap = new Map<string, { overall: number[]; pass: boolean[] }>();
  for (const i of items) {
    const key = i.swarm_name || "Untitled swarm";
    const e = swarmMap.get(key) ?? { overall: [], pass: [] };
    if (i.overall != null) e.overall.push(i.overall);
    if (i.pass != null) e.pass.push(i.pass);
    swarmMap.set(key, e);
  }
  const bySwarm = [...swarmMap.entries()]
    .map(([name, e]) => ({
      name,
      avg: mean(e.overall),
      passRate: e.pass.length ? e.pass.filter(Boolean).length / e.pass.length : null,
      count: e.overall.length + (e.overall.length ? 0 : e.pass.length),
    }))
    .sort((a, b) => b.count - a.count);

  // by metric
  const metricMap = new Map<string, number[]>();
  for (const i of items) {
    for (const [id, score] of Object.entries(i.metrics)) {
      const arr = metricMap.get(id);
      if (arr) arr.push(score);
      else metricMap.set(id, [score]);
    }
  }
  const byMetric = [...metricMap.entries()]
    .map(([metric, vals]) => ({ metric, avg: mean(vals) as number, count: vals.length }))
    .sort((a, b) => a.avg - b.avg);

  // 7d-vs-prior-7d delta
  const wk = 7 * 86400000;
  const last7 = withOverall
    .filter((i) => now - new Date(i.started_at).getTime() <= wk)
    .map((i) => i.overall);
  const prior7 = withOverall
    .filter((i) => {
      const age = now - new Date(i.started_at).getTime();
      return age > wk && age <= 2 * wk;
    })
    .map((i) => i.overall);
  const lastAvg = mean(last7);
  const priorAvg = mean(prior7);
  const delta = lastAvg != null && priorAvg != null ? lastAvg - priorAvg : null;

  return {
    total: items.length,
    avgOverall: mean(withOverall.map((i) => i.overall)),
    passRate: withPass.length ? withPass.filter((i) => i.pass).length / withPass.length : null,
    delta,
    byDay,
    bySwarm,
    byMetric,
  };
}
