// Resizing and fitting whole columns and rows at once (R497).
//
// FOUND IN R497: with the whole sheet selected (Select All, Ctrl+A), dragging
// a column's edge changed that one column, and the same for a row — Excel and
// Google Sheets resize every selected column. Double-click to fit had the same
// shape. These pin the rule (which columns a drag speaks for), the keyboard
// selections that make whole columns and rows, the selection staying whole as
// the grid grows, and the fit leaving empty columns alone.
import { describe, expect, it } from "vitest";

import { fitColumnWidths } from "@/components/sheets/fit";
import type { RangeAddr } from "@/lib/sheets/a1";
import {
  growWithExtent,
  isWholeColumns,
  isWholeRows,
  resizeSpan,
  selRange,
  selectWholeColumns,
  selectWholeRows,
  type Selection,
} from "@/lib/sheets/selection";

const extent = { rows: 1000, cols: 52 };
const range = (r0: number, c0: number, r1: number, c1: number): RangeAddr => ({ r0, c0, r1, c1 });
const all = range(0, 0, extent.rows - 1, extent.cols - 1);

describe("resizeSpan: which columns a header edge speaks for", () => {
  it("every column when the whole sheet is selected", () => {
    expect(resizeSpan(all, 3, "cols", extent)).toEqual([0, 51]);
    expect(resizeSpan(all, 7, "rows", extent)).toEqual([0, 999]);
  });

  it("every selected column when whole columns are selected and the edge is one of theirs", () => {
    const bd = range(0, 1, extent.rows - 1, 3); // B:D by their headers
    expect(resizeSpan(bd, 2, "cols", extent)).toEqual([1, 3]);
  });

  it("only the dragged column when its edge is outside the selected columns", () => {
    const bd = range(0, 1, extent.rows - 1, 3);
    expect(resizeSpan(bd, 6, "cols", extent)).toEqual([6, 6]);
  });

  it("only the dragged column when the selection is cells, not whole columns", () => {
    // A1:C10 crosses column B, but nobody asked to resize A and C.
    expect(resizeSpan(range(0, 0, 9, 2), 1, "cols", extent)).toEqual([1, 1]);
  });

  it("rows follow the same rule against whole rows", () => {
    const rows3to5 = range(2, 0, 4, extent.cols - 1);
    expect(resizeSpan(rows3to5, 3, "rows", extent)).toEqual([2, 4]);
    expect(resizeSpan(rows3to5, 9, "rows", extent)).toEqual([9, 9]);
    // Whole COLUMNS selected says nothing about resizing rows.
    expect(resizeSpan(range(0, 1, extent.rows - 1, 3), 5, "rows", extent)).toEqual([5, 5]);
  });

  it("whole means reaching the grid's last row or column", () => {
    expect(isWholeColumns(range(0, 0, 998, 0), extent.rows)).toBe(false);
    expect(isWholeColumns(range(0, 0, 999, 0), extent.rows)).toBe(true);
    expect(isWholeRows(range(4, 0, 4, 51), extent.cols)).toBe(true);
    expect(isWholeRows(range(4, 1, 4, 51), extent.cols)).toBe(false);
  });
});

describe("Ctrl+Space and Shift+Space", () => {
  const sel: Selection = { anchor: { row: 4, col: 2 }, focus: { row: 6, col: 3 } };

  it("Ctrl+Space selects the selection's whole columns", () => {
    const s = selectWholeColumns(sel, extent.rows);
    expect(selRange(s)).toEqual(range(0, 2, 999, 3));
    expect(isWholeColumns(selRange(s), extent.rows)).toBe(true);
    expect(s.scroll).toBe("none");
  });

  it("Shift+Space selects the selection's whole rows", () => {
    const s = selectWholeRows(sel, extent.cols);
    expect(selRange(s)).toEqual(range(4, 0, 6, 51));
    expect(isWholeRows(selRange(s), extent.cols)).toBe(true);
  });
});

describe("growWithExtent: a whole selection stays whole as the grid grows", () => {
  const grown = { rows: 2000, cols: 78 };

  it("Select All grows both ways", () => {
    const s: Selection = { anchor: { row: 0, col: 0 }, focus: { row: 999, col: 51 } };
    expect(selRange(growWithExtent(s, extent, grown))).toEqual(range(0, 0, 1999, 77));
  });

  it("whole columns grow down, and keep their columns", () => {
    const s: Selection = { anchor: { row: 0, col: 2 }, focus: { row: 999, col: 4 } };
    const g = growWithExtent(s, extent, grown);
    expect(selRange(g)).toEqual(range(0, 2, 1999, 4));
    expect(g.anchor).toEqual({ row: 0, col: 2 }); // the active cell does not move
  });

  it("leaves a block of cells, and an unchanged grid, alone", () => {
    const s: Selection = { anchor: { row: 3, col: 1 }, focus: { row: 999, col: 2 } };
    expect(growWithExtent(s, extent, grown)).toBe(s);
    const w: Selection = { anchor: { row: 0, col: 0 }, focus: { row: 999, col: 51 } };
    expect(growWithExtent(w, extent, extent)).toBe(w);
  });
});

describe("fitColumnWidths", () => {
  // A 3-column sheet: A short, B long, C empty, D beyond what is used.
  const cells: Record<string, string> = {
    "0,0": "id",
    "1,0": "7",
    "0,1": "A much longer heading than the rest",
    "1,1": "x",
  };
  const engine = {
    used: () => ({ rows: 2, cols: 3 }),
    getInput: (_t: string, r: number, c: number) =>
      cells[`${r},${c}`] === undefined ? undefined : { i: cells[`${r},${c}`] },
    getValue: (_t: string, r: number, c: number) => cells[`${r},${c}`] ?? null,
  };
  const fit = (c0: number, c1: number) =>
    fitColumnWidths({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      engine: engine as any,
      tabId: "t",
      c0,
      c1,
      merges: [],
      baseFont: "sans-serif",
    });

  it("fits every column in the span that has text, wider text wider", () => {
    const w = fit(0, 1);
    expect(Object.keys(w)).toEqual(["0", "1"]);
    expect(w[1]).toBeGreaterThan(w[0]);
  });

  it("leaves empty columns out, so fitting the whole sheet does not shrink them", () => {
    expect(Object.keys(fit(0, 51))).toEqual(["0", "1"]);
    expect(fit(2, 3)).toEqual({});
  });

  it("does not fit text a merge spans", () => {
    const w = fitColumnWidths({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      engine: engine as any,
      tabId: "t",
      c0: 1,
      c1: 1,
      merges: [range(0, 1, 0, 2)],
      baseFont: "sans-serif",
    });
    // Only "x" counts now, so B fits narrower than with its heading.
    expect(w[1]).toBeLessThan(fit(1, 1)[1]);
  });
});
