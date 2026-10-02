// The ETL home dashboard's numbers. A success rate that quietly counted live
// or cancelled runs as verdicts would misreport health at the exact moment
// someone glances at it, so the aggregation is pure and pinned here.
import { describe, expect, it } from "vitest";

import {
  computeEtlOverview,
  runDurationMs,
  rowsLoadedOf,
  PULSE_LIMIT,
  type OverviewRun,
} from "@/lib/etlOverview";

const NOW = new Date("2026-08-29T12:00:00Z");

const run = (o: Partial<OverviewRun>): OverviewRun => ({
  pipeline_id: "p1",
  status: "succeeded",
  trigger: "manual",
  attempt: 1,
  created_at: "2026-08-29T10:00:00Z",
  started_at: null,
  finished_at: null,
  metrics: { rows_loaded: 10 },
  ...o,
});

describe("computeEtlOverview", () => {
  it("counts the 7-day window and sums rows from succeeded runs only", () => {
    const { stats } = computeEtlOverview(
      [
        run({ metrics: { rows_loaded: 100 } }),
        run({ status: "failed", metrics: { rows_loaded: 50 } }),
        // Outside the window: contributes to nothing weekly.
        run({ created_at: "2026-08-01T00:00:00Z", metrics: { rows_loaded: 999 } }),
      ],
      NOW,
    );
    expect(stats.runs_7d).toBe(2);
    expect(stats.succeeded_7d).toBe(1);
    expect(stats.failed_7d).toBe(1);
    expect(stats.rows_loaded_7d).toBe(100);
    expect(stats.success_rate_7d).toBe(0.5);
  });

  it("live and cancelled runs are not verdicts", () => {
    const { stats } = computeEtlOverview(
      [
        run({ status: "running" }),
        run({ status: "retrying" }),
        run({ status: "queued" }),
        run({ status: "cancelled" }),
        run({ status: "succeeded" }),
      ],
      NOW,
    );
    expect(stats.running_now).toBe(3);
    expect(stats.success_rate_7d).toBe(1); // 1 of 1 FINISHED
    expect(stats.runs_7d).toBe(5);
  });

  it("no finished runs → success rate is null, not 0 or 100", () => {
    const { stats } = computeEtlOverview([run({ status: "running" })], NOW);
    expect(stats.success_rate_7d).toBeNull();
    const empty = computeEtlOverview([], NOW);
    expect(empty.stats.success_rate_7d).toBeNull();
  });

  it("per-pipeline pulse keeps newest-first order and caps at the limit", () => {
    const runs: OverviewRun[] = [];
    for (let i = 0; i < 15; i++) {
      runs.push(
        run({
          status: i === 0 ? "failed" : "succeeded",
          created_at: `2026-08-29T${String(11 - Math.floor(i / 2)).padStart(2, "0")}:0${i % 2}:00Z`,
        }),
      );
    }
    const { per_pipeline } = computeEtlOverview(runs, NOW);
    expect(per_pipeline.p1.recent).toHaveLength(PULSE_LIMIT);
    expect(per_pipeline.p1.recent[0]).toBe("failed"); // newest first
    // 14 succeeded + 1 failed finished runs → 14/15.
    expect(per_pipeline.p1.success_rate).toBeCloseTo(14 / 15);
  });

  it("pulse success rate uses ALL fetched finished runs, dots only the cap", () => {
    const runs: OverviewRun[] = Array.from({ length: 12 }, (_, i) =>
      run({ status: i < 6 ? "succeeded" : "failed" }),
    );
    const { per_pipeline } = computeEtlOverview(runs, NOW);
    expect(per_pipeline.p1.success_rate).toBe(0.5);
  });

  it("separates pipelines", () => {
    const { per_pipeline } = computeEtlOverview(
      [run({ pipeline_id: "a" }), run({ pipeline_id: "b", status: "failed" })],
      NOW,
    );
    expect(per_pipeline.a.success_rate).toBe(1);
    expect(per_pipeline.b.success_rate).toBe(0);
  });
});

describe("rowsLoadedOf", () => {
  it("tolerates junk metrics", () => {
    expect(rowsLoadedOf(null)).toBe(0);
    expect(rowsLoadedOf({})).toBe(0);
    expect(rowsLoadedOf({ rows_loaded: "12" })).toBe(0);
    expect(rowsLoadedOf({ rows_loaded: NaN })).toBe(0);
    expect(rowsLoadedOf({ rows_loaded: 42 })).toBe(42);
  });
});

describe("runtime attribution", () => {
  const now = new Date("2026-08-30T12:00:00Z");
  const mk = (over: Partial<OverviewRun>): OverviewRun => ({
    pipeline_id: "p1",
    status: "succeeded",
    trigger: "manual",
    attempt: 1,
    created_at: "2026-08-30T10:00:00Z",
    started_at: "2026-08-30T10:00:00Z",
    finished_at: "2026-08-30T10:01:00Z",
    metrics: { rows_loaded: 10 },
    ...over,
  });

  it("sums per-pipeline sandbox time and rows over the window", () => {
    const { stats, per_pipeline } = computeEtlOverview(
      [
        mk({}),
        mk({ finished_at: "2026-08-30T10:02:30Z", metrics: { rows_loaded: 5 } }),
        // A failed run still burned sandbox time but loads nothing.
        mk({ status: "failed", finished_at: "2026-08-30T10:00:30Z", metrics: null }),
        // Out of window: contributes to neither.
        mk({
          created_at: "2026-08-01T00:00:00Z",
          started_at: "2026-08-01T00:00:00Z",
          finished_at: "2026-08-01T01:00:00Z",
        }),
      ],
      now,
    );
    expect(per_pipeline.p1.runtime_ms_7d).toBe(60_000 + 150_000 + 30_000);
    expect(per_pipeline.p1.rows_7d).toBe(15);
    expect(stats.runtime_ms_7d).toBe(240_000);
  });

  it("a still-running run accrues up to now; queued runs accrue nothing", () => {
    expect(
      runDurationMs(
        mk({ status: "running", finished_at: null, started_at: "2026-08-30T11:58:00Z" }),
        now,
      ),
    ).toBe(120_000);
    expect(runDurationMs(mk({ started_at: null, finished_at: null }), now)).toBe(0);
  });
});
