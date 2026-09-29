// Data → Text to Columns, as Excel's (R157): each cell of one column split
// at its delimiters into the cells to its right. A piece becomes a cell as a
// CSV's field does (csvCell): 1,200 a number, 2026-03-08 a date, and text
// that would read as a formula stays text, so splitting never runs anything.

import { csvCell } from "./csv";
import type { CellInput } from "./engine";

export type SplitOptions = {
  /** The characters that split: any of them, e.g. [",", ";"]. */
  delimiters: string[];
  /** Two delimiters in a row make one split, not an empty piece between. */
  consecutive: boolean;
  /** A piece in these quotes keeps its delimiters: "Lisbon, PT". */
  qualifier: '"' | "'" | null;
};

/** Most columns one cell may split into. */
export const MAX_SPLIT = 1000;

/** One cell's text, split. */
export function splitText(text: string, opts: SplitOptions): string[] {
  const delims = new Set(opts.delimiters.filter((d) => d.length === 1));
  if (!delims.size) return [text];
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  let lastWasDelim = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (opts.qualifier && ch === opts.qualifier) {
      // A doubled qualifier inside quotes is the character itself.
      if (quoted && text[i + 1] === opts.qualifier) {
        cur += ch;
        i++;
      } else quoted = !quoted;
      lastWasDelim = false;
      continue;
    }
    if (!quoted && delims.has(ch)) {
      if (!(opts.consecutive && lastWasDelim)) out.push(cur);
      cur = "";
      lastWasDelim = true;
      if (out.length >= MAX_SPLIT - 1) {
        // The rest stays whole in the last piece.
        cur = text.slice(i + 1);
        lastWasDelim = false;
        break;
      }
      continue;
    }
    cur += ch;
    lastWasDelim = false;
  }
  if (!(opts.consecutive && lastWasDelim && cur === "")) out.push(cur);
  return out;
}

/** Every cell's pieces, and the widest: what the dialog previews and how far the split reaches. */
export function splitColumn(
  texts: string[],
  opts: SplitOptions,
): { rows: string[][]; width: number } {
  const rows = texts.map((t) => splitText(t, opts));
  return { rows, width: rows.reduce((w, r) => Math.max(w, r.length), 1) };
}

/**
 * The edits that put each row's pieces in the cells from `dest` rightwards,
 * as wide as the widest row (a shorter row's other cells empty). A piece is
 * a cell as a CSV field is.
 */
export function splitEdits(
  rows: string[][],
  width: number,
  dest: { row: number; col: number },
): { row: number; col: number; input: string; format: string | null }[] {
  const out: { row: number; col: number; input: string; format: string | null }[] = [];
  rows.forEach((pieces, r) => {
    for (let k = 0; k < width; k++) {
      const cell: CellInput | undefined = pieces[k] === undefined ? undefined : csvCell(pieces[k]);
      out.push({
        row: dest.row + r,
        col: dest.col + k,
        input: cell?.i ?? "",
        format: cell?.f ?? null,
      });
    }
  });
  return out;
}
