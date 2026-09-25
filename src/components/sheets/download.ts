// Downloading a workbook as Excel (.xlsx) or a sheet as CSV. Grid sheets go
// out as the editor holds them (unsaved edits included), each formula with
// its current value beside it; a table sheet goes out as the rows its view
// shows, read through the lakehouse (so the reader's grants apply) up to
// SHEETS_EXPORT_MAX_ROWS.

import type { WorkbookEngine } from "@/lib/sheets/engine";
import type { Scalar } from "@/lib/sheets/formula/values";
import type { TableConfig } from "@/lib/sheets/sql/tableQuery";
import type { ExportGridSheet, ExportTableSheet } from "@/lib/sheets/xlsx";
import type { TabMeta } from "./useWorkbook";

type TableRows = (args: { tab_id: string; config: TableConfig }) => Promise<
  | {
      ok: true;
      columns: { name: string; kind: string }[];
      rows: (string | number | boolean | null)[][];
      truncated: boolean;
      maxRows: number;
    }
  | { ok: false; error: string }
>;

const FORBIDDEN = '<>:"/\\|?*';

/** A file name from a workbook or sheet name: no characters a file system refuses. */
export function fileName(name: string, ext: string): string {
  // Characters a file system refuses, and control characters, become spaces.
  const cleaned = Array.from(name, (ch) =>
    ch.charCodeAt(0) < 32 || FORBIDDEN.includes(ch) ? " " : ch,
  ).join("");
  const base = cleaned.replace(/\s+/g, " ").trim() || "workbook";
  return `${base.slice(0, 120)}.${ext}`;
}

export function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** A date or timestamp from the lakehouse (ISO text) as a spreadsheet serial day. */
function serialOf(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const t = Date.parse(v.length === 10 ? `${v}T00:00:00Z` : v.endsWith("Z") ? v : `${v}Z`);
  return Number.isFinite(t) ? t / 86_400_000 + 25_569 : null;
}

async function tableSheet(
  tab: TabMeta,
  config: TableConfig,
  rowsFn: TableRows,
  notes: string[],
): Promise<ExportTableSheet> {
  const r = await rowsFn({ tab_id: tab.id, config });
  if (!r.ok) throw new Error(`${tab.name}: ${r.error}`);
  if (r.truncated) {
    notes.push(
      `${tab.name}: the first ${r.maxRows.toLocaleString()} rows (SHEETS_EXPORT_MAX_ROWS); save the whole table to the lakehouse instead`,
    );
  }
  const dated = r.columns.map((c) => c.kind === "date");
  const rows = r.rows.map((row) =>
    row.map((v, i) => (dated[i] ? (serialOf(v) ?? (v as Scalar)) : (v as Scalar))),
  );
  return {
    kind: "table",
    name: tab.name,
    columns: r.columns.map((c) => c.name),
    formats: r.columns.map((c) => (c.kind === "date" ? "yyyy-mm-dd" : undefined)),
    rows,
  };
}

/** Every sheet of the workbook, in tab order, as an .xlsx. Returns notes on what was cut short. */
export async function downloadXlsx(opts: {
  name: string;
  engine: WorkbookEngine;
  tabs: TabMeta[];
  tableConfigs: Record<string, TableConfig>;
  tableRows: TableRows;
}): Promise<string[]> {
  const { writeXlsx } = await import("@/lib/sheets/xlsx");
  const notes: string[] = [];
  const sheets: (ExportGridSheet | ExportTableSheet)[] = [];
  for (const tab of [...opts.tabs].sort((a, b) => a.position - b.position)) {
    if (tab.kind === "table") {
      const cfg = opts.tableConfigs[tab.id];
      if (cfg) sheets.push(await tableSheet(tab, cfg, opts.tableRows, notes));
      continue;
    }
    const grid = opts.engine.snapshot(tab.id);
    if (!grid) continue;
    sheets.push({
      kind: "grid",
      name: tab.name,
      grid,
      value: (r, c) => opts.engine.getValue(tab.id, r, c),
      spill: (r, c) => opts.engine.spillSize(tab.id, r, c),
    });
  }
  const buf = await writeXlsx(sheets);
  saveBlob(
    new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
    fileName(opts.name, "xlsx"),
  );
  return notes;
}

/** One sheet as CSV: a grid's used range as shown, or a table sheet's rows. */
export async function downloadCsv(opts: {
  workbook: string;
  tab: TabMeta;
  engine: WorkbookEngine;
  tableConfig?: TableConfig;
  tableRows: TableRows;
}): Promise<string[]> {
  const { BOM, gridToCsv } = await import("@/lib/sheets/csv");
  const { csvText } = await import("@/lib/exportData");
  const notes: string[] = [];
  let csv: string;
  if (opts.tab.kind === "table") {
    if (!opts.tableConfig) throw new Error("This table sheet has no settings");
    const t = await tableSheet(opts.tab, opts.tableConfig, opts.tableRows, notes);
    csv = `${csvText([t.columns, ...t.rows])}\r\n`;
  } else {
    const used = opts.engine.used(opts.tab.id);
    csv = gridToCsv(used.rows, used.cols, (r, c) => ({
      v: opts.engine.getValue(opts.tab.id, r, c),
      input: opts.engine.getInput(opts.tab.id, r, c),
    }));
  }
  // A byte-order mark, so Excel opens UTF-8 text (accents, ₹, 東京) correctly.
  saveBlob(
    new Blob([BOM, csv], { type: "text/csv;charset=utf-8" }),
    fileName(`${opts.workbook} - ${opts.tab.name}`, "csv"),
  );
  return notes;
}
