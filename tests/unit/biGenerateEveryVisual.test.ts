// R507: every visual the builder offers can be chosen by the AI — by
// "Generate Entire Dashboard" (tables and governed models), the AI Analyst,
// Visual BI in chat and an embedded agent's chat — and what a model returns is
// made into a chart that draws.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { VIZ_TYPES } from "@/components/bi/vizTypes";
import { calendarCells } from "@/components/bi/biDrawHelpers";
import { autoDateGrain } from "@/lib/biChartMath";
import { PLANNER_SHAPE_RULES, suggestChart, type ChartSpec, type LlmJsonFn } from "@/lib/biAgent";
import {
  CHART_CATALOG,
  NOT_GENERATED,
  chartStepTypeLines,
  chartTypeFromWord,
  fallbackChart,
  isGeneratedChartType,
  normalizeChartSpec,
  plannerTypeList,
} from "@/lib/biChartCatalog";
import { aggregationPlan, isAggregatableChart } from "@/lib/biAggregate";
import { REQUIRED_FIELDS, reconcileChartFields } from "@/lib/biChartFields";
import {
  SEMANTIC_CHART_KINDS,
  semanticTimeOrder,
  widgetFromSemantic,
  type BiWidget,
} from "@/lib/biDashboards";
import { aggregateCappedWidget } from "@/lib/biGeneratedTotals";
import {
  GOVERNED_CHART_TYPES,
  GOVERNED_PLANNER_SYSTEM,
  GOVERNED_SHAPES,
  toSemanticQuery,
  validateSuggestion,
} from "@/lib/biGenerateSemantic";
import { shapeGeneratedChart } from "@/lib/biGeneratedShape";
import { semanticChartSpec } from "@/lib/biSemanticCharts";
import { chartEveryStep } from "@/lib/aiAnalyst";
import type { MetricModelOption } from "@/components/bi/biDataContext";

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");
const result = (columns: string[], rows: Record<string, unknown>[]) => ({
  columns,
  rows,
  row_count: rows.length,
});
const plan = { intent: "x", tables: [], metrics: [], breakdowns: [] } as never;

/** A model that answers with `reply` and keeps the prompt it was shown. */
function fakeLlm(reply: unknown) {
  const seen: { system: string; user: string }[] = [];
  const llm: LlmJsonFn = async <T>(o: { systemPrompt: string; userPrompt: string }) => {
    seen.push({ system: o.systemPrompt, user: o.userPrompt });
    return reply as T;
  };
  return { llm, seen };
}

const salesRows = [
  { region: "North", sales: 120, profit: 30 },
  { region: "South", sales: 90, profit: -4 },
  { region: "East", sales: 60, profit: 12 },
];

describe("one catalogue of visuals, held against the picker", () => {
  it("names every visual the builder offers, or says why a model never chooses it", () => {
    for (const v of VIZ_TYPES) {
      const covered = isGeneratedChartType(v.value) || v.value in NOT_GENERATED;
      expect(covered, v.value).toBe(true);
    }
    // And nothing in the catalogue that the picker cannot draw.
    const offered = new Set(VIZ_TYPES.map((v) => v.value as string));
    for (const e of CHART_CATALOG) expect(offered.has(e.type), e.type).toBe(true);
  });

  it("includes the visuals added since R500", () => {
    for (const t of [
      "pareto",
      "calendar",
      "smallmultiples",
      "pictogram",
      "radialbar",
      "range",
      "bump",
      "pointmap",
      "journey",
      "cards",
      "map",
      "bubblemap",
      "matrix",
      "combo",
    ]) {
      expect(isGeneratedChartType(t), t).toBe(true);
    }
  });

  it("knows which fields each drawn visual cannot do without", () => {
    for (const e of CHART_CATALOG) {
      if (e.type === "table" || e.type === "cards") continue;
      expect(REQUIRED_FIELDS[e.type], e.type).toBeDefined();
    }
  });

  it("has a renderer branch for every catalogue visual", () => {
    const render = read("src/components/bi/BiChartRender.tsx");
    const card = read("src/components/bi/BiWidgetCard.tsx");
    for (const e of CHART_CATALOG) {
      const drawn = render.includes(`"${e.type}"`) || card.includes(`"${e.type}"`);
      expect(drawn, e.type).toBe(true);
    }
  });
});

describe("the chart step offers every visual and reads what comes back", () => {
  const rows = [
    { cause: "Late", count: 40 },
    { cause: "Damaged", count: 25 },
    { cause: "Wrong item", count: 9 },
  ];

  it("lists every catalogue type, with its fields, in the prompt", async () => {
    const { llm, seen } = fakeLlm({ type: "pareto", categoryField: "cause", valueField: "count" });
    await suggestChart({
      question: "What drives returns?",
      result: result(["cause", "count"], rows) as never,
      plan,
      llm,
    });
    const system = seen[0].system;
    for (const e of CHART_CATALOG) expect(system, e.type).toContain(`'${e.type}'`);
    expect(system).toContain("percentStack");
    expect(system).toContain("extraMeasures");
    expect(system).toContain("legend");
    expect(chartStepTypeLines().split("\n")).toHaveLength(CHART_CATALOG.length);
  });

  it("passes the planner's wish through to the chart step", async () => {
    const { llm, seen } = fakeLlm({ type: "bar", xField: "cause", yField: "count" });
    await suggestChart({
      question: "Returns by cause",
      result: result(["cause", "count"], rows) as never,
      plan,
      llm,
      preferChart: "pareto",
    });
    expect(seen[0].user).toContain("'pareto'");
  });

  it("maps a model's word for a visual onto the type that draws it", async () => {
    const cases: [string, string][] = [
      ["Small Multiples", "smallmultiples"],
      ["small_multiples", "smallmultiples"],
      ["donut", "pie"],
      ["choropleth", "map"],
      ["Pivot Table", "matrix"],
      ["stacked-column", "scolumn"],
      ["calendar heatmap", "calendar"],
      ["radial bar", "radialbar"],
      ["dumbbell", "range"],
      ["Pareto Chart", "pareto"],
    ];
    for (const [word, type] of cases) expect(chartTypeFromWord(word), word).toBe(type);
    expect(chartTypeFromWord("controls")).toBeUndefined();
    expect(chartTypeFromWord("ontology")).toBeUndefined();
    expect(chartTypeFromWord("sparkle-chart")).toBeUndefined();
    const { llm } = fakeLlm({ type: "Donut", nameField: "cause", valueField: "count" });
    const spec = await suggestChart({
      question: "q",
      result: result(["cause", "count"], rows) as never,
      plan,
      llm,
    });
    expect(spec.type).toBe("pie");
  });

  it("draws a type nobody draws as the chart the rows can carry", () => {
    const res = { columns: ["region", "sales"], rows: salesRows };
    expect(normalizeChartSpec({ type: "controls", params: ["x"] }, res).type).toBe("bar");
    expect(normalizeChartSpec({ type: "hologram" }, res).type).toBe("bar");
    expect(normalizeChartSpec(null, res).type).toBe("bar");
    expect(normalizeChartSpec([{ type: "bar" }], res).type).toBe("bar");
    const daily = [
      { day: "2026-07-01", rides: 3 },
      { day: "2026-07-02", rides: 5 },
    ];
    expect(fallbackChart(["day", "rides"], daily)).toEqual({
      type: "line",
      xField: "day",
      yField: "rides",
    });
    expect(fallbackChart(["a", "b"], [{ a: "x", b: "y" }]).type).toBe("table");
  });

  it("keeps an option only when its value is one the renderer reads", () => {
    const res = { columns: ["month", "sales", "region"], rows: [] };
    const spec = normalizeChartSpec(
      {
        type: "line",
        xField: ["month"],
        yField: "sales",
        legend: "middle",
        movingAverage: "7",
        forecast: { model: "x" },
        zoomBar: "true",
        logScale: "maybe",
        dateGrain: "Month",
        refLine: { mode: "average" },
        annotations: [{ x: "2026-07", text: "Heatwave" }, { x: "2026-08" }],
      },
      res,
    ) as Record<string, unknown>;
    expect(spec.xField).toBe("month");
    expect(spec.legend).toBeUndefined();
    expect(spec.movingAverage).toBe(7);
    expect(spec.forecast).toBeUndefined();
    expect(spec.zoomBar).toBe(true);
    expect(spec.logScale).toBeUndefined();
    expect(spec.dateGrain).toBe("month");
    expect(spec.refLine).toEqual({ mode: "avg" });
    expect(spec.annotations).toEqual([{ x: "2026-07", text: "Heatwave" }]);

    const map = normalizeChartSpec(
      { type: "map", locationField: "state", valueField: "n", region: "USA" },
      res,
    );
    expect((map as { region?: string }).region).toBeUndefined();
    const us = normalizeChartSpec(
      { type: "map", locationField: "state", valueField: "n", region: "US" },
      res,
    );
    expect((us as { region?: string }).region).toBe("us");
    const combo = normalizeChartSpec(
      {
        type: "combo",
        xField: "m",
        barField: "a",
        lineField: "b",
        lineAxis: "LEFT",
        extraLines: "c",
      },
      res,
    ) as Record<string, unknown>;
    expect(combo.lineAxis).toBe("left");
    expect(combo.extraLines).toEqual(["c"]);
    const kpi = normalizeChartSpec({ type: "kpi", valueField: "sales", compareTo: "yoy" }, res);
    expect((kpi as { compareTo?: string }).compareTo).toBe("year");
    const picto = normalizeChartSpec(
      { type: "pictogram", categoryField: "r", valueField: "n", icon: "unicorn" },
      res,
    );
    expect((picto as { icon?: string }).icon).toBeUndefined();
  });

  it("gives a narrative a sentence the columns can carry when the model named none", () => {
    const res = { columns: ["region", "sales"], rows: salesRows };
    const spec = normalizeChartSpec({ type: "insight", valueField: "sales" }, res) as Record<
      string,
      unknown
    >;
    expect(spec.kind).toBe("top");
    expect(spec.categoryField).toBe("region");
  });

  it("names cards after the first label column when the model wrote no title", () => {
    const res = { columns: ["product", "revenue"], rows: [{ product: "A", revenue: 3 }] };
    const spec = normalizeChartSpec({ type: "cards" }, res) as Record<string, unknown>;
    expect(spec.title).toBe("{{product}}");
  });
});

describe("the columns a generated chart names", () => {
  it("fills a field the model left out when exactly one column can be meant", () => {
    const v = reconcileChartFields({
      chart: { type: "pareto" } as ChartSpec,
      columns: ["cause", "count"],
      rows: [
        { cause: "Late", count: 4 },
        { cause: "Lost", count: 2 },
      ],
    });
    expect(v.verdict).toBe("repaired");
    expect(v.verdict !== "ok" && v.chart).toMatchObject({
      type: "pareto",
      categoryField: "cause",
      valueField: "count",
    });
    // Nothing the model named was renamed, so there is nothing to say.
    expect(v.verdict === "repaired" && v.note).toBeFalsy();
  });

  it("shows the rows, and says why, when it cannot tell which column was meant", () => {
    const v = reconcileChartFields({
      chart: { type: "pareto", categoryField: "cause" } as ChartSpec,
      columns: ["cause", "count", "cost"],
      rows: [{ cause: "Late", count: 4, cost: 9 }],
    });
    expect(v.verdict).toBe("unplottable");
    expect(v.verdict === "unplottable" && v.note).toMatch(/did not say which column is its value/);
  });

  it("will not silently drop the date a calendar is drawn on", () => {
    // dateField is optional on a KPI, so a missing one used to be deleted;
    // on a calendar it is the chart.
    const v = reconcileChartFields({
      chart: { type: "calendar", dateField: "date", valueField: "rides" } as ChartSpec,
      columns: ["day", "rides"],
      rows: [
        { day: "2026-07-01", rides: 3 },
        { day: "2026-07-02", rides: 5 },
      ],
    });
    expect(v.verdict).toBe("repaired");
    expect(v.verdict !== "ok" && (v.chart as { dateField?: string }).dateField).toBe("day");
  });

  it("keeps a stacked column whose series split is missing as a single series", () => {
    const v = reconcileChartFields({
      chart: {
        type: "scolumn",
        xField: "region",
        yField: "sales",
        seriesField: "segment",
      } as ChartSpec,
      columns: ["region", "sales"],
      rows: salesRows,
    });
    expect(v.verdict).toBe("repaired");
    expect(v.verdict !== "ok" && (v.chart as { seriesField?: string }).seriesField).toBeUndefined();
    expect(v.verdict !== "ok" && v.chart.type).toBe("scolumn");
  });

  it("drops extra measures the rows cannot draw, and lines no longer among them", () => {
    const v = reconcileChartFields({
      chart: {
        type: "combo",
        xField: "region",
        barField: "sales",
        lineField: "profit",
        extraMeasures: ["sales", "margin", "region", "profit"],
        extraLines: ["margin"],
      } as ChartSpec,
      columns: ["region", "sales", "profit"],
      rows: salesRows,
    });
    expect(v.verdict).toBe("repaired");
    const c = v.verdict !== "ok" ? (v.chart as Record<string, unknown>) : {};
    expect(c.extraMeasures).toBeUndefined();
    expect(c.extraLines).toBeUndefined();
  });

  it("keeps extra measures that are there", () => {
    const v = reconcileChartFields({
      chart: {
        type: "bar",
        xField: "region",
        yField: "sales",
        extraMeasures: ["profit"],
      } as ChartSpec,
      columns: ["region", "sales", "profit"],
      rows: salesRows,
    });
    expect(v.verdict).toBe("ok");
  });

  it("drops a treemap colour measure the query did not return", () => {
    const v = reconcileChartFields({
      chart: {
        type: "treemap",
        nameField: "region",
        valueField: "sales",
        colorMeasure: "margin",
        scale: "diverging",
      } as ChartSpec,
      columns: ["region", "sales"],
      rows: salesRows,
    });
    const c = v.verdict !== "ok" ? (v.chart as Record<string, unknown>) : {};
    expect(c.colorMeasure).toBeUndefined();
    expect(c.scale).toBeUndefined();
  });
});

describe("the planner's visual, built when the chart step drew another", () => {
  const bar = (x: string, y: string) => ({ type: "bar", xField: x, yField: y }) as ChartSpec;
  const shape = (
    chartType: string,
    columns: string[],
    rows: Record<string, unknown>[],
    current?: ChartSpec,
  ) => shapeGeneratedChart({ chartType }, columns, rows, current);

  it("draws a pareto, a pictogram and radial bars from a category and a measure", () => {
    expect(shape("pareto", ["region", "sales"], salesRows, bar("region", "sales"))).toMatchObject({
      type: "pareto",
      categoryField: "region",
      valueField: "sales",
    });
    expect(shape("pictogram", ["region", "sales"], salesRows, bar("region", "sales"))?.type).toBe(
      "pictogram",
    );
    expect(
      shape("radialbar", ["region", "sales"], salesRows, bar("region", "sales")),
    ).toMatchObject({
      type: "radialbar",
      nameField: "region",
    });
  });

  it("draws a calendar only from a date", () => {
    const days = Array.from({ length: 14 }, (_, i) => ({
      day: `2026-07-${String(i + 1).padStart(2, "0")}`,
      rides: i * 3,
    }));
    expect(shape("calendar", ["day", "rides"], days)).toMatchObject({
      type: "calendar",
      dateField: "day",
      valueField: "rides",
    });
    expect(shape("calendar", ["region", "sales"], salesRows, bar("region", "sales"))?.type).toBe(
      "bar",
    );
  });

  it("draws small multiples per value of a second category", () => {
    const rows = ["2026-01", "2026-02", "2026-03"].flatMap((m, i) =>
      ["North", "South"].map((r, j) => ({ month: m, region: r, sales: 10 * i + j })),
    );
    expect(shape("smallmultiples", ["month", "region", "sales"], rows)).toMatchObject({
      type: "smallmultiples",
      xField: "month",
      splitField: "region",
      yField: "sales",
      kind: "line",
    });
  });

  it("draws a combo and a pivot with every measure that came back", () => {
    const rows = [
      { region: "North", segment: "A", sales: 1, profit: 2, units: 3 },
      { region: "South", segment: "B", sales: 4, profit: 5, units: 6 },
    ];
    const cols = ["region", "segment", "sales", "profit", "units"];
    expect(shape("combo", cols, rows, bar("region", "sales"))).toMatchObject({
      type: "combo",
      xField: "region",
      barField: "sales",
      lineField: "profit",
      extraMeasures: ["units"],
    });
    expect(shape("matrix", cols, rows, bar("region", "sales"))).toMatchObject({
      type: "matrix",
      rowField: "region",
      colField: "segment",
      valueField: "sales",
      extraMeasures: ["profit", "units"],
    });
  });

  it("draws a map only when the values are places", () => {
    const states = [
      { st: "OH", claims: 3 },
      { st: "TX", claims: 5 },
      { st: "FL", claims: 2 },
    ];
    expect(shape("map", ["st", "claims"], states, bar("st", "claims"))).toMatchObject({
      type: "map",
      locationField: "st",
    });
    expect(shape("map", ["region", "sales"], salesRows, bar("region", "sales"))?.type).toBe("bar");
  });

  it("draws rank over time only from a rank, and points only from coordinates", () => {
    const ranks = [
      { week: "2026-W01", team: "A", pos: 1 },
      { week: "2026-W01", team: "B", pos: 2 },
      { week: "2026-W02", team: "A", pos: 2 },
      { week: "2026-W02", team: "B", pos: 1 },
    ];
    expect(shape("bump", ["week", "team", "pos"], ranks)).toMatchObject({
      type: "bump",
      yField: "pos",
      seriesField: "team",
    });
    const pts = [
      { name: "Dock 1", lat: 51.5, lng: -0.12, bikes: 9 },
      { name: "Dock 2", lat: 51.52, lng: -0.1, bikes: 4 },
    ];
    expect(shape("pointmap", ["name", "lat", "lng", "bikes"], pts)).toMatchObject({
      type: "pointmap",
      latField: "lat",
      lngField: "lng",
      sizeField: "bikes",
      labelField: "name",
    });
    expect(shape("pointmap", ["region", "sales"], salesRows, bar("region", "sales"))?.type).toBe(
      "bar",
    );
  });

  it("draws start to finish from two measures per item", () => {
    expect(shape("range", ["region", "sales", "profit"], salesRows)).toMatchObject({
      type: "range",
      categoryField: "region",
      startField: "sales",
      endField: "profit",
    });
  });

  it("leaves the chart alone when it already is the planner's, or the shape cannot carry it", () => {
    const pareto = { type: "pareto", categoryField: "region", valueField: "sales" } as ChartSpec;
    expect(shape("pareto", ["region", "sales"], salesRows, pareto)).toBe(pareto);
    expect(
      shape("journey", ["region", "sales"], Array(20).fill(salesRows[0]), bar("region", "sales"))
        ?.type,
    ).toBe("bar");
  });

  it("keeps the number format the chart step chose", () => {
    const current = { ...bar("region", "sales"), format: "currency", currency: "EUR" } as ChartSpec;
    expect(shape("pareto", ["region", "sales"], salesRows, current)).toMatchObject({
      type: "pareto",
      format: "currency",
      currency: "EUR",
    });
  });
});

describe("the dashboard planner", () => {
  it("is offered every catalogue visual, and told the question each one needs", () => {
    const list = plannerTypeList();
    for (const e of CHART_CATALOG) expect(list, e.type).toContain(e.type);
    expect(PLANNER_SHAPE_RULES).toMatch(/calendar.*PER DAY/);
    expect(PLANNER_SHAPE_RULES).toMatch(/smallmultiples.*FOR EACH/);
    expect(PLANNER_SHAPE_RULES).toMatch(/bump.*RANK/);
    const src = read("src/lib/biAgent.ts");
    expect(src).toContain("const SUGGESTABLE_CHARTS = plannerTypeList();");
    expect(src).toContain("chartType: chartTypeFromWord(w.chartType)");
  });

  it("shows each planned visual with the picker's own icon and name", () => {
    const src = read("src/components/bi/GenerateDashboardDialog.tsx");
    expect(src).toContain("VIZ_TYPES.find((v) => v.value === type)?.icon");
    expect(src).toContain("{chartTypeLabel(s.chartType)}");
  });
});

describe("a dashboard generated from a governed model", () => {
  const model: MetricModelOption = {
    name: "sales_model",
    label: "Sales",
    metrics: [
      { name: "revenue", agg: "sum" },
      { name: "margin", agg: "avg" },
      { name: "orders", agg: "count" },
    ],
    dimensions: [
      { name: "region", type: "string" },
      { name: "channel", type: "string" },
      { name: "segment", type: "string" },
      { name: "order_date", type: "time" },
    ],
  };
  const check = (
    chartType: string,
    metrics: string[],
    dimensions: string[],
    grains?: Record<string, string>,
  ) => validateSuggestion({ title: chartType, chartType, metrics, dimensions, grains }, model);

  it("takes the shapes a query of metrics by dimensions can fill", () => {
    expect(GOVERNED_CHART_TYPES).toEqual(
      expect.arrayContaining(["combo", "matrix", "map", "calendar", "pareto", "smallmultiples"]),
    );
    expect([...GOVERNED_CHART_TYPES].sort()).toEqual([...SEMANTIC_CHART_KINDS].sort());
    for (const t of GOVERNED_CHART_TYPES) expect(GOVERNED_PLANNER_SYSTEM, t).toContain(t);
  });

  it("holds each shape to the metrics and dimensions it draws", () => {
    expect(check("combo", ["revenue", "margin"], ["region"]).ok).toBe(true);
    expect(check("combo", ["revenue"], ["region"]).ok).toBe(false);
    expect(check("matrix", ["revenue", "orders"], ["region", "channel", "segment"]).ok).toBe(true);
    expect(check("matrix", ["revenue"], ["region"]).ok).toBe(false);
    const split = check("bar", ["revenue", "margin"], ["region", "channel"]);
    expect(!split.ok && split.rejected.reason).toMatch(/second dimension shows one metric/);
    expect(check("pie", ["revenue", "margin"], ["region"]).ok).toBe(false);
  });

  it("lets a KPI read a time dimension, and only a time dimension", () => {
    expect(check("kpi", ["revenue"], ["order_date"], { order_date: "month" }).ok).toBe(true);
    const r = check("kpi", ["revenue"], ["region"]);
    expect(!r.ok && r.rejected.reason).toMatch(/single figure/);
  });

  it("draws a calendar by the day", () => {
    const r = check("calendar", ["orders"], ["order_date"]);
    expect(r.ok && r.widget.grains).toEqual({ order_date: "day" });
    const monthly = check("calendar", ["orders"], ["order_date"], { order_date: "month" });
    expect(!monthly.ok && monthly.rejected.reason).toMatch(/one square per day/);
    expect(check("calendar", ["orders"], ["region"]).ok).toBe(false);
  });

  it("builds each shape from the query the compiler returns", () => {
    const rows = [{ region: "N", channel: "web", revenue: 1, margin: 0.2, orders: 3 }];
    const cols = ["region", "channel", "revenue", "margin", "orders"];
    const spec = (
      chartType: string,
      metrics: string[],
      dimensions: string[],
      grains?: Record<string, string>,
    ) =>
      semanticChartSpec({
        chartType: chartType as never,
        metrics,
        dimensions,
        columns: cols,
        rows,
        grains,
      });
    expect(spec("combo", ["revenue", "margin", "orders"], ["region"])).toEqual({
      type: "combo",
      xField: "region",
      barField: "revenue",
      lineField: "margin",
      extraMeasures: ["orders"],
    });
    expect(spec("matrix", ["revenue", "margin"], ["region", "channel"])).toMatchObject({
      type: "matrix",
      rowField: "region",
      colField: "channel",
      extraMeasures: ["margin"],
    });
    expect(spec("bar", ["revenue", "orders"], ["region"])).toMatchObject({
      extraMeasures: ["orders"],
    });
    expect(spec("kpi", ["revenue"], ["order_date"], { order_date: "month" })).toMatchObject({
      type: "kpi",
      dateField: "order_date",
      sparkline: true,
    });
    expect(
      spec("smallmultiples", ["revenue"], ["order_date", "region"], { order_date: "month" }),
    ).toMatchObject({
      kind: "line",
      splitField: "region",
    });
    expect(spec("treemap", ["revenue", "margin"], ["region"])).toMatchObject({
      colorMeasure: "margin",
    });
    expect(spec("map", ["revenue"], ["region"])).toMatchObject({
      type: "map",
      locationField: "region",
    });
  });

  it("falls back to a shape the query can fill, never an empty frame", () => {
    const rows = [{ region: "N", revenue: 1 }];
    const cols = ["region", "revenue"];
    const spec = (chartType: string, metrics: string[], dimensions: string[]) =>
      semanticChartSpec({
        chartType: chartType as never,
        metrics,
        dimensions,
        columns: cols,
        rows,
      });
    expect(spec("combo", ["revenue"], ["region"]).type).toBe("bar");
    expect(spec("heatmap", ["revenue"], ["region"]).type).toBe("bar");
    expect(spec("matrix", ["revenue"], ["region"]).type).toBe("table");
    expect(spec("pie", ["revenue"], []).type).toBe("kpi");
    expect(spec("calendar", ["revenue"], ["region"]).type).toBe("bar");
  });

  it("carries the lead metric's format onto every chart but a table", () => {
    const w = widgetFromSemantic({
      title: "Revenue by region",
      model: "m",
      metrics: ["revenue"],
      dimensions: ["region"],
      chartType: "pareto",
      columns: ["region", "revenue"],
      rows: [{ region: "N", revenue: 1 }],
      sql: "SELECT 1",
      format: "currency",
      currency: "EUR",
    });
    expect(w.chart).toMatchObject({ type: "pareto", format: "currency", currency: "EUR" });
    const shapes = GOVERNED_SHAPES;
    expect(shapes.table.metrics[1]).toBeGreaterThan(1);
  });
});

describe("the AI Analyst, chat and embeds check the columns too", () => {
  it("re-points an analyst step's chart at the column its query returned", async () => {
    const turn = {
      question: "q",
      steps: [{ goal: "Rides by station" }],
    } as never as Parameters<typeof chartEveryStep>[0]["turn"];
    await chartEveryStep({
      turn,
      results: [
        {
          columns: ["station", "rides"],
          rows: [
            { station: "A", rides: 4 },
            { station: "B", rides: 2 },
          ],
          row_count: 2,
        } as never,
      ],
      question: "q",
      suggest: async () =>
        ({ type: "pareto", categoryField: "station", valueField: "trips" }) as ChartSpec,
    });
    expect(turn.steps[0].chart).toMatchObject({ type: "pareto", valueField: "rides" });
  });

  it("checks chat's and the embed's charts with the same function", () => {
    expect(read("src/lib/chatBi.ts")).toContain("reconcileChartFields({");
    const embed = read("src/utils/embedBi.server.ts");
    expect(embed).toContain("await suggestChart({");
    expect(embed).toContain("reconcileChartFields({ chart: suggested");
    // The six-type list that embeds were limited to is gone.
    expect(embed).not.toContain('"bar"|"line"|"area"|"pie"|"scatter"|"kpi"');
  });
});

describe("found generating a dashboard in the browser", () => {
  it("keeps a combo's extra measures and a treemap's colour through the GROUP BY", () => {
    // A refresh aggregates in SQL; columns left out of the plan were dropped,
    // so the combo lost its third series and the treemap its colour.
    const combo = aggregationPlan({
      type: "combo",
      xField: "month",
      barField: "sales",
      lineField: "margin",
      extraMeasures: ["units"],
    } as ChartSpec);
    expect(combo?.measures.map((m) => m.field)).toEqual(["sales", "margin", "units"]);
    const tree = aggregationPlan({
      type: "treemap",
      nameField: "product",
      valueField: "sales",
      colorMeasure: "profit",
    } as ChartSpec);
    expect(tree?.measures.map((m) => m.field)).toEqual(["sales", "profit"]);
  });

  it("aggregates in SQL the newer visuals whose renderers add up duplicates", () => {
    const plan = (chart: Record<string, unknown>) => aggregationPlan(chart as ChartSpec);
    expect(plan({ type: "pareto", categoryField: "product", valueField: "sales" })).toEqual({
      dims: ["product"],
      measures: [{ field: "sales", agg: "sum" }],
    });
    expect(plan({ type: "calendar", dateField: "day", valueField: "rides" })?.dims).toEqual([
      "day",
    ]);
    expect(plan({ type: "pictogram", categoryField: "segment", valueField: "n" })?.dims).toEqual([
      "segment",
    ]);
    expect(
      plan({ type: "smallmultiples", xField: "month", yField: "sales", splitField: "region" })
        ?.dims,
    ).toEqual(["month", "region"]);
    // These draw row by row, so a GROUP BY would change what they show.
    expect(plan({ type: "radialbar", nameField: "r", valueField: "v" })).toBeNull();
    expect(plan({ type: "journey", categoryField: "r", valueField: "v" })).toBeNull();
    // Generated widgets start with pushdown on for them.
    expect(isAggregatableChart({ type: "pareto" } as ChartSpec)).toBe(true);
  });

  it("adds up each small multiple's rows by x, as a line chart does", () => {
    // In the helpers since R511, which the card and the PDF both use.
    const src = read("src/components/bi/biDrawHelpers.ts");
    expect(src).toContain("rows: aggregateByField(g.rows, chart.xField, [chart.yField])");
    expect(read("src/components/bi/BiBreadthCharts.tsx")).toContain(
      "smallMultipleGroups(rows, chart)",
    );
  });

  it("keeps a date grain only on the charts that regroup by one", () => {
    const res = { columns: ["month", "sales", "profit"], rows: [] };
    const combo = normalizeChartSpec(
      {
        type: "combo",
        xField: "month",
        barField: "sales",
        lineField: "profit",
        dateGrain: "month",
      },
      res,
    );
    expect((combo as { dateGrain?: string }).dateGrain).toBeUndefined();
    const line = normalizeChartSpec(
      { type: "line", xField: "month", yField: "sales", dateGrain: "month" },
      res,
    );
    expect((line as { dateGrain?: string }).dateGrain).toBe("month");
    // And a grain already stored on a combo no longer leaves its axis raw.
    const render = read("src/components/bi/BiChartRender.tsx");
    expect(render).toContain('} else if (xKey && (grain === "auto" || !isTime)) {');
  });

  it("asks for a year of days at most, and a governed calendar for the latest days", () => {
    expect(PLANNER_SHAPE_RULES).toMatch(/PER DAY over the last 12 months/);
    const q = toSemanticQuery(
      {
        title: "Daily orders",
        chartType: "calendar",
        metrics: ["orders"],
        dimensions: ["order_date"],
        grains: { order_date: "day" },
      },
      "sales_model",
    );
    expect(q.orderBy).toEqual([{ field: "order_date", dir: "desc" }]);
    expect(q.limit).toBe(400);
  });
});

describe("a generated widget that hit the snapshot cap", () => {
  const capped = (chart: Record<string, unknown>): BiWidget =>
    ({
      id: "w",
      kind: "chart",
      title: "Monthly sales for each region",
      source: { kind: "local" },
      sql: "SELECT order_date, region, sales FROM saas_sales ORDER BY order_date",
      chart: chart as ChartSpec,
      columns: ["order_date", "region", "sales"],
      rows: Array.from({ length: 500 }, () => ({
        order_date: "2022-01-03",
        region: "EMEA",
        sales: 1,
      })),
      truncated: true,
      agg_pushdown: true,
    }) as BiWidget;
  const sm = {
    type: "smallmultiples",
    xField: "order_date",
    yField: "sales",
    splitField: "region",
  };

  it("is aggregated in SQL at once, as the next refresh would", async () => {
    const w = capped(sm);
    const seen: string[] = [];
    const done = await aggregateCappedWidget({
      widget: w,
      dialect: "duckdb",
      cap: 500,
      run: async (sql) => {
        seen.push(sql);
        return {
          columns: ["order_date", "region", "sales"],
          rows: [
            { order_date: "2022-01-03", region: "EMEA", sales: 900 },
            { order_date: "2022-01-03", region: "AMER", sales: 700 },
          ],
        };
      },
    });
    expect(done).toBe(true);
    expect(seen[0]).toMatch(/SUM\("sales"\) AS "sales"/);
    expect(seen[0]).toMatch(/GROUP BY "order_date", "region"/);
    expect(w.rows).toHaveLength(2);
    expect(w.truncated).toBe(false);
  });

  it("is left as it was, still marked Partial, when the query cannot be aggregated", async () => {
    const off = { ...capped(sm), agg_pushdown: false } as BiWidget;
    expect(
      await aggregateCappedWidget({
        widget: off,
        dialect: "duckdb",
        cap: 500,
        run: async () => ({ columns: [], rows: [] }),
      }),
    ).toBe(false);
    const failed = capped(sm);
    const kept = failed.rows;
    expect(
      await aggregateCappedWidget({
        widget: failed,
        dialect: "duckdb",
        cap: 500,
        run: async () => {
          throw new Error("engine down");
        },
      }),
    ).toBe(false);
    expect(failed.rows).toBe(kept);
    expect(failed.truncated).toBe(true);
    // A scatter needs every point, so it never aggregates.
    const scatter = capped({ type: "scatter", xField: "sales", yField: "sales" });
    expect(
      await aggregateCappedWidget({
        widget: scatter,
        dialect: "duckdb",
        cap: 500,
        run: async () => ({ columns: [], rows: [] }),
      }),
    ).toBe(false);
  });

  it("is wired into the dashboard generator", () => {
    expect(read("src/components/bi/GenerateDashboardDialog.tsx")).toContain(
      "await aggregateCappedWidget({",
    );
  });
});

describe("a calendar that starts on the last day of a month", () => {
  it("names the month that fills the columns, not both on top of each other", () => {
    const rows = Array.from({ length: 40 }, (_, i) => {
      const d = new Date(Date.UTC(2024, 11, 31 + i));
      return { d: d.toISOString().slice(0, 10), v: i };
    });
    const { months } = calendarCells(rows, "d", "v");
    expect(months[0].label).toBe("Jan");
    expect(months.map((m) => m.label)).not.toContain("Dec");
  });
});

describe("a monthly series spanning less than a year and a half", () => {
  it("is labelled by month, not by the week each month starts in", () => {
    // Found in the AI Analyst: twelve monthly timestamps span 334 days, which
    // fits 60 weekly labels, so the combo's axis read "2025-W44, 2025-W49".
    const months = Array.from({ length: 12 }, (_, i) => ({
      m: new Date(Date.UTC(2025, 10 + i, 1)).toISOString().slice(0, 10) + " 00:00:00",
    }));
    expect(autoDateGrain(months, "m")).toBe("month");
    const quarters = [0, 3, 6, 9].map((mo) => ({
      q: new Date(Date.UTC(2025, mo, 1)).toISOString().slice(0, 10) + " 00:00:00",
    }));
    expect(autoDateGrain(quarters, "q")).toBe("quarter");
    // Daily data keeps the grain its span asks for.
    const days = Array.from({ length: 40 }, (_, i) => ({
      d: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10) + " 00:00:00",
    }));
    expect(autoDateGrain(days, "d")).toBe("day");
  });
});

describe("a governed time axis", () => {
  it("is asked for oldest first, and keeps that order on refresh", () => {
    // Found generating from a semantic model: quarters reached the combo as
    // 2024-10, 2024-04, 2022-04, because a governed query has no order.
    expect(semanticTimeOrder(["region", "order_date"], { order_date: "quarter" })).toEqual([
      { field: "order_date", dir: "asc" },
    ]);
    expect(semanticTimeOrder(["region"], {})).toBeUndefined();
    const q = toSemanticQuery(
      {
        title: "Quarterly sales and profit",
        chartType: "combo",
        metrics: ["revenue", "margin"],
        dimensions: ["order_date"],
        grains: { order_date: "quarter" },
      },
      "sales_model",
    );
    expect(q.orderBy).toEqual([{ field: "order_date", dir: "asc" }]);
    const w = widgetFromSemantic({
      title: "Quarterly sales and profit",
      model: "m",
      metrics: ["revenue", "margin"],
      dimensions: ["order_date"],
      grains: { order_date: "quarter" },
      orderBy: q.orderBy,
      chartType: "combo",
      columns: ["order_date", "revenue", "margin"],
      rows: [{ order_date: "2022-01-01", revenue: 1, margin: 2 }],
      sql: "SELECT 1",
    });
    expect(w.source).toMatchObject({
      kind: "semantic",
      orderBy: [{ field: "order_date", dir: "asc" }],
    });
    expect(read("src/utils/bi/refresh.server.ts")).toContain("orderBy: w.source.orderBy,");
    expect(read("src/components/bi/BiBuilderPane.tsx")).toContain(
      "semanticTimeOrder(mmDims, grains)",
    );
  });
});

describe("an embed answer without a chart", () => {
  it("says why in the server log, and never with the question or the rows", () => {
    const src = read("src/utils/embedBi.server.ts");
    expect(src).toContain("console.warn(`[embed-bi] owner ${opts.ownerId}: no chart: ${reason}`)");
    for (const reason of [
      "the agent can read no data tables",
      "the model wrote no SQL",
      "the query returned no rows",
      "the rows suit no chart",
    ]) {
      expect(src).toContain(reason);
    }
    // The skip reasons interpolate schema facts only.
    expect(src).not.toMatch(/skip\([^)]*opts\.question/);
  });

  it("declines a question about a table the agent cannot read", () => {
    expect(read("src/utils/embedBi.server.ts")).toContain('return { "sql": null }');
  });

  it("asks every query to stay long, and the analyst to plan steps that fit", () => {
    expect(read("src/lib/biAgent.ts")).toContain("Keep the result LONG");
    // R512: a step drawn as a chart keeps more rows than one shown as a table.
    expect(read("src/lib/aiAnalyst.ts")).toContain("Each step keeps its first");
    expect(read("src/lib/aiAnalyst.ts")).toContain("when drawn ");
  });
});
