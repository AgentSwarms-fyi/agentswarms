// A chart names the columns it draws, and those names get checked too.
//
// The case this file exists for, taken verbatim off a generated dashboard:
//
//   sql:   SELECT month FROM analytics.bi_demo_sales
//          WHERE revenue IS NOT NULL ORDER BY revenue DESC NULLS LAST LIMIT 5
//   chart: { type: "bar", xField: "month", yField: "revenue" }
//
// The query orders BY revenue and never selects it, so the widget drew five
// x-axis labels, no y-axis, no bars, and said nothing about why. The title
// check next door cannot see this: it compares a title against a ROW COUNT,
// and five rows under a title promising five agree perfectly.
import fs from "node:fs";

import { describe, expect, it } from "vitest";

import type { ChartSpec } from "@/lib/biAgent";
import { numericColumns, reconcileChartFields, unshownRows } from "@/lib/biChartFields";

/** The five rows the live query actually returned: a month, and nothing else. */
const MONTHS_ONLY = [
  { month: "2025-05" },
  { month: "2025-04" },
  { month: "2025-06" },
  { month: "2025-03" },
  { month: "2025-12" },
];

describe("telling a measure from a label", () => {
  it("reads numbers out of the rows, not out of the column name", () => {
    const rows = [
      { month: "2025-05", revenue: 1902.4, note: null },
      { month: "2025-04", revenue: 1841.1, note: null },
    ];
    const n = numericColumns(["month", "revenue", "note"], rows);
    expect([...n]).toEqual(["revenue"]);
  });

  it("does not call an all-null column a measure", () => {
    // Nothing in it to plot, whatever it is named.
    const n = numericColumns(["revenue"], [{ revenue: null }, { revenue: null }]);
    expect(n.has("revenue")).toBe(false);
  });

  it("does not call a column numeric because SOME of it is", () => {
    const n = numericColumns(["mixed"], [{ mixed: 1 }, { mixed: "n/a" }]);
    expect(n.has("mixed")).toBe(false);
  });
});

describe("a chart whose measure the query never selected", () => {
  it("falls back to the rows and says which column is missing", () => {
    const v = reconcileChartFields({
      chart: { type: "bar", xField: "month", yField: "revenue" },
      columns: ["month"],
      rows: MONTHS_ONLY,
    });
    expect(v.verdict).toBe("unplottable");
    if (v.verdict !== "unplottable") throw new Error("unreachable");
    expect(v.missing).toEqual(["revenue"]);
    expect(v.chart.type).toBe("table");
    expect(v.note).toBe("This query returns no revenue column, so the rows are shown instead.");
    // A widget title is plain text — markdown would be shown, not rendered.
    expect(v.note).not.toContain("`");
  });

  it("will not press the category column into service as the measure", () => {
    // `month` is the only column there is, and it is already the x-axis. A
    // repair that drew months as bar heights would be worse than an empty
    // frame, because it would look like an answer.
    const v = reconcileChartFields({
      chart: { type: "bar", xField: "month", yField: "revenue" },
      columns: ["month"],
      rows: MONTHS_ONLY,
    });
    if (v.verdict !== "unplottable") throw new Error("expected unplottable");
    expect(JSON.stringify(v.chart)).not.toContain("month");
  });

  it("keeps the number formatting through the fall back", () => {
    const v = reconcileChartFields({
      chart: {
        type: "bar",
        xField: "month",
        yField: "revenue",
        format: "currency",
        currency: "EUR",
      },
      columns: ["month"],
      rows: MONTHS_ONLY,
    });
    if (v.verdict !== "unplottable") throw new Error("expected unplottable");
    expect(v.chart.format).toBe("currency");
    expect(v.chart.currency).toBe("EUR");
  });
});

describe("repairs that are not guesses", () => {
  it("re-points a measure when exactly one spare numeric column can be meant", () => {
    const rows = [{ month: "2025-05", total_revenue: 1902.4 }];
    const v = reconcileChartFields({
      chart: { type: "bar", xField: "month", yField: "revenue" },
      columns: ["month", "total_revenue"],
      rows,
    });
    expect(v.verdict).toBe("repaired");
    if (v.verdict !== "repaired") throw new Error("unreachable");
    expect((v.chart as { yField: string }).yField).toBe("total_revenue");
    expect(v.note).toContain("revenue → total_revenue");
  });

  it("refuses to choose between two spare numeric columns", () => {
    const rows = [{ month: "2025-05", revenue_net: 1, revenue_gross: 2 }];
    const v = reconcileChartFields({
      chart: { type: "bar", xField: "month", yField: "revenue" },
      columns: ["month", "revenue_net", "revenue_gross"],
      rows,
    });
    // Two candidates is a guess, and a guess drawn as a chart is indefensible.
    expect(v.verdict).toBe("unplottable");
  });

  it("does not repair two missing fields onto the same spare column", () => {
    // One spare numeric column cannot be both bar and line; drawing it twice
    // would present one series as a comparison of two.
    const rows = [{ month: "2025-05", amount: 10 }];
    const v = reconcileChartFields({
      chart: { type: "combo", xField: "month", barField: "units", lineField: "revenue" },
      columns: ["month", "amount"],
      rows,
    });
    expect(v.verdict).toBe("unplottable");
    if (v.verdict !== "unplottable") throw new Error("unreachable");
    expect(v.missing).toHaveLength(1);
  });

  it("drops a series split that is not in the result, silently", () => {
    // A missing seriesField is not a chart that cannot draw. It is a chart
    // with one series, which needs no apology.
    const rows = [{ month: "2025-05", revenue: 1 }];
    const v = reconcileChartFields({
      chart: { type: "bar", xField: "month", yField: "revenue", seriesField: "region" },
      columns: ["month", "revenue"],
      rows,
    });
    expect(v.verdict).toBe("repaired");
    if (v.verdict !== "repaired") throw new Error("unreachable");
    expect("seriesField" in v.chart).toBe(false);
    expect(v.note).toBeUndefined();
  });
});

describe("which field has to be a number depends on the chart", () => {
  it("treats a sankey's yField as a node label, not a measure", () => {
    // yField is the TARGET NODE here. Repairing it onto the numeric column
    // would draw flow magnitudes as node names.
    const rows = [{ src: "a", dst: "b", amount: 5 }];
    const v = reconcileChartFields({
      chart: { type: "sankey", xField: "src", yField: "target", valueField: "amount" },
      columns: ["src", "dst", "amount"],
      rows,
    });
    expect(v.verdict).toBe("repaired");
    if (v.verdict !== "repaired") throw new Error("unreachable");
    expect((v.chart as { yField: string }).yField).toBe("dst");
  });

  it("treats a heatmap's axes as categorical and its valueField as the measure", () => {
    const rows = [{ month: "2025-05", region: "EMEA", total: 5 }];
    const v = reconcileChartFields({
      chart: { type: "heatmap", xField: "month", yField: "region", valueField: "revenue" },
      columns: ["month", "region", "total"],
      rows,
    });
    expect(v.verdict).toBe("repaired");
    if (v.verdict !== "repaired") throw new Error("unreachable");
    expect((v.chart as { valueField: string }).valueField).toBe("total");
  });

  it("leaves an honest chart completely alone", () => {
    const chart: ChartSpec = { type: "bar", xField: "month", yField: "revenue" };
    const v = reconcileChartFields({
      chart,
      columns: ["month", "revenue"],
      rows: [{ month: "2025-05", revenue: 1 }],
    });
    expect(v.verdict).toBe("ok");
  });

  it("has nothing to say about a table, or about no chart at all", () => {
    expect(reconcileChartFields({ chart: { type: "table" }, columns: [], rows: [] }).verdict).toBe(
      "ok",
    );
    expect(reconcileChartFields({ chart: undefined, columns: ["a"], rows: [] }).verdict).toBe("ok");
  });
});

describe("a single-value chart drawing one row of several", () => {
  // All three taken off a generated dashboard. A KPI renders rows[0] and
  // nothing else, so the first two put a third of a breakdown in the type size
  // reserved for a headline, and said nothing about it.
  const BY_REGION = [
    { region: "AMER", total_revenue: 25874.92 },
    { region: "EMEA", total_revenue: 15524.94 },
    { region: "APAC", total_revenue: 10349.98 },
  ];

  it("counts the rows a KPI is not showing", () => {
    // 25,874.92 of a 51,749.84 total, under a card titled "Revenue by Region".
    expect(unshownRows(BY_REGION, "total_revenue")).toBe(3);
  });

  it("says nothing when the one row IS the result", () => {
    expect(unshownRows([{ total: 51749.84 }], "total")).toBeNull();
  });

  it("says nothing about a label, only about a measure", () => {
    // "Best Month by Revenue" is a KPI over 36 ordered rows whose valueField is
    // `month`. Row zero IS the answer there. A caveat on it would be noise, and
    // noise is what teaches readers to ignore the caveats that matter.
    const months = [{ month: "2025-05" }, { month: "2025-04" }, { month: "2025-06" }];
    expect(unshownRows(months, "month")).toBeNull();
  });

  it("is unmoved by a missing field, an empty result or no rows at all", () => {
    expect(unshownRows(BY_REGION, undefined)).toBeNull();
    expect(unshownRows(BY_REGION, "not_a_column")).toBeNull();
    expect(unshownRows([], "total_revenue")).toBeNull();
    expect(unshownRows(undefined, "total_revenue")).toBeNull();
  });

  it("does not count a non-finite first value", () => {
    expect(unshownRows([{ v: Number.NaN }, { v: 2 }], "v")).toBeNull();
  });

  it("is drawn by both single-value charts, and computed where it is drawn", () => {
    // Not stored on the widget: a count of rows that a refresh can replace is
    // exactly the sentence that goes stale. This one is derived at render, so
    // there is nothing to restate and nothing that can outlive its data.
    const render = fs.readFileSync("src/components/bi/BiChartRender.tsx", "utf8");
    expect(render).toContain("const ofRows = unshownRows(rows, chart.valueField);");
    expect(render).toMatch(/1 of \{ofRows\} rows/);
    expect(render).toContain("const gaugeOf = unshownRows(rows, chart.valueField);");
    expect(render).toMatch(/caveat=\{gaugeOf !== null \? `1 of \$\{gaugeOf\} rows` : undefined\}/);
    // And the gauge has to actually render what it is handed.
    const parts = fs.readFileSync("src/components/bi/BiChartParts.tsx", "utf8");
    expect(parts).toMatch(/\{caveat && \(/);
    expect(parts).toContain("{caveat}");
  });
});

describe("the check is actually wired into both generators", () => {
  it("corrects the TURN before the widget is built, in dashboard and report", () => {
    for (const f of [
      "src/components/bi/GenerateDashboardDialog.tsx",
      "src/components/bi/GenerateReportDialog.tsx",
    ]) {
      const src = fs.readFileSync(f, "utf8");
      expect(src, f).toContain("reconcileChartFields");
      // On the turn, not the widget: widgetFromBiTurn derives `agg_pushdown`
      // from the chart spec, so a correction applied afterwards would leave
      // the widget aggregating for a chart it is no longer drawing.
      const fixes = src.indexOf('if (fields.verdict !== "ok") turn.chart = fields.chart;');
      const builds = src.indexOf("widgetFromBiTurn(turn, gen.source)");
      expect(fixes, f).toBeGreaterThan(-1);
      expect(builds, f).toBeGreaterThan(fixes);
    }
    // And the dashboard must SHOW the note, alongside the title note rather
    // than instead of it.
    const dash = fs.readFileSync("src/components/bi/GenerateDashboardDialog.tsx", "utf8");
    const assignsFinal = dash.indexOf("const base = picks[i].title || widget.title;");
    const appliesNotes = dash.indexOf("notes.length ? `${base}");
    expect(assignsFinal).toBeGreaterThan(-1);
    expect(appliesNotes).toBeGreaterThan(assignsFinal);
    expect(dash).toContain('fields.verdict !== "ok" ? fields.note : undefined');
    // The field note stays AHEAD of the count note: the count note is the
    // title's suffix so a refresh can find and restate it.
    expect(dash).toContain("const notes = [fieldNote, fixed.note].filter(Boolean);");
  });
});
