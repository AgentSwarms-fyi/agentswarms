// Excel 365's spill reference, A1#: the range the formula in A1 spills into
// (R171). Before, =SUM(A1#) was #NAME? ("Unknown error value"), and a file
// holding _xlfn.ANCHORARRAY(A1), Excel's form of it, read as an unknown
// function.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { WorkbookEngine, type GridData } from "@/lib/sheets/engine";
import { withIntersections } from "@/lib/sheets/formula/implicit";
import { lex } from "@/lib/sheets/formula/lexer";
import { parseFormula } from "@/lib/sheets/formula/parser";
import { renameSheetInFormula, shiftFormula } from "@/lib/sheets/formula/shift";
import { adjustFormula } from "@/lib/sheets/ops";
import { adjustFormulaForShift } from "@/lib/sheets/shiftCells";
import { fromFileFormula, readXlsx, toFileFormula, writeXlsx } from "@/lib/sheets/xlsx";

/** Data!A1 spills 1, 2, 3; `cells` go on Data, `other` on a second sheet, "My Sheet". */
function book(cells: Record<string, string>, other: Record<string, string> = {}) {
  const grid = (c: Record<string, string>): GridData => ({
    cells: Object.fromEntries(Object.entries(c).map(([k, i]) => [k, { i }])),
  });
  const e = new WorkbookEngine([
    { id: "d", name: "Data", grid: grid({ "0,0": "=SEQUENCE(3)", ...cells }) },
    { id: "o", name: "My Sheet", grid: grid(other) },
  ]);
  e.recalcAll();
  return e;
}

describe("A1# in a formula", () => {
  it("lexes as the cell and a # of its own, so a rewrite of the cell keeps it", () => {
    const t = lex("SUM('My Sheet'!$A$2#)-1");
    expect(t.map((x) => x.t + (x.t === "op" ? x.v : ""))).toEqual([
      "func",
      "(",
      "cell",
      "op#",
      ")",
      "op-",
      "num",
    ]);
    expect(t[2]).toMatchObject({ sheet: "My Sheet", s: 4, e: 19 });
    expect(t[3]).toMatchObject({ s: 19, e: 20 });
    expect(parseFormula("A2#")).toMatchObject({ k: "cell", spill: true });
    expect(parseFormula("A2")).not.toHaveProperty("spill");
    expect(() => parseFormula("A1:B2#")).toThrow();
    // A # ends an operand: the - after it takes two.
    expect(lex("A2#-1").map((x) => x.t + (x.t === "op" ? x.v : ""))).toEqual([
      "cell",
      "op#",
      "op-",
      "num",
    ]);
  });

  it("is the whole spill: SUM, ROWS, COUNTIF, INDEX, XLOOKUP and a spill of its own", () => {
    const e = book({
      "0,4": "=SUM(A1#)",
      "1,4": "=ROWS(A1#)",
      "2,4": '=COUNTIF(A1#,">1")',
      "3,4": "=INDEX(A1#,3)",
      "0,2": "=A1#*10",
      "4,4": "=XLOOKUP(20,C1#,A1#)",
      // OFFSET moves the whole spill: A2:A4 is 2, 3 and a blank.
      "5,4": "=SUM(OFFSET(A1#,1,0))",
      "0,6": "=A1#-1",
    });
    expect([0, 1, 2, 3, 4].map((r) => e.getValue("d", r, 4))).toEqual([6, 3, 2, 3, 2]);
    expect([0, 1, 2].map((r) => e.getValue("d", r, 2))).toEqual([10, 20, 30]);
    expect(e.getValue("d", 5, 4)).toBe(5);
    expect([0, 1, 2].map((r) => e.getValue("d", r, 6))).toEqual([0, 1, 2]);
  });

  it("follows the spill when it grows", () => {
    const e = book({ "0,4": "=SUM(A1#)" });
    e.setInput("d", 0, 0, "=SEQUENCE(5)");
    expect(e.getValue("d", 0, 4)).toBe(15);
  });

  it("from another sheet, quoted or not", () => {
    const e = book({}, { "0,0": "=SUM(Data!A1#)", "0,1": "=SEQUENCE(2,2)" });
    expect(e.getValue("o", 0, 0)).toBe(6);
    const back = book({ "0,4": "=SUM('My Sheet'!B1#)" }, { "0,1": "=SEQUENCE(2,2)" });
    expect(back.getValue("d", 0, 4)).toBe(10);
  });

  it("is #REF! where nothing spills: a value, a blocked spill; #CYCLE! on itself", () => {
    const e = book({ "0,5": "7", "0,4": "=F1#", "1,4": "=SUM(A1#)", "2,4": "=SUM(E3#)" });
    expect(e.getValue("d", 0, 4)).toMatchObject({ err: "#REF!" });
    expect(e.getValue("d", 1, 4)).toBe(6);
    expect(e.getValue("d", 2, 4)).toMatchObject({ err: "#CYCLE!" });
    e.setInput("d", 1, 0, "x");
    expect(e.getValue("d", 0, 0)).toMatchObject({ err: "#SPILL!" });
    expect(e.getValue("d", 1, 4)).toMatchObject({ err: "#REF!" });
    e.setInput("d", 1, 0, "");
    expect(e.getValue("d", 1, 4)).toBe(6);
  });

  it("is #CYCLE! when the spill it reads depends on it", () => {
    // F1 sums G1's spill; G1's length is F1.
    const e = book({ "0,5": "=SUM(G1#)", "0,6": "=SEQUENCE(F1)" });
    expect(e.getValue("d", 0, 5)).toMatchObject({ err: "#CYCLE!" });
  });

  it("works in a rule's formula", () => {
    expect(book({}).evaluateAt("d", 5, 5, "=SUM(A1#)")).toBe(6);
  });
});

describe("rewrites keep the #", () => {
  it("copy, rename, insert rows and shift cells", () => {
    expect(shiftFormula("=SUM(A1#)", 1, 1)).toBe("=SUM(B2#)");
    expect(renameSheetInFormula("=SUM(Data!A1#)", "Data", "My Data")).toBe("=SUM('My Data'!A1#)");
    expect(adjustFormula("=SUM(A2#)", "S", "S", "rows", 0, 2)).toBe("=SUM(A4#)");
    expect(adjustFormula("=SUM(A2#)", "S", "S", "rows", 1, -1)).toBe("=SUM(#REF!#)");
    expect(
      adjustFormulaForShift("=SUM(A2#)", "S", "S", { r0: 0, c0: 0, r1: 0, c1: 0 }, "down"),
    ).toBe("=SUM(A3#)");
  });
});

describe("in an Excel file, A1# is _xlfn.ANCHORARRAY(A1)", () => {
  it("is written so, and read back", () => {
    expect(toFileFormula("=SUM(A1#)+ROWS('My Sheet'!$B$2#)")).toBe(
      "SUM(_xlfn.ANCHORARRAY(A1))+ROWS(_xlfn.ANCHORARRAY('My Sheet'!$B$2))",
    );
    expect(toFileFormula('="A1#"&A1')).toBe('"A1#"&A1');
    // A plain formula from a file reads one value of a spill where older Excel would.
    expect(withIntersections("=A1#*2", () => false)).toBe("=@A1#*2");
    expect(withIntersections("=SUM(A1#)", () => false)).toBe("=SUM(A1#)");
    expect(fromFileFormula("SUM(_xlfn.ANCHORARRAY('My Sheet'!$B$2))*_xlfn.ANCHORARRAY(C3)")).toBe(
      "SUM('My Sheet'!$B$2#)*C3#",
    );
  });

  it("XlsxWriter's file reads in and computes", async () => {
    const b = readFileSync(
      resolve(process.cwd(), "tests/fixtures/sheets/xlsxwriter-spillref.xlsx"),
    );
    const got = await readXlsx(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), {
      maxCells: 1000,
    });
    const [data, sums] = got.sheets;
    expect(data.grid.cells["0,2"].i).toBe("=A1#*2");
    expect(data.grid.cells["0,4"].i).toBe("=SUM(A1#)");
    expect(data.grid.cells["0,6"].i).toBe("=SUM('My Sums'!A3#)");
    expect(sums.grid.cells["1,0"].i).toBe("=ROWS(Data!$C$1#)");
    const e = new WorkbookEngine([
      { id: "d", name: data.name, grid: data.grid },
      { id: "o", name: sums.name, grid: sums.grid },
    ]);
    e.recalcAll();
    expect([e.getValue("d", 2, 2), e.getValue("d", 0, 4), e.getValue("d", 0, 6)]).toEqual([
      6, 6, 3,
    ]);
    expect([e.getValue("o", 0, 0), e.getValue("o", 1, 0)]).toEqual([6, 3]);
  }, 60_000);

  it("a download writes it as Excel reads it", async () => {
    const e = book({ "0,4": "=SUM(A1#)", "0,2": "=A1#*2" });
    const buf = await writeXlsx([
      {
        kind: "grid",
        name: "Data",
        grid: e.snapshot("d")!,
        value: (r, c) => e.getValue("d", r, c),
        spill: (r, c) => e.spillSize("d", r, c),
        arrayFormula: (r, c) => e.arrayFormula("d", r, c),
      },
    ]);
    const sheet = strFromU8(unzipSync(new Uint8Array(buf))["xl/worksheets/sheet1.xml"]);
    expect(sheet).toContain(">SUM(_xlfn.ANCHORARRAY(A1))</f>");
    expect(sheet).toMatch(
      /<c r="C1" cm="1"[^>]*><f t="array" ref="C1:C3">_xlfn\.ANCHORARRAY\(A1\)\*2<\/f>/,
    );
  }, 60_000);
});
