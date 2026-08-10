// A dashboard widget must never present a cut-short result as the whole thing.
//
// FOUND BY MEASUREMENT, not by reading. A line chart of 2001 daily revenue was
// built from a local dataset of 364 rows. The rendered chart's x-axis ran
// 2001-01-01 → 2001-02-19 and its last point was 767,527,521,677.20; the real
// year-end cumulative is 9,194,232,197,148.53. Twelve times short, over a
// widget titled "Cumulative revenue 2001", with no caveat anywhere on the card
// and `truncated: false` written into `bi_widget_results`.
//
// Three independent faults produced that:
//
//   1. The widget path ran `runQuery`, whose cap is PLAYGROUND_ROW_CAP (50) —
//      a workbench PREVIEW cap. Widget snapshots are governed by
//      `widgetRowCap()` (500), which the SERVER's scheduled refresh already
//      used, so the same widget drew 50 points in the browser and 364 after a
//      scheduled refresh.
//   2. The builder never copied the preview's own `capped` flag onto the
//      widget, so `syncWidgetResults` stored `truncated: false`.
//   3. The "Partial" badge was gated on `!agg_pushdown`, on the reasoning that
//      an aggregated result is complete by construction. That is true of each
//      row's VALUE and false of the row LIST: GROUP BY over 364 days still
//      returns 364 rows, and the cap drops the tail either way.
//
// Any one of them alone is enough to make a chart lie, so each is pinned.
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import { widgetFromBiTurn, WIDGET_ROW_CAP_DEFAULT } from "@/lib/biDashboards";
import type { BiTurn } from "@/lib/biAgent";

const DASHBOARD = readFileSync("src/routes/_authenticated/bi_.$dashboardId.tsx", "utf8");
const BUILDER = readFileSync("src/components/bi/BiBuilderPane.tsx", "utf8");
const CARD = readFileSync("src/components/bi/BiWidgetCard.tsx", "utf8");
const REFRESH = readFileSync("src/utils/bi/refresh.server.ts", "utf8");

function turn(rowCount: number, capped: boolean): BiTurn {
  const rows = Array.from({ length: rowCount }, (_, i) => ({
    day: `2001-${String(Math.floor(i / 31) + 1).padStart(2, "0")}-${String((i % 31) + 1).padStart(2, "0")}`,
    revenue: 1000 + i,
  }));
  return {
    question: "Cumulative revenue 2001",
    sql: "SELECT day, revenue FROM store_sales_daily_2001",
    status: "done",
    chart: { type: "line" },
    result: {
      columns: ["day", "revenue"],
      rows,
      row_count: rows.length,
      total_matched: capped ? rows.length + 1 : rows.length,
      capped,
      duration_ms: 1,
    },
  } as BiTurn;
}

describe("a widget pinned from an AI answer records whether it was cut short", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("marks a result the engine reported as capped", () => {
    const w = widgetFromBiTurn(turn(50, true), { kind: "local" });
    expect(w?.truncated).toBe(true);
  });

  it("marks a result that overflows the snapshot cap even if the engine did not", () => {
    // The engine can return everything it found and STILL overflow the
    // snapshot: `snapshotRows` is what slices, so the check must look at the
    // cap, not only at the flag.
    const w = widgetFromBiTurn(turn(WIDGET_ROW_CAP_DEFAULT + 10, false), { kind: "local" });
    expect(w?.rows?.length).toBe(WIDGET_ROW_CAP_DEFAULT);
    expect(w?.truncated).toBe(true);
  });

  it("leaves a complete result unmarked, so the badge means something", () => {
    // The counterpart that keeps this from passing vacuously: if `truncated`
    // were hardcoded true, every widget would wear a warning and the warning
    // would stop carrying information.
    const w = widgetFromBiTurn(turn(12, false), { kind: "local" });
    expect(w?.truncated).toBe(false);
    expect(w?.rows?.length).toBe(12);
  });

  it("respects an explicitly passed cap rather than only the default", () => {
    const w = widgetFromBiTurn(turn(30, false), { kind: "local" }, 10);
    expect(w?.rows?.length).toBe(10);
    expect(w?.truncated).toBe(true);
  });
});

describe("the widget data path does not borrow the playground's row cap", () => {
  it("the dashboard runs local widget SQL through the uncapped runner", () => {
    expect(DASHBOARD).toContain("runQueryUnlimited");
    expect(DASHBOARD).toContain("widgetRowCap()");
  });

  it("the dashboard no longer calls runQuery, whose cap is 50", () => {
    // `runQuery` is the workbench preview entry point and applies
    // PLAYGROUND_ROW_CAP. Reaching for it here is the original bug.
    expect(DASHBOARD, "the 50-row playground cap is back on the widget path").not.toMatch(
      /\brunQuery\(/,
    );
  });

  it("the playground cap is still 50 — this test is about WHERE it applies", () => {
    const ENGINE = readFileSync("src/lib/sqlEngine.ts", "utf8");
    expect(ENGINE).toMatch(/PLAYGROUND_ROW_CAP\s*=\s*50/);
  });
});

describe("creation and refresh both record truncation", () => {
  it("the builder carries the preview's capped flag onto the widget", () => {
    expect(BUILDER).toMatch(/truncated:\s*preview\.capped/);
  });

  it("the dashboard's manual refresh records it too", () => {
    // Deliberately NOT the looser /truncated:\s*res\.capped/ — the direct-query
    // path in the same file already contains that, so deleting the line in
    // `refreshAll` left the loose assertion still passing. Mutation testing
    // caught it: the check has to name the whole expression it is pinning.
    expect(DASHBOARD).toMatch(
      /truncated:\s*res\.capped\s*\|\|\s*res\.rows\.length\s*>\s*widgetRowCap\(\)/,
    );
  });

  it("the scheduled server refresh does not excuse an aggregated widget", () => {
    // The old line was:
    //   w.truncated = !w.agg_pushdown && result.rows.length >= WIDGET_ROW_CAP;
    expect(REFRESH, "pushdown is being treated as making truncation harmless").not.toMatch(
      /truncated\s*=\s*!w\.agg_pushdown/,
    );
    expect(REFRESH).toMatch(/w\.truncated\s*=\s*result\.rows\.length\s*>=\s*WIDGET_ROW_CAP/);
  });
});

describe("the Partial badge can actually fire", () => {
  it("is not gated on the widget aggregating in SQL", () => {
    expect(CARD, "the badge is suppressed for aggregated widgets again").not.toMatch(
      /widget\.truncated\s*&&\s*!widget\.agg_pushdown/,
    );
    expect(CARD).toMatch(/\{widget\.truncated\s*&&/);
  });
});
