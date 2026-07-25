// Client-side builders that turn a plan into a real, fully-editable Office file.
// Each library is dynamically imported so its (large) bundle only loads when the
// user actually generates a document.
import type { Cell, SheetData } from "write-excel-file/browser";

import { hydrateFromSupabase, runQueryUnlimited } from "@/lib/sqlEngine";
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

// ── PowerPoint (pptxgenjs) — a designed deck ──────────────────────────────────
// Cover + section dividers, KPI cards, native editable charts with a colour
// palette, styled tables, per-slide "key insight" bars, and a consistent accent
// theme with a footer + automatic slide numbers.

const PPTX_INK = "1E293B";
const PPTX_SUB = "64748B";
const PPTX_BODY = "334155";
const PPTX_BORDER = "E2E8F0";
const PPTX_CARD = "F8FAFC";
const PPTX_DEFAULT_ACCENT = "4F46E5";

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

function pptxEffectiveLayout(s: PptxSlide): NonNullable<PptxSlide["layout"]> {
  if (s.layout) return s.layout;
  if (s.kpis?.length) return "kpi";
  if (s.chart && s.chart.series.length > 0) return "chart";
  if (s.table) return "table";
  return "bullets";
}

function pptxTableRows(t: DocTable, accent: string) {
  const header = t.columns.map((c) => ({
    text: String(c),
    options: { bold: true, fill: { color: accent }, color: "FFFFFF" },
  }));
  const body = (t.rows ?? []).map((r, ri) =>
    r.map((cell) => ({
      text: cell === null || cell === undefined ? "" : String(cell),
      options: { fill: { color: ri % 2 === 0 ? "FFFFFF" : PPTX_CARD } },
    })),
  );
  return [header, ...body];
}

export async function buildPptx(plan: PptxPlan, filename: string): Promise<void> {
  const PptxGen = (await import("pptxgenjs")).default;
  const pptx = new PptxGen();
  pptx.layout = "LAYOUT_WIDE"; // 13.333 × 7.5 in
  type Slide = ReturnType<typeof pptx.addSlide>;

  const accent = normalizeHex(plan.accent, PPTX_DEFAULT_ACCENT);
  const accentTint = tintHex(accent, 0.9);
  const palette = [accent, "0EA5E9", "10B981", "F59E0B", "EF4444", "8B5CF6", "EC4899", "14B8A6"];
  const deckTitle = plan.title || "Untitled";

  const CW = 13.333;
  const M = 0.6;
  const CONTENT_W = CW - M * 2;

  // Content-slide master: accent spine + footer + auto slide number.
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
            y: 7.06,
            w: 9,
            h: 0.34,
            fontSize: 8,
            color: PPTX_SUB,
            valign: "middle",
          },
        },
      },
    ],
    slideNumber: {
      x: 12.4,
      y: 7.06,
      w: 0.6,
      h: 0.34,
      fontSize: 8,
      color: PPTX_SUB,
      align: "right",
    },
  });

  const titleBar = (slide: Slide, title: string, subtitle?: string) => {
    slide.addText(title || "", {
      x: M,
      y: 0.36,
      w: CONTENT_W,
      h: 0.7,
      fontSize: 24,
      bold: true,
      color: PPTX_INK,
    });
    slide.addShape("rect", { x: M + 0.02, y: 1.08, w: 0.9, h: 0.06, fill: { color: accent } });
    if (subtitle) {
      slide.addText(subtitle, {
        x: M,
        y: 1.16,
        w: CONTENT_W,
        h: 0.4,
        fontSize: 12,
        color: PPTX_SUB,
      });
    }
  };

  const takeawayBar = (slide: Slide, text: string) => {
    slide.addShape("roundRect", {
      x: M,
      y: 6.35,
      w: CONTENT_W,
      h: 0.62,
      fill: { color: accentTint },
      line: { color: accent, width: 1 },
      rectRadius: 0.06,
    });
    slide.addText(
      [
        { text: "Key insight   ", options: { bold: true, color: accent } },
        { text, options: { color: PPTX_INK } },
      ],
      { x: M + 0.25, y: 6.35, w: CONTENT_W - 0.5, h: 0.62, valign: "middle", fontSize: 12 },
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
    const data = chart.series.map((ser) => ({
      name: ser.name || "Series",
      labels: chart.categories,
      values: ser.values,
    }));
    slide.addChart(type, data, {
      ...box,
      chartColors: palette,
      showLegend: isPie || chart.series.length > 1,
      legendPos: "b",
      legendColor: PPTX_SUB,
      legendFontSize: 9,
      showTitle: false,
      showValue: isPie,
      showPercent: isPie,
      dataLabelColor: isPie ? "FFFFFF" : PPTX_BODY,
      dataLabelFontSize: 9,
      barDir: chart.type === "bar" ? "bar" : "col",
      barGapWidthPct: 40,
      catAxisLabelColor: PPTX_SUB,
      catAxisLabelFontSize: 9,
      valAxisLabelColor: PPTX_SUB,
      valAxisLabelFontSize: 9,
      chartColorsOpacity: chart.type === "area" ? 45 : 100,
      lineSize: 2,
      lineSmooth: true,
      holeSize: chart.type === "doughnut" ? 55 : undefined,
    });
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
          bullet: { characterCode: "2022", indent: 16 },
          fontSize: 13,
          color: PPTX_BODY,
          paraSpaceAfter: 8,
        },
      })),
      { ...box, valign: "top" },
    );
  };

  // ── Cover ──
  {
    const s = pptx.addSlide();
    s.background = { color: "FFFFFF" };
    s.addShape("rect", { x: 0, y: 0, w: CW, h: 3.5, fill: { color: accent } });
    s.addShape("rect", { x: 0, y: 3.5, w: CW, h: 0.12, fill: { color: accentTint } });
    s.addText(deckTitle, {
      x: 0.8,
      y: 1.0,
      w: 11.7,
      h: 1.5,
      fontSize: 40,
      bold: true,
      color: "FFFFFF",
      valign: "middle",
    });
    if (plan.subtitle) {
      s.addText(plan.subtitle, { x: 0.8, y: 2.5, w: 11.7, h: 0.7, fontSize: 18, color: "FFFFFF" });
    }
    s.addText(
      `Generated ${new Date().toLocaleDateString(undefined, {
        year: "numeric",
        month: "long",
        day: "numeric",
      })}`,
      { x: 0.8, y: 4.0, w: 11.7, h: 0.4, fontSize: 12, color: PPTX_SUB },
    );
  }

  // ── Content slides ──
  for (const s of plan.slides ?? []) {
    const layout = pptxEffectiveLayout(s);

    if (layout === "section") {
      const slide = pptx.addSlide();
      slide.background = { color: accent };
      slide.addText(s.title || "", {
        x: 0.9,
        y: 2.7,
        w: 11.5,
        h: 1.6,
        fontSize: 34,
        bold: true,
        color: "FFFFFF",
        valign: "middle",
      });
      if (s.subtitle) {
        slide.addText(s.subtitle, {
          x: 0.9,
          y: 4.2,
          w: 11.5,
          h: 0.6,
          fontSize: 16,
          color: tintHex(accent, 0.72),
        });
      }
      if (s.notes) slide.addNotes(s.notes);
      continue;
    }

    const slide = pptx.addSlide({ masterName: "AGS_CONTENT" });
    titleBar(slide, s.title, s.subtitle);
    const bottom = s.takeaway ? 6.15 : 6.9;
    const top = s.subtitle ? 1.7 : 1.5;

    if (layout === "kpi" && s.kpis?.length) {
      const kpis = s.kpis.slice(0, 5);
      const gap = 0.3;
      const cardW = (CONTENT_W - gap * (kpis.length - 1)) / kpis.length;
      const cardY = 1.95;
      const cardH = 2.3;
      kpis.forEach((k, i) => {
        const x = M + i * (cardW + gap);
        slide.addShape("roundRect", {
          x,
          y: cardY,
          w: cardW,
          h: cardH,
          fill: { color: PPTX_CARD },
          line: { color: PPTX_BORDER, width: 1 },
          rectRadius: 0.08,
        });
        slide.addShape("rect", { x, y: cardY, w: cardW, h: 0.1, fill: { color: accent } });
        slide.addText(k.value ?? "", {
          x: x + 0.1,
          y: cardY + 0.45,
          w: cardW - 0.2,
          h: 0.9,
          align: "center",
          fontSize: 30,
          bold: true,
          color: accent,
        });
        slide.addText(k.label ?? "", {
          x: x + 0.15,
          y: cardY + 1.35,
          w: cardW - 0.3,
          h: 0.5,
          align: "center",
          fontSize: 12,
          color: PPTX_SUB,
        });
        if (k.delta) {
          slide.addText(k.delta, {
            x: x + 0.1,
            y: cardY + 1.85,
            w: cardW - 0.2,
            h: 0.35,
            align: "center",
            fontSize: 12,
            bold: true,
            color: k.positive === false ? "EF4444" : "10B981",
          });
        }
      });
      if (s.bullets?.length) {
        addBullets(slide, s.bullets, { x: M, y: 4.5, w: CONTENT_W, h: bottom - 4.5 });
      }
    } else if (layout === "chart" && s.chart && s.chart.series.length > 0) {
      if (s.bullets?.length) {
        addChart(slide, s.chart, { x: M, y: top, w: 7.4, h: bottom - top });
        addBullets(slide, s.bullets, { x: 8.3, y: top + 0.1, w: 4.4, h: bottom - top - 0.1 });
      } else {
        addChart(slide, s.chart, { x: M, y: top, w: CONTENT_W, h: bottom - top });
      }
    } else if (layout === "twoColumn") {
      const leftW = 6.0;
      let ly = top;
      if (s.paragraph) {
        slide.addText(s.paragraph, {
          x: M,
          y: ly,
          w: leftW,
          h: 1.2,
          fontSize: 13,
          color: PPTX_BODY,
        });
        ly += 1.3;
      }
      if (s.bullets?.length)
        addBullets(slide, s.bullets, { x: M, y: ly, w: leftW, h: bottom - ly });
      if (s.chart && s.chart.series.length > 0) {
        addChart(slide, s.chart, { x: 6.9, y: top, w: 5.83, h: bottom - top });
      } else if (s.table) {
        slide.addTable(pptxTableRows(s.table, accent), {
          x: 6.9,
          y: top,
          w: 5.83,
          fontSize: 10,
          border: { type: "solid", color: PPTX_BORDER, pt: 1 },
          color: PPTX_BODY,
          autoPage: false,
        });
      }
    } else if (layout === "table" && s.table) {
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
