// Drift over time (R548): batch runs and daily live traffic as one chart.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  DRIFT_HISTORY_DAYS,
  DRIFT_PLOT_FLOOR,
  driftAxis,
  driftHistoryLine,
  driftHistoryRows,
  driftPlotRows,
} from "@/lib/mlDriftHistory";

const rd = (p: string) => readFileSync(p, "utf8");

describe("the chart's rows", () => {
  it("puts each day once, oldest first, with the day's highest batch run and its live verdict", () => {
    const rows = driftHistoryRows(
      [
        // The day's highest run is not its last: a chart of the last would hide it.
        { at: "2026-11-20T09:00:00Z", score: 0.31, version: 3 },
        { at: "2026-11-20T17:00:00Z", score: 0.08, version: 3 },
        { at: "2026-11-18T09:00:00Z", score: 0.05, version: 2 },
      ],
      [
        { day: "2026-11-20", score: 0.12, rows: 900, version: 3 },
        { day: "2026-11-21", score: 0.27, rows: 1200, version: 4 },
      ],
    );
    expect(rows).toEqual([
      { day: "2026-11-18", batch: 0.05, batchRuns: 1, versions: [2] },
      { day: "2026-11-20", batch: 0.31, batchRuns: 2, live: 0.12, liveRows: 900, versions: [3] },
      { day: "2026-11-21", live: 0.27, liveRows: 1200, versions: [4] },
    ]);
  });

  it("keeps a canary's day at the higher of the two versions, and lists both", () => {
    const [r] = driftHistoryRows(
      [],
      [
        { day: "2026-11-21", score: 0.1, rows: 800, version: 4 },
        { day: "2026-11-21", score: 0.4, rows: 200, version: 5 },
      ],
    );
    expect(r).toEqual({ day: "2026-11-21", live: 0.4, liveRows: 200, versions: [4, 5] });
  });

  it("leaves out what was not measured", () => {
    expect(
      driftHistoryRows(
        [{ at: "2026-11-20T09:00:00Z", score: Number.NaN, version: 1 }],
        [{ day: "2026-11-21", score: null, rows: 10, version: 1 }],
      ),
    ).toEqual([]);
  });
});

describe("the sentence over it", () => {
  const rows = driftHistoryRows(
    [
      { at: "2026-11-20T09:00:00Z", score: 0.08, version: 3 },
      { at: "2026-11-20T17:00:00Z", score: 0.31, version: 3 },
    ],
    [
      { day: "2026-11-21", score: 0.27, rows: 1200, version: 4 },
      { day: "2026-11-22", score: 0.04, rows: 1100, version: 4 },
    ],
  );

  it("says what was measured, the highest of each, and the days over the line", () => {
    expect(driftHistoryLine(rows, 0.25)).toBe(
      `Over the last ${DRIFT_HISTORY_DAYS} days: 2 batch runs measured, the highest PSI 0.31 on 2026-11-20; live traffic measured on 2 days, the highest 0.27 on 2026-11-21; 2 days reached the alert threshold of 0.25.`,
    );
  });

  it("says so when no day reached it, and says nothing when nothing was measured", () => {
    expect(driftHistoryLine(rows, 0.5)).toContain("no day reached the alert threshold of 0.50.");
    expect(driftHistoryLine([], 0.25)).toBeNull();
  });
});

describe("the wiring", () => {
  it("is read for the model's owner only, from 90 days of both", () => {
    const fns = rd("src/utils/mlConsole.functions.ts");
    const fn = fns.slice(fns.indexOf("export const mlDriftHistory"));
    expect(fn).toMatch(/\.eq\("id", data\.modelId\)\s*\.eq\("user_id", userId\)/);
    expect(fn).toMatch(/\.from\("ml_predictions"\)[\s\S]{0,300}\.not\("drift_score", "is", null\)/);
    expect(fn).toContain('.from("ml_traffic_daily")');
    // Before its migration the daily read errors, and the batch runs still draw.
    expect(fn).toContain("dailyKept: !daily.error,");
    expect(rd("src/routes/_authenticated/ml_.$modelId.tsx")).toContain(
      "{!shared ? <DriftHistoryCard token={token} modelId={model.id} /> : null}",
    );
  });

  it("adds a table the owner can only read, one row per version per day", () => {
    const sql = rd("supabase/migrations/20261208000000_ml_traffic_daily.sql");
    expect(sql).toContain("PRIMARY KEY (version_id, day)");
    expect(sql).toContain("ALTER TABLE public.ml_traffic_daily ENABLE ROW LEVEL SECURITY;");
    expect(sql).toContain("FOR SELECT");
    expect(sql).not.toMatch(/FOR (ALL|INSERT|UPDATE|DELETE)/);
    expect(sql).not.toMatch(/DROP (TABLE|COLUMN)|RENAME/);
  });

  it("the hourly check keeps the day's verdict, keyed by version and day", () => {
    const src = rd("src/utils/ml/traffic.server.ts");
    expect(src).toContain('{ onConflict: "version_id,day" },');
    expect(src).toContain("await recordDay(model, t, now);");
  });
});

describe("found from the UI in R548", () => {
  // One run at PSI 6.33 put the 0.25 threshold and the 0.1 line on the floor
  // of a linear axis; and the batch dots had a white fill and no stroke.
  const rows = driftHistoryRows(
    [
      { at: "2026-09-20T09:00:00Z", score: 0.004, version: 1 },
      { at: "2026-10-03T09:00:00Z", score: 6.33, version: 7 },
    ],
    [],
  );

  it("draws on a log axis from the floor to the next power of ten, ticked at each", () => {
    expect(driftAxis(rows, 0.25)).toEqual({ domain: [0.01, 10], ticks: [0.01, 0.1, 1, 10] });
    // With nothing above the threshold, the axis still reaches past it.
    expect(driftAxis([], 0.25)).toEqual({ domain: [0.01, 1], ticks: [0.01, 0.1, 1] });
  });

  it("draws a reading below the floor on it, and keeps the real one for the tooltip", () => {
    const [low, high] = driftPlotRows(rows);
    expect(low).toMatchObject({ batch: 0.004, batchPlot: DRIFT_PLOT_FLOOR });
    expect(high).toMatchObject({ batch: 6.33, batchPlot: 6.33 });
  });

  it("the card uses the log axis, filled dots, and the real value in the tooltip", () => {
    const card = rd("src/components/ml/DriftHistoryCard.tsx");
    expect(card).toContain('scale="log"');
    expect(card).toContain('dataKey="batchPlot"');
    expect(card).toMatch(/dot=\{\{\s*r: 3\.5,\s*fill: "var\(--chart-1\)"/);
    expect(card).toContain('const v = name === "batch runs" ? r?.batch : r?.live;');
  });
});
