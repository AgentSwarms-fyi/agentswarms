// Paste Special (R159), as Excel's. Before, the cell's menu had Paste, Paste
// values only and Paste formatting only: no way to turn a column into a row
// (Transpose), add a copied column into another (Operation), paste around
// blanks, or paste formulas, notes or values with their number formats alone.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseRangeA1 } from "@/lib/sheets/a1";
import { WorkbookEngine } from "@/lib/sheets/engine";
import {
  pasteSpecialEdits,
  pasteTarget,
  type CopiedCell,
  type PasteSpecialOptions,
} from "@/lib/sheets/pasteSpecial";
import type { Scalar } from "@/lib/sheets/formula/values";

const src = (p: string) => readFileSync(p, "utf8");
const opts = (o: Partial<PasteSpecialOptions>): PasteSpecialOptions => ({
  what: "all",
  operation: "none",
  skipBlanks: false,
  transpose: false,
  ...o,
});

// Copied: A1:B2 = [10, =A1*2] / [(blank), "x" with a note and a format].
const copied: {
  range: ReturnType<typeof parseRangeA1> & object;
  inputs: CopiedCell[][];
  values: Scalar[][];
} = {
  range: parseRangeA1("A1:B2")!,
  inputs: [
    [{ i: "10", f: "0.00" }, { i: "=A1*2" }],
    [undefined, { i: "x", n: "a note", s: { b: true } }],
  ],
  values: [
    [10, 20],
    [null, "x"],
  ],
};
const empty = () => ({ input: "", value: null as Scalar });

describe("where the cells land", () => {
  it("as copied, or rows and columns swapped", () => {
    expect(pasteTarget({ row: 5, col: 2 }, 0, 1, false)).toEqual({ row: 5, col: 3 });
    expect(pasteTarget({ row: 5, col: 2 }, 0, 1, true)).toEqual({ row: 6, col: 2 });
  });
});

describe("what is pasted", () => {
  const at = { row: 4, col: 2 }; // C5
  it("All: input, formats, style, link and note; formulas move with the cell", () => {
    const e = pasteSpecialEdits(copied, at, opts({}), empty);
    expect(e.find((x) => x.row === 4 && x.col === 3)?.input).toBe("=C5*2");
    expect(e.find((x) => x.row === 4 && x.col === 2)).toMatchObject({
      input: "10",
      format: "0.00",
    });
    expect(e.find((x) => x.row === 5 && x.col === 3)).toMatchObject({
      note: "a note",
      style: { b: true },
    });
  });
  it("Formulas: the formula, the target's formats kept", () => {
    const e = pasteSpecialEdits(copied, at, opts({ what: "formulas" }), empty);
    const f = e.find((x) => x.row === 4 && x.col === 2)!;
    expect(f.input).toBe("10");
    expect("format" in f).toBe(false);
  });
  it("Values: what the cells showed, as literals; with number formats when asked", () => {
    const v = pasteSpecialEdits(copied, at, opts({ what: "values" }), empty);
    expect(v.find((x) => x.row === 4 && x.col === 3)?.input).toBe("20");
    expect("format" in v.find((x) => x.row === 4 && x.col === 2)!).toBe(false);
    const vf = pasteSpecialEdits(copied, at, opts({ what: "values_formats" }), empty);
    expect(vf.find((x) => x.row === 4 && x.col === 2)).toMatchObject({
      input: "10",
      format: "0.00",
    });
  });
  it("Formats and Notes leave what the target holds", () => {
    const held = () => ({ input: "keep", value: "keep" as Scalar });
    const f = pasteSpecialEdits(copied, at, opts({ what: "formats" }), held);
    expect(f.every((x) => x.input === "keep")).toBe(true);
    expect(f.find((x) => x.row === 5 && x.col === 3)?.style).toEqual({ b: true });
    const n = pasteSpecialEdits(copied, at, opts({ what: "notes" }), held);
    expect(n.find((x) => x.row === 5 && x.col === 3)).toMatchObject({
      input: "keep",
      note: "a note",
    });
  });
  it("Skip blanks leaves the target of a blank copied cell alone", () => {
    const e = pasteSpecialEdits(copied, at, opts({ skipBlanks: true }), empty);
    expect(e.some((x) => x.row === 5 && x.col === 2)).toBe(false);
    expect(e.length).toBe(3);
  });
  it("Transpose: the row becomes a column, formulas moved to where they land", () => {
    const e = pasteSpecialEdits(copied, at, opts({ transpose: true }), empty);
    // B1 (=A1*2) lands at C6 (row 5, col 2): its reference moves by (+5, +1).
    expect(e.find((x) => x.row === 5 && x.col === 2)?.input).toBe("=B6*2");
    expect(e.find((x) => x.row === 4 && x.col === 3)?.input).toBe("");
  });
});

describe("an operation with what is there", () => {
  const at = { row: 0, col: 3 };
  const one = (input: string, value: Scalar) => ({
    range: parseRangeA1("A1")!,
    inputs: [[{ i: input }]] as CopiedCell[][],
    values: [[value]],
  });
  const run = (
    op: PasteSpecialOptions["operation"],
    here: { input: string; value: Scalar },
    v = 5,
  ) => pasteSpecialEdits(one(String(v), v), at, opts({ operation: op }), () => here);
  it("adds, subtracts, multiplies and divides a number into a number", () => {
    expect(run("add", { input: "10", value: 10 })[0].input).toBe("15");
    expect(run("subtract", { input: "10", value: 10 })[0].input).toBe("5");
    expect(run("multiply", { input: "10", value: 10 })[0].input).toBe("50");
    expect(run("divide", { input: "10", value: 10 })[0].input).toBe("2");
  });
  it("a blank target is 0; a formula target keeps its formula, combined", () => {
    expect(run("add", { input: "", value: null })[0].input).toBe("5");
    expect(run("multiply", { input: "=SUM(A1:A3)", value: 6 })[0].input).toBe("=(SUM(A1:A3))*5");
  });
  it("dividing by zero shows Excel's #DIV/0!, not a number", () => {
    const e = run("divide", { input: "10", value: 10 }, 0);
    const engine = new WorkbookEngine([{ id: "s", name: "S", grid: { cells: {} } }]);
    engine.setInputs("s", e);
    expect(engine.getValue("s", 0, 3)).toMatchObject({ err: "#DIV/0!" });
  });
  it("text, on either side, leaves the cell as it is; the target's formats are kept", () => {
    expect(run("add", { input: "abc", value: "abc" })).toEqual([]);
    expect(
      pasteSpecialEdits(one("x", "x"), at, opts({ operation: "add" }), () => ({
        input: "1",
        value: 1,
      })),
    ).toEqual([]);
    expect(Object.keys(run("add", { input: "10", value: 10 })[0]).sort()).toEqual([
      "col",
      "input",
      "row",
    ]);
  });
});

describe("in the editor", () => {
  const ed = src("src/components/sheets/WorkbookEditor.tsx");
  it("Ctrl+Alt+V and the cell's menu open it", () => {
    expect(ed).toMatch(
      /if \(mod && e\.altKey && \(e\.key === "v" \|\| e\.key === "V"\)\) \{\s*\/\/[^\n]*\n\s*e\.preventDefault\(\);\s*openPasteSpecial\(\);/,
    );
    expect(ed).toMatch(/item\("Paste special…", actions\.pasteSpecial\)/);
  });
  it("from a copy made here, not a cut, and within the sheet; one undo step", () => {
    expect(ed).toMatch(
      /if \(!clip\.current\) return void toast\.error\("Copy cells in this workbook first"\);\s*\/\/[^\n]*\n\s*if \(clip\.current\.cut\)/,
    );
    expect(ed).toMatch(/\.filter\(\(e\) => e\.row < MAX_ROWS && e\.col < MAX_COLS\);/);
    expect(ed).toMatch(/wb\.applyEdits\(tabId, edits\);\s*const h = c\.inputs\.length;/);
  });
  it("the keyboard goes back to the grid once the dialog has gone, for Ctrl+Z", () => {
    expect(ed).toMatch(/doPasteSpecial\(at, opts\);\s*afterDialog\(\);/);
    expect(ed).toMatch(/setPasteSpecialAt\(null\);\s*afterDialog\(\);\s*\}\}\s*onPaste=/);
  });
});
