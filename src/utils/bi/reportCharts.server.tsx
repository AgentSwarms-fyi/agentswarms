// A report block's chart, rendered on the server (R509).
//
// The same component the card draws with, rendered to markup at a fixed
// size: FixedChartSize stands in for the measuring the browser would do. The
// markup is drawn into the PDF by lib/biReportCharts, so a scheduled PDF's
// chart is the app's chart rather than a second drawing of it.
//
// The components are imported on first use. They are heavy, and only a
// scheduled run or a preview of one needs them on the server.
import { PDFDocument, StandardFonts, type PDFFont } from "pdf-lib";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { ChartSpec } from "@/lib/biAgent";
import type { ServerVisual } from "@/lib/biReportCharts";

/** Fetches a picture for a printed visual; the scheduled run passes its SSRF-guarded one. */
export type PictureFetch = (url: string) => Promise<Response>;

// ── The visuals laid out for paper (R511) ───────────────────────────────────

/** Widths in the PDF's own fonts, so lines are cut where the page will cut them. */
let fonts: Promise<{ regular: PDFFont; bold: PDFFont }> | null = null;
function pdfFonts() {
  fonts ??= (async () => {
    const doc = await PDFDocument.create();
    return {
      regular: await doc.embedFont(StandardFonts.Helvetica),
      bold: await doc.embedFont(StandardFonts.HelveticaBold),
    };
  })();
  return fonts;
}

/** At most this many pictures and tiles per visual, each in its own time limit. */
const MAX_PICTURES = 24;

async function asDataUrl(url: string, fetchPicture: PictureFetch): Promise<string | null> {
  try {
    const res = await fetchPicture(url);
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    const { sniffImageType } = await import("@/lib/biReportImages");
    const type = sniffImageType(bytes);
    if (!type) return null;
    const mime = type === "svg" ? "image/svg+xml" : `image/${type}`;
    return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
  } catch {
    return null;
  }
}

async function printedMarkup(
  chart: ChartSpec,
  rows: Record<string, unknown>[],
  size: { width: number; height: number },
  opts: { fetchPicture?: PictureFetch },
): Promise<string> {
  const { printMapTiles, printPictureUrls, printVisualSvg } =
    await import("@/components/bi/biPrintVisuals");
  const { encLine } = await import("@/lib/biPdf");
  const { regular, bold } = await pdfFonts();
  const measure = (text: string, px: number, isBold: boolean) =>
    (isBold ? bold : regular).widthOfTextAtSize(encLine(text.replace(/−/g, "-")), px);
  const fetchPicture =
    opts.fetchPicture ??
    (async (url: string) => (await import("@/utils/bi/reportSchedule.server")).fetchPicture(url));

  const pictures = new Map<string, string>();
  for (const url of printPictureUrls(chart, rows).slice(0, MAX_PICTURES)) {
    const data = await asDataUrl(url, fetchPicture);
    if (data) pictures.set(url, data);
  }

  // Street tiles only where the deployment names a tile server, as on screen;
  // the server asks for them, so no viewer's whereabouts go with the request.
  let tiles: { href: string; left: number; top: number; size: number }[] | undefined;
  let mapCredit: string | undefined;
  if (chart.type === "pointmap") {
    const { publicConfig } = await import("@/lib/publicConfig");
    const cfg = publicConfig();
    if (cfg.mapTilesUrl) {
      const wanted = printMapTiles(chart, rows, size.width, size.height, cfg.mapTilesUrl);
      // One at a time: tile servers allow a client very few at once.
      tiles = [];
      for (const t of wanted.slice(0, MAX_PICTURES)) {
        const href = await asDataUrl(t.url, fetchPicture);
        if (href) tiles.push({ href, left: t.left, top: t.top, size: t.size });
      }
      mapCredit = cfg.mapTilesAttribution;
    }
  }

  return printVisualSvg({
    chart,
    rows,
    width: size.width,
    height: size.height,
    measure,
    pictures,
    tiles,
    mapCredit,
  });
}

export async function renderVisualMarkup(
  chart: ChartSpec,
  rows: Record<string, unknown>[],
  size: { width: number; height: number },
  /** The widget's columns, in order; a data table shows exactly these. */
  columns?: string[],
  opts: { fetchPicture?: PictureFetch } = {},
): Promise<ServerVisual> {
  try {
    // A percent format's scale, read from the rows as on screen (R512): the
    // KPI and table below are drawn without BiChartRender, which reads it.
    const { resolvePercentOf } = await import("@/lib/biChartFields");
    chart = resolvePercentOf(chart, rows);
    const { isPrintedVisual } = await import("@/components/bi/biPrintVisuals");
    if (isPrintedVisual(chart.type))
      return { kind: "markup", html: await printedMarkup(chart, rows, size, opts) };
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
