// R505's chart options: parts as shares of 100%, where the legend sits,
// notes pinned to points, and treemap tiles coloured by a second measure —
// the arithmetic behind each, and how the builder's options become specs.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { categoryAxis } from "@/components/bi/biChartData";
import {
  legendPlacement,
  measureTileColor,
  noteRows,
  percentShares,
  placeNotes,
} from "@/components/bi/biDrawHelpers";
import type { ChartSpec } from "@/lib/biAgent";
import { reconcileChartFields } from "@/lib/biChartFields";
import {
  VISUAL_OPTS_DEFAULT,
  stacksParts,
  treemapColor,
  visualAnalytics,
  visualOptsFrom,
} from "@/lib/biVisualOpts";

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");

describe("a 100% stack", () => {
  it("turns each part into its share of the row and keeps the value for the tooltip", () => {
    const out = percentShares(
      [
        { m: "Jan", member: 30, casual: 10 },
        { m: "Feb", member: 0, casual: 0 },
        { m: "Mar", member: 5, casual: -5 },
      ],
      ["member", "casual"],
    );
    expect(out[0]).toMatchObject({
      member: 75,
      casual: 25,
      "__raw:member": 30,
      "__raw:casual": 10,
    });
    // Nothing in the row: nothing drawn, rather than a divide by zero.
    expect(out[1]).toMatchObject({ member: null, casual: null });
    // A part below zero has no share of a whole.
    expect(out[2]).toMatchObject({ member: 100, casual: null, "__raw:casual": -5 });
  });

  it("is offered only where the parts stack", () => {
    expect(stacksParts("scolumn", {})).toBe(true);
    expect(stacksParts("shbar", {})).toBe(true);
    expect(stacksParts("bar", { seriesField: "type" })).toBe(false);
    expect(stacksParts("bar", { seriesField: "type", stacked: true })).toBe(true);
    expect(stacksParts("area", {})).toBe(false);
    expect(stacksParts("area", { extraMeasures: ["profit"] })).toBe(true);
    expect(stacksParts("line", { seriesField: "type" })).toBe(false);
  });
});

describe("the legend", () => {
  it("sits under the chart unless moved, and can be hidden", () => {
    expect(legendPlacement(undefined)).toEqual({
      layout: "horizontal",
      align: "center",
      verticalAlign: "bottom",
    });
    expect(legendPlacement("top")?.verticalAlign).toBe("top");
    expect(legendPlacement("right")).toEqual({
      layout: "vertical",
      align: "right",
      verticalAlign: "middle",
    });
    expect(legendPlacement("none")).toBeNull();
  });
});

describe("category labels in a narrow card", () => {
  it("are judged against the card's own width, not a typical one", () => {
    // FOUND IN R505's UI test: five areas in a third-width card (about 240px
    // of plot) were left flat at the typical 640px and printed over each other.
    const areas = ["Bronx", "Brooklyn", "Jersey City", "Manhattan", "Queens"];
    expect(categoryAxis(areas, 11).angle).toBeUndefined();
    expect(categoryAxis(areas, 11, 240).angle).toBe(-35);
    expect(categoryAxis(areas, 11, 240).height).toBeGreaterThan(24);
  });
});

describe("notes on a chart", () => {
  const data = [
    { day: "Mon", a: 3, b: 5 },
    { day: "Tue", a: 4, b: 1 },
  ];

  it("sit above the highest mark at their x, or the top of a stack", () => {
    const notes = [
      { x: "Tue", text: "  Rain  " },
      { x: "Sun", text: "not on the chart" },
      { x: "Mon", text: "   " },
    ];
    expect(placeNotes(data, "day", ["a", "b"], notes, false)).toEqual([
      { x: "Tue", y: 4, text: "Rain" },
    ]);
    expect(placeNotes(data, "day", ["a", "b"], notes, true)).toEqual([
      { x: "Tue", y: 5, text: "Rain" },
    ]);
  });

  it("match a number typed as text, and keep the chart's own value", () => {
    const laps = [
      { lap: 33, pos: 2 },
      { lap: 34, pos: 1 },
    ];
    expect(placeNotes(laps, "lap", ["pos"], [{ x: "34", text: "Safety car" }], false)).toEqual([
      { x: 34, y: 1, text: "Safety car" },
    ]);
  });

  it("keep ten notes of eighty characters at most", () => {
    const many = Array.from({ length: 12 }, () => ({ x: "Mon", text: "x".repeat(100) }));
    const placed = placeNotes(data, "day", ["a"], many, false);
    expect(placed).toHaveLength(10);
    expect(placed[0].text).toHaveLength(80);
  });

  it("side by side take separate rows, each the lowest that is clear", () => {
    expect(
      noteRows([
        [0, 50],
        [40, 90],
        [100, 150],
        [45, 60],
      ]),
    ).toEqual([0, 1, 0, 2]);
  });
});

describe("treemap tiles coloured by a measure", () => {
  const range = { min: -10, max: 30 };

  it("run from pale to deep across the range, low to high", () => {
    expect(measureTileColor(-10, range, "sequential")).toContain("var(--primary) 12%");
    expect(measureTileColor(30, range, "sequential")).toContain("var(--primary) 100%");
  });

  it("split at zero: green on the good side, red on the other, deeper further out", () => {
    expect(measureTileColor(30, range, "diverging")).toContain("#16a34a 100%");
    expect(measureTileColor(-10, range, "diverging")).toContain("#dc2626");
    expect(measureTileColor(30, range, "diverging", true)).toContain("#dc2626 100%");
    expect(measureTileColor(null, range, "diverging")).toBe("var(--muted)");
  });

  it("drop a colour column the query does not return, rather than show a table", () => {
    const chart: ChartSpec = {
      type: "treemap",
      nameField: "team",
      valueField: "points",
      colorField: "team_colour",
    };
    const verdict = reconcileChartFields({
      chart,
      columns: ["team", "points", "driver"],
      rows: [{ team: "A", points: 10, driver: "X" }],
    });
    expect(verdict.verdict).toBe("repaired");
    // Not re-pointed at the one other text column, either.
    expect(verdict.verdict === "repaired" && verdict.chart).toEqual({
      type: "treemap",
      nameField: "team",
      valueField: "points",
    });
  });
});

describe("the builder's options become specs", () => {
  const o = (patch: Partial<typeof VISUAL_OPTS_DEFAULT>) => ({
    ...VISUAL_OPTS_DEFAULT,
    ...patch,
  });

  it("keeps a 100% stack only where the parts stack", () => {
    expect(visualAnalytics("scolumn", o({ percentStack: true }))).toEqual({ percentStack: true });
    expect(visualAnalytics("bar", o({ percentStack: true }), false)).toEqual({});
    expect(visualAnalytics("line", o({ percentStack: true }))).toEqual({});
  });

  it("writes the legend only when it moves, and only for charts that draw one", () => {
    expect(visualAnalytics("pie", o({ legend: "right" }))).toEqual({ legend: "right" });
    expect(visualAnalytics("pie", o({ legend: "bottom" }))).toEqual({});
    expect(visualAnalytics("kpi", o({ legend: "none" }))).toEqual({});
  });

  it("keeps notes with an x and a text, numbers as numbers", () => {
    const notes = [
      { x: "34", text: "Safety car" },
      { x: "2026-07", text: " Heatwave " },
      { x: "", text: "no x" },
      { x: "Mon", text: "" },
    ];
    expect(visualAnalytics("line", o({ notes })).annotations).toEqual([
      { x: 34, text: "Safety car" },
      { x: "2026-07", text: "Heatwave" },
    ]);
    expect(visualAnalytics("hbar", o({ notes })).annotations).toBeUndefined();
  });

  it("colours a treemap by a measure, and reads it back", () => {
    expect(treemapColor(o({}))).toEqual({});
    expect(treemapColor(o({ colorMeasure: "margin" }))).toEqual({
      colorMeasure: "margin",
      scale: undefined,
      lowerIsBetter: undefined,
    });
    expect(
      treemapColor(o({ colorMeasure: "delay", heatScale: "diverging", lowerIsBetter: true })),
    ).toEqual({ colorMeasure: "delay", scale: "diverging", lowerIsBetter: true });

    const saved: ChartSpec = {
      type: "treemap",
      nameField: "station",
      valueField: "rides",
      colorMeasure: "avg_minutes",
      scale: "diverging",
      lowerIsBetter: true,
      legend: "none",
      annotations: [{ x: 7, text: "x" }],
    };
    const back = visualOptsFrom(saved);
    expect(back).toMatchObject({
      colorMeasure: "avg_minutes",
      heatScale: "diverging",
      lowerIsBetter: true,
      legend: "none",
      notes: [{ x: "7", text: "x" }],
    });
  });
});

describe("wiring", () => {
  const render = read("src/components/bi/BiChartRender.tsx");

  it("draws every legend through the placement setting", () => {
    // The one <Legend> left is legendEl's own.
    expect(render.match(/<Legend\b/g)).toHaveLength(1);
    expect(render.match(/legendEl\(/g)?.length).toBeGreaterThanOrEqual(7);
  });

  it("draws notes after the marks, so they sit on top", () => {
    for (const layer of ["barNotes", "lineNotes", "areaNotes"]) {
      const at = render.indexOf(`{notesLayer(${layer})}`);
      expect(at, layer).toBeGreaterThan(0);
      // Nothing but the chart's closing tag after it.
      expect(render.slice(at).split("\n")[1]).toMatch(/<\/(BarChart|ComposedChart|AreaChart)>/);
    }
  });

  it("documents each option where readers look", () => {
    const docs = read("src/routes/docs.bi.tsx");
    for (const id of ["percent-stack", "legend-placement", "chart-notes", "treemap-colour"]) {
      expect(docs, id).toContain(`id="${id}"`);
    }
  });
});
