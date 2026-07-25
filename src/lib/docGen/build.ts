// Client-side builders that turn a plan into a real, fully-editable Office file.
// Each library is dynamically imported so its (large) bundle only loads when the
// user actually generates a document.
import type { Cell, SheetData } from "write-excel-file/browser";

import type { DocTable, DocxPlan, PptxPlan, XlsxCell, XlsxPlan } from "./types";

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

// ── Excel (write-excel-file) — real cells + live formulas ─────────────────────
function toXlsxCell(v: XlsxCell): Cell {
  if (v === null || v === undefined) return null;
  if (typeof v === "object" && "formula" in v) {
    return { type: "Formula", value: v.formula } as unknown as Cell;
  }
  if (typeof v === "number") return Number.isFinite(v) ? { type: Number, value: v } : null;
  if (typeof v === "boolean") return { type: Boolean, value: v };
  return { type: String, value: String(v) };
}

export async function buildXlsx(plan: XlsxPlan, filename: string): Promise<void> {
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
