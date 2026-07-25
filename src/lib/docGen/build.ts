// Client-side builders that turn a plan into a real, fully-editable Office file.
// Each library is dynamically imported so its (large) bundle only loads when the
// user actually generates a document.
import type { Cell, SheetData } from "write-excel-file/browser";

import { hydrateFromSupabase, runQueryUnlimited } from "@/lib/sqlEngine";
import type {
  DocScope,
  DocTable,
  DocxPlan,
  MaterializedXlsxPlan,
  PptxPlan,
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

// ── PowerPoint (pptxgenjs) — native text, tables and editable charts ──────────
export async function buildPptx(plan: PptxPlan, filename: string): Promise<void> {
  const PptxGen = (await import("pptxgenjs")).default;
  const pptx = new PptxGen();
  pptx.layout = "LAYOUT_WIDE";

  // Title slide.
  const title = pptx.addSlide();
  title.addText(plan.title || "Untitled", {
    x: 0.5,
    y: 2.2,
    w: 12.3,
    h: 1.2,
    fontSize: 40,
    bold: true,
    align: "center",
    color: "1E293B",
  });
  if (plan.subtitle) {
    title.addText(plan.subtitle, {
      x: 0.5,
      y: 3.5,
      w: 12.3,
      h: 0.8,
      fontSize: 18,
      align: "center",
      color: "64748B",
    });
  }

  for (const s of plan.slides ?? []) {
    const slide = pptx.addSlide();
    slide.addText(s.title || "", {
      x: 0.5,
      y: 0.35,
      w: 12.3,
      h: 0.8,
      fontSize: 26,
      bold: true,
      color: "1E293B",
    });
    let cursorY = 1.4;
    if (s.paragraph) {
      slide.addText(s.paragraph, {
        x: 0.6,
        y: cursorY,
        w: 12,
        h: 1,
        fontSize: 14,
        color: "334155",
      });
      cursorY += 1.1;
    }
    if (s.bullets?.length) {
      slide.addText(
        s.bullets.map((b) => ({
          text: b,
          options: { bullet: true, fontSize: 16, color: "334155" },
        })),
        { x: 0.7, y: cursorY, w: 11.8, h: Math.min(4.5, s.bullets.length * 0.45 + 0.3) },
      );
      cursorY += Math.min(4.5, s.bullets.length * 0.45 + 0.5);
    }
    if (s.chart && s.chart.series.length > 0) {
      const type =
        s.chart.type === "line"
          ? pptx.ChartType.line
          : s.chart.type === "pie"
            ? pptx.ChartType.pie
            : pptx.ChartType.bar;
      const data = s.chart.series.map((ser) => ({
        name: ser.name,
        labels: s.chart!.categories,
        values: ser.values,
      }));
      slide.addChart(type, data, {
        x: 0.7,
        y: Math.min(cursorY, 3),
        w: 11.8,
        h: Math.min(4.2, 6.8 - Math.min(cursorY, 3)),
        showLegend: s.chart.series.length > 1 || s.chart.type === "pie",
        showTitle: false,
      });
    } else if (s.table) {
      slide.addTable(tableToPptxRows(s.table), {
        x: 0.6,
        y: Math.min(cursorY, 3),
        w: 12.1,
        fontSize: 11,
        border: { type: "solid", color: "E2E8F0", pt: 1 },
        color: "334155",
      });
    }
    if (s.notes) slide.addNotes(s.notes);
  }

  await pptx.writeFile({ fileName: withExt(filename, "pptx") });
}

function tableToPptxRows(t: DocTable) {
  const header = t.columns.map((c) => ({
    text: String(c),
    options: { bold: true, fill: { color: "F1F5F9" }, color: "0F172A" },
  }));
  const body = (t.rows ?? []).map((r) =>
    r.map((cell) => ({ text: cell === null || cell === undefined ? "" : String(cell) })),
  );
  return [header, ...body];
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
