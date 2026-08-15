// The dashboard's "last 24h" card.
//
// The bug these exist for did not throw, did not log, and did not look wrong:
// three of the card's four figures were computed over the whole fetched page
// rather than over 24 hours, so a heading that said "last 24h" described 51.
// Every test below is therefore about the boundary — what is inside the
// window, what is outside it, and what the card is allowed to claim when it
// cannot see the whole window at all.
import { describe, expect, it } from "vitest";

import {
  ACTIVITY_BUCKETS,
  UNATTRIBUTED_MODEL,
  activityMetrics,
  activityWindow,
  bucketHour,
  hourlyBuckets,
  modelMix,
  type ActivityRow,
} from "@/lib/dashboardActivity";

const NOW = Date.parse("2026-08-15T20:00:00.000Z");
const HOUR = 3_600_000;

/** A row `hoursAgo` before NOW. */
const row = (hoursAgo: number, extra: Partial<ActivityRow> = {}): ActivityRow => ({
  created_at: new Date(NOW - hoursAgo * HOUR).toISOString(),
  status: "success",
  latency_ms: 1000,
  tokens_in: 10,
  tokens_out: 10,
  llm_model: "m",
  cost_usd: 1,
  ...extra,
});

const win = (rows: ActivityRow[], fetchLimit = 1000) =>
  activityWindow(rows, { now: NOW, fetchLimit });

describe("the window is 24 hours, for every figure on the card", () => {
  it("keeps rows inside the window and drops rows outside it", () => {
    const w = win([row(1), row(23), row(25), row(50)]);
    expect(w.rows).toHaveLength(2);
  });

  it("EXCLUDES older rows from success rate, latency and spend", () => {
    // The original bug, in one assertion. The three old rows are cheap, fast
    // and successful; the recent one is none of those. Computing over the
    // whole page hides it behind the majority.
    const w = win([
      row(1, { status: "error", latency_ms: 30_000, cost_usd: 5 }),
      row(30, { status: "success", latency_ms: 100, cost_usd: 0.01 }),
      row(31, { status: "success", latency_ms: 100, cost_usd: 0.01 }),
      row(32, { status: "success", latency_ms: 100, cost_usd: 0.01 }),
    ]);
    const m = activityMetrics(w);
    expect(m.runs).toBe(1);
    expect(m.successRate).toBe(0);
    expect(m.avgLatencyMs).toBe(30_000);
    expect(m.spend.total).toBe(5);
  });

  it("reproduces the measured discrepancy that started this", () => {
    // Shaped like the real account: a fast, cheap, clean recent day sitting
    // inside a slower, costlier 51-hour page.
    const recent = Array.from({ length: 4 }, () =>
      row(2, { status: "success", latency_ms: 12_200, cost_usd: 0.14 }),
    );
    const older = Array.from({ length: 4 }, () =>
      row(40, { status: "error", latency_ms: 26_600, cost_usd: 0.1875 }),
    );
    const m = activityMetrics(win([...recent, ...older]));
    expect(m.successRate).toBe(100); // not 50
    expect(m.avgLatencyMs).toBe(12_200); // not 19_400
    expect(m.spend.total).toBeCloseTo(0.56, 5); // not 1.31
  });

  it("ignores a row whose timestamp cannot be read rather than counting it", () => {
    const w = win([row(1), { ...row(1), created_at: "not a date" }]);
    expect(w.rows).toHaveLength(1);
  });

  it("treats the boundary as inclusive of exactly 24h ago", () => {
    expect(win([row(24)]).rows).toHaveLength(1);
    expect(win([row(24.001)]).rows).toHaveLength(0);
  });
});

describe("a card that cannot see the whole window says so", () => {
  it("is not truncated when the fetch came back short", () => {
    // Fewer rows than asked for means the table ran out: nothing was left.
    expect(win([row(1), row(2)], 200).truncated).toBe(false);
  });

  it("is not truncated when a full fetch reached past the window", () => {
    // The oldest row predates the window, so every row inside it was seen.
    const rows = [row(1), row(2), row(30)];
    expect(win(rows, 3).truncated).toBe(false);
  });

  it("IS truncated when a full fetch is still inside the window", () => {
    // 3 rows requested, 3 returned, oldest only 2h old — there may be more at
    // hour 3 that were never fetched, and the count cannot know.
    const rows = [row(1), row(1.5), row(2)];
    const w = win(rows, 3);
    expect(w.truncated).toBe(true);
    expect(activityMetrics(w).runsAtLeast).toBe(true);
  });

  it("marks the run count as a floor, not a total, when truncated", () => {
    const m = activityMetrics(win([row(1), row(2)], 2));
    expect(m.runs).toBe(2);
    expect(m.runsAtLeast).toBe(true);
    expect(m.truncated).toBe(true);
  });

  it("an empty fetch is complete, not truncated", () => {
    const w = win([], 200);
    expect(w.truncated).toBe(false);
    expect(activityMetrics(w).runs).toBe(0);
  });
});

describe("a rate with nothing under it is not a rate", () => {
  it("reports null rather than 100% when there are no runs", () => {
    // The old code returned 100 here, congratulating an empty account on a
    // perfect record.
    const m = activityMetrics(win([]));
    expect(m.successRate).toBeNull();
    expect(m.avgLatencyMs).toBeNull();
  });

  it("reports null when every run in the window was cancelled", () => {
    const m = activityMetrics(win([row(1, { status: "cancelled" })]));
    expect(m.successRate).toBeNull();
  });

  it("keeps cancelled runs out of the denominator without voiding the rate", () => {
    const m = activityMetrics(
      win([row(1, { status: "success" }), row(2, { status: "cancelled" })]),
    );
    expect(m.successRate).toBe(100);
  });

  it("averages latency over rows that recorded one, not over all rows", () => {
    // A null latency is missing, not zero; averaging it in drags the mean down.
    const m = activityMetrics(win([row(1, { latency_ms: 1000 }), row(2, { latency_ms: null })]));
    expect(m.avgLatencyMs).toBe(1000);
  });

  it("counts an unpriced row so the spend total can admit it is a floor", () => {
    const m = activityMetrics(
      win([row(1, { cost_usd: 0, pricing_missing: "true" }), row(2, { cost_usd: 3 })]),
    );
    expect(m.spend.total).toBe(3);
    expect(m.spend.partial).toBe(true);
  });
});

describe("the hourly bars run forwards in time", () => {
  it("puts the most recent hour last and 23 hours ago first", () => {
    // Bucketing by getHours() put today's 00:00 on the left and yesterday's
    // 23:00 on the right, so the trend read backwards across midnight.
    const b = hourlyBuckets([row(0.5), row(23.5)], NOW);
    expect(b).toHaveLength(ACTIVITY_BUCKETS);
    expect(b[ACTIVITY_BUCKETS - 1]).toBe(1);
    expect(b[0]).toBe(1);
    expect(b.reduce((s, n) => s + n, 0)).toBe(2);
  });

  it("orders three runs across the day boundary oldest to newest", () => {
    const b = hourlyBuckets([row(1), row(10), row(20)], NOW);
    const filled = b.map((v, i) => (v ? i : -1)).filter((i) => i >= 0);
    expect(filled).toEqual([...filled].sort((a, z) => a - z));
    expect(filled).toEqual([3, 13, 22]);
  });

  it("drops anything outside the 24 bars instead of folding it into one", () => {
    expect(hourlyBuckets([row(25), row(100)], NOW).every((v) => v === 0)).toBe(true);
  });

  it("labels each bar with the hour it actually covers", () => {
    const lastHour = new Date(NOW).getHours();
    expect(bucketHour(ACTIVITY_BUCKETS - 1, NOW)).toBe(lastHour);
    expect(bucketHour(0, NOW)).toBe(new Date(NOW - 23 * HOUR).getHours());
  });
});

describe("model mix answers the question it prints", () => {
  const rows = [
    // kimi: many cheap calls. gpt: few expensive ones. By runs kimi leads
    // 3:1; by tokens gpt leads. The panel says tokens.
    row(1, { llm_model: "kimi", tokens_in: 10, tokens_out: 10 }),
    row(2, { llm_model: "kimi", tokens_in: 10, tokens_out: 10 }),
    row(3, { llm_model: "kimi", tokens_in: 10, tokens_out: 10 }),
    row(4, { llm_model: "gpt", tokens_in: 500, tokens_out: 500 }),
  ];

  it("ranks by tokens, not by run count", () => {
    const mix = modelMix(rows);
    expect(mix.entries[0].model).toBe("gpt");
    expect(mix.entries[0].tokens).toBe(1000);
    expect(mix.entries[1].model).toBe("kimi");
    expect(mix.entries[1].tokens).toBe(60);
  });

  it("shares are proportions of tokens and sum to 100 across all models", () => {
    const mix = modelMix(rows);
    expect(mix.totalTokens).toBe(1060);
    expect(mix.entries.reduce((s, e) => s + e.share, 0)).toBeCloseTo(100, 6);
  });

  it("attributes tokens from an unnamed model rather than dropping them", () => {
    // Dropping them understates the total and moves every other share.
    const mix = modelMix([row(1, { llm_model: null, tokens_in: 100, tokens_out: 0 })]);
    expect(mix.entries[0].model).toBe(UNATTRIBUTED_MODEL);
    expect(mix.totalTokens).toBe(100);
  });

  it("says how many models the top-N cut left out", () => {
    const many = ["a", "b", "c", "d", "e", "f"].map((m, i) =>
      row(1, { llm_model: m, tokens_in: 10 * (6 - i), tokens_out: 0 }),
    );
    const mix = modelMix(many, 4);
    expect(mix.entries).toHaveLength(4);
    expect(mix.hidden).toBe(2);
  });

  it("does not render a bar for a model that used no tokens", () => {
    const mix = modelMix([row(1, { llm_model: "silent", tokens_in: 0, tokens_out: 0 })]);
    expect(mix.entries).toHaveLength(0);
    expect(mix.totalTokens).toBe(0);
  });

  it("produces no NaN share when nothing recorded a token", () => {
    const mix = modelMix([row(1, { tokens_in: 0, tokens_out: 0 })]);
    expect(mix.entries.every((e) => Number.isFinite(e.share))).toBe(true);
  });

  it("breaks a tie by name so the panel does not reshuffle between renders", () => {
    const mix = modelMix([
      row(1, { llm_model: "zeta", tokens_in: 5, tokens_out: 0 }),
      row(1, { llm_model: "alpha", tokens_in: 5, tokens_out: 0 }),
    ]);
    expect(mix.entries.map((e) => e.model)).toEqual(["alpha", "zeta"]);
  });
});
