// Sheets and Excel files. Two directions and two writers: a workbook written
// by this code and read back must be the same workbook, and a file written by
// a different tool (openpyxl, the fixture) must come in looking and computing
// as it did there. The UI round drives the same files through the browser.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import ExcelJS from "exceljs";
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { fileName } from "@/components/sheets/download";
import { BOM, csvCell, gridToCsv, parseCsv, rowsToGrid } from "@/lib/sheets/csv";
import { WorkbookEngine, type GridData } from "@/lib/sheets/engine";
import {
  fromFileFormula,
  ptToPx,
  pxToPt,
  pxToWidth,
  readXlsx,
  toFileFormula,
  excelSheetNames,
  widthToPx,
  writeXlsx,
} from "@/lib/sheets/xlsx";
import { applyTint, resolveColor, themeColors } from "@/lib/sheets/xlsxColors";

const fixture = () => {
  const b = readFileSync(resolve(process.cwd(), "tests/fixtures/sheets/openpyxl-sales.xlsx"));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

describe("formulas as a file stores them", () => {
  it("drops the _xlfn prefixes Excel writes for newer functions", () => {
    expect(fromFileFormula("_xlfn.XLOOKUP(A2,B:B,C:C)")).toBe("XLOOKUP(A2,B:B,C:C)");
    expect(fromFileFormula("_xlfn._xlws.FILTER(A:A,B:B>1)")).toBe("FILTER(A:A,B:B>1)");
    expect(fromFileFormula("_xlfn.LET(_xlpm.x,1,_xlpm.x+1)")).toBe("LET(x,1,x+1)");
  });
  it("adds them back, outside strings and sheet names", () => {
    expect(toFileFormula("=XLOOKUP(A2,B:B,C:C)")).toBe("_xlfn.XLOOKUP(A2,B:B,C:C)");
    expect(toFileFormula("=SORT(UNIQUE(A2:A9))")).toBe("_xlfn._xlws.SORT(_xlfn.UNIQUE(A2:A9))");
    expect(toFileFormula('="UNIQUE(" & A1')).toBe('"UNIQUE(" & A1');
    expect(toFileFormula("='IFS(x'!A1+SUM(B1)")).toBe("'IFS(x'!A1+SUM(B1)");
    expect(toFileFormula("=SUM(A1:A3)")).toBe("SUM(A1:A3)");
  });
});

describe("units and colors", () => {
  it("converts widths and heights both ways", () => {
    expect(widthToPx(8.43)).toBe(64);
    expect(pxToWidth(widthToPx(20))).toBeCloseTo(20, 1);
    expect(ptToPx(15)).toBe(20);
    expect(pxToPt(24)).toBe(18);
  });
  it("reads theme, tint, indexed and ARGB colors", () => {
    expect(resolveColor({ argb: "FF4472C4" })).toBe("#4472C4");
    expect(resolveColor({ theme: 4 })).toBe("#4472C4");
    expect(resolveColor({ theme: 0 })).toBe("#FFFFFF");
    expect(resolveColor({ indexed: 10 })).toBe("#FF0000");
    expect(resolveColor({ indexed: 64 })).toBeUndefined();
    expect(applyTint("#4472C4", -0.25)).toBe("#2F5597");
    expect(applyTint("#000000", 0.5)).toBe("#808080");
    const xml =
      '<a:dk1><a:sysClr val="windowText" lastClr="111111"/></a:dk1><a:lt1><a:srgbClr val="FEFEFE"/></a:lt1><a:accent1><a:srgbClr val="123456"/></a:accent1>';
    const t = themeColors(xml);
    expect(t[0]).toBe("#FEFEFE");
    expect(t[1]).toBe("#111111");
    expect(t[4]).toBe("#123456");
  });
});

describe("a file another tool wrote (openpyxl)", () => {
  it("brings the cells, formulas and sheets in", async () => {
    const r = await readXlsx(fixture(), { maxCells: 200_000 });
    expect(r.sheets.map((s) => s.name)).toEqual(["Sales", "Bob's notes", "Lists"]);
    const sales = r.sheets[0].grid;
    expect(sales.cells["0,0"].i).toBe("Region");
    expect(sales.cells["1,3"].i).toBe("=B2+C2");
    expect(sales.cells["2,3"].i).toBe("=B3+C3");
    expect(sales.cells["5,3"].i).toBe("=SUM(D2:D5)");
    expect(sales.cells["2,1"].i).toBe("-350");
  });
  it("keeps what the sheet looks like", async () => {
    const r = await readXlsx(fixture(), { maxCells: 200_000 });
    const g = r.sheets[0].grid;
    const h = g.cells["0,0"].s!;
    expect(h).toMatchObject({ b: true, font: "Arial", sz: 12, align: "center", va: "middle" });
    expect(h.color).toBe("#FFFFFF");
    // openpyxl writes the Office 2007 theme: accent1 #4F81BD, darkened 25%.
    expect(h.bg).toBe("#376092");
    expect(g.cells["1,1"].f).toBe("#,##0;[Red]-#,##0");
    expect(g.cells["1,4"].f).toBe("yyyy-mm-dd");
    expect(g.cells["1,0"].s?.bd?.l).toEqual({ s: "thin" });
    const total = g.cells["5,3"].s!;
    expect(total).toMatchObject({ b: true, i: true, st: true, color: "#FF0000" });
    expect(total.bd).toEqual({ t: { s: "thick", c: "#C00000" }, b: { s: "double" } });
    expect(g.merges).toEqual(["A8:D8"]);
    // The merged block's other cells hold nothing (the file repeats the value there).
    expect(g.cells["7,1"]).toBeUndefined();
    expect(g.cells["7,3"]).toBeUndefined();
    expect(g.cells["9,0"].s).toMatchObject({ wrap: true, va: "top" });
    expect(g.rowHeights?.["9"]).toBe(60);
    expect(g.cells["11,0"]).toMatchObject({ i: "Docs", l: "https://example.com/handbook" });
    expect(g.colWidths?.["0"]).toBe(widthToPx(22));
    expect(g.hiddenCols).toEqual([5]);
    expect(g.hiddenRows).toEqual([13]);
    expect(g.frozenRows).toBe(1);
    expect(g.frozenCols).toBe(1);
  });
  it("computes the same answers here", async () => {
    const r = await readXlsx(fixture(), { maxCells: 200_000 });
    const e = new WorkbookEngine(
      r.sheets.map((s, i) => ({
        id: `s${i}`,
        name: s.name.replace(/'/g, ""),
        kind: "grid" as const,
        grid: s.grid,
      })),
    );
    expect(e.getValue("s0", 5, 3)).toBe(1200 + 1350 - 350 + 410 + 980 + 1010 + 1500 + 1720);
    // A date comes in as Excel's serial day, formatted.
    expect(e.getValue("s0", 1, 4)).toBe(45353); // 2024-03-02
  });
});

describe("a formula this engine cannot compute", () => {
  async function fileWith(cells: Record<string, unknown>): Promise<ArrayBuffer> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("S");
    for (const [a, v] of Object.entries(cells)) ws.getCell(a).value = v as ExcelJS.CellValue;
    return (await wb.xlsx.writeBuffer()) as ArrayBuffer;
  }

  it("shows the value Excel saved, and says so", async () => {
    const buf = await fileWith({
      A1: { formula: 'CUBEVALUE("Sales","[Measures].[Total]")', result: 42 },
      A2: { formula: 'IFERROR(CUBEMEMBER("Sales","x"),"none")', result: "Q1" },
      A3: { formula: "[1]Budget!B2*2", result: 10 },
      A4: { formula: "A1*2", result: 84 },
      A5: { formula: "NOSUCH(1)", result: { error: "#N/A" } },
      A6: { formula: "TaxRate*100", result: 8 },
    });
    const r = await readXlsx(buf, { maxCells: 100 });
    const g = r.sheets[0].grid;
    expect(g.cells["0,0"]).toMatchObject({ i: '=CUBEVALUE("Sales","[Measures].[Total]")', c: 42 });
    expect(g.cells["3,0"].c).toBeUndefined();
    expect(r.sheets[0].cachedFormulas).toBe(5);
    // A defined name lives in the file, not here: Excel's value again.
    expect(g.cells["5,0"]).toMatchObject({ i: "=TaxRate*100", c: 8 });
    const e = new WorkbookEngine([{ id: "s", name: "S", kind: "grid", grid: g }]);
    expect(e.getValue("s", 0, 0)).toBe(42);
    expect(e.isCached("s", 0, 0)).toBe(true);
    expect(e.unknownFunctions("s", 0, 0)).toEqual(["CUBEVALUE"]);
    // IFERROR would have hidden the missing function behind "none".
    expect(e.getValue("s", 1, 0)).toBe("Q1");
    // A link to another file does not parse here: Excel's value again.
    expect(e.getValue("s", 2, 0)).toBe(10);
    // And formulas over it compute from it.
    expect(e.getValue("s", 3, 0)).toBe(84);
    expect(e.getValue("s", 4, 0)).toMatchObject({ err: "#N/A" });
  });

  it("drops the saved value once the formula is edited", async () => {
    const buf = await fileWith({ A1: { formula: "CUBEVALUE(1)", result: 5 } });
    const g = (await readXlsx(buf, { maxCells: 100 })).sheets[0].grid;
    const e = new WorkbookEngine([{ id: "s", name: "S", kind: "grid", grid: g }]);
    e.setInputs("s", [{ row: 0, col: 0, input: "=CUBEVALUE(2)" }]);
    expect(e.getInput("s", 0, 0)?.c).toBeUndefined();
    expect(e.getValue("s", 0, 0)).toMatchObject({ err: "#NAME?" });
    expect(e.isCached("s", 0, 0)).toBe(false);
  });
});

describe("a workbook written here and read back", () => {
  const grid: GridData = {
    cells: {
      "0,0": { i: "Item", s: { b: true, bg: "#FFFF00", font: "Georgia", sz: 14 } },
      "0,1": { i: "Price", s: { align: "right", bd: { b: { s: "double", c: "#C00000" } } } },
      "1,0": { i: "Tea", l: "https://example.com/tea" },
      "1,1": { i: "3.5", f: '"$"#,##0.00' },
      "2,0": { i: "'007" },
      "2,1": { i: "=B2*2", s: { i: true, st: true, color: "#7030A0" } },
      "3,0": { i: "=SEQUENCE(3)" },
      "4,3": { i: "Wrapped\nline", s: { wrap: true, va: "top", ind: 2 } },
    },
    colWidths: { "0": 150 },
    rowHeights: { "4": 48 },
    merges: ["D1:E2"],
    hiddenRows: [8],
    hiddenCols: [6],
    hideGrid: true,
  };

  it("round-trips values, formulas, styles, merges and layout", async () => {
    const e = new WorkbookEngine([{ id: "s", name: "Menu", kind: "grid", grid }]);
    const buf = await writeXlsx([
      {
        kind: "grid",
        name: "Menu",
        grid,
        value: (r, c) => e.getValue("s", r, c),
        spill: (r, c) => e.spillSize("s", r, c),
      },
      {
        kind: "table",
        name: "Orders 2024",
        columns: ["id", "amount"],
        rows: [
          [1, 10],
          [2, 20.5],
        ],
      },
    ]);
    const back = await readXlsx(buf, { maxCells: 200_000 });
    const g = back.sheets[0].grid;
    expect(g.cells["0,0"].s).toMatchObject({ b: true, bg: "#FFFF00", font: "Georgia", sz: 14 });
    expect(g.cells["0,1"].s?.bd?.b).toEqual({ s: "double", c: "#C00000" });
    expect(g.cells["1,0"]).toMatchObject({ i: "Tea", l: "https://example.com/tea" });
    expect(g.cells["1,1"]).toMatchObject({ i: "3.5", f: '"$"#,##0.00' });
    expect(g.cells["2,0"].i).toBe("'007");
    // A formula computed here keeps no copy of Excel's value.
    expect(g.cells["2,1"]).toMatchObject({ i: "=B2*2" });
    expect(g.cells["2,1"].c).toBeUndefined();
    expect(g.cells["2,1"].s).toMatchObject({ i: true, st: true, color: "#7030A0" });
    // A spilling formula goes out as an array formula and comes back as the one formula.
    expect(g.cells["3,0"].i).toBe("=SEQUENCE(3)");
    expect(g.cells["4,0"]).toBeUndefined();
    expect(g.cells["4,3"]).toMatchObject({
      i: "Wrapped\nline",
      s: { wrap: true, va: "top", ind: 2 },
    });
    expect(g.merges).toEqual(["D1:E2"]);
    expect(g.colWidths?.["0"]).toBe(150);
    expect(g.rowHeights?.["4"]).toBe(48);
    expect(g.hiddenRows).toEqual([8]);
    expect(g.hiddenCols).toEqual([6]);
    expect(g.hideGrid).toBe(true);
    // The table sheet is an Excel table, so Orders_2024[amount] works in Excel.
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const t = wb.getWorksheet("Orders 2024")!;
    expect(t.getCell("B3").value).toBe(20.5);
    expect(Object.keys((t as unknown as { tables: Record<string, unknown> }).tables)).toEqual([
      "Orders_2024",
    ]);
    // Excel recalculates on open (ExcelJS writes the flag but does not read it back).
    const xml = strFromU8(unzipSync(new Uint8Array(buf))["xl/workbook.xml"]);
    expect(xml).toMatch(/<calcPr[^>]*fullCalcOnLoad="1"/);
  });

  it("cuts a sheet name to Excel's 31 characters, and the formulas that use it", async () => {
    const long = "Quarterly revenue by region and product line";
    expect(excelSheetNames([long, `${long} 2`, "Short"])).toEqual([
      "Quarterly revenue by region and",
      "Quarterly revenue by region (2)",
      "Short",
    ]);
    const buf = await writeXlsx([
      { kind: "grid", name: long, grid: { cells: { "0,0": { i: "5" } } }, value: () => 5 },
      {
        kind: "grid",
        name: "Short",
        grid: { cells: { "0,0": { i: `='${long}'!A1*2` } } },
        value: () => 10,
      },
    ]);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Quarterly revenue by region and", "Short"]);
    expect((wb.getWorksheet("Short")!.getCell("A1").value as { formula: string }).formula).toBe(
      "'Quarterly revenue by region and'!A1*2",
    );
  });

  it("writes newer functions with the prefix Excel needs", async () => {
    const g: GridData = { cells: { "0,0": { i: "=XLOOKUP(1,{1},{2})" } } };
    const buf = await writeXlsx([{ kind: "grid", name: "S", grid: g, value: () => 2 }]);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const v = wb.getWorksheet("S")!.getCell("A1").value as { formula: string };
    expect(v.formula).toBe("_xlfn.XLOOKUP(1,{1},{2})");
  });

  it("does not write a link that runs code, even if one got into a grid", async () => {
    const g: GridData = { cells: { "0,0": { i: "x", l: "javascript:alert(1)" } } };
    const buf = await writeXlsx([{ kind: "grid", name: "S", grid: g, value: () => "x" }]);
    // Not in the file at all (the reader here would also drop it, so look at the file).
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    expect(wb.getWorksheet("S")!.getCell("A1").value).toBe("x");
    const parts = Object.keys(unzipSync(new Uint8Array(buf)));
    expect(parts.some((f) => f.includes("_rels/sheet1"))).toBe(false);
  });

  it("stops at the cell limit and says so", async () => {
    const big: GridData = { cells: {} };
    for (let r = 0; r < 30; r++) big.cells[`${r},0`] = { i: String(r) };
    const buf = await writeXlsx([{ kind: "grid", name: "Big", grid: big, value: (r) => r }]);
    const back = await readXlsx(buf, { maxCells: 10 });
    expect(Object.keys(back.sheets[0].grid.cells)).toHaveLength(10);
    expect(back.warnings.join(" ")).toMatch(/more than 10 cells/);
  });
});

describe("CSV", () => {
  it("detects the delimiter and drops the trailing empty row", () => {
    expect(parseCsv("a;b\n1;2\n").rows).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    expect(parseCsv("a\tb\r\n1\t2").delimiter).toBe("\t");
    expect(parseCsv(`${BOM}name,note\nx,"a, b"`).rows[1]).toEqual(["x", "a, b"]);
  });
  it("reads numbers, dates and percentages, and keeps formulas as text", () => {
    expect(csvCell("1,200")).toEqual({ i: "1,200", f: "#,##0" });
    expect(csvCell("-12,345.5")).toEqual({ i: "-12,345.5", f: "#,##0.00" });
    // Not a thousands group: stays General.
    expect(csvCell("12,34")).toEqual({ i: "12,34" });
    expect(csvCell("2024-01-31")).toEqual({ i: "2024-01-31", f: "yyyy-mm-dd" });
    expect(csvCell("12%")).toEqual({ i: "12%", f: "0%" });
    expect(csvCell('=HYPERLINK("http://x")')).toEqual({ i: '\'=HYPERLINK("http://x")' });
    expect(csvCell("+44 20 7946")).toEqual({ i: "'+44 20 7946" });
    expect(csvCell("-5")).toEqual({ i: "-5" });
    expect(csvCell("")).toBeUndefined();
    const g = rowsToGrid([
      ["a", ""],
      ["", "b"],
    ]);
    expect(g.cells).toEqual({ "0,0": { i: "a" }, "1,1": { i: "b" } });
  });
  it("writes what cells show, quoting where needed and defusing formulas", () => {
    const e = new WorkbookEngine([
      {
        id: "s",
        name: "S",
        kind: "grid",
        grid: {
          cells: {
            "0,0": { i: "a, b" },
            "0,1": { i: "1234.5", f: "#,##0.00" },
            "1,0": { i: '="=cmd"' },
            "1,1": { i: 'say "hi"' },
          },
        },
      },
    ]);
    const csv = gridToCsv(2, 2, (r, c) => ({
      v: e.getValue("s", r, c),
      input: e.getInput("s", r, c),
    }));
    expect(csv).toBe('"a, b","1,234.50"\r\n\'=cmd,"say ""hi"""\r\n');
  });

  it("names a downloaded file without characters a file system refuses", () => {
    expect(fileName('Q1: "North/South" <draft>?', "csv")).toBe("Q1 North South draft.csv");
    expect(fileName("tab\there", "xlsx")).toBe("tab here.xlsx");
    expect(fileName("  ", "xlsx")).toBe("workbook.xlsx");
  });

  it("writes a negative formatted number as the number, not as defused text", () => {
    const e = new WorkbookEngine([
      {
        id: "s",
        name: "S",
        kind: "grid",
        grid: { cells: { "0,0": { i: "-350", f: "$#,##0.00" }, "0,1": { i: "-2" } } },
      },
    ]);
    const csv = gridToCsv(1, 2, (r, c) => ({
      v: e.getValue("s", r, c),
      input: e.getInput("s", r, c),
    }));
    expect(csv).toBe("-350,-2\r\n");
  });
});
