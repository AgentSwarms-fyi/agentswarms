// Paste Special, as Excel's (R159): what of the copied cells to paste, an
// arithmetic operation with what is there, blanks skipped, rows and columns
// swapped. Worked out as cell edits, so the editor applies them as one undo
// step like any paste.

import type { RangeAddr } from "./a1";
import type { CellStyle } from "./engine";
import { shiftFormula } from "./formula/shift";
import { isError, type Scalar } from "./formula/values";

export type PasteWhat = "all" | "formulas" | "values" | "values_formats" | "formats" | "notes";
export type PasteOperation = "none" | "add" | "subtract" | "multiply" | "divide";

export type PasteSpecialOptions = {
  what: PasteWhat;
  operation: PasteOperation;
  skipBlanks: boolean;
  transpose: boolean;
};

/** A copied cell, as the editor's clipboard holds it. */
export type CopiedCell =
  { i: string; f?: string; s?: CellStyle; l?: string; n?: string } | undefined;

export type PasteEdit = {
  row: number;
  col: number;
  input: string;
  format?: string | null;
  style?: CellStyle | null;
  link?: string | null;
  note?: string | null;
};

const OP: Record<Exclude<PasteOperation, "none">, (a: number, b: number) => number> = {
  add: (a, b) => a + b,
  subtract: (a, b) => a - b,
  multiply: (a, b) => a * b,
  divide: (a, b) => a / b,
};
const SIGN: Record<Exclude<PasteOperation, "none">, string> = {
  add: "+",
  subtract: "-",
  multiply: "*",
  divide: "/",
};

/** A value as typed input that reads back as the same value (Paste Values). */
export function literalText(v: Scalar): string {
  if (v === null) return "";
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (isError(v) || v === "") return "";
  // Text that would read as a number, a formula or a boolean stays text.
  return /^[=+\-@]|^(true|false)$/i.test(v) || Number.isFinite(Number(v.replace(/[,$%]/g, "")))
    ? `'${v}`
    : v;
}

/** Where a copied cell lands: across becomes down when transposed. */
export function pasteTarget(
  at: { row: number; col: number },
  dr: number,
  dc: number,
  transpose: boolean,
): { row: number; col: number } {
  return transpose
    ? { row: at.row + dc, col: at.col + dr }
    : { row: at.row + dr, col: at.col + dc };
}

/**
 * The edits of a Paste Special. `dest` reads what a target cell holds now
 * (its typed input and value), for an operation and for keeping what the
 * chosen part leaves alone.
 */
export function pasteSpecialEdits(
  copied: { range: RangeAddr; inputs: CopiedCell[][]; values: Scalar[][] },
  at: { row: number; col: number },
  opts: PasteSpecialOptions,
  dest: (row: number, col: number) => { input: string; value: Scalar },
): PasteEdit[] {
  const edits: PasteEdit[] = [];
  copied.inputs.forEach((line, dr) =>
    line.forEach((cell, dc) => {
      const value = copied.values[dr]?.[dc] ?? null;
      const blank = (!cell || cell.i === "") && (value === null || value === "");
      if (opts.skipBlanks && blank) return;
      const to = pasteTarget(at, dr, dc, opts.transpose);
      const here = dest(to.row, to.col);
      const src = { row: copied.range.r0 + dr, col: copied.range.c0 + dc };
      const typed = cell?.i ?? "";
      const moved = typed.startsWith("=")
        ? shiftFormula(typed, to.row - src.row, to.col - src.col)
        : typed;

      // The part pasted, before any operation.
      let input: string;
      switch (opts.what) {
        case "formats":
          edits.push({ ...to, input: here.input, format: cell?.f ?? null, style: cell?.s ?? null });
          return;
        case "notes":
          edits.push({ ...to, input: here.input, note: cell?.n ?? null });
          return;
        case "values":
        case "values_formats":
          input = literalText(value);
          break;
        default:
          input = moved;
      }

      if (opts.operation !== "none") {
        // Only a number combines; anything else leaves the cell as it is.
        if (typeof value !== "number") return;
        const op = opts.operation;
        if (here.input.startsWith("=")) {
          input = `=(${here.input.slice(1)})${SIGN[op]}${value}`;
        } else if (here.value === null || typeof here.value === "number") {
          const a = here.value ?? 0;
          input = op === "divide" && value === 0 ? `=${a}/0` : String(OP[op](a, value));
        } else return;
        // Excel keeps the target's formats when combining.
        edits.push({ ...to, input });
        return;
      }

      if (opts.what === "all") {
        edits.push({
          ...to,
          input,
          format: cell?.f ?? null,
          style: cell?.s ?? null,
          link: cell?.l ?? null,
          note: cell?.n ?? null,
        });
      } else if (opts.what === "values_formats") {
        edits.push({ ...to, input, format: cell?.f ?? null });
      } else {
        // Formulas, or values: the target keeps its formats, links and note.
        edits.push({ ...to, input });
      }
    }),
  );
  return edits;
}
