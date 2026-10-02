// The browser's side of the Sheets assistant: a description of the workbook
// the model starts from, and the answers to its reads, taken from the
// engine as the person sees the workbook (unsaved edits included).

import { a1, colLetters, parseRangeA1 } from "./a1";
import { MAX_READ_CELLS, type AssistTool } from "./assist";
import { cellView } from "./cellView";
import type { WorkbookEngine } from "./engine";
import { isError, isMatrix, type Scalar, type Value } from "./formula/values";

export type TableColumns = Record<string, { name: string; type: string }[]>;

type ColType = "number" | "text" | "date" | "bool" | "mixed" | "empty";

function shown(engine: WorkbookEngine, sheetId: string, r: number, c: number): string {
  const v = engine.getValue(sheetId, r, c);
  return cellView(v, engine.getInput(sheetId, r, c)).text;
}

function typeOf(engine: WorkbookEngine, sheetId: string, r: number, c: number): ColType {
  const v = engine.getValue(sheetId, r, c);
  if (v === null || v === "") return "empty";
  if (typeof v === "boolean") return "bool";
  if (typeof v === "number") {
    const f = engine.getInput(sheetId, r, c)?.f ?? "";
    return /[dy]/i.test(f) && !/[#0]/.test(f.replace(/"[^"]*"/g, "")) ? "date" : "number";
  }
  return isError(v) ? "mixed" : "text";
}

/** A sheet's header row (the first row holding text) and each column's type below it. */
export function describeGrid(
  engine: WorkbookEngine,
  sheetId: string,
  sampleRows = 5,
): {
  size: string;
  header: number;
  columns: { letter: string; name: string; type: ColType }[];
  sample: string[][];
} {
  const used = engine.used(sheetId);
  const rows = Math.min(used.rows, 1_048_576);
  const cols = Math.min(used.cols, 60);
  if (!rows || !cols) return { size: "empty", header: -1, columns: [], sample: [] };
  // The header: the first of the top rows that is mostly text.
  let header = -1;
  for (let r = 0; r < Math.min(rows, 10) && header < 0; r++) {
    let text = 0;
    let filled = 0;
    for (let c = 0; c < cols; c++) {
      const v = engine.getValue(sheetId, r, c);
      if (v === null || v === "") continue;
      filled++;
      if (typeof v === "string") text++;
    }
    if (filled >= 2 && text / filled >= 0.8) header = r;
  }
  const first = header + 1;
  const columns = [];
  for (let c = 0; c < cols; c++) {
    const types = new Set<ColType>();
    for (let r = first; r < Math.min(rows, first + 50); r++) {
      const t = typeOf(engine, sheetId, r, c);
      if (t !== "empty") types.add(t);
    }
    const type: ColType = types.size === 0 ? "empty" : types.size === 1 ? [...types][0] : "mixed";
    columns.push({
      letter: colLetters(c),
      name: header >= 0 ? shown(engine, sheetId, header, c) : "",
      type,
    });
  }
  const sample: string[][] = [];
  for (let r = first; r < Math.min(rows, first + sampleRows); r++) {
    const line: string[] = [];
    for (let c = 0; c < cols; c++) line.push(shown(engine, sheetId, r, c));
    sample.push(line);
  }
  return {
    size: `A1:${a1(rows - 1, cols - 1)} (${rows} rows, ${used.cols} columns)`,
    header,
    columns,
    sample,
  };
}

/** What the model is told about the workbook before it asks anything. */
export function workbookContext(args: {
  engine: WorkbookEngine;
  workbookName: string;
  activeSheetId: string;
  selection: string;
  focus: { row: number; col: number };
  tableColumns?: TableColumns;
}): string {
  const { engine } = args;
  const lines: string[] = [`Workbook: ${args.workbookName}`];
  const active = engine.sheet(args.activeSheetId);
  if (active) {
    const input = engine.getInput(active.id, args.focus.row, args.focus.col)?.i ?? "";
    const value =
      active.kind === "grid" ? shown(engine, active.id, args.focus.row, args.focus.col) : "";
    const detail =
      active.kind === "grid"
        ? engine.getErrorDetail(active.id, args.focus.row, args.focus.col)
        : undefined;
    lines.push(
      `Active sheet: ${active.name}; selection ${args.selection}; active cell ${a1(args.focus.row, args.focus.col)}` +
        (input ? ` holds ${JSON.stringify(input)}` : " is empty") +
        (input.startsWith("=") ? ` showing ${JSON.stringify(value)}` : "") +
        (detail ? ` (error: ${detail})` : ""),
    );
  }
  for (const s of engine.listSheets()) {
    if (s.kind === "table") {
      const cols = args.tableColumns?.[s.name] ?? [];
      lines.push(
        `\nTABLE sheet "${s.name}" (lakehouse; refer to it as ${s.name}[column]): columns ${cols.map((c) => `${c.name} (${c.type})`).join(", ") || "not loaded"}`,
      );
      continue;
    }
    const d = describeGrid(engine, s.id);
    lines.push(`\nGRID sheet "${s.name}": ${d.size}`);
    if (d.header >= 0) {
      lines.push(
        `Header row ${d.header + 1}: ${d.columns
          .filter((c) => c.name || c.type !== "empty")
          .map((c) => `${c.letter}=${c.name || "(no name)"} [${c.type}]`)
          .join(", ")}`,
      );
    }
    if (d.sample.length) {
      lines.push(`First rows as shown:`);
      for (const row of d.sample) lines.push(`  ${row.map((x) => x.slice(0, 40)).join(" | ")}`);
    }
  }
  // The workbook's names, which formulas use as they are (R148).
  const names = engine.definedNames();
  if (names.length) {
    lines.push(`\nNAMES (use in formulas by name, e.g. =SUM(${names[0].name})):`);
    for (const d of names.slice(0, 100))
      lines.push(`  ${d.name} = ${d.ref}${d.comment ? ` (${d.comment.slice(0, 80)})` : ""}`);
    if (names.length > 100) lines.push(`  … and ${names.length - 100} more`);
  }
  const text = lines.join("\n");
  return text.length > 40_000 ? `${text.slice(0, 40_000)}\n… (cut)` : text;
}

function scalarText(v: Scalar): string | number | boolean | null {
  if (v === null) return null;
  if (isError(v)) return v.err;
  return v;
}

/** The answer to one read, as text for the model. */
export async function runTool(
  tool: AssistTool,
  args: {
    engine: WorkbookEngine;
    activeSheetId: string;
    tableColumns?: TableColumns;
    /** Waits for table answers the lakehouse is still computing. */
    settle?: () => Promise<void>;
  },
): Promise<string> {
  const { engine } = args;
  const sheetName =
    "sheet" in tool && tool.sheet ? tool.sheet : engine.sheet(args.activeSheetId)?.name;
  const sheetId = sheetName ? engine.sheetIdByName(sheetName) : undefined;
  if (!sheetId && tool.tool !== "find")
    return JSON.stringify({ error: `No sheet named ${JSON.stringify(sheetName)}` });
  const sheet = sheetId ? engine.sheet(sheetId) : undefined;
  switch (tool.tool) {
    case "read_range": {
      if (sheet?.kind === "table")
        return JSON.stringify({
          error: `${sheet.name} is a table sheet; read it with evaluate, e.g. =SUM(${sheet.name}[column]), or describe_sheet`,
        });
      const r = parseRangeA1(tool.range.replace(/\$/g, "").toUpperCase());
      if (!r) return JSON.stringify({ error: `"${tool.range}" is not a range such as A1:D20` });
      const cells = (r.r1 - r.r0 + 1) * (r.c1 - r.c0 + 1);
      if (cells > MAX_READ_CELLS)
        return JSON.stringify({
          error: `${tool.range} is ${cells} cells; read at most ${MAX_READ_CELLS} at a time, or compute over it with evaluate`,
        });
      const rows: string[][] = [];
      for (let row = r.r0; row <= r.r1; row++) {
        const line: string[] = [];
        for (let col = r.c0; col <= r.c1; col++) line.push(shown(engine, sheetId!, row, col));
        rows.push(line);
      }
      return JSON.stringify({ sheet: sheet?.name, range: tool.range, rows });
    }
    case "evaluate": {
      const formula = tool.formula.startsWith("=") ? tool.formula : `=${tool.formula}`;
      let v: Value = engine.evaluateAt(sheetId!, 0, 0, formula, { array: true });
      // A formula over a table sheet is answered by the lakehouse; wait for it.
      for (let i = 0; i < 20 && isBusy(v) && args.settle; i++) {
        await args.settle();
        v = engine.evaluateAt(sheetId!, 0, 0, formula, { array: true });
      }
      if (isMatrix(v)) {
        const rows = v.slice(0, 200).map((line) => line.slice(0, 50).map(scalarText));
        return JSON.stringify({
          formula,
          value: rows,
          ...(v.length > 200 ? { note: `first 200 of ${v.length} rows` } : {}),
        });
      }
      return JSON.stringify({
        formula,
        value: scalarText(v),
        ...(isError(v) && v.detail ? { detail: v.detail } : {}),
      });
    }
    case "describe_sheet": {
      if (sheet?.kind === "table")
        return JSON.stringify({
          sheet: sheet.name,
          kind: "table",
          columns: args.tableColumns?.[sheet.name] ?? [],
          refer: `${sheet.name}[column]`,
        });
      const d = describeGrid(engine, sheetId!, 8);
      return JSON.stringify({ sheet: sheet?.name, kind: "grid", ...d, header: d.header + 1 });
    }
    case "find": {
      const needle = tool.text.toLowerCase();
      const hits: { sheet: string; cell: string; text: string }[] = [];
      const sheets = tool.sheet
        ? engine.listSheets().filter((s) => s.name.toLowerCase() === tool.sheet!.toLowerCase())
        : engine.listSheets();
      for (const s of sheets) {
        if (s.kind !== "grid") continue;
        const used = engine.used(s.id);
        for (let r = 0; r < used.rows && hits.length < 50; r++)
          for (let c = 0; c < used.cols && hits.length < 50; c++) {
            const t = shown(engine, s.id, r, c);
            if (t && t.toLowerCase().includes(needle))
              hits.push({ sheet: s.name, cell: a1(r, c), text: t.slice(0, 80) });
          }
      }
      return JSON.stringify({
        text: tool.text,
        hits,
        ...(hits.length >= 50 ? { note: "first 50" } : {}),
      });
    }
  }
}

function isBusy(v: Value): boolean {
  return !isMatrix(v) && isError(v) && v.err === "#BUSY!";
}
