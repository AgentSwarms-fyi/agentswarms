// Column widths that fit the text shown in them: the header edge's
// double-click and the header menu's "Fit to data" (R497).
import { colLetters, type RangeAddr } from "@/lib/sheets/a1";
import { cellView } from "@/lib/sheets/cellView";
import type { CellInput, WorkbookEngine } from "@/lib/sheets/engine";
import { CELL_PAD_X } from "@/lib/sheets/layout";
import { mergeAt } from "@/lib/sheets/merge";
import { fontPx, fontStack } from "@/lib/sheets/style";

import { measureText } from "./measure";

/** A cell's CSS font, at a zoom; `extra` is what a rule (conditional format) adds. */
export function cellFont(
  s: CellInput["s"],
  z: number,
  base: string,
  extra?: { b?: boolean; i?: boolean },
): string {
  const italic = (extra?.i ?? s?.i) ? "italic " : "";
  const weight = (extra?.b ?? s?.b) ? "600 " : "";
  return `${italic}${weight}${fontPx(s?.sz, z)}px ${fontStack(s?.font) ?? base}`;
}

/**
 * The width each of columns c0..c1 needs for its widest shown text, read
 * from the first 2,000 rows in use. A column with nothing to show is left
 * out, so fitting a whole sheet does not shrink its empty columns to slivers
 * (Excel leaves an empty column's width as it was).
 */
export function fitColumnWidths({
  engine,
  tabId,
  c0,
  c1,
  merges,
  baseFont,
}: {
  engine: Pick<WorkbookEngine, "used" | "getInput" | "getValue">;
  tabId: string;
  c0: number;
  c1: number;
  merges: RangeAddr[];
  baseFont: string;
}): Record<number, number> {
  const used = engine.used(tabId);
  const out: Record<number, number> = {};
  const last = Math.min(c1, used.cols - 1);
  const rows = Math.min(used.rows, 2000);
  for (let col = c0; col <= last; col++) {
    let max = 0;
    for (let r = 0; r < rows; r++) {
      const input = engine.getInput(tabId, r, col);
      const v = cellView(engine.getValue(tabId, r, col), input);
      if (!v.text || mergeAt(merges, r, col)) continue;
      max = Math.max(max, measureText(v.text, cellFont(input?.s, 1, baseFont)));
    }
    if (max === 0) continue;
    max = Math.max(max, colLetters(col).length * 8);
    out[col] = Math.max(24, Math.min(800, Math.ceil(max + CELL_PAD_X * 2 + 4)));
  }
  return out;
}
