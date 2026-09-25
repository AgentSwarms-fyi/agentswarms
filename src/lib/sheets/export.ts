// A grid range as a table: the first row names the columns, each column gets
// the type its values have, and the values are what the sheet computed (a
// formula's answer, not its text). Used to save a range to the lakehouse.

import type { RangeAddr } from "./a1";
import { cellView, effectiveFormat } from "./cellView";
import type { CellInput } from "./engine";
import { isDateFormat } from "./format";
import { isError, serialParts, type Scalar } from "./formula/values";

export type ExportType = "DOUBLE" | "BIGINT" | "VARCHAR" | "BOOLEAN" | "DATE" | "TIMESTAMP";

export type ExportColumn = { header: string; name: string; type: ExportType };

export type ExportCell = string | number | boolean | null;

/** "Unit Price ($)" → "unit_price": a column name any engine accepts unquoted. */
export function columnIdentifier(header: string, index: number, taken: Set<string>): string {
  let n = header
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
  if (!n) n = `column_${index + 1}`;
  if (/^[0-9]/.test(n)) n = `c_${n}`;
  let out = n;
  let k = 2;
  while (taken.has(out)) out = `${n}_${k++}`;
  taken.add(out);
  return out;
}

const pad = (n: number) => String(n).padStart(2, "0");

function isoDate(serial: number): string {
  const p = serialParts(serial);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

function isoDateTime(serial: number): string {
  const p = serialParts(serial);
  return `${p.y}-${pad(p.m)}-${pad(p.d)} ${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}`;
}

/** The type a column's values share; text when they share none. */
export function inferType(values: { v: Scalar; input: CellInput | undefined }[]): ExportType {
  const present = values.filter(({ v }) => v !== null && v !== "" && !isError(v));
  if (!present.length) return "VARCHAR";
  if (present.every(({ v }) => typeof v === "boolean")) return "BOOLEAN";
  if (present.every(({ v }) => typeof v === "number")) {
    const dated = present.map(({ input }) => effectiveFormat(input));
    if (dated.every((f) => f && isDateFormat(f))) {
      const timed = present.some(({ v }) => !Number.isInteger(v as number));
      return timed ? "TIMESTAMP" : "DATE";
    }
    return present.every(({ v }) => Number.isSafeInteger(v as number)) ? "BIGINT" : "DOUBLE";
  }
  return "VARCHAR";
}

/** One value as the column's type will store it; null when it does not fit. */
export function exportValue(v: Scalar, input: CellInput | undefined, type: ExportType): ExportCell {
  if (v === null || v === "" || isError(v)) return null;
  switch (type) {
    case "BOOLEAN":
      return typeof v === "boolean" ? v : null;
    case "BIGINT":
    case "DOUBLE":
      return typeof v === "number" ? v : null;
    case "DATE":
      return typeof v === "number" ? isoDate(v) : null;
    case "TIMESTAMP":
      return typeof v === "number" ? isoDateTime(v) : null;
    default:
      // Text: what the cell shows, so a formatted number keeps its look.
      return typeof v === "string" ? v : cellView(v, input).text;
  }
}

/**
 * A range as columns and rows. `get` reads a cell's value and input; the
 * first row of the range is the header.
 */
export function rangeToTable(
  range: RangeAddr,
  get: (row: number, col: number) => { v: Scalar; input: CellInput | undefined },
): { columns: ExportColumn[]; rows: ExportCell[][] } {
  const taken = new Set<string>();
  const columns: ExportColumn[] = [];
  for (let c = range.c0; c <= range.c1; c++) {
    const head = get(range.r0, c);
    const header =
      head.v === null || isError(head.v)
        ? ""
        : typeof head.v === "string"
          ? head.v
          : String(head.v);
    const values = [];
    for (let r = range.r0 + 1; r <= range.r1; r++) values.push(get(r, c));
    columns.push({
      header,
      name: columnIdentifier(header, c - range.c0, taken),
      type: inferType(values),
    });
  }
  const rows = exportRows(range, get, columns);
  return { columns, rows };
}

/** The data rows of a range, each value as its column's (possibly changed) type stores it. */
export function exportRows(
  range: RangeAddr,
  get: (row: number, col: number) => { v: Scalar; input: CellInput | undefined },
  columns: Pick<ExportColumn, "type">[],
): ExportCell[][] {
  const rows: ExportCell[][] = [];
  for (let r = range.r0 + 1; r <= range.r1; r++) {
    const row = columns.map((col, i) => {
      const cell = get(r, range.c0 + i);
      return exportValue(cell.v, cell.input, col.type);
    });
    // A row with nothing in it is the range running past the data.
    if (row.some((x) => x !== null)) rows.push(row);
  }
  return rows;
}
