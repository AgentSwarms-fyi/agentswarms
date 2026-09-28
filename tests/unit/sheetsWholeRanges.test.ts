// Whole columns (A:A) and whole rows (1:1) are Excel's full 1,048,576 rows and
// 16,384 columns, however little of them a sheet uses. The engine reads only
// the used part (a SUM over A:A must not walk a million cells), so the
// functions that see the blank rest say so themselves. FOUND IN R140 while
// checking the Phase I sample against openpyxl: COUNTIFS(Orders!L:L,
// "<>Returned") counted the header and none of the blanks Excel counts.
import { describe, expect, it } from "vitest";

import { MAX_COLS, MAX_ROWS } from "@/lib/sheets/a1";
import { WorkbookEngine } from "@/lib/sheets/engine";

// S: A1:A3 = a, x, b; B1:B2 = 1, 2. T: A1:A5 = a; B1 = 5, B5 = 7.
function engine() {
  return new WorkbookEngine([
    {
      id: "s",
      name: "S",
      kind: "grid",
      grid: {
        cells: {
          "0,0": { i: "a" },
          "1,0": { i: "x" },
          "2,0": { i: "b" },
          "0,1": { i: "1" },
          "1,1": { i: "2" },
        },
      },
    },
    {
      id: "t",
      name: "T",
      kind: "grid",
      grid: {
        cells: {
          "0,0": { i: "a" },
          "1,0": { i: "a" },
          "2,0": { i: "a" },
          "3,0": { i: "a" },
          "4,0": { i: "a" },
          "0,1": { i: "5" },
          "4,1": { i: "7" },
        },
      },
    },
  ]);
}
const at = (f: string) => engine().evaluateAt("s", 0, 5, f);

describe("R142: a formula whose answer is an empty cell shows 0, as in Excel", () => {
  const grid = (cells: Record<string, string>) =>
    new WorkbookEngine([
      {
        id: "g",
        name: "G",
        kind: "grid",
        grid: { cells: Object.fromEntries(Object.entries(cells).map(([k, i]) => [k, { i }])) },
      },
    ]);

  it("a reference, an INDEX past the data, and the gaps of a spilled range", () => {
    const e = grid({
      "0,0": "x",
      "2,0": "y",
      "0,1": "=A500",
      "1,1": "=INDEX(A:A,500)",
      "2,1": "=ISNUMBER(B1)",
      "3,1": '=IF(TRUE,"")',
      "0,3": "=A1:A3",
      "4,1": "=ISBLANK(A500)",
      "5,1": "=COUNTA(A1:A3)",
    });
    expect(e.getValue("g", 0, 1)).toBe(0);
    expect(e.getValue("g", 1, 1)).toBe(0);
    expect(e.getValue("g", 2, 1)).toBe(true);
    // Text that is empty is still text, not 0.
    expect(e.getValue("g", 3, 1)).toBe("");
    // A spill of A1:A3 shows the gap as 0.
    expect([0, 1, 2].map((r) => e.getValue("g", r, 3))).toEqual(["x", 0, "y"]);
    // Inside a formula the cell is still blank.
    expect(e.getValue("g", 4, 1)).toBe(true);
    expect(e.getValue("g", 5, 1)).toBe(2);
  });
});

describe("R140: whole columns and rows are as long as Excel's", () => {
  it("their size", () => {
    expect(at("=ROWS(A:A)")).toBe(MAX_ROWS);
    expect(at("=COLUMNS(1:1)")).toBe(MAX_COLS);
    expect(at("=ROWS(1:3)")).toBe(3);
    expect(at("=COLUMNS(A:C)")).toBe(3);
    expect(at("=ROWS(A1:A10)")).toBe(10);
  });

  it("the blanks past the data count as blanks", () => {
    expect(at("=COUNTBLANK(A:A)")).toBe(MAX_ROWS - 3);
    expect(at("=COUNTBLANK(1:1)")).toBe(MAX_COLS - 2);
    expect(at('=COUNTIF(A:A,"<>x")')).toBe(MAX_ROWS - 1);
    expect(at('=COUNTIF(A:A,"")')).toBe(MAX_ROWS - 3);
    expect(at('=COUNTIF(A:A,"=")')).toBe(MAX_ROWS - 3);
    // A blank row counts for COUNTIFS only when every criterion takes a blank.
    expect(at('=COUNTIFS(A:A,"<>x",B:B,"")')).toBe(1 + MAX_ROWS - 3);
    expect(at('=COUNTIFS(A:A,"<>x",B:B,1)')).toBe(1);
    // Criteria that no blank meets are as before.
    expect(at('=COUNTIF(A:A,"x")')).toBe(1);
    expect(at('=COUNTIF(A:A,"<>")')).toBe(3);
    // A bounded range is exactly its cells.
    expect(at('=COUNTIF(A1:A10,"<>x")')).toBe(9);
  });

  it("INDEX past the used rows is an empty cell, and past the sheet is #REF!", () => {
    expect(at("=INDEX(A:A,3)")).toBe("b");
    expect(at("=INDEX(A:A,100)")).toBe(null);
    expect(at("=INDEX(A:B,100,2)")).toBe(null);
    expect(at(`=INDEX(A:A,${MAX_ROWS + 1})`)).toEqual({ err: "#REF!" });
    expect(at("=INDEX(A1:A3,4)")).toEqual({ err: "#REF!" });
  });

  it("whole columns of sheets used to different depths line up, as in Excel", () => {
    expect(at('=SUMIFS(T!B:B,A:A,"a")')).toBe(5);
    expect(at('=SUMIFS(B:B,T!A:A,"a")')).toBe(3);
    expect(at('=COUNTIFS(A:A,"a",T!A:A,"a")')).toBe(1);
    expect(at('=AVERAGEIFS(T!B:B,T!A:A,"a")')).toBe(6);
    // Blank rows add nothing to a sum or an average.
    expect(at('=SUMIF(A:A,"<>x",B:B)')).toBe(1);
    expect(at('=AVERAGEIF(A:A,"",B:B)')).toEqual({ err: "#DIV/0!" });
  });
});
