// Client-side builders that turn a plan into a real, fully-editable Office file.
// Each library is dynamically imported so its (large) bundle only loads when the
// user actually generates a document.
import type { Cell, SheetData } from "write-excel-file/browser";

import { hydrateFromSupabase, runQueryUnlimited } from "@/lib/sqlEngine";
import { materializePptxWithBI } from "./biData";
import type {
  DocChart,
  DocScope,
  DocTable,
  DocxPlan,
  MaterializedXlsxPlan,
  PptxPlan,
  PptxSlide,
  XlsxCell,
  XlsxComputedColumn,
  XlsxLiteralSheet,
  XlsxPlan,
  XlsxTotalsRow,
} from "./types";
import { isXlsxDataSheet } from "./types";

function withExt(name: string, ext: string): string {
  const base = (name || "document").trim() || "document";
  return base.toLowerCase().endsWith(`.${ext}`) ? base : `${base}.${ext}`;
}

function downloadBlob(blob: Blob, filename: string): void {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ── PowerPoint (pptxgenjs) — a modern, data-filled deck ───────────────────────
// Segoe-UI typography, a deep-ink cover with layered accent rings, section
// dividers with a large index watermark, soft-shadow KPI cards (accent rule +
// delta pill), native editable charts filled from REAL data (materializePptxWithBI
// runs each slide's analytical question through the BI analyst), styled tables,
// per-slide "key insight" bars, and a master with footer + slide numbers.

const PPTX_FONT = "Segoe UI";
const PPTX_INK = "0F172A"; // near-black slate for headings
const PPTX_INK_DEEP = "0B1220"; // cover / section background
const PPTX_SUB = "64748B";
const PPTX_BODY = "334155";
const PPTX_BORDER = "E7EBF0";
const PPTX_CARD = "F8FAFC";
const PPTX_DEFAULT_ACCENT = "4F46E5";
const PPTX_GRID = "EEF2F7";
const PPTX_SHADOW = {
  type: "outer" as const,
  color: "9AA6B8",
  blur: 11,
  offset: 3,
  angle: 90,
  opacity: 0.22,
};

function normalizeHex(c: string | undefined, fallback: string): string {
  const h = (c ?? "").replace(/^#/, "").trim();
  return /^[0-9a-fA-F]{6}$/.test(h) ? h.toUpperCase() : fallback;
}

/** Mix a hex colour toward white (amt 0..1) — for light accent tints. */
function tintHex(hex: string, amt: number): string {
  const n = parseInt(hex, 16);
  const mix = (c: number) => Math.round(c + (255 - c) * amt);
  return [mix((n >> 16) & 255), mix((n >> 8) & 255), mix(n & 255)]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

/** Mix a hex colour toward black (amt 0..1) — for a deeper accent shade. */
function shadeHex(hex: string, amt: number): string {
  const n = parseInt(hex, 16);
  const mix = (c: number) => Math.round(c * (1 - amt));
  return [mix((n >> 16) & 255), mix((n >> 8) & 255), mix(n & 255)]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

/** Relative luminance (0..1) of a hex colour. */
function luminance(hex: string): number {
  const n = parseInt(hex, 16);
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
}

/**
 * A version of `hex` guaranteed to read on the DARK cover/section background —
 * lighten until it's clearly visible. Fixes dark accents (e.g. navy) that the
 * model may pick, which would otherwise be invisible on the deep-ink slides.
 */
function onDark(hex: string): string {
  let c = tintHex(hex, 0.4);
  for (let i = 0; i < 6 && luminance(c) < 0.62; i++) c = tintHex(c, 0.3);
  return c;
}

/** A version of `hex` guaranteed to read as TEXT on white content slides. */
function onLight(hex: string): string {
  let c = hex;
  for (let i = 0; i < 6 && luminance(c) > 0.6; i++) c = shadeHex(c, 0.28);
  return c;
}

/** A chart is renderable only when it actually has categories + series values. */
function chartHasData(c?: DocChart): c is DocChart {
  return (
    !!c &&
    (c.categories?.length ?? 0) > 0 &&
    (c.series?.length ?? 0) > 0 &&
    (c.series ?? []).some((sr) => (sr.values?.length ?? 0) > 0)
  );
}

function pptxEffectiveLayout(s: PptxSlide): NonNullable<PptxSlide["layout"]> {
  if (s.layout) return s.layout;
  if (s.kpis?.length) return "kpi";
  if (chartHasData(s.chart)) return "chart";
  if (s.table) return "table";
  return "bullets";
}

function pptxTableRows(t: DocTable, accent: string) {
  const header = t.columns.map((c) => ({
    text: String(c),
    options: { bold: true, fill: { color: accent }, color: "FFFFFF", fontFace: PPTX_FONT },
  }));
  const body = (t.rows ?? []).map((r, ri) =>
    r.map((cell) => ({
      text: cell === null || cell === undefined ? "" : String(cell),
      options: { fill: { color: ri % 2 === 0 ? "FFFFFF" : PPTX_CARD }, fontFace: PPTX_FONT },
    })),
  );
  return [header, ...body];
}

export async function buildPptx(
  plan: PptxPlan,
  filename: string,
  opts: { model?: string } = {},
): Promise<void> {
  // Fill charts + KPIs from the user's REAL data via the BI analyst pipeline.
  await materializePptxWithBI(plan, { model: opts.model });

  const PptxGen = (await import("pptxgenjs")).default;
  const pptx = new PptxGen();
  pptx.layout = "LAYOUT_WIDE"; // 13.333 × 7.5 in
  type Slide = ReturnType<typeof pptx.addSlide>;

  const accent = normalizeHex(plan.accent, PPTX_DEFAULT_ACCENT);
  const accentTint = tintHex(accent, 0.92);
  const accentDeep = shadeHex(accent, 0.22);
  // Accent darkened just enough to read as TEXT on white content slides (a
  // pale accent the model picked would otherwise wash out).
  const accentInk = onLight(accent);
  const palette = [accentInk, "0EA5E9", "10B981", "F59E0B", "EF4444", "8B5CF6", "EC4899", "14B8A6"];
  const deckTitle = plan.title || "Untitled";
  const deckDate = new Date().toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const CW = 13.333;
  const M = 0.6;
  const CONTENT_W = CW - M * 2;

  pptx.defineSlideMaster({
    title: "AGS_CONTENT",
    background: { color: "FFFFFF" },
    objects: [
      { rect: { x: 0, y: 0, w: 0.16, h: 7.5, fill: { color: accent } } },
      {
        text: {
          text: deckTitle,
          options: {
            x: 0.5,
            y: 7.08,
            w: 9,
            h: 0.32,
            fontSize: 8,
            color: PPTX_SUB,
            fontFace: PPTX_FONT,
            valign: "middle",
          },
        },
      },
    ],
    slideNumber: {
      x: 12.4,
      y: 7.08,
      w: 0.6,
      h: 0.32,
      fontSize: 8,
      color: PPTX_SUB,
      fontFace: PPTX_FONT,
      align: "right",
    },
  });

  const card = (
    slide: Slide,
    b: { x: number; y: number; w: number; h: number },
    topRule = false,
  ) => {
    slide.addShape("roundRect", {
      x: b.x,
      y: b.y,
      w: b.w,
      h: b.h,
      fill: { color: "FFFFFF" },
      line: { color: PPTX_BORDER, width: 1 },
      rectRadius: 0.08,
      shadow: PPTX_SHADOW,
    });
    if (topRule)
      slide.addShape("rect", { x: b.x, y: b.y, w: b.w, h: 0.09, fill: { color: accent } });
  };

  // Header: a small uppercase kicker (the current section), the title, an accent
  // tick + hairline rule, and optional right-aligned context.
  const titleBar = (slide: Slide, title: string, kicker?: string, subtitle?: string) => {
    if (kicker) {
      slide.addText(kicker.toUpperCase().slice(0, 60), {
        x: M,
        y: 0.4,
        w: CONTENT_W,
        h: 0.26,
        fontSize: 10.5,
        bold: true,
        color: accentInk,
        fontFace: PPTX_FONT,
        charSpacing: 2.5,
      });
    }
    slide.addText(title || "", {
      x: M - 0.02,
      y: kicker ? 0.64 : 0.5,
      w: subtitle ? CONTENT_W - 3.6 : CONTENT_W,
      h: 0.62,
      fontSize: (title || "").length > 60 ? 20 : 24,
      bold: true,
      color: PPTX_INK,
      fontFace: PPTX_FONT,
      fit: "shrink",
    });
    if (subtitle) {
      slide.addText(subtitle, {
        x: M + CONTENT_W - 3.5,
        y: kicker ? 0.78 : 0.64,
        w: 3.5,
        h: 0.34,
        align: "right",
        fontSize: 11.5,
        color: PPTX_SUB,
        fontFace: PPTX_FONT,
      });
    }
    slide.addShape("rect", { x: M, y: 1.3, w: 0.5, h: 0.05, fill: { color: accent } });
    slide.addShape("rect", {
      x: M + 0.6,
      y: 1.322,
      w: CONTENT_W - 0.6,
      h: 0.012,
      fill: { color: PPTX_BORDER },
    });
  };

  const takeawayBar = (slide: Slide, text: string) => {
    slide.addShape("roundRect", {
      x: M,
      y: 6.4,
      w: CONTENT_W,
      h: 0.58,
      fill: { color: accentTint },
      rectRadius: 0.08,
    });
    slide.addShape("roundRect", {
      x: M,
      y: 6.4,
      w: 0.11,
      h: 0.58,
      fill: { color: accent },
      rectRadius: 0.04,
    });
    slide.addText(
      [
        { text: "KEY INSIGHT    ", options: { bold: true, color: accentInk, charSpacing: 1 } },
        { text: (text || "").slice(0, 240), options: { color: PPTX_INK } },
      ],
      {
        x: M + 0.32,
        y: 6.4,
        w: CONTENT_W - 0.6,
        h: 0.58,
        valign: "middle",
        fontSize: 12,
        fontFace: PPTX_FONT,
        fit: "shrink",
      },
    );
  };

  const addChart = (
    slide: Slide,
    chart: DocChart,
    box: { x: number; y: number; w: number; h: number },
  ) => {
    const type =
      chart.type === "line"
        ? pptx.ChartType.line
        : chart.type === "area"
          ? pptx.ChartType.area
          : chart.type === "pie"
            ? pptx.ChartType.pie
            : chart.type === "doughnut"
              ? pptx.ChartType.doughnut
              : pptx.ChartType.bar;
    const isPie = chart.type === "pie" || chart.type === "doughnut";
    const isBarCol = chart.type === "bar" || chart.type === "column";
    const cats = chart.categories ?? [];
    const series = chart.series ?? [];
    // Value labels on the bars when it stays readable — makes the chart feel
    // data-rich without clutter (single series, not too many categories).
    const showBarValues = isBarCol && series.length === 1 && cats.length <= 8;
    // Card frame behind the chart, chart inset with padding.
    card(slide, box);
    const inset = { x: box.x + 0.28, y: box.y + 0.28, w: box.w - 0.56, h: box.h - 0.56 };
    slide.addChart(
      type,
      series.map((ser) => ({ name: ser.name || "Series", labels: cats, values: ser.values ?? [] })),
      {
        ...inset,
        chartColors: palette,
        showLegend: isPie || series.length > 1,
        legendPos: "b",
        legendColor: PPTX_SUB,
        legendFontSize: 9,
        legendFontFace: PPTX_FONT,
        showTitle: false,
        showValue: isPie || showBarValues,
        showPercent: isPie,
        dataLabelColor: isPie ? "FFFFFF" : PPTX_SUB,
        dataLabelFontSize: 9,
        dataLabelFontFace: PPTX_FONT,
        dataLabelFontBold: showBarValues,
        dataLabelPosition: showBarValues ? "outEnd" : undefined,
        barDir: chart.type === "bar" ? "bar" : "col",
        barGapWidthPct: 42,
        catAxisLabelColor: PPTX_SUB,
        catAxisLabelFontSize: 9,
        catAxisLabelFontFace: PPTX_FONT,
        catAxisLineShow: false,
        valAxisLabelColor: PPTX_SUB,
        valAxisLabelFontSize: 9,
        valAxisLabelFontFace: PPTX_FONT,
        valAxisLineShow: false,
        valGridLine: isPie ? { style: "none" } : { color: PPTX_GRID, size: 1, style: "solid" },
        catGridLine: { style: "none" },
        chartColorsOpacity: chart.type === "area" ? 40 : 100,
        lineSize: 2.5,
        lineSmooth: true,
        holeSize: chart.type === "doughnut" ? 62 : undefined,
      },
    );
  };

  const addBullets = (
    slide: Slide,
    bullets: string[],
    box: { x: number; y: number; w: number; h: number },
  ) => {
    slide.addText(
      bullets.map((b) => ({
        text: b,
        options: {
          bullet: { characterCode: "25AA", indent: 18 },
          fontSize: 13,
          color: PPTX_BODY,
          fontFace: PPTX_FONT,
          paraSpaceAfter: 10,
        },
      })),
      { ...box, valign: "top" },
    );
  };

  // ── Cover: deep-ink canvas with layered translucent accent rings ──
  {
    const s = pptx.addSlide();
    s.background = { color: PPTX_INK_DEEP };
    // Concentric accent rings bleeding off the top-right corner for depth.
    s.addShape("ellipse", {
      x: 8.9,
      y: -2.6,
      w: 7.4,
      h: 7.4,
      fill: { color: accent, transparency: 80 },
    });
    s.addShape("ellipse", {
      x: 10.3,
      y: -1.0,
      w: 5.2,
      h: 5.2,
      fill: { color: accentDeep, transparency: 74 },
    });
    s.addShape("ellipse", {
      x: 11.5,
      y: 3.3,
      w: 3.6,
      h: 3.6,
      fill: { color: "FFFFFF", transparency: 92 },
    });
    // Accent eyebrow: a short rule + spaced uppercase meta.
    s.addShape("rect", { x: 0.9, y: 2.02, w: 0.62, h: 0.09, fill: { color: accent } });
    s.addText(`REPORT · ${deckDate.toUpperCase()}`, {
      x: 1.64,
      y: 1.82,
      w: 8,
      h: 0.4,
      fontSize: 11.5,
      bold: true,
      color: onDark(accent),
      fontFace: PPTX_FONT,
      charSpacing: 3,
    });
    s.addText(deckTitle, {
      x: 0.85,
      y: 2.45,
      w: 9.6,
      h: 2.3,
      fontSize: deckTitle.length > 48 ? 36 : 46,
      bold: true,
      color: "FFFFFF",
      fontFace: PPTX_FONT,
      valign: "top",
      lineSpacingMultiple: 0.98,
      fit: "shrink",
    });
    if (plan.subtitle) {
      s.addText(plan.subtitle, {
        x: 0.9,
        y: 4.95,
        w: 8.6,
        h: 1.0,
        fontSize: 18,
        color: "CBD5E1",
        fontFace: PPTX_FONT,
      });
    }
    s.addShape("rect", { x: 0.9, y: 6.45, w: 3.0, h: 0.02, fill: { color: "334155" } });
    s.addText(`${(plan.slides ?? []).length} slides · Generated ${deckDate}`, {
      x: 0.9,
      y: 6.6,
      w: 8,
      h: 0.4,
      fontSize: 11,
      color: "94A3B8",
      fontFace: PPTX_FONT,
    });
  }

  // ── Content slides ──
  let sectionNo = 0;
  let currentSection = ""; // drives the small kicker above each slide title
  for (const s of plan.slides ?? []) {
    const layout = pptxEffectiveLayout(s);

    if (layout === "section") {
      sectionNo += 1;
      currentSection = s.title || `Section ${sectionNo}`;
      const slide = pptx.addSlide();
      slide.background = { color: PPTX_INK_DEEP };
      // Oversized, faint index bleeding off the bottom-right (readable on dark).
      slide.addText(String(sectionNo).padStart(2, "0"), {
        x: 6.4,
        y: 1.1,
        w: 6.6,
        h: 6.2,
        fontSize: 300,
        bold: true,
        color: onDark(accent),
        transparency: 86,
        align: "right",
        valign: "bottom",
        fontFace: PPTX_FONT,
      });
      slide.addShape("rect", {
        x: 0.9,
        y: 2.72,
        w: 0.62,
        h: 0.09,
        fill: { color: onDark(accent) },
      });
      slide.addText(`SECTION ${String(sectionNo).padStart(2, "0")}`, {
        x: 1.64,
        y: 2.52,
        w: 8,
        h: 0.4,
        fontSize: 11.5,
        bold: true,
        color: onDark(accent),
        fontFace: PPTX_FONT,
        charSpacing: 3,
      });
      slide.addText(s.title || "", {
        x: 0.9,
        y: 3.02,
        w: 9.4,
        h: 1.5,
        fontSize: (s.title || "").length > 42 ? 30 : 38,
        bold: true,
        color: "FFFFFF",
        fontFace: PPTX_FONT,
        valign: "top",
        fit: "shrink",
      });
      if (s.subtitle) {
        slide.addText(s.subtitle, {
          x: 0.92,
          y: 4.6,
          w: 8.8,
          h: 0.8,
          fontSize: 15,
          color: "CBD5E1",
          fontFace: PPTX_FONT,
        });
      }
      if (s.notes) slide.addNotes(s.notes);
      continue;
    }

    const slide = pptx.addSlide({ masterName: "AGS_CONTENT" });
    titleBar(slide, s.title, currentSection || deckTitle, s.subtitle);
    const bottom = s.takeaway ? 6.25 : 6.95;
    const top = 1.55;
    const hasChart = chartHasData(s.chart);

    if (layout === "kpi" && s.kpis?.length) {
      const kpis = s.kpis.slice(0, 5);
      const gap = 0.28;
      const cardW = (CONTENT_W - gap * (kpis.length - 1)) / kpis.length;
      const cardY = 1.95;
      const cardH = 2.3;
      kpis.forEach((k, i) => {
        const x = M + i * (cardW + gap);
        // Card with a thin accent top rule.
        card(slide, { x, y: cardY, w: cardW, h: cardH }, true);
        // Uppercase muted label.
        slide.addText((k.label ?? "").toUpperCase(), {
          x: x + 0.26,
          y: cardY + 0.34,
          w: cardW - 0.5,
          h: 0.7,
          fontSize: 10.5,
          bold: true,
          color: PPTX_SUB,
          fontFace: PPTX_FONT,
          charSpacing: 1.2,
          valign: "top",
        });
        // Big value.
        slide.addText(k.value ?? "", {
          x: x + 0.24,
          y: cardY + 0.9,
          w: cardW - 0.42,
          h: 0.9,
          fontSize: 33,
          bold: true,
          color: PPTX_INK,
          fontFace: PPTX_FONT,
          valign: "middle",
        });
        // Delta as a soft colour pill.
        if (k.delta) {
          const good = k.positive !== false;
          slide.addShape("roundRect", {
            x: x + 0.26,
            y: cardY + cardH - 0.62,
            w: Math.min(cardW - 0.5, 0.42 + k.delta.length * 0.11),
            h: 0.34,
            fill: { color: good ? "DCFCE7" : "FEE2E2" },
            rectRadius: 0.17,
          });
          slide.addText(k.delta, {
            x: x + 0.26,
            y: cardY + cardH - 0.62,
            w: Math.min(cardW - 0.5, 0.42 + k.delta.length * 0.11),
            h: 0.34,
            align: "center",
            valign: "middle",
            fontSize: 10.5,
            bold: true,
            color: good ? "047857" : "B91C1C",
            fontFace: PPTX_FONT,
          });
        }
      });
      if (s.bullets?.length)
        addBullets(slide, s.bullets, { x: M, y: 4.55, w: CONTENT_W, h: bottom - 4.55 });
    } else if (layout === "twoColumn" && (hasChart || s.table)) {
      const leftW = 5.9;
      let ly = top;
      if (s.paragraph) {
        slide.addText(s.paragraph, {
          x: M,
          y: ly,
          w: leftW,
          h: 1.2,
          fontSize: 13,
          color: PPTX_BODY,
          fontFace: PPTX_FONT,
        });
        ly += 1.3;
      }
      if (s.bullets?.length)
        addBullets(slide, s.bullets, { x: M, y: ly, w: leftW, h: bottom - ly });
      if (hasChart && s.chart) {
        addChart(slide, s.chart, { x: 6.8, y: top, w: 5.93, h: bottom - top });
      } else if (s.table) {
        slide.addTable(pptxTableRows(s.table, accent), {
          x: 6.8,
          y: top,
          w: 5.93,
          fontSize: 10,
          border: { type: "solid", color: PPTX_BORDER, pt: 1 },
          color: PPTX_BODY,
          autoPage: false,
        });
      }
    } else if (hasChart && s.chart) {
      if (s.bullets?.length) {
        addChart(slide, s.chart, { x: M, y: top, w: 7.3, h: bottom - top });
        addBullets(slide, s.bullets, { x: 8.2, y: top + 0.15, w: 4.5, h: bottom - top - 0.15 });
      } else {
        addChart(slide, s.chart, { x: M, y: top, w: CONTENT_W, h: bottom - top });
      }
    } else if (s.table) {
      slide.addTable(pptxTableRows(s.table, accent), {
        x: M,
        y: top,
        w: CONTENT_W,
        fontSize: 11,
        border: { type: "solid", color: PPTX_BORDER, pt: 1 },
        color: PPTX_BODY,
        autoPage: false,
        valign: "middle",
      });
    } else {
      let y = top;
      if (s.paragraph) {
        slide.addText(s.paragraph, {
          x: M,
          y,
          w: CONTENT_W,
          h: 1.2,
          fontSize: 14,
          color: PPTX_BODY,
          fontFace: PPTX_FONT,
        });
        y += 1.3;
      }
      if (s.bullets?.length) addBullets(slide, s.bullets, { x: M, y, w: CONTENT_W, h: bottom - y });
    }

    if (s.takeaway) takeawayBar(slide, s.takeaway);
    if (s.notes) slide.addNotes(s.notes);
  }

  await pptx.writeFile({ fileName: withExt(filename, "pptx") });
}

// ── Word (docx) — headings, paragraphs, bullet lists, tables ──────────────────
export async function buildDocx(plan: DocxPlan, filename: string): Promise<void> {
  const docx = await import("docx");
  const {
    Document,
    Packer,
    Paragraph,
    HeadingLevel,
    Table,
    TableRow,
    TableCell,
    WidthType,
    TextRun,
  } = docx;

  const headingFor = (lvl: 1 | 2 | 3) =>
    lvl === 1
      ? HeadingLevel.HEADING_1
      : lvl === 2
        ? HeadingLevel.HEADING_2
        : HeadingLevel.HEADING_3;

  // Section children mix Paragraph + Table; keep it loose and cast at the end.
  const children: unknown[] = [];
  children.push(new Paragraph({ text: plan.title || "Untitled", heading: HeadingLevel.TITLE }));

  for (const b of plan.blocks ?? []) {
    if (b.type === "heading") {
      children.push(new Paragraph({ text: b.text, heading: headingFor(b.level) }));
    } else if (b.type === "paragraph") {
      children.push(new Paragraph({ children: [new TextRun(b.text)] }));
    } else if (b.type === "bullets") {
      for (const item of b.items) {
        children.push(new Paragraph({ text: item, bullet: { level: 0 } }));
      }
    } else if (b.type === "table") {
      children.push(
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [
            new TableRow({
              children: b.table.columns.map(
                (c) =>
                  new TableCell({
                    children: [
                      new Paragraph({ children: [new TextRun({ text: String(c), bold: true })] }),
                    ],
                  }),
              ),
            }),
            ...(b.table.rows ?? []).map(
              (row) =>
                new TableRow({
                  children: row.map(
                    (cell) =>
                      new TableCell({
                        children: [
                          new Paragraph(cell === null || cell === undefined ? "" : String(cell)),
                        ],
                      }),
                  ),
                }),
            ),
          ],
        }),
      );
    }
  }

  const doc = new Document({ sections: [{ children: children as never }] });
  const blob = await Packer.toBlob(doc);
  downloadBlob(blob, withExt(filename, "docx"));
}

// ── Excel materialization — turn data-bound sheets into literal ones ───────────
// A data-bound sheet declares a `sourceSql`; here we run it over the user's
// hydrated tables (ALL rows in `full` scope, capped in `sample`), then append
// any computed columns and totals row as live Excel formulas resolved against
// the real, now-known row ranges. Literal sheets pass straight through.

const SCOPE_ROW_CAP: Record<DocScope, number> = { sample: 100, full: 100_000 };

/** 0 → "A", 25 → "Z", 26 → "AA". */
function colLetter(index0: number): string {
  let n = index0;
  let s = "";
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

/** Resolve {col:Header} / {row} / {first} / {last} tokens in a formula template. */
function resolveFormula(
  tmpl: string,
  headerToLetter: Map<string, string>,
  ctx: { row?: number; first?: number; last?: number },
): string {
  return tmpl
    .replace(/\{col:([^}]+)\}/g, (_m, h: string) => headerToLetter.get(h.trim()) ?? "A")
    .replace(/\{row\}/g, ctx.row != null ? String(ctx.row) : "")
    .replace(/\{first\}/g, ctx.first != null ? String(ctx.first) : "")
    .replace(/\{last\}/g, ctx.last != null ? String(ctx.last) : "");
}

const NUMBER_FORMATS: Record<NonNullable<XlsxComputedColumn["format"]>, string> = {
  number: "#,##0.00",
  currency: "$#,##0.00",
  percent: "0.00%",
};

/** Coerce an arbitrary query value into a literal spreadsheet cell. */
function toLiteral(v: unknown): XlsxCell {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v);
}

function noteSheet(name: string, message: string): XlsxLiteralSheet {
  return { name, headers: ["Note"], rows: [[message]] };
}

function materializeDataSheet(
  name: string,
  sourceSql: string,
  computed: XlsxComputedColumn[],
  totals: XlsxTotalsRow | undefined,
  cap: number,
): XlsxLiteralSheet {
  let result: { columns: string[]; rows: Record<string, unknown>[] };
  try {
    result = runQueryUnlimited(sourceSql, cap);
  } catch (e) {
    return noteSheet(name, `Could not run query: ${(e as Error).message}`);
  }

  const headers = [...result.columns, ...computed.map((c) => c.header)];
  const headerToLetter = new Map<string, string>();
  headers.forEach((h, i) => {
    if (!headerToLetter.has(h)) headerToLetter.set(h, colLetter(i));
  });

  const first = 2; // row 1 is the header
  const last = 1 + result.rows.length;

  const dataRows: XlsxCell[][] = result.rows.map((r, i) => {
    const excelRow = first + i;
    const base: XlsxCell[] = result.columns.map((c) => toLiteral(r[c]));
    const calc: XlsxCell[] = computed.map((c) => ({
      formula: resolveFormula(c.formula, headerToLetter, { row: excelRow }),
      ...(c.format ? { format: NUMBER_FORMATS[c.format] } : {}),
    }));
    return [...base, ...calc];
  });

  const rows = [...dataRows];
  if (totals && result.rows.length > 0 && (totals.label || totals.cells?.length)) {
    const totalRow: XlsxCell[] = headers.map(() => null);
    if (totals.label) totalRow[0] = totals.label;
    for (const cell of totals.cells ?? []) {
      const idx = headers.indexOf(cell.column);
      if (idx >= 0) {
        totalRow[idx] = { formula: resolveFormula(cell.formula, headerToLetter, { first, last }) };
      }
    }
    rows.push(totalRow);
  }

  return { name, headers, rows };
}

/**
 * Resolve a plan's data-bound sheets against the user's real data. Hydrates the
 * in-browser SQL engine once (only when needed). Never throws for a single bad
 * sheet — that sheet becomes a small note so the rest of the workbook still
 * generates.
 */
export async function materializeXlsxPlan(
  plan: XlsxPlan,
  scope: DocScope,
): Promise<MaterializedXlsxPlan> {
  const cap = SCOPE_ROW_CAP[scope] ?? SCOPE_ROW_CAP.sample;
  const hasData = (plan.sheets ?? []).some(isXlsxDataSheet);
  if (hasData) {
    try {
      await hydrateFromSupabase();
    } catch {
      /* queries will surface a clear per-sheet note if tables are missing */
    }
  }

  const sheets: XlsxLiteralSheet[] = (plan.sheets ?? []).map((s) => {
    if (isXlsxDataSheet(s)) {
      return materializeDataSheet(
        s.name || "Sheet1",
        s.sourceSql,
        s.computedColumns ?? [],
        s.totals,
        cap,
      );
    }
    return { name: s.name || "Sheet1", headers: s.headers ?? [], rows: s.rows ?? [] };
  });

  return { sheets };
}

// ── Excel (write-excel-file) — real cells + live formulas ─────────────────────
function toXlsxCell(v: XlsxCell): Cell {
  if (v === null || v === undefined) return null;
  if (typeof v === "object" && "formula" in v) {
    return {
      type: "Formula",
      value: v.formula,
      ...(v.format ? { format: v.format } : {}),
    } as unknown as Cell;
  }
  if (typeof v === "number") return Number.isFinite(v) ? { type: Number, value: v } : null;
  if (typeof v === "boolean") return { type: Boolean, value: v };
  return { type: String, value: String(v) };
}

export async function buildXlsx(plan: MaterializedXlsxPlan, filename: string): Promise<void> {
  const writeXlsxFile = (await import("write-excel-file/browser")).default;
  const sheets = (plan.sheets ?? []).filter((s) => s && (s.headers?.length || s.rows?.length));
  if (sheets.length === 0) throw new Error("The plan produced no sheets");

  const built = sheets.map((s) => {
    const header: Cell[] = (s.headers ?? []).map((h) => ({
      type: String,
      value: String(h),
      fontWeight: "bold" as const,
    }));
    const body: Cell[][] = (s.rows ?? []).map((row) => row.map(toXlsxCell));
    const data: SheetData = header.length ? [header, ...body] : body;
    return {
      data,
      sheet: (s.name || "Sheet1").replace(/[\\/?*[\]:]/g, " ").slice(0, 31) || "Sheet1",
    };
  });

  if (built.length === 1) {
    await writeXlsxFile(built[0].data, { sheet: built[0].sheet }).toFile(withExt(filename, "xlsx"));
  } else {
    await writeXlsxFile(built).toFile(withExt(filename, "xlsx"));
  }
}
