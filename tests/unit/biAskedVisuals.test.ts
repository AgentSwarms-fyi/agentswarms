// The visual a request asks for survives being split (R511). Asked in chat
// for "sales by region as a nightingale rose, sales by segment as radial
// bars, sales by industry as a treemap, and sales by product as a pareto
// chart", Visual BI drew four bar charts: the request was reworded into one
// question per visual, and the rewording dropped "as a treemap". The AI
// Analyst did the same with its steps. Found in R511's UI test, with a bar
// chart whose category and measure were the wrong way round.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { chartEveryStep, type AnalystTurn } from "@/lib/aiAnalyst";
import { kpiCaption, singleValueKpi } from "@/lib/biAgent";
import { requestedChartTypes } from "@/lib/biChartCatalog";
import { reconcileChartFields } from "@/lib/biChartFields";

describe("the visuals a request names", () => {
  it("are read in order, however they are spelled", () => {
    expect(
      requestedChartTypes(
        "From saas_sales, show four charts: total sales as a KPI, the profit margin as a gauge against a 15% target, a narrative sentence about the top 3 products by sales, and sales by region as a bar chart.",
      ),
    ).toEqual(["kpi", "gauge", "insight", "bar"]);
    expect(
      requestedChartTypes(
        "show the top 10 customers as horizontal bars, sales by industry split by segment as stacked horizontal bars, sales by region as stacked columns, and quarterly profit as a line chart",
      ),
    ).toEqual(["hbar", "shbar", "scolumn", "line"]);
    expect(
      requestedChartTypes(
        "sales by region as a nightingale rose, sales by segment as radial bars, sales by industry as a treemap, and sales by product as a pareto chart",
      ),
    ).toEqual(["nightingale", "radialbar", "treemap", "pareto"]);
    expect(
      requestedChartTypes(
        "orders, discounted orders and profitable orders as a funnel, profit by product as a waterfall, a heatmap of sales by region and quarter, and sales by region and segment as a pivot table",
      ),
    ).toEqual(["funnel", "waterfall", "heatmap", "matrix"]);
    expect(
      requestedChartTypes(
        "daily sales in 2025 as a calendar heatmap, monthly sales split by region as small multiples, sales as a word cloud, order sizes as a box plot, sales by country as a bubble map",
      ),
    ).toEqual(["calendar", "smallmultiples", "wordcloud", "boxplot", "bubblemap"]);
  });

  it("are not found in ordinary words", () => {
    expect(
      requestedChartTypes("show me revenue by region and the number of orders by month"),
    ).toEqual([]);
    expect(requestedChartTypes("list my data tables, then the flow of orders by line")).toEqual([]);
    expect(requestedChartTypes("as well as the totals, such as revenue")).toEqual([]);
  });
});

describe("a split request", () => {
  it("tells the chat splitter to keep each visual, and hands each question its own", () => {
    const src = readFileSync("src/lib/chatBi.ts", "utf8");
    expect(src).toMatch(/KEEP the visual the user asked for with the question it belongs to/);
    expect(src).toMatch(/preferChart: preferFor\(q, i\)/);
  });

  it("gives each analyst step the visual asked for it, in order", async () => {
    const res = (rows: Record<string, unknown>[]) => ({
      columns: Object.keys(rows[0]),
      rows,
      row_count: rows.length,
      total_matched: rows.length,
      capped: false,
      duration_ms: 1,
    });
    const turn: AnalystTurn = {
      question: "q",
      steps: [
        { goal: "total sales by industry", status: "done" },
        { goal: "daily sales in 2025", status: "done" },
        { goal: "sales by region and segment as a pivot", status: "done" },
      ],
      status: "done",
    };
    const preferred: (string | undefined)[] = [];
    await chartEveryStep({
      turn,
      question:
        "Show sales by industry as a treemap, daily sales in 2025 as a calendar heatmap, and sales by region and segment as a pivot table.",
      results: [
        res([{ industry: "Finance", sales: 3 }]),
        res([{ day: "2025-01-01", sales: 4 }]),
        res([{ region: "EMEA", segment: "SMB", sales: 5 }]),
      ],
      suggest: async (a) => {
        preferred.push(a.preferChart);
        return { type: "table" };
      },
    });
    expect(preferred).toEqual(["treemap", "calendar", "matrix"]);
  });

  it("says nothing when the steps do not line up with the visuals named", async () => {
    const turn: AnalystTurn = {
      question: "q",
      steps: [
        { goal: "a", status: "done" },
        { goal: "b", status: "done" },
      ],
      status: "done",
    };
    const preferred: (string | undefined)[] = [];
    const r = {
      columns: ["k", "v"],
      rows: [{ k: "x", v: 1 }],
      row_count: 1,
      total_matched: 1,
      capped: false,
      duration_ms: 1,
    };
    await chartEveryStep({
      turn,
      question: "three things: sales as a treemap, profit as a funnel, and cost as a pie",
      results: [r, r],
      suggest: async (a) => {
        preferred.push(a.preferChart);
        return { type: "table" };
      },
    });
    expect(preferred).toEqual([undefined, undefined]);
  });
});

describe("a category and a measure the wrong way round", () => {
  const rows = [
    { Customer: "Example Corp", total_sales: 43893.0424 },
    { Customer: "AnyCompany", total_sales: 41255.9471 },
  ];

  it("are swapped back", () => {
    const v = reconcileChartFields({
      chart: { type: "hbar", xField: "total_sales", yField: "Customer" } as never,
      columns: ["Customer", "total_sales"],
      rows,
    });
    expect(v).toMatchObject({
      verdict: "repaired",
      chart: { type: "hbar", xField: "Customer", yField: "total_sales" },
    });
    const pie = reconcileChartFields({
      chart: { type: "treemap", nameField: "total_sales", valueField: "Customer" } as never,
      columns: ["Customer", "total_sales"],
      rows,
    });
    expect(pie).toMatchObject({ chart: { nameField: "Customer", valueField: "total_sales" } });
  });

  it("are left alone when both read as numbers, as years by sales do", () => {
    const v = reconcileChartFields({
      chart: { type: "bar", xField: "year", yField: "sales" } as never,
      columns: ["year", "sales"],
      rows: [
        { year: 2024, sales: 10 },
        { year: 2025, sales: 12 },
      ],
    });
    expect(v.verdict).toBe("ok");
  });
});

describe("a KPI's caption", () => {
  it("is the measure's name when the intent is an instruction", () => {
    expect(
      kpiCaption("total_sales", "Calculate the total sales amount from the SaaS sales dataset"),
    ).toBe("Total sales");
    expect(
      kpiCaption("table_count", "Count the number of tables in the ontology_sample schema"),
    ).toBe("Table count");
    expect(kpiCaption("revenue", "Revenue this year")).toBe("Revenue this year");
    expect(
      singleValueKpi(
        {
          columns: ["total_sales"],
          rows: [{ total_sales: 2297201.86 }],
          row_count: 1,
          total_matched: 1,
          capped: false,
          duration_ms: 1,
        },
        "Calculate the total sales amount from the SaaS sales dataset",
      ),
    ).toMatchObject({ type: "kpi", valueField: "total_sales", label: "Total sales" });
  });
});

describe("a gauge of a ratio against a percentage", () => {
  it("is read on one scale: a 12% margin against a 15% target", async () => {
    const { gaugeReading } = await import("@/components/bi/biDrawHelpers");
    expect(gaugeReading({ value: 0.12, target: 15 })).toMatchObject({
      value: 12,
      target: 15,
      format: { format: "percent" },
      rescaled: true,
    });
    // Out of a hundred, with no target.
    expect(gaugeReading({ value: 0.42, max: 100 }).rescaled).toBe(true);
    // Already on one scale, either way.
    expect(gaugeReading({ value: 0.12, target: 0.15 }).rescaled).toBe(false);
    expect(gaugeReading({ value: 12, target: 15 }).rescaled).toBe(false);
    // A count is not a ratio, and an average far below its target is not one either.
    expect(gaugeReading({ value: 1, target: 10 }).rescaled).toBe(false);
    expect(gaugeReading({ value: 0.5, target: 3 }).rescaled).toBe(false);
    // Money is never a percentage.
    expect(gaugeReading({ value: 0.12, target: 15, format: "currency" }).rescaled).toBe(false);
  });

  it("prints the margin and its share of the target", { timeout: 400_000 }, async () => {
    const { renderVisualMarkup } = await import("@/utils/bi/reportCharts.server");
    const v = await renderVisualMarkup(
      { type: "gauge", valueField: "profit_margin", targetField: "target" } as never,
      [{ profit_margin: 0.1246, target: 15 }],
      { width: 300, height: 200 },
    );
    expect(v.kind).toBe("markup");
    const html = v.kind === "markup" ? v.html : "";
    expect(html).toContain(">12.46%<");
    expect(html).toContain("target 15% · 83%");
    // Captioned by the measure, not its column name.
    expect(html).toContain(">Profit margin<");
  });
});
