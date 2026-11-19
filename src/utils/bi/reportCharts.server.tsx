// A report block's chart, rendered on the server (R509).
//
// The same component the card draws with, rendered to markup at a fixed
// size: FixedChartSize stands in for the measuring the browser would do. The
// markup is drawn into the PDF by lib/biReportCharts, so a scheduled PDF's
// chart is the app's chart rather than a second drawing of it.
//
// The components are imported on first use. They are heavy, and only a
// scheduled run or a preview of one needs them on the server.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { ChartSpec } from "@/lib/biAgent";
import type { ServerVisual } from "@/lib/biReportCharts";

export async function renderVisualMarkup(
  chart: ChartSpec,
  rows: Record<string, unknown>[],
  size: { width: number; height: number },
  /** The widget's columns, in order; a data table shows exactly these. */
  columns?: string[],
): Promise<ServerVisual> {
  try {
    if (chart.type === "kpi") {
      const { kpiFigures } = await import("@/components/bi/biKpiFigures");
      return { kind: "kpi", figures: kpiFigures(chart, rows) };
    }
    if (chart.type === "table") {
      // The card's own table (R510): its formats, rules and totals. It shows
      // one page of rows; the drawing says how many more there are.
      const { WidgetDataTable } = await import("@/components/bi/BiDataTable");
      const html = renderToStaticMarkup(
        createElement(WidgetDataTable, {
          columns: columns?.length ? columns : Object.keys(rows[0] ?? {}),
          rows,
          columnFormats: chart.columnFormats,
          totals: chart.totals !== false,
          striped: chart.striped === true,
        }),
      );
      return { kind: "markup", html, bodyRows: rows.length };
    }
    const [{ BiChartRender }, { FixedChartSize }] = await Promise.all([
      import("@/components/bi/BiChartRender"),
      import("@/components/bi/biChartSize"),
    ]);
    // A zoom slider is a control for a viewer; on paper the chart shows its
    // whole range, which is where the slider starts anyway.
    const printed: ChartSpec = { ...chart, zoomBar: false };
    const html = renderToStaticMarkup(
      createElement(
        FixedChartSize.Provider,
        { value: size },
        createElement(BiChartRender, { chart: printed, rows, fill: true }),
      ),
    );
    return { kind: "markup", html };
  } catch (e) {
    return {
      kind: "none",
      reason: `This chart could not be drawn: ${(e as Error).message.slice(0, 120)}`,
    };
  }
}
