// R502's visuals and line options: the arithmetic behind a Pareto, a calendar,
// small multiples, a pictogram and a moving average, and how the builder's
// options become specs.
import { describe, expect, it } from "vitest";

import {
  calendarCells,
  movingAverage,
  paretoRows,
  pictogramUnit,
  splitRows,
} from "@/components/bi/biDrawHelpers";
import {
  VISUAL_OPTS_DEFAULT,
  visualAnalytics,
  visualOptsFrom,
  visualSpec,
} from "@/lib/biVisualOpts";

const noFields = { xField: "", yField: "", seriesField: "", nameField: "", valueField: "" };

describe("a moving average", () => {
  it("starts once a full window is in, and skips missing points", () => {
    expect(movingAverage([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
    expect(movingAverage([2, null, 4, 6], 2)).toEqual([null, 2, 4, 5]);
    expect(movingAverage([5, 7], 1)).toEqual([5, 7]);
  });
});

describe("a Pareto", () => {
  it("sorts largest first and runs the share of the whole total", () => {
    const rows = [
      { s: "b", v: 30 },
      { s: "a", v: 50 },
      { s: "c", v: 20 },
      { s: "a", v: 0 },
      { s: "d", v: -5 },
    ];
    expect(paretoRows(rows, "s", "v")).toEqual([
      { category: "a", value: 50, cumPct: 50 },
      { category: "b", value: 30, cumPct: 80 },
      { category: "c", value: 20, cumPct: 100 },
    ]);
  });
});

describe("a calendar", () => {
  it("lays days out a column per week, Sunday first, adding up a day's rows", () => {
    const rows = [
      { d: "2026-03-01", v: 2 }, // a Sunday
      { d: "2026-03-01", v: 3 },
      { d: "2026-03-04", v: 7 }, // Wednesday
      { d: "2026-03-09", v: 1 }, // the next Monday
    ];
    const { cells, weeks, months } = calendarCells(rows, "d", "v");
    expect(cells).toHaveLength(9);
    expect(cells[0]).toEqual({ date: "2026-03-01", week: 0, weekday: 0, value: 5 });
    expect(cells.find((c) => c.date === "2026-03-02")?.value).toBeNull();
    expect(cells.find((c) => c.date === "2026-03-09")).toMatchObject({ week: 1, weekday: 1 });
    expect(weeks).toBe(2);
    expect(months).toEqual([{ week: 0, label: "Mar" }]);
  });

  it("shows the latest stretch of a long history", () => {
    const rows = Array.from({ length: 800 }, (_, i) => ({
      d: new Date(Date.UTC(2024, 0, 1) + i * 86400000).toISOString().slice(0, 10),
      v: i,
    }));
    const { cells } = calendarCells(rows, "d", "v", 400);
    expect(cells).toHaveLength(400);
    expect(cells.at(-1)?.value).toBe(799);
  });
});

describe("small multiples and pictograms", () => {
  it("orders panels by their total, not their row count", () => {
    const rows = [
      { area: "Bronx", v: 1 },
      { area: "Bronx", v: 1 },
      { area: "Manhattan", v: 10 },
      { area: "Manhattan", v: 9 },
    ];
    expect(splitRows(rows, "area", 12, "v").map((g) => g.key)).toEqual(["Manhattan", "Bronx"]);
    expect(splitRows(rows, "area", 1).length).toBe(1);
  });

  it("picks a round unit so the largest value fits in about twenty pictures", () => {
    expect(pictogramUnit(19_915_795)).toBe(1_000_000);
    expect(pictogramUnit(87)).toBe(5);
    expect(pictogramUnit(0)).toBe(1);
  });
});

describe("the builder's options become specs", () => {
  it("builds the four visuals from their own fields", () => {
    const o = {
      ...VISUAL_OPTS_DEFAULT,
      categoryField: "station",
      measureField: "rides",
      dateField: "day",
      smX: "week",
      smY: "rides",
      splitField: "area",
      smKind: "bar" as const,
      icon: "bike" as const,
      unit: "1000000",
    };
    expect(visualSpec("pareto", o, noFields)).toEqual({
      type: "pareto",
      categoryField: "station",
      valueField: "rides",
    });
    expect(visualSpec("calendar", o, noFields)).toEqual({
      type: "calendar",
      dateField: "day",
      valueField: "rides",
    });
    expect(visualSpec("smallmultiples", o, noFields)).toEqual({
      type: "smallmultiples",
      xField: "week",
      yField: "rides",
      splitField: "area",
      kind: "bar",
    });
    const pict = visualSpec("pictogram", o, noFields);
    expect(pict).toEqual({
      type: "pictogram",
      categoryField: "station",
      valueField: "rides",
      icon: "bike",
      unit: 1_000_000,
    });
    // And back again, so editing returns to the same choices.
    const back = visualOptsFrom(pict!);
    expect([back.icon, back.unit, back.categoryField]).toEqual(["bike", "1000000", "station"]);
    expect(visualSpec("calendar", VISUAL_OPTS_DEFAULT, noFields)).toBeNull();
  });

  it("adds a moving average to lines only, a log axis and zoom bar to lines and columns", () => {
    const o = { ...VISUAL_OPTS_DEFAULT, maWindow: "7", logScale: true, zoomBar: true };
    expect(visualAnalytics("line", o)).toMatchObject({
      movingAverage: 7,
      logScale: true,
      zoomBar: true,
    });
    expect(visualAnalytics("bar", o)).toEqual({ logScale: true, zoomBar: true });
    expect(visualAnalytics("area", o)).toEqual({});
    expect(visualAnalytics("line", { ...VISUAL_OPTS_DEFAULT, maWindow: "1" })).toEqual({});
    expect(visualAnalytics("line", { ...VISUAL_OPTS_DEFAULT, maWindow: "x" })).toEqual({});
  });
});
