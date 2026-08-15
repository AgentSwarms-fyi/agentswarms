// The dashboard's "last 24h" card, computed over the last 24h.
//
// MEASURED, which is why this exists. The card fetched the newest 200 traces
// and derived four figures from them. Only one — the run count — was filtered
// to 24 hours; success rate, average latency and spend were computed over the
// whole page. On a real account the newest 200 rows spanned 51.3 hours, so a
// card headed "Activity — last 24h" read:
//
//     96% success · 19.4s avg · $1.31        (what 51.3 hours looked like)
//
// when the last 24 hours were:
//
//     98% success · 12.2s avg · $0.56        (spend overstated 2.3x)
//
// Nothing errored and every figure looked plausible, which is the whole
// problem: a wrong number that announces itself is a bug, and a wrong number
// that does not is a false statement the product keeps making.
//
// budgetSpendClient's header already names this failure — "PostgREST caps rows,
// past the cap the browser sums a PREFIX of the month and renders it as the
// total". That fix landed on month-to-date spend and never reached this card.
// So the second job here is COMPLETENESS: a fixed-size fetch cannot see a busy
// day, and a card that cannot see the whole window has to say so rather than
// report the part it saw as the whole.
//
// Pure — no imports beyond the spend total — because the tests and the page
// both read it, and a metric re-implemented in its own test proves nothing.
import { sumSpend, type PricedRow, type SpendTotal } from "./spendCompleteness";

/** The window the card claims to describe. */
export const ACTIVITY_WINDOW_MS = 86_400_000;

/** One bar per hour of that window. */
export const ACTIVITY_BUCKETS = 24;

export type ActivityRow = PricedRow & {
  created_at: string;
  status?: string | null;
  latency_ms?: number | null;
  tokens_in?: number | null;
  tokens_out?: number | null;
  llm_model?: string | null;
};

export type ActivityWindow = {
  /** The rows that actually fall inside the window. */
  rows: ActivityRow[];
  /**
   * True when the fetch could not prove it saw the whole window, so every
   * count below is a floor rather than the answer.
   */
  truncated: boolean;
};

/**
 * Narrow a newest-first page of traces to the window, and say whether that page
 * was big enough to contain all of it.
 *
 * The completeness test is the useful part. A page of `fetchLimit` rows proves
 * it covered the window when EITHER the table ran out (fewer rows came back
 * than were asked for) OR the oldest row it returned predates the window — in
 * both cases the fetch reached past the boundary, so nothing inside was left
 * behind. If it came back full and its oldest row is still inside the window,
 * there may be more rows we never saw and we cannot know how many.
 */
export function activityWindow(
  fetched: readonly ActivityRow[],
  opts: { now: number; fetchLimit: number },
): ActivityWindow {
  const start = opts.now - ACTIVITY_WINDOW_MS;
  const rows = fetched.filter((r) => {
    const t = new Date(r.created_at).getTime();
    return Number.isFinite(t) && t >= start;
  });
  if (fetched.length < opts.fetchLimit) return { rows, truncated: false };
  const oldest = fetched.reduce((min, r) => {
    const t = new Date(r.created_at).getTime();
    return Number.isFinite(t) && t < min ? t : min;
  }, Infinity);
  return { rows, truncated: !(oldest < start) };
}

export type ActivityMetrics = {
  runs: number;
  /** True when `runs` is a floor — the window was bigger than the fetch. */
  runsAtLeast: boolean;
  /** Null when nothing in the window has a verdict yet. */
  successRate: number | null;
  /** Null when nothing in the window recorded a latency. */
  avgLatencyMs: number | null;
  spend: SpendTotal;
  truncated: boolean;
};

/**
 * The four figures on the card, over the window and nothing else.
 *
 * successRate and avgLatencyMs are NULLABLE on purpose. The previous code
 * returned 100 for a set with no decided runs, so an account that had never
 * run anything — or whose every run was cancelled — was congratulated on a
 * 100% success rate it had not earned. A rate with no runs under it is not a
 * rate, and "—" is the honest render.
 */
export function activityMetrics(w: ActivityWindow): ActivityMetrics {
  // A user pressing Stop is not a failure: cancelled turns leave the
  // denominator entirely rather than dragging it down.
  const decided = w.rows.filter((r) => r.status !== "cancelled");
  const ok = decided.filter((r) => r.status === "success").length;
  const timed = w.rows.filter((r) => typeof r.latency_ms === "number" && r.latency_ms >= 0);
  return {
    runs: w.rows.length,
    runsAtLeast: w.truncated,
    successRate: decided.length ? Math.round((ok / decided.length) * 100) : null,
    avgLatencyMs: timed.length
      ? Math.round(timed.reduce((s, r) => s + (r.latency_ms as number), 0) / timed.length)
      : null,
    spend: sumSpend(w.rows),
    truncated: w.truncated,
  };
}

/**
 * Hourly run volume, oldest bar first, ending at the hour containing `now`.
 *
 * Ordering by hour-of-day (the previous behaviour: `getHours()` into a fixed
 * 0..23 array) puts today's midnight on the left and yesterday's 23:00 on the
 * right, so a 24-hour trend reads backwards across the day boundary. Bucketing
 * by hours-ago keeps the axis chronological.
 */
export function hourlyBuckets(rows: readonly ActivityRow[], now: number): number[] {
  const buckets = Array(ACTIVITY_BUCKETS).fill(0) as number[];
  for (const r of rows) {
    const t = new Date(r.created_at).getTime();
    if (!Number.isFinite(t)) continue;
    const hoursAgo = Math.floor((now - t) / 3_600_000);
    if (hoursAgo < 0 || hoursAgo >= ACTIVITY_BUCKETS) continue;
    buckets[ACTIVITY_BUCKETS - 1 - hoursAgo] += 1;
  }
  return buckets;
}

/** The clock hour a bucket covers, so its tooltip names the right hour. */
export function bucketHour(index: number, now: number): number {
  const d = new Date(now - (ACTIVITY_BUCKETS - 1 - index) * 3_600_000);
  return d.getHours();
}

/** A model with no name recorded still spent tokens; dropping it understates. */
export const UNATTRIBUTED_MODEL = "(model not recorded)";

export type ModelMixEntry = { model: string; tokens: number; share: number };
export type ModelMix = {
  entries: ModelMixEntry[];
  /** Total across ALL models in the window, not just the entries shown. */
  totalTokens: number;
  /** How many models were left out of `entries` by the top-N cut. */
  hidden: number;
};

/**
 * Where the tokens went — by tokens, because that is what the panel says.
 *
 * It counted RUNS. That is not a mislabel with the same shape underneath: on
 * the account this was found on, ranking by runs put google/gemini-3-flash in
 * fourth place with 6 runs, while by tokens fourth place belongs to
 * claude-haiku-latest with 11,873 — a different model entirely. The leader's
 * lead also changes character: 2.3x by runs, 1.09x by tokens. Someone reading
 * the panel to decide where their token spend goes was being shown a different
 * question's answer.
 */
export function modelMix(rows: readonly ActivityRow[], topN = 4): ModelMix {
  const byModel = new Map<string, number>();
  for (const r of rows) {
    const key = r.llm_model?.trim() || UNATTRIBUTED_MODEL;
    const tokens = (r.tokens_in ?? 0) + (r.tokens_out ?? 0);
    byModel.set(key, (byModel.get(key) ?? 0) + (Number.isFinite(tokens) ? tokens : 0));
  }
  const totalTokens = [...byModel.values()].reduce((s, n) => s + n, 0);
  const ranked = [...byModel.entries()]
    .filter(([, tokens]) => tokens > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return {
    entries: ranked.slice(0, topN).map(([model, tokens]) => ({
      model,
      tokens,
      // Guarded rather than assumed: every row having zero tokens is a real
      // state (a provider that reports no usage), and it must not render as
      // NaN-width bars.
      share: totalTokens > 0 ? (tokens / totalTokens) * 100 : 0,
    })),
    totalTokens,
    hidden: Math.max(0, ranked.length - topN),
  };
}
