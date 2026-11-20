// R512: a Percent format reads a ratio as a percentage.
//
// The format treated every value as already being in percent units, so a
// margin returned as 0.14 printed "0.14%". A chart now reads the scale from its
// measures (all between -1 and 1, with fractions among them, are ratios), and
// a builder setting states it when the data cannot.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BiBuildPreview } from "@/components/bi/BiBuildPreview";
import { fmtBiValue } from "@/components/bi/biChartData";
import { WidgetDataTable } from "@/components/bi/BiDataTable";
import { BiSuggestedNarratives } from "@/components/bi/BiSuggestedNarratives";
import { gaugeReading } from "@/components/bi/biDrawHelpers";
import { readsAsRatios, resolvePercentOf } from "@/lib/biChartFields";
import { suggestNarratives } from "@/lib/biInsights";
import { renderVisualMarkup } from "@/utils/bi/reportCharts.server";

const margins = [
  { region: "EMEA", margin: 0.14 },
  { region: "AMER", margin: 0.205 },
  { region: "APJ", margin: 0.09 },
];
// A ratio printed as one: "0.14%", not part of "10.14%".
const RAW_RATIO = /(?<![\d.])0\.\d+%/;

describe("a Percent format", () => {
  it("prints a ratio ×100 when the scale says so", () => {
    expect(fmtBiValue(0.14, { format: "percent", percentOf: "ratio" })).toBe("14%");
    expect(fmtBiValue(14, { format: "percent" })).toBe("14%");
    expect(fmtBiValue(0.14, { format: "percent", percentOf: "percent" })).toBe("0.14%");
  });

  it("reads ratios from the values", () => {
    expect(readsAsRatios(margins, ["margin"])).toBe(true);
    expect(readsAsRatios([{ m: "0.14" }], ["m"])).toBe(true);
    expect(readsAsRatios([{ p: 14 }, { p: 9.5 }], ["p"])).toBe(false);
    // 0s and 1s, or nothing at all, say nothing.
    expect(readsAsRatios([{ f: 0 }, { f: 1 }], ["f"])).toBe(false);
    expect(readsAsRatios([], ["m"])).toBe(false);
  });

  it("is resolved from a chart's measures, and a stated scale is kept", () => {
    const bar = { type: "bar", xField: "region", yField: "margin", format: "percent" };
    expect(resolvePercentOf(bar as never, margins).percentOf).toBe("ratio");
    expect(resolvePercentOf({ ...bar, percentOf: "percent" } as never, margins).percentOf).toBe(
      "percent",
    );
    const plain = { type: "bar", xField: "region", yField: "margin" };
    expect(resolvePercentOf(plain as never, margins)).toBe(plain);
  });

  it("leaves a gauge against a percentage target to its own reading", () => {
    const gauge = { type: "gauge", valueField: "margin", targetField: "target", format: "percent" };
    expect(
      resolvePercentOf(gauge as never, [{ margin: 0.1247, target: 15 }]).percentOf,
    ).toBeUndefined();
    // And a gauge R511 already rescaled is not scaled again.
    const r = gaugeReading({
      value: 0.1247,
      target: 15,
      format: { format: "percent", percentOf: "ratio" },
    });
    expect(r.rescaled).toBe(true);
    expect(fmtBiValue(r.value, r.format)).toBe("12.47%");
  });

  it("is resolved per table column, each from its own values", () => {
    const table = {
      type: "table",
      columnFormats: { margin: { format: "percent" }, growth: { format: "percent" } },
    };
    const t = resolvePercentOf(table as never, [{ margin: 0.14, growth: 3.5 }]);
    expect(t.columnFormats?.margin.percentOf).toBe("ratio");
    expect(t.columnFormats?.growth.percentOf).toBeUndefined();
  });
});

describe("drawn", () => {
  it("a table's Percent column reads 14%", () => {
    const html = renderToStaticMarkup(
      createElement(WidgetDataTable, {
        columns: ["region", "margin"],
        rows: margins,
        columnFormats: { margin: { format: "percent" } },
      }),
    );
    expect(html).toContain("14%");
    expect(html).toContain("20.5%");
    expect(html).not.toMatch(RAW_RATIO);
  });

  it("a bar chart and a KPI in a PDF read 14%", { timeout: 400_000 }, async () => {
    const size = { width: 480, height: 300 };
    const bar = await renderVisualMarkup(
      { type: "bar", xField: "region", yField: "margin", format: "percent" } as never,
      margins,
      size,
    );
    expect(bar.kind).toBe("markup");
    const html = bar.kind === "markup" ? bar.html : "";
    expect(html).toMatch(/\d%/);
    expect(html).not.toMatch(RAW_RATIO);
    const kpi = await renderVisualMarkup(
      { type: "kpi", valueField: "margin", format: "percent" } as never,
      [{ margin: 0.14 }],
      size,
    );
    expect(kpi.kind).toBe("kpi");
    const text = JSON.stringify(kpi);
    expect(text).toContain("14%");
    expect(text).not.toMatch(RAW_RATIO);
  });
});

describe("in the builder", () => {
  // R512 UI test on 8080: a Percent bar of average discounts drew 27% on its
  // axis while the suggested narratives under it read "APJ 0.27%".
  const discounts = [
    { region: "AMER", avg_discount: 0.1094 },
    { region: "APJ", avg_discount: 0.2672 },
    { region: "EMEA", avg_discount: 0.1414 },
  ];
  const base = { source: { kind: "local" as const }, sql: "select 1" };

  it("suggests narratives that print the ratio as a percentage", () => {
    const html = renderToStaticMarkup(
      createElement(BiSuggestedNarratives, {
        columns: ["region", "avg_discount"],
        rows: discounts,
        chart: { type: "bar", xField: "region", yField: "avg_discount", format: "percent" },
        base,
        onAdd: () => {},
      }),
    );
    expect(html).toContain("26.72%");
    expect(html).not.toMatch(RAW_RATIO);
  });

  it("gives an added narrative the stated scale only", () => {
    const value = (n: number) => String(n);
    const [auto] = suggestNarratives(["region", "avg_discount"], discounts, value, {
      format: "percent",
    });
    expect(auto.spec.format).toBe("percent");
    expect(auto.spec.percentOf).toBeUndefined(); // read from its values when it draws
    const [stated] = suggestNarratives(["region", "avg_discount"], discounts, value, {
      format: "percent",
      percentOf: "percent",
    });
    expect(stated.spec.percentOf).toBe("percent");
  });

  it("previews raw rows with a Percent column as percentages", () => {
    const html = renderToStaticMarkup(
      createElement(BiBuildPreview, {
        chartSpec: null,
        chartType: "bar",
        preview: { columns: ["region", "avg_discount"], rows: discounts },
        colFormats: { avg_discount: { format: "percent" } },
      }),
    );
    expect(html).toContain("26.72%");
    expect(html).not.toMatch(RAW_RATIO);
  });
});
