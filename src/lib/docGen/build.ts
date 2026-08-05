// Client-side builders that turn a plan into a real, fully-editable Office file.
// Each library is dynamically imported so its (large) bundle only loads when the
// user actually generates a document.
import type { Cell, SheetData } from "write-excel-file/browser";

import { hydrateFromSupabase, runQueryUnlimited } from "@/lib/sqlEngine";
import { materializePptxWithBI } from "./biData";
import { chartToSvg, svgToDataUri } from "./chartSvg";
import { diagramToSvg } from "./diagramSvg";
import { docxThumbUri, pptxThumbUri, xlsxThumbUri } from "./docThumb";

/** A generated document: the file blob, its filename, and an SVG-data-URI
 * thumbnail of the first slide/page/sheet (shown in chat before download). */
export type BuiltDoc = { blob: Blob; filename: string; thumb: string };
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
import { alignColumnAggregates } from "./xlsxRepair";

function withExt(name: string, ext: string): string {
  const base = (name || "document").trim() || "document";
  return base.toLowerCase().endsWith(`.${ext}`) ? base : `${base}.${ext}`;
}

export function downloadBlob(blob: Blob, filename: string): void {
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

/**
 * Attach a pre-rendered SVG to every diagram slide (used by the server-side
 * renderer, which rasterises it). Mirrors the palette/colours buildPptx uses.
 */
export function attachDiagramSvgs(plan: PptxPlan): void {
  const accent = normalizeHex(plan.accent, PPTX_DEFAULT_ACCENT);
  const accentInk = onLight(accent);
  const palette = [
    accentInk,
    "0EA5E9",
    "10B981",
    "F59E0B",
    "EF4444",
    "8B5CF6",
    "EC4899",
    "14B8A6",
    "F97316",
    "22C55E",
  ];
  for (const s of plan.slides ?? []) {
    if (s.diagram && !s.diagramSvg) {
      const svg = diagramToSvg(
        s.diagram,
        {
          palette,
          ink: PPTX_INK,
          sub: PPTX_BODY,
          card: "FFFFFF",
          border: PPTX_BORDER,
          accent: accentInk,
        },
        1160,
        470,
      );
      if (svg) s.diagramSvg = svg;
    }
  }
}

export async function buildPptx(
  plan: PptxPlan,
  filename: string,
  opts: { model?: string; skipMaterialize?: boolean } = {},
): Promise<BuiltDoc> {
  // Fill charts + KPIs from the user's REAL data via the BI analyst pipeline.
  // (Skipped when the caller already materialised — e.g. the server-side path
  // that pre-fills the plan before trying the render service.)
  if (!opts.skipMaterialize) await materializePptxWithBI(plan, { model: opts.model });

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
  // A vibrant, multi-colour chart palette (independent of the deck accent so
  // charts are never monochrome). The accent still themes the deck chrome.
  const palette = [
    accentInk,
    "0EA5E9",
    "10B981",
    "F59E0B",
    "EF4444",
    "8B5CF6",
    "EC4899",
    "14B8A6",
    "F97316",
    "22C55E",
  ];
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

  // Charts are rendered by OUR OWN SVG renderer and embedded as an image (with a
  // pptxgenjs-generated PNG fallback). We moved off pptxgenjs native charts
  // because they sometimes embedded a chart frame with axes + gridlines but no
  // plotted series — an empty-looking visual. Drawing the SVG ourselves
  // guarantees the bars/lines/slices are always visible when data exists.
  const addChart = (
    slide: Slide,
    chart: DocChart,
    box: { x: number; y: number; w: number; h: number },
  ) => {
    const inset = { x: box.x + 0.22, y: box.y + 0.22, w: box.w - 0.44, h: box.h - 0.44 };
    const svg = chartToSvg(
      chart,
      { palette, ink: PPTX_INK, sub: PPTX_SUB, grid: PPTX_GRID },
      960,
      Math.max(360, Math.round((960 * inset.h) / inset.w)),
    );
    if (!svg) return; // nothing plottable (guarded upstream by chartHasData)
    card(slide, box);
    slide.addImage({ data: svgToDataUri(svg), x: inset.x, y: inset.y, w: inset.w, h: inset.h });
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
          bullet: { characterCode: "25AA", indent: 22 },
          fontSize: 18,
          color: PPTX_BODY,
          fontFace: PPTX_FONT,
          paraSpaceAfter: 15,
        },
      })),
      { ...box, valign: "top", fit: "shrink" },
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

    // A SmartArt-style diagram takes the whole content area (drawn as a designed
    // SVG image with its own cards/connectors).
    const diagramSvg = s.diagram
      ? diagramToSvg(
          s.diagram,
          {
            palette,
            ink: PPTX_INK,
            sub: PPTX_BODY,
            card: "FFFFFF",
            border: PPTX_BORDER,
            accent: accentInk,
          },
          1160,
          Math.max(360, Math.round((1160 * (bottom - top)) / CONTENT_W)),
        )
      : "";

    if (diagramSvg) {
      slide.addImage({
        data: svgToDataUri(diagramSvg),
        x: M,
        y: top,
        w: CONTENT_W,
        h: bottom - top,
      });
    } else if (layout === "kpi" && s.kpis?.length) {
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
    } else {
      // A VISUAL (chart preferred; else the real data table the materializer
      // leaves when a chart can't be built) plus optional text beside it. This
      // keeps the visual area filled — a data slide never shows an empty gap.
      const drawTable = (x: number, w: number, fontSize: number) =>
        slide.addTable(pptxTableRows(s.table!, accent), {
          x,
          y: top,
          w,
          fontSize,
          border: { type: "solid", color: PPTX_BORDER, pt: 1 },
          color: PPTX_BODY,
          autoPage: false,
          valign: "middle",
        });
      const hasVisual = hasChart || !!s.table;
      const hasText = !!(s.bullets?.length || s.paragraph);
      if (hasVisual && hasText) {
        // Visual on the left, narrative on the right.
        if (hasChart && s.chart)
          addChart(slide, s.chart, { x: M, y: top, w: 7.3, h: bottom - top });
        else drawTable(M, 7.3, 12);
        let ty = top + 0.05;
        if (s.paragraph) {
          slide.addText(s.paragraph, {
            x: 8.2,
            y: ty,
            w: 4.5,
            h: 1.6,
            fontSize: 14,
            color: PPTX_BODY,
            fontFace: PPTX_FONT,
            fit: "shrink",
          });
          ty += 1.7;
        }
        if (s.bullets?.length)
          addBullets(slide, s.bullets, { x: 8.2, y: ty, w: 4.5, h: bottom - ty });
      } else if (hasVisual) {
        if (hasChart && s.chart)
          addChart(slide, s.chart, { x: M, y: top, w: CONTENT_W, h: bottom - top });
        else drawTable(M, CONTENT_W, 13);
      } else {
        let y = top;
        if (s.paragraph) {
          slide.addText(s.paragraph, {
            x: M,
            y,
            w: CONTENT_W,
            h: 1.6,
            fontSize: 16,
            color: PPTX_BODY,
            fontFace: PPTX_FONT,
            fit: "shrink",
          });
          y += 1.7;
        }
        if (s.bullets?.length)
          addBullets(slide, s.bullets, { x: M, y, w: CONTENT_W, h: bottom - y });
      }
    }

    if (s.takeaway) takeawayBar(slide, s.takeaway);
    if (s.notes) slide.addNotes(s.notes);
  }

  const blob = (await pptx.write({ outputType: "blob" })) as Blob;
  return { blob, filename: withExt(filename, "pptx"), thumb: pptxThumbUri(plan) };
}

// ── Word (docx) — headings, paragraphs, bullet lists, tables ──────────────────
export async function buildDocx(plan: DocxPlan, filename: string): Promise<BuiltDoc> {
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
    BorderStyle,
    ShadingType,
    TableLayoutType,
  } = docx;

  const headingFor = (lvl: 1 | 2 | 3) =>
    lvl === 1
      ? HeadingLevel.HEADING_1
      : lvl === 2
        ? HeadingLevel.HEADING_2
        : HeadingLevel.HEADING_3;

  // Table styling: full page width, FIXED layout with explicit column widths (so
  // columns don't collapse and the data is visible), light shaded header, thin
  // borders on every cell, and padding. USABLE = Letter width minus 1" margins.
  const USABLE = 9360;
  const cellBorder = { style: BorderStyle.SINGLE, size: 4, color: "D9DEE5" };
  const cellMargins = { top: 60, bottom: 60, left: 110, right: 110 };

  // Section children mix Paragraph + Table; keep it loose and cast at the end.
  const children: unknown[] = [];
  children.push(new Paragraph({ text: plan.title || "Untitled", heading: HeadingLevel.TITLE }));

  let seenH1 = false; // start each major (level-1) section on a fresh page
  for (const b of plan.blocks ?? []) {
    // One malformed block must not cost the whole document. A planner can emit
    // a "bullets" block with no items or a "table" block with no table, and
    // every field below is then read off undefined — which threw and lost a
    // report that was otherwise complete.
    if (!b || typeof b !== "object") continue;
    if (b.type === "heading" && !String(b.text ?? "").trim()) continue;
    if (b.type === "paragraph" && !String(b.text ?? "").trim()) continue;
    if (b.type === "bullets" && !Array.isArray(b.items)) continue;
    if (b.type === "table" && !Array.isArray(b.table?.columns)) continue;
    if (b.type === "heading") {
      const isH1 = b.level === 1;
      children.push(
        new Paragraph({
          text: b.text,
          heading: headingFor(b.level),
          pageBreakBefore: isH1 && seenH1,
          spacing: { before: 240, after: 120 },
        }),
      );
      if (isH1) seenH1 = true;
    } else if (b.type === "paragraph") {
      children.push(
        new Paragraph({ children: [new TextRun(b.text)], spacing: { after: 160, line: 300 } }),
      );
    } else if (b.type === "bullets") {
      for (const item of b.items) {
        children.push(new Paragraph({ text: item, bullet: { level: 0 }, spacing: { after: 60 } }));
      }
    } else if (b.type === "table") {
      const cols = Math.max(1, b.table.columns.length);
      const colW = Math.floor(USABLE / cols);
      const headerRow = new TableRow({
        tableHeader: true,
        children: b.table.columns.map(
          (c) =>
            new TableCell({
              width: { size: colW, type: WidthType.DXA },
              margins: cellMargins,
              shading: { type: ShadingType.CLEAR, fill: "EEF2F7", color: "auto" },
              children: [
                new Paragraph({ children: [new TextRun({ text: String(c), bold: true })] }),
              ],
            }),
        ),
      });
      const bodyRows = (b.table.rows ?? []).map(
        (row) =>
          new TableRow({
            children: Array.from({ length: cols }, (_, ci) => {
              const cell = row[ci];
              return new TableCell({
                width: { size: colW, type: WidthType.DXA },
                margins: cellMargins,
                children: [new Paragraph(cell === null || cell === undefined ? "" : String(cell))],
              });
            }),
          }),
      );
      children.push(
        new Table({
          width: { size: USABLE, type: WidthType.DXA },
          columnWidths: Array.from({ length: cols }, () => colW),
          layout: TableLayoutType.FIXED,
          borders: {
            top: cellBorder,
            bottom: cellBorder,
            left: cellBorder,
            right: cellBorder,
            insideHorizontal: cellBorder,
            insideVertical: cellBorder,
          },
          rows: [headerRow, ...bodyRows],
        }),
      );
      children.push(new Paragraph({ text: "", spacing: { after: 140 } }));
    }
  }

  const doc = new Document({ sections: [{ children: children as never }] });
  const blob = await Packer.toBlob(doc);
  return { blob, filename: withExt(filename, "docx"), thumb: docxThumbUri(plan) };
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

async function materializeDataSheet(
  name: string,
  sourceSql: string,
  computed: XlsxComputedColumn[],
  totals: XlsxTotalsRow | undefined,
  cap: number,
): Promise<XlsxLiteralSheet> {
  let result: { columns: string[]; rows: Record<string, unknown>[] };
  try {
    result = await runQueryUnlimited(sourceSql, cap);
  } catch (e) {
    return noteSheet(
      name,
      `Could not run query: ${(e as Error).message}. The plan referenced a table that isn't in ` +
        `your data — regenerate, and if the figures should come from the internet, say so in the ` +
        `prompt (e.g. "using prices from the web").`,
    );
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

  // Sequential rather than Promise.all: each sheet's query runs on the same
  // single DuckDB-Wasm connection, so firing them together would queue inside
  // the worker anyway while making a failure harder to attribute to a sheet.
  const sheets: XlsxLiteralSheet[] = [];
  for (const s of plan.sheets ?? []) {
    if (isXlsxDataSheet(s)) {
      sheets.push(
        await materializeDataSheet(
          s.name || "Sheet1",
          s.sourceSql,
          s.computedColumns ?? [],
          s.totals,
          cap,
        ),
      );
    } else {
      sheets.push({ name: s.name || "Sheet1", headers: s.headers ?? [], rows: s.rows ?? [] });
    }
  }

  // Put each column's total under that column. Data sheets already place totals
  // by header name, so this is a no-op for them; literal sheets are authored
  // positionally and the totals row lands in column B whatever it sums.
  const repairs: string[] = [];
  const aligned = sheets.map((s) => {
    const { sheet, moves } = alignColumnAggregates(s);
    for (const m of moves) repairs.push(`${sheet.name}: moved ${m}`);
    return sheet;
  });

  return { sheets: aligned, repairs };
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

export async function buildXlsx(plan: MaterializedXlsxPlan, filename: string): Promise<BuiltDoc> {
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

  const blob =
    built.length === 1
      ? await writeXlsxFile(built[0].data, { sheet: built[0].sheet }).toBlob()
      : await writeXlsxFile(built).toBlob();
  return { blob, filename: withExt(filename, "xlsx"), thumb: xlsxThumbUri(plan) };
}
