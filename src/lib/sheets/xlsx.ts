// Excel files (.xlsx) in and out of a workbook, through ExcelJS (MIT).
//
// Reading keeps what a sheet looks like and how it computes: values and
// formulas (shared and array formulas included, Excel's _xlfn. prefixes
// removed), number formats, fonts, fills, borders, alignment, wrapping,
// merges, hyperlinks, column widths, row heights, hidden rows and columns,
// gridlines and frozen panes. A formula this engine cannot compute keeps
// the value Excel last saved for it, and says so. Writing does the reverse,
// with each formula's current value saved beside it and Excel told to
// recalculate on open, so the file is right in Excel whatever it computes.
//
// ExcelJS is loaded only when a file is read or written.

import { a1, cellKey, parseRangeA1, rangeA1, type RangeAddr } from "./a1";
import type { CellInput, CellStyle, GridData } from "./engine";
import { FUNCTIONS } from "./formula/functions";
import { parseFormula, type Node } from "./formula/parser";
import { isError, type Scalar } from "./formula/values";
import { renameSheetInFormula } from "./formula/shift";
import { normalizeLink } from "./style";
import type { BorderSide, BorderStyle, Borders } from "./style";
import { resolveColor, themeColors, toArgb, type FileColor } from "./xlsxColors";

// The ExcelJS types, only as far as this module uses them.
/* eslint-disable @typescript-eslint/no-explicit-any */
type XCell = any;
type XSheet = any;
type XBook = any;
/* eslint-enable @typescript-eslint/no-explicit-any */

async function excel() {
  const mod = await import("exceljs");
  return (mod as unknown as { default?: typeof mod }).default ?? mod;
}

// ── Units ──────────────────────────────────────────────────────────────────

/** Excel's column width (characters of the default font) → pixels, and back. */
export const widthToPx = (chars: number): number => Math.round(chars * 7 + 5);
export const pxToWidth = (px: number): number =>
  Math.max(0, Math.round(((px - 5) / 7) * 100) / 100);
/** Row height in points → pixels, and back. */
export const ptToPx = (pt: number): number => Math.round((pt * 4) / 3);
export const pxToPt = (px: number): number => Math.round(px * 0.75 * 4) / 4;

/** Excel serial date ↔ JS Date, as ExcelJS converts them (the 1900 system, UTC). */
export const dateToSerial = (d: Date): number => d.getTime() / 86_400_000 + 25_569;

// ── Formulas ───────────────────────────────────────────────────────────────

/**
 * A formula as a file stores it → as typed here: newer functions carry
 * prefixes in the file (_xlfn.XLOOKUP, _xlfn._xlws.FILTER, _xlpm.x in LET).
 */
export function fromFileFormula(f: string): string {
  return f.replace(/_xlfn\._xlws\.|_xlfn\.|_xlws\.|_xlpm\./gi, "");
}

/**
 * Functions added to Excel after 2007 must be written with the _xlfn.
 * prefix (FILTER and SORT also _xlws.), or Excel reads them as unknown
 * names and shows #NAME?.
 */
const XLFN = new Set([
  "AGGREGATE",
  "ARABIC",
  "BASE",
  "BITAND",
  "CEILING.MATH",
  "CONCAT",
  "COVARIANCE.P",
  "COVARIANCE.S",
  "DAYS",
  "DECIMAL",
  "FLOOR.MATH",
  "FORECAST.LINEAR",
  "IFNA",
  "IFS",
  "ISOWEEKNUM",
  "MAXIFS",
  "MINIFS",
  "MODE.SNGL",
  "NORM.DIST",
  "NORM.INV",
  "NORM.S.DIST",
  "NORM.S.INV",
  "PERCENTILE.EXC",
  "PERCENTILE.INC",
  "QUARTILE.INC",
  "QUARTILE.EXC",
  "RANK.AVG",
  "RANK.EQ",
  "SEQUENCE",
  "STDEV.P",
  "STDEV.S",
  "SWITCH",
  "TEXTJOIN",
  "UNICHAR",
  "UNICODE",
  "UNIQUE",
  "VAR.P",
  "VAR.S",
  "XLOOKUP",
  "XMATCH",
  "XOR",
  "SORTBY",
  "RANDARRAY",
  "LET",
  "TEXTBEFORE",
  "TEXTAFTER",
  "TEXTSPLIT",
  "VSTACK",
  "HSTACK",
  "TAKE",
  "DROP",
  "CHOOSECOLS",
  "CHOOSEROWS",
  "TOCOL",
  "TOROW",
  "WRAPROWS",
  "WRAPCOLS",
  "EXPAND",
  "LAMBDA",
]);
const XLWS = new Set(["FILTER", "SORT"]);

export function toFileFormula(f: string): string {
  const body = f.startsWith("=") ? f.slice(1) : f;
  let out = "";
  let i = 0;
  while (i < body.length) {
    const ch = body[i];
    if (ch === '"') {
      const end = body.indexOf('"', i + 1);
      // "" inside a string is an escaped quote: keep scanning past it.
      let j = end;
      while (j !== -1 && body[j + 1] === '"') j = body.indexOf('"', j + 2);
      const stop = j === -1 ? body.length : j + 1;
      out += body.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === "'") {
      const end = body.indexOf("'", i + 1);
      const stop = end === -1 ? body.length : end + 1;
      out += body.slice(i, stop);
      i = stop;
      continue;
    }
    const m = /^[A-Za-z][A-Za-z0-9.]*(?=\s*\()/.exec(body.slice(i));
    if (m && !/[A-Za-z0-9_.]/.test(body[i - 1] ?? "")) {
      const name = m[0].toUpperCase();
      out += XLWS.has(name) ? `_xlfn._xlws.${name}` : XLFN.has(name) ? `_xlfn.${name}` : m[0];
      i += m[0].length;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

// ── Styles ─────────────────────────────────────────────────────────────────

const BORDER_IN: Record<string, BorderStyle> = {
  thin: "thin",
  hair: "thin",
  dotted: "dotted",
  dashDotDot: "dotted",
  dashDot: "dashed",
  dashed: "dashed",
  mediumDashed: "dashed",
  mediumDashDot: "dashed",
  mediumDashDotDot: "dashed",
  slantDashDot: "dashed",
  medium: "medium",
  thick: "thick",
  double: "double",
};

function borderIn(
  b: { style?: string; color?: FileColor } | undefined,
  theme: string[],
): BorderSide | undefined {
  if (!b?.style) return undefined;
  const s = BORDER_IN[b.style];
  if (!s) return undefined;
  const c = resolveColor(b.color, theme);
  return c && c !== "#000000" ? { s, c } : { s };
}

/** A cell's look from a file, in this workbook's terms. */
export function styleFromFile(cell: XCell, theme: string[]): CellStyle | undefined {
  const s: CellStyle = {};
  const font = cell.font ?? {};
  if (font.bold) s.b = true;
  if (font.italic) s.i = true;
  if (font.underline && font.underline !== "none") s.u = true;
  if (font.strike) s.st = true;
  if (font.name && font.name !== "Calibri")
    s.font = String(font.name)
      .slice(0, 64)
      .replace(/["'\\<>;{}]/g, "");
  if (typeof font.size === "number" && font.size !== 11)
    s.sz = Math.max(1, Math.min(409, font.size));
  const fc = resolveColor(font.color, theme);
  if (fc && fc !== "#000000") s.color = fc;
  const fill = cell.fill;
  if (fill?.type === "pattern" && fill.pattern && fill.pattern !== "none") {
    const bg = resolveColor(fill.fgColor, theme) ?? resolveColor(fill.bgColor, theme);
    if (bg) s.bg = bg;
  } else if (fill?.type === "gradient" && fill.stops?.length) {
    const bg = resolveColor(fill.stops[0].color, theme);
    if (bg) s.bg = bg;
  }
  const al = cell.alignment ?? {};
  if (al.horizontal === "center" || al.horizontal === "centerContinuous") s.align = "center";
  else if (al.horizontal === "right") s.align = "right";
  else if (
    al.horizontal === "left" ||
    al.horizontal === "justify" ||
    al.horizontal === "distributed"
  )
    s.align = "left";
  if (al.vertical === "top") s.va = "top";
  else if (al.vertical === "middle" || al.vertical === "center") s.va = "middle";
  if (al.wrapText) s.wrap = true;
  if (typeof al.indent === "number" && al.indent > 0) s.ind = Math.min(15, al.indent);
  const bd = cell.border;
  if (bd) {
    const b: Borders = {};
    const t = borderIn(bd.top, theme);
    const r = borderIn(bd.right, theme);
    const bo = borderIn(bd.bottom, theme);
    const l = borderIn(bd.left, theme);
    if (t) b.t = t;
    if (r) b.r = r;
    if (bo) b.b = bo;
    if (l) b.l = l;
    if (Object.keys(b).length) s.bd = b;
  }
  return Object.keys(s).length ? s : undefined;
}

function styleToFile(s: CellStyle | undefined, format: string | undefined) {
  const out: Record<string, unknown> = {};
  if (s) {
    const font: Record<string, unknown> = {};
    if (s.b) font.bold = true;
    if (s.i) font.italic = true;
    if (s.u) font.underline = true;
    if (s.st) font.strike = true;
    font.name = s.font ?? "Calibri";
    font.size = s.sz ?? 11;
    if (s.color) font.color = { argb: toArgb(s.color) };
    out.font = font;
    if (s.bg) out.fill = { type: "pattern", pattern: "solid", fgColor: { argb: toArgb(s.bg) } };
    const al: Record<string, unknown> = {};
    if (s.align) al.horizontal = s.align;
    if (s.va) al.vertical = s.va;
    if (s.wrap) al.wrapText = true;
    if (s.ind) al.indent = s.ind;
    if (Object.keys(al).length) out.alignment = al;
    if (s.bd) {
      const side = (b: BorderSide | undefined) =>
        b ? { style: b.s, color: { argb: toArgb(b.c ?? "#000000") } } : undefined;
      const border: Record<string, unknown> = {};
      if (s.bd.t) border.top = side(s.bd.t);
      if (s.bd.r) border.right = side(s.bd.r);
      if (s.bd.b) border.bottom = side(s.bd.b);
      if (s.bd.l) border.left = side(s.bd.l);
      out.border = border;
    }
  }
  if (format) out.numFmt = format;
  return out;
}

// ── Reading ────────────────────────────────────────────────────────────────

export type ImportedSheet = {
  name: string;
  grid: GridData;
  /** Non-empty cells. */
  cells: number;
  hidden: boolean;
  /** Formulas kept at Excel's saved value because they cannot be computed here. */
  cachedFormulas: number;
};

export type ImportResult = { sheets: ImportedSheet[]; warnings: string[] };

function textOf(v: unknown): string {
  if (v && typeof v === "object" && "richText" in (v as object)) {
    return ((v as { richText: { text: string }[] }).richText ?? []).map((r) => r.text).join("");
  }
  return v == null ? "" : String(v);
}

/** What a file's cell value becomes as typed input (a literal the engine reads back the same). */
function literalInput(v: unknown): { i: string; f?: string } | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return { i: String(v) };
  if (typeof v === "boolean") return { i: v ? "TRUE" : "FALSE" };
  if (v instanceof Date) return { i: String(dateToSerial(v)) };
  if (typeof v === "object" && v && "error" in (v as object)) {
    const e = (v as { error: string }).error;
    return { i: e === "#N/A" ? "=NA()" : `'${e}` };
  }
  const t = textOf(v);
  if (t === "") return null;
  // Text that would read back as a number, a formula or TRUE stays text.
  if (/^[=+\-@]/.test(t) || /^(true|false)$/i.test(t) || /^[\d.,%$ ()-]+$/.test(t))
    return { i: `'${t}` };
  return { i: t };
}

/**
 * Whether this engine can compute a formula: it parses, calls only functions
 * the engine has, and names no defined name (those stay in the file).
 */
export function computable(formula: string): boolean {
  let ast: Node;
  try {
    ast = parseFormula(formula.startsWith("=") ? formula.slice(1) : formula);
  } catch {
    return false;
  }
  const ok = (n: Node): boolean => {
    switch (n.k) {
      case "call":
        return !!FUNCTIONS[n.name] && n.args.every(ok);
      case "name":
        return false;
      case "unary":
      case "percent":
        return ok(n.arg);
      case "bin":
        return ok(n.left) && ok(n.right);
      case "array":
        return n.rows.every((r) => r.every(ok));
      default:
        return true;
    }
  };
  return ok(ast);
}

/** A formula's saved result as a value this workbook can hold. */
function cachedValue(result: unknown): string | number | boolean | undefined {
  if (result === null || result === undefined) return undefined;
  if (typeof result === "number" || typeof result === "boolean") return result;
  if (result instanceof Date) return dateToSerial(result);
  if (typeof result === "object" && "error" in (result as object))
    return (result as { error: string }).error;
  return textOf(result);
}

export type ReadOptions = {
  /** Cells one grid sheet may hold (SHEETS_MAX_CELLS). */
  maxCells: number;
};

/**
 * Read an .xlsx file into grid sheets. Values that are the result of a
 * formula come in as the formula; Excel's saved result is kept beside it
 * (`c`) for the editor to fall back on when it cannot compute the formula.
 */
export async function readXlsx(data: ArrayBuffer, opts: ReadOptions): Promise<ImportResult> {
  const ExcelJS = await excel();
  const wb: XBook = new ExcelJS.Workbook();
  await wb.xlsx.load(data);
  const theme = themeColors(wb._themes?.theme1);
  const warnings: string[] = [];
  const sheets: ImportedSheet[] = [];
  for (const ws of wb.worksheets as XSheet[]) {
    if (ws.state === "veryHidden") continue;
    const cells: Record<string, CellInput> = {};
    let count = 0;
    let cached = 0;
    let truncated = false;
    const spillTargets = new Set<string>();
    ws.eachRow({ includeEmpty: true }, (row: XCell, rowNumber: number) => {
      if (truncated) return;
      row.eachCell({ includeEmpty: true }, (cell: XCell, colNumber: number) => {
        if (truncated) return;
        const r = rowNumber - 1;
        const c = colNumber - 1;
        const key = cellKey(r, c);
        if (cell.isMerged && cell.master?.address !== cell.address) {
          // A merged block's other cells hold nothing but their borders.
          return;
        }
        const style = styleFromFile(cell, theme);
        const numFmt: string | undefined =
          typeof cell.numFmt === "string" && cell.numFmt !== "General" ? cell.numFmt : undefined;
        const input: CellInput = { i: "" };
        const v = cell.value;
        const isFormula = v && typeof v === "object" && ("formula" in v || "sharedFormula" in v);
        if (spillTargets.has(key)) {
          // Filled by the array formula above or to the left of it; Excel
          // stores its values here, and here the formula spills them again.
        } else if (isFormula) {
          const text: string | undefined = cell.formula ?? (v as { formula?: string }).formula;
          if (text) {
            input.i = `=${fromFileFormula(text)}`;
            // Excel's saved value, kept only where it will be needed: a
            // formula this engine cannot compute shows it instead.
            const cv = cachedValue((v as { result?: unknown }).result);
            if (cv !== undefined && !computable(input.i)) input.c = cv;
            const ref: string | undefined = (v as { ref?: string }).ref;
            if ((v as { shareType?: string }).shareType === "array" && ref) {
              const rr = parseRangeA1(ref);
              if (rr) {
                for (let y = rr.r0; y <= rr.r1; y++)
                  for (let x = rr.c0; x <= rr.c1; x++)
                    if (y !== r || x !== c) spillTargets.add(cellKey(y, x));
              }
            }
          }
        } else if (v && typeof v === "object" && "hyperlink" in v) {
          const lit = literalInput((v as { text?: unknown }).text);
          if (lit) input.i = lit.i;
          const href = normalizeLink(String((v as { hyperlink?: string }).hyperlink ?? ""));
          if (href) input.l = href;
          else
            warnings.push(
              `${ws.name}!${a1(r, c)}: a link that is not a web, mail or in-workbook address was dropped`,
            );
        } else {
          const lit = literalInput(v);
          if (lit) input.i = lit.i;
          if (v instanceof Date && !numFmt) input.f = "yyyy-mm-dd";
        }
        if (numFmt) input.f = numFmt;
        if (style) input.s = style;
        if (input.i === "" && !input.f && !input.s && !input.l) return;
        if (input.i !== "" && ++count > opts.maxCells) {
          truncated = true;
          return;
        }
        if (input.c !== undefined && input.i.startsWith("=")) cached++;
        cells[key] = input;
      });
    });
    if (truncated) {
      warnings.push(
        `${ws.name}: more than ${opts.maxCells.toLocaleString()} cells (SHEETS_MAX_CELLS); only the first ${opts.maxCells.toLocaleString()} came in. Import a sheet this large as a table sheet instead.`,
      );
    }
    const grid: GridData = { cells };
    // Merges.
    const merges: string[] = (ws.model?.merges ?? []).filter((m: string) => !!parseRangeA1(m));
    if (merges.length) grid.merges = merges.map((m) => rangeA1(parseRangeA1(m)!));
    // Column widths: every column up to the used width, so the sheet keeps
    // Excel's proportions (its default is narrower than this grid's).
    const defaultW: number = ws.properties?.defaultColWidth ?? 8.43;
    const colWidths: Record<string, number> = {};
    const hiddenCols: number[] = [];
    // Every column the file describes, not only those holding cells: a
    // hidden or widened column past the data is still part of the sheet.
    const maxCol = Math.min(16_384, Math.max(ws.columnCount ?? 0, ws._columns?.length ?? 0, 1));
    for (let c = 1; c <= maxCol; c++) {
      const col = ws.getColumn(c);
      colWidths[String(c - 1)] = widthToPx(col.width ?? defaultW);
      if (col.hidden) hiddenCols.push(c - 1);
    }
    grid.colWidths = colWidths;
    if (hiddenCols.length) grid.hiddenCols = hiddenCols;
    // Row heights set in the file (a default-height row is left to fit its content).
    const defaultH: number = ws.properties?.defaultRowHeight ?? 15;
    const rowHeights: Record<string, number> = {};
    const hiddenRows: number[] = [];
    // Every row the file describes (a hidden row past the data has no cells).
    const rowList: (XCell | undefined)[] = ws._rows ?? [];
    for (let i = 0; i < Math.min(rowList.length, 1_048_576); i++) {
      const row = rowList[i];
      if (!row) continue;
      if (row.hidden) hiddenRows.push(i);
      if (typeof row.height === "number" && Math.abs(row.height - defaultH) > 0.01) {
        rowHeights[String(i)] = Math.max(12, Math.min(800, ptToPx(row.height)));
      }
    }
    if (Object.keys(rowHeights).length) grid.rowHeights = rowHeights;
    if (hiddenRows.length) grid.hiddenRows = hiddenRows;
    const view = ws.views?.[0];
    if (view?.showGridLines === false) grid.hideGrid = true;
    if (view?.state === "frozen") {
      if (view.ySplit) grid.frozenRows = Math.min(100, view.ySplit);
      if (view.xSplit) grid.frozenCols = Math.min(50, view.xSplit);
    }
    sheets.push({
      name: ws.name,
      grid,
      cells: count,
      hidden: ws.state === "hidden",
      cachedFormulas: cached,
    });
  }
  return { sheets, warnings };
}

// ── Writing ────────────────────────────────────────────────────────────────

export type ExportGridSheet = {
  kind: "grid";
  name: string;
  grid: GridData;
  value: (row: number, col: number) => Scalar;
  /** The size of the array a formula spills, when it spills. */
  spill?: (row: number, col: number) => { rows: number; cols: number } | undefined;
};
export type ExportTableSheet = {
  kind: "table";
  name: string;
  columns: string[];
  /** A number format per column (dates arrive as serial days). */
  formats?: (string | undefined)[];
  rows: Scalar[][];
};

function fileValue(v: Scalar): unknown {
  if (v === null) return null;
  if (isError(v)) return { error: v.err };
  return v;
}

/** An Excel table name from a sheet name: letters, digits and _ only. */
function tableName(name: string, taken: Set<string>): string {
  let n = name.replace(/[^A-Za-z0-9_]/g, "_");
  if (!/^[A-Za-z_]/.test(n)) n = `T_${n}`;
  if (/^[A-Za-z]{1,3}\d+$/.test(n) || /^[RC]\d*$/i.test(n)) n = `${n}_`;
  let out = n;
  for (let k = 2; taken.has(out.toLowerCase()); k++) out = `${n}_${k}`;
  taken.add(out.toLowerCase());
  return out;
}

/**
 * The names the sheets get in the file: Excel refuses a sheet name longer
 * than 31 characters (a workbook with one does not open), and two names that
 * differ only past the 31st would collide once cut.
 */
export function excelSheetNames(names: readonly string[]): string[] {
  const taken = new Set<string>();
  return names.map((raw) => {
    const base = raw.replace(/[\\/?*[\]:]/g, " ").trim() || "Sheet";
    let out = base.slice(0, 31);
    for (let k = 2; taken.has(out.toLowerCase()); k++) {
      const tail = ` (${k})`;
      out = base.slice(0, 31 - tail.length) + tail;
    }
    taken.add(out.toLowerCase());
    return out;
  });
}

export async function writeXlsx(
  sheets: (ExportGridSheet | ExportTableSheet)[],
): Promise<ArrayBuffer> {
  const ExcelJS = await excel();
  const wb: XBook = new ExcelJS.Workbook();
  wb.creator = "AgentSwarms Sheets";
  wb.created = new Date();
  // Excel recomputes everything on open: the saved values are this
  // workbook's, and Excel's own answer is the one to show there.
  wb.calcProperties = { fullCalcOnLoad: true };
  const tables = new Set<string>();
  const fileNames = excelSheetNames(sheets.map((s) => s.name));
  // A shortened name is shortened in every formula that uses it, too.
  const renamed = sheets
    .map((s, i) => ({ from: s.name, to: fileNames[i] }))
    .filter((r) => r.from !== r.to);
  const inFile = (f: string) => {
    let out = f;
    for (const r of renamed) out = renameSheetInFormula(out, r.from, r.to);
    return out;
  };
  for (const [index, s] of sheets.entries()) {
    const sheetName = fileNames[index];
    if (s.kind === "table") {
      const ws = wb.addWorksheet(sheetName);
      if (s.columns.length) {
        ws.addTable({
          name: tableName(s.name, tables),
          ref: "A1",
          headerRow: true,
          style: { theme: "TableStyleLight9", showRowStripes: true },
          columns: s.columns.map((name) => ({ name, filterButton: true })),
          rows: s.rows.length ? s.rows.map((r) => r.map(fileValue)) : [s.columns.map(() => null)],
        });
        s.columns.forEach((_, i) => {
          const col = ws.getColumn(i + 1);
          col.width = 16;
          const f = s.formats?.[i];
          if (f) col.numFmt = f;
        });
      }
      continue;
    }
    const ws = wb.addWorksheet(sheetName, {
      views: [
        {
          showGridLines: !s.grid.hideGrid,
          ...(s.grid.frozenRows || s.grid.frozenCols
            ? { state: "frozen", xSplit: s.grid.frozenCols ?? 0, ySplit: s.grid.frozenRows ?? 0 }
            : {}),
        },
      ],
    });
    ws.properties.defaultColWidth = pxToWidth(104);
    ws.properties.defaultRowHeight = pxToPt(24);
    for (const [k, w] of Object.entries(s.grid.colWidths ?? {}))
      ws.getColumn(Number(k) + 1).width = pxToWidth(w);
    for (const c of s.grid.hiddenCols ?? []) ws.getColumn(c + 1).hidden = true;
    for (const [k, h] of Object.entries(s.grid.rowHeights ?? {}))
      ws.getRow(Number(k) + 1).height = pxToPt(h);
    for (const r of s.grid.hiddenRows ?? []) {
      const row = ws.getRow(r + 1);
      row.hidden = true;
      // ExcelJS writes no row that has neither cells nor a height, and a
      // hidden empty row would silently come back shown.
      if (row.height === undefined) row.height = pxToPt(24);
    }
    const spilled = new Set<string>();
    for (const [key, input] of Object.entries(s.grid.cells)) {
      const [r, c] = key.split(",").map(Number);
      const cell = ws.getCell(r + 1, c + 1);
      const v = s.value(r, c);
      if (input.i.startsWith("=")) {
        const formula = toFileFormula(inFile(input.i));
        const size = s.spill?.(r, c);
        if (size && (size.rows > 1 || size.cols > 1)) {
          // A spilling formula goes out as an array formula over the range
          // it fills, which every Excel computes the same way.
          const ref: RangeAddr = { r0: r, c0: c, r1: r + size.rows - 1, c1: c + size.cols - 1 };
          ws.fillFormula(
            rangeA1(ref),
            formula,
            (row: number, col: number) => fileValue(s.value(row - 1, col - 1)),
            "array",
          );
          for (let y = ref.r0; y <= ref.r1; y++)
            for (let x = ref.c0; x <= ref.c1; x++)
              if (y !== r || x !== c) spilled.add(cellKey(y, x));
        } else {
          cell.value = { formula, result: fileValue(v) };
        }
      } else if (!spilled.has(key)) {
        const val = input.i.startsWith("'") ? input.i.slice(1) : fileValue(v);
        const href = input.l ? normalizeLink(input.l) : null;
        cell.value = href ? { text: String(val ?? ""), hyperlink: href } : val;
      }
      const st = styleToFile(input.s, input.f);
      Object.assign(cell, st);
    }
    for (const m of s.grid.merges ?? []) ws.mergeCells(m);
  }
  if (!sheets.length) wb.addWorksheet("Sheet1");
  return (await wb.xlsx.writeBuffer()) as ArrayBuffer;
}
