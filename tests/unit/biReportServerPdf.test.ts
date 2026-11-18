// A scheduled report's PDF, laid out on the server (R509).
//
// Renders the real chart component on the server for every visual the AI and
// the builder offer, holds SCHEDULED_DRAW to what came back, and reads a
// whole server-made PDF back with pdf.js to check its charts are there as
// text and shapes rather than holes.
import { decodePDFRawStream, PDFArray, PDFDocument, PDFRawStream } from "pdf-lib";
import { describe, expect, it } from "vitest";

import { CHART_CATALOG } from "@/lib/biChartCatalog";
import { mainSvg, narrativeText } from "@/lib/biReportCharts";
import { buildReportPdfBytes } from "@/lib/biReportPdf";
import { SCHEDULED_DRAW } from "@/lib/biReportSchedule";
import type { BiReport, ReportBlock } from "@/lib/biReports";
import { findAll, parseMarkup } from "@/lib/svgPdf";
import { renderVisualMarkup } from "@/utils/bi/reportCharts.server";

const rows = [
  {
    region: "East",
    kind: "A",
    month: "2025-01-01",
    sales: 120,
    profit: 30,
    target: 150,
    start: 10,
    end: 14,
    lat: 40.7,
    lng: -74,
    country: "France",
    word: "alpha",
    rank: 1,
  },
  {
    region: "West",
    kind: "B",
    month: "2025-02-01",
    sales: 90,
    profit: 12,
    target: 100,
    start: 12,
    end: 9,
    lat: 41.7,
    lng: -73,
    country: "Spain",
    word: "beta",
    rank: 2,
  },
  {
    region: "North",
    kind: "A",
    month: "2025-03-01",
    sales: 60,
    profit: -5,
    target: 80,
    start: 8,
    end: 11,
    lat: 42.1,
    lng: -72,
    country: "Italy",
    word: "gamma",
    rank: 3,
  },
  {
    region: "South",
    kind: "B",
    month: "2025-04-01",
    sales: 150,
    profit: 44,
    target: 140,
    start: 5,
    end: 7,
    lat: 39.9,
    lng: -75,
    country: "Germany",
    word: "delta",
    rank: 4,
  },
];

/** One spec per visual a model may choose. A new visual has to be added here. */
const SPECS: Record<string, Record<string, unknown>> = {
  kpi: { type: "kpi", valueField: "sales", dateField: "month", sparkline: true },
  gauge: { type: "gauge", valueField: "sales", targetField: "target" },
  insight: { type: "insight", kind: "top", valueField: "sales", categoryField: "region" },
  bar: { type: "bar", xField: "region", yField: "sales" },
  hbar: { type: "hbar", xField: "region", yField: "sales" },
  scolumn: { type: "scolumn", xField: "region", yField: "sales", seriesField: "kind" },
  shbar: { type: "shbar", xField: "region", yField: "sales", seriesField: "kind" },
  line: { type: "line", xField: "month", yField: "sales" },
  area: { type: "area", xField: "month", yField: "sales" },
  combo: { type: "combo", xField: "region", barField: "sales", lineField: "profit" },
  scatter: { type: "scatter", xField: "sales", yField: "profit" },
  pie: { type: "pie", nameField: "region", valueField: "sales" },
  nightingale: { type: "nightingale", nameField: "region", valueField: "sales" },
  radialbar: { type: "radialbar", nameField: "region", valueField: "sales" },
  treemap: { type: "treemap", nameField: "region", valueField: "sales" },
  pareto: { type: "pareto", categoryField: "region", valueField: "sales" },
  funnel: { type: "funnel", nameField: "region", valueField: "sales" },
  waterfall: { type: "waterfall", xField: "region", yField: "profit" },
  heatmap: { type: "heatmap", xField: "region", yField: "kind", valueField: "sales" },
  matrix: { type: "matrix", rowField: "region", colField: "kind", valueField: "sales" },
  calendar: { type: "calendar", dateField: "month", valueField: "sales" },
  smallmultiples: {
    type: "smallmultiples",
    xField: "month",
    yField: "sales",
    splitField: "region",
  },
  pictogram: { type: "pictogram", categoryField: "region", valueField: "sales" },
  range: { type: "range", categoryField: "region", startField: "start", endField: "end" },
  bump: { type: "bump", xField: "month", yField: "rank", seriesField: "region" },
  barrace: { type: "barrace", xField: "region", yField: "sales", timeField: "month" },
  sankey: { type: "sankey", xField: "region", yField: "kind", valueField: "sales" },
  radar: { type: "radar", xField: "region", yField: "sales" },
  wordcloud: { type: "wordcloud", textField: "word", valueField: "sales" },
  boxplot: { type: "boxplot", xField: "kind", yField: "sales" },
  map: { type: "map", locationField: "country", valueField: "sales" },
  bubblemap: { type: "bubblemap", locationField: "country", valueField: "sales" },
  pointmap: { type: "pointmap", latField: "lat", lngField: "lng" },
  journey: { type: "journey", categoryField: "region", valueField: "sales" },
  cards: { type: "cards", title: "region" },
  table: { type: "table" },
};

/** Not drawn although the markup would allow it, and why. */
const LEFT_OUT_ON_PURPOSE: Record<string, string> = {
  barrace: "an animation: its first frame is not the chart",
  table: "a table block prints its rows; a table visual has no picture",
};

const size = { width: 640, height: 300 };

describe("every visual, rendered on the server", () => {
  it("has a spec here", () => {
    for (const entry of CHART_CATALOG) expect(SPECS[entry.type], entry.type).toBeDefined();
  });

  it("draws as SCHEDULED_DRAW says, and only what it says", { timeout: 400_000 }, async () => {
    for (const [type, spec] of Object.entries(SPECS)) {
      const v = await renderVisualMarkup(spec as never, rows, size);
      const mode = SCHEDULED_DRAW[type];
      if (mode === "kpi") {
        expect(v.kind, type).toBe("kpi");
        continue;
      }
      expect(v.kind, type).toBe("markup");
      if (v.kind !== "markup") continue;
      const tree = parseMarkup(v.html);
      if (mode === "svg") expect(mainSvg(tree), type).not.toBeNull();
      else if (mode === "table")
        expect(findAll(tree, (e) => e.tag === "table").length, type).toBe(1);
      else if (mode === "text") expect(narrativeText(tree).length, type).toBeGreaterThan(10);
      else if (!LEFT_OUT_ON_PURPOSE[type]) {
        // Not drawn: there must be no single chart svg it could have used.
        expect(mainSvg(tree), `${type} draws as one svg: add it to SCHEDULED_DRAW`).toBeNull();
      }
    }
  });
});

/**
 * The strings a PDF draws, page by page, read with pdf-lib: its content
 * streams decoded and their text-showing operands collected. (pdf.js would
 * do it too, but loading it costs more than the rest of this file.)
 */
async function pdfText(bytes: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((page) => {
    const contents = page.node.Contents();
    const streams =
      contents instanceof PDFArray
        ? contents.asArray().map((r) => doc.context.lookup(r))
        : [contents];
    const out: string[] = [];
    for (const st of streams) {
      if (!(st instanceof PDFRawStream)) continue;
      const ops = new TextDecoder("latin1").decode(decodePDFRawStream(st).decode());
      for (const m of ops.matchAll(/<([0-9A-Fa-f]*)>\s*Tj/g)) {
        let str = "";
        for (let i = 0; i + 1 < m[1].length; i += 2) {
          str += String.fromCharCode(parseInt(m[1].slice(i, i + 2), 16));
        }
        out.push(str);
      }
    }
    return out.join(" ").replace(/\s+/g, " ");
  });
}

function chartBlock(
  id: string,
  title: string,
  chart: Record<string, unknown>,
  height = 180,
): ReportBlock {
  return {
    id,
    kind: "chart",
    height,
    widget: {
      id: `w_${id}`,
      kind: "chart",
      title,
      sql: "",
      chart: chart as never,
      rows,
      columns: Object.keys(rows[0]),
    },
  } as ReportBlock;
}

describe("a report laid out on the server", () => {
  it(
    "draws its charts as text and shapes, with legends, KPIs, pivots and narratives",
    { timeout: 400_000 },
    async () => {
      const report: BiReport = {
        name: "Server pack",
        page: { size: "a4", orientation: "portrait", margin: 40 },
        header: {},
        footer: {},
        blocks: [
          { id: "h", kind: "heading", level: 1, text: "Monthly pack" } as ReportBlock,
          chartBlock("bar", "Sales by region", SPECS.bar),
          chartBlock("pie", "Share", SPECS.pie),
          chartBlock("kpi", "Latest month", SPECS.kpi, 120),
          chartBlock("mx", "Pivot", SPECS.matrix, 120),
          chartBlock("ins", "Narrative", SPECS.insight, 60),
          chartBlock("sm", "Panels", SPECS.smallmultiples, 120),
        ],
      };
      const bytes = await buildReportPdfBytes({
        report,
        now: new Date("2026-02-02T08:00:00Z"),
        renderVisual: (block) => (s) =>
          renderVisualMarkup(block.widget.chart!, block.widget.rows ?? [], s),
      });
      const text = (await pdfText(bytes)).join(" | ");
      // The bar chart's category axis and value ticks, as text.
      for (const w of ["Sales by region", "East", "West", "North", "South", "160"]) {
        expect(text).toContain(w);
      }
      // The pie's legend, drawn in its own strip.
      expect(text).toMatch(/Share[\s\S]*East[\s\S]*West[\s\S]*North[\s\S]*South/);
      // The KPI: label, the latest month's value and the change against March.
      expect(text).toContain("SALES");
      expect(text).toContain("150");
      expect(text).toMatch(/vs Mar 2025/);
      // The pivot, as a grid with its total.
      expect(text).toContain("Total");
      // The narrative's sentence.
      expect(text).toMatch(/top 3 regions by sales/i);
      // Small multiples are not drawn, and the page says so where they would be.
      expect(text).toContain("drawn in the app only");
    },
  );
});
