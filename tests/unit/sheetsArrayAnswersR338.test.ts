// A function's array answer in an older file's formula (R338).
//
// FOUND IN R337: typed in one cell without Ctrl+Shift+Enter, =LINEST(…),
// =TRANSPOSE(…) or =ROW(A2:A4) showed one value in the Excel that wrote it.
// Imported here they spilled, into #SPILL! beside a neighbour. Excel 365
// shows an @ in front of such a function. Microsoft's page on @ gives
// =INDEX(A1:A10,B1) as =@INDEX(A1:A10,B1) and =OFFSET(A1:A2,1,1) as
// =@OFFSET(A1:A2,1,1), with "a common exception ... if they're wrapped in a
// function that accepts an array or range (for example, SUM() or
// AVERAGE())". R162 gave a file's formulas the @ on ranges; this gives it on
// functions, and makes @ on a range INDEX, OFFSET or INDIRECT answers with
// take the cell in the formula's own row, as Excel's @ does.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import { WorkbookEngine, type GridData } from "@/lib/sheets/engine";
import { intersectionsForFile, withIntersections } from "@/lib/sheets/formula/implicit";
import { readXlsx, writeXlsx, type ImportResult } from "@/lib/sheets/xlsx";

const ranges =
  (...names: string[]) =>
  (n: string) =>
    names.includes(n.toLowerCase());
const at = (f: string, isRange = ranges()) => withIntersections(f, isRange);
const unchanged = (...fs: string[]) => fs.forEach((f) => expect(at(f), f).toBe(f));

describe("Microsoft's table of the @ Excel 365 adds to an older formula", () => {
  it("each row of the page's table", () => {
    unchanged("=SUM(A1:A10)", "=A1+A2");
    expect(at("=A1:A10")).toBe("=@A1:A10");
    expect(at("=INDEX(A1:A10,B1)")).toBe("=@INDEX(A1:A10,B1)");
    expect(at("=OFFSET(A1:A2,1,1)")).toBe("=@OFFSET(A1:A2,1,1)");
  });

  it("the page's exception: inside a function that takes an array or range", () => {
    unchanged(
      "=SUM(INDEX(A1:C3,0,2))",
      "=AVERAGE(OFFSET(A1:A2,1,1))",
      "=SUM(LINEST(B2:B7,A2:A7)*{9,1})",
      "=SUMPRODUCT((B2:B7>5000)*ROW(B2:B7))",
      "=MAX(TRANSPOSE(A2:A4))",
    );
    // INDEX's array is taken whole: LINEST inside it takes no @.
    expect(at("=INDEX(LINEST(B2:B7,A2:A7),1)")).not.toContain("@LINEST");
  });
});

describe("functions whose answer can be several values, where the cell takes it", () => {
  it("the functions whose answer is an array", () => {
    for (const f of [
      "LINEST(B2:B7,A2:A7)",
      "LOGEST(B2:B7,A2:A7)",
      "TREND(B2:B7,A2:A7,{7;8})",
      "GROWTH(B2:B7,A2:A7)",
      "TRANSPOSE(A2:A4)",
      "MMULT(A1:B2,C1:D2)",
      "MINVERSE(A1:B2)",
      "FREQUENCY(A1:A9,B1:B3)",
      "MODE.MULT(A1:A9)",
    ])
      expect(at(`=${f}`)).toBe(`=@${f}`);
  });

  it("ROW and COLUMN of several cells; of one cell, or none, they are one number", () => {
    expect(at("=ROW(A2:A4)")).toBe("=@ROW(A2:A4)");
    expect(at("=COLUMN(A1:C1)")).toBe("=@COLUMN(A1:C1)");
    expect(at("=ROW(Sales)", ranges("sales"))).toBe("=@ROW(Sales)");
    unchanged("=ROW()", "=ROW(A2)", "=COLUMN(C1)", "=ROW()-1");
  });

  it("INDEX, OFFSET and INDIRECT when what they pick can be several cells", () => {
    expect(at("=INDEX(A1:A10,0)")).toBe("=@INDEX(A1:A10,0)");
    expect(at("=INDEX(A1:C3,2)")).toBe("=@INDEX(A1:C3,2)");
    expect(at("=OFFSET(A1,1,1,3,1)")).toBe("=@OFFSET(A1,1,1,3,1)");
    expect(at("=INDIRECT(B1)")).toBe("=@INDIRECT(B1)");
    expect(at('=INDIRECT("A1:A3")')).toBe('=@INDIRECT("A1:A3")');
    // One cell by their own arguments: nothing to intersect.
    unchanged(
      "=INDEX(A1:A10,3)",
      "=INDEX(A1:C3,2,3)",
      "=OFFSET(A1,1,1)",
      "=OFFSET(A1,1,1,1,1)",
      '=INDIRECT("B2")',
    );
  });

  it("under an operator or a function of one value, the cell still takes it", () => {
    expect(at("=ABS(-LINEST(B2:B7,A2:A7))")).toBe("=ABS(-@LINEST(B2:B7,A2:A7))");
    expect(at("=LINEST(B2:B7,A2:A7)*2")).toBe("=@LINEST(B2:B7,A2:A7)*2");
    expect(at("=ROUND(TREND(B2:B7,A2:A7,7),0)")).toBe("=ROUND(@TREND(B2:B7,A2:A7,7),0)");
  });

  it("a range IF, IFERROR or CHOOSE passes on to the cell", () => {
    expect(at("=IF(A2>0,B2:B7,0)")).toBe("=IF(A2>0,@B2:B7,0)");
    expect(at("=IFERROR(1/0,B2:B7)")).toBe("=IFERROR(1/0,@B2:B7)");
    expect(at("=CHOOSE(2,A2:A7,B2:B7)")).toBe("=CHOOSE(2,@A2:A7,@B2:B7)");
    expect(at("=IF(TRUE,Sales,0)", ranges("sales"))).toBe("=IF(TRUE,@Sales,0)");
    // Not where SUM takes what IF answers with.
    expect(at("=SUM(IF(A2:A7>3,B2:B7,0))")).not.toContain("@B2:B7");
  });

  it("an @ already there is not doubled", () => {
    unchanged("=@LINEST(B2:B7,A2:A7)", "=@INDEX(A1:A10,B1)");
  });
});

describe("on the way out, a plain formula drops the @ older Excel never needed", () => {
  const out = (f: string, dynamic = false) => intersectionsForFile(f, dynamic);

  it("before such a function, or a range passed on to the cell", () => {
    for (const f of [
      "=LINEST(B2:B7,A2:A7)",
      "=INDEX(A1:A10,B1)",
      "=OFFSET(A1:A2,1,1)",
      "=ABS(-LINEST(B2:B7,A2:A7))",
      "=IF(A2>0,B2:B7,0)",
      "=ROW(A2:A4)",
      "=TRANSPOSE(A2:A4)",
    ])
      expect(out(at(f)), f).toBe(f);
  });

  it("kept as _xlfn.SINGLE where older Excel would read the formula otherwise", () => {
    // ABS(A1:A3) in an older formula is ABS of A1:A3's cell in its row, not of A1.
    expect(out("=@ABS(A1:A3)")).toBe("=_xlfn.SINGLE(ABS(A1:A3))");
    expect(out("=@(A1:A3*2)")).toBe("=_xlfn.SINGLE((A1:A3*2))");
    // A dynamic array formula keeps every @.
    expect(out("=@LINEST(B2:B7,A2:A7)", true)).toBe("=_xlfn.SINGLE(LINEST(B2:B7,A2:A7))");
  });
});

function engineOf(cells: Record<string, string>) {
  const grid: GridData = { cells: {} };
  const months = [1, 2, 3, 4, 5, 6];
  const sales = [3100, 4500, 4400, 5400, 7500, 8100];
  months.forEach((m, i) => (grid.cells[`${i + 1},0`] = { i: String(m) }));
  sales.forEach((s, i) => (grid.cells[`${i + 1},1`] = { i: String(s) }));
  for (const [key, i] of Object.entries(cells)) grid.cells[key] = { i };
  const e = new WorkbookEngine([{ id: "s", name: "Legacy", grid }]);
  e.recalcAll();
  return e;
}

describe("@ on the range INDEX, OFFSET or INDIRECT answers with", () => {
  it("takes the cell in the formula's own row, as from a range written out", () => {
    const e = engineOf({
      "4,5": "=@INDEX(A2:B7,0,2)",
      "7,5": "=@INDEX(A2:B7,0,2)",
      "2,6": "=@OFFSET(A2:A3,1,1)",
      "1,6": "=@OFFSET(A2:A3,1,1)",
      "5,7": '=@INDIRECT("B2:B7")',
    });
    // B5, B3 and B6; row 8 and row 2 are outside what was picked.
    expect(e.getValue("s", 4, 5)).toBe(5400);
    expect(e.getValue("s", 7, 5)).toEqual(expect.objectContaining({ err: "#VALUE!" }));
    expect(e.getValue("s", 2, 6)).toBe(4500);
    expect(e.getValue("s", 1, 6)).toEqual(expect.objectContaining({ err: "#VALUE!" }));
    expect(e.getValue("s", 5, 7)).toBe(7500);
  });

  it("from a row of a reference, the formula's own column", () => {
    // Row 3 of A2:B7 is A4:B4; in column B, B4.
    const e = engineOf({ "19,1": "=@INDEX(A2:B7,3,0)" });
    expect(e.getValue("s", 19, 1)).toBe(4400);
  });

  it("an array's top-left value, and one cell's value, as before", () => {
    const e = engineOf({
      "9,5": "=@LINEST(B2:B7,A2:A7)",
      "9,6": "=@ROW(A2:A4)",
      "9,7": "=@INDEX(A2:B7,2,2)",
    });
    expect(e.getValue("s", 9, 5)).toBeCloseTo(1000, 9);
    expect(e.getValue("s", 9, 6)).toBe(2);
    expect(e.getValue("s", 9, 7)).toBe(4500);
  });
});

describe("a file of such formulas (openpyxl-array-answers.xlsx)", () => {
  let file: ImportResult;
  let e: WorkbookEngine;
  beforeAll(async () => {
    const b = readFileSync(
      resolve(process.cwd(), "tests/fixtures/sheets/openpyxl-array-answers.xlsx"),
    );
    file = await readXlsx(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), {
      maxCells: 1000,
    });
    e = new WorkbookEngine([{ id: "s", name: "Legacy", grid: file.sheets[0].grid }]);
    e.recalcAll();
  }, 60_000);
  const cell = (a1: string) => {
    const col = a1.charCodeAt(0) - 65;
    const row = Number(a1.slice(1)) - 1;
    return { input: e.getInput("s", row, col)?.i, value: e.getValue("s", row, col), row, col };
  };
  const num = (a1: string) => {
    const v = cell(a1).value;
    expect(typeof v, `${a1}: ${JSON.stringify(v)}`).toBe("number");
    return Math.round((v as number) * 1e6) / 1e6;
  };

  it("computes as older Excel did, one value in each cell", () => {
    expect(["D2", "D3", "D4", "D5", "D6", "D7"].map(num)).toEqual([1000, 11000, 2000, 2, 18, 1]);
    expect(cell("D8").value).toEqual(expect.objectContaining({ err: "#VALUE!" }));
    expect(["D9", "D10", "D13", "D14"].map(num)).toEqual([1000, 9000, 13, 2]);
    expect(["F3", "F4", "F5", "F6"].map(num)).toEqual([4500, 5500, 5400, 7500]);
    // Nothing spills: the cell below TREND and beside LINEST are empty.
    for (const a of ["D2", "D5", "D7", "D10"]) {
      const { row, col } = cell(a);
      expect(e.spillSize("s", row, col), a).toBeUndefined();
    }
    expect(cell("D11").value).toBeNull();
    expect(cell("E2").value).toBeNull();
  });

  it("an array formula over D12:E12 keeps both values", () => {
    expect(["D12", "E12"].map(num)).toEqual([1000, 2000]);
  });

  it("shows the @ Excel 365 shows, and none where SUM or AVERAGE takes the answer", () => {
    expect(cell("D2").input).toBe("=@LINEST(B2:B7,A2:A7)");
    expect(cell("D3").input).toBe("=SUM(LINEST(B2:B7,A2:A7)*{9,1})");
    expect(cell("D5").input).toBe("=@ROW(A2:A4)");
    expect(cell("D6").input).toBe("=SUMPRODUCT((B2:B7>5000)*ROW(B2:B7))");
    expect(cell("D9").input).toBe("=ABS(-@LINEST(B2:B7,A2:A7))");
    expect(cell("D13").input).toBe("=ROW()");
    expect(cell("F3").input).toBe("=@OFFSET(A2:A3,1,1)");
    expect(cell("F4").input).toBe("=AVERAGE(OFFSET(A2,0,1,6,1))");
    expect(cell("F6").input).toBe("=IF(A2>0,@B2:B7,0)");
  });

  it("goes back out as it came in", async () => {
    const buf = await writeXlsx([
      {
        kind: "grid",
        name: "Legacy",
        grid: e.snapshot("s")!,
        value: (r, c) => e.getValue("s", r, c),
        spill: (r, c) => e.spillSize("s", r, c),
        arrayFormula: (r, c) => e.arrayFormula("s", r, c),
      },
    ]);
    const xml = strFromU8(unzipSync(new Uint8Array(buf))["xl/worksheets/sheet1.xml"]);
    expect(xml).toMatch(/<c r="D2"(?![^>]*cm=)[^>]*><f>LINEST\(B2:B7,A2:A7\)<\/f>/);
    expect(xml).toMatch(/<c r="D5"(?![^>]*cm=)[^>]*><f>ROW\(A2:A4\)<\/f>/);
    expect(xml).toMatch(/<c r="F6"(?![^>]*cm=)[^>]*><f>IF\(A2&gt;0,B2:B7,0\)<\/f>/);
    expect(xml).not.toContain("@");
    expect(xml).not.toContain("SINGLE");
  });
});
