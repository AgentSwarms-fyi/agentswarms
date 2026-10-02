// Dynamic array formulas in a download (R161). Excel reads a plain formula in
// a file as one from before dynamic arrays: where it expects one value and
// meets a range, it takes the one in the formula's own row. Before: a
// download wrote =SUM(LEN(A1:A3)) in row 5 plain (Excel: #VALUE!, here 14),
// and a spilling formula as an older array formula, fixed to its size.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import { WorkbookEngine, type GridData } from "@/lib/sheets/engine";
import { readXlsx, writeXlsx } from "@/lib/sheets/xlsx";
import { DYNAMIC_METADATA_XML } from "@/lib/sheets/xlsxDynamic";

const words = { "0,0": { i: "one" }, "1,0": { i: "three" }, "2,0": { i: "eleven" } };

function engineOf(cells: Record<string, string>): WorkbookEngine {
  const grid: GridData = { cells: { ...words } };
  for (const [key, i] of Object.entries(cells)) grid.cells[key] = { i };
  const e = new WorkbookEngine([{ id: "s", name: "Data", grid }]);
  e.recalcAll();
  return e;
}

/** Does the formula at A1-style (row, col) work over arrays where older Excel takes one value? */
const worksOverArrays = (formula: string, row = 4, col = 1) => {
  const e = engineOf({ [`${row},${col}`]: formula });
  e.getValue("s", row, col);
  return e.arrayFormula("s", row, col);
};

describe("which formulas work over arrays where older Excel takes one value", () => {
  it("a function of one value given a range, and an operator on one", () => {
    expect(worksOverArrays("=SUM(LEN(A1:A3))")).toBe(true);
    expect(worksOverArrays('=SUM(IF(A1:A3="three",1,0))')).toBe(true);
    expect(worksOverArrays('=MATCH(1,(A1:A3="eleven")*1,0)')).toBe(true);
    expect(worksOverArrays("=-A1:A3")).toBe(true);
    expect(worksOverArrays("=SUM(LEN(A:A))")).toBe(true);
  });
  it("a whole column is many values even with one row used", () => {
    // Older Excel reads Other!F:F in row 5 as Other!F5, a blank: 0, not 1.
    const e = new WorkbookEngine([
      { id: "s", name: "Data", grid: { cells: { "4,1": { i: "=SUM(LEN(Other!F:F))" } } } },
      { id: "o", name: "Other", grid: { cells: { "0,5": { i: "x" } } } },
    ]);
    e.recalcAll();
    expect(e.getValue("s", 4, 1)).toBe(1);
    expect(e.arrayFormula("s", 4, 1)).toBe(true);
  });
  it("not a formula that takes ranges where Excel always has", () => {
    expect(worksOverArrays("=LEN(A1)")).toBe(false);
    expect(worksOverArrays("=SUM(A1:A3)")).toBe(false);
    expect(worksOverArrays('=COUNTIF(A1:A3,"t*")')).toBe(false);
    expect(worksOverArrays('=INDEX(A1:A3,MATCH("three",A1:A3,0))')).toBe(false);
    expect(worksOverArrays('=A1:A1&"!"')).toBe(false);
  });
  it("is worked out afresh each time the formula computes", () => {
    const e = engineOf({ "4,1": "=SUM(LEN(A1:A3))" });
    expect(e.getValue("s", 4, 1)).toBe(14);
    expect(e.arrayFormula("s", 4, 1)).toBe(true);
    e.setInputs("s", [{ row: 4, col: 1, input: "=LEN(A1)" }]);
    expect(e.getValue("s", 4, 1)).toBe(3);
    expect(e.arrayFormula("s", 4, 1)).toBe(false);
  });
});

async function download(cells: Record<string, string>) {
  const e = engineOf(cells);
  const grid = e.snapshot("s")!;
  const buf = await writeXlsx([
    {
      kind: "grid",
      name: "Data",
      grid,
      value: (r, c) => e.getValue("s", r, c),
      spill: (r, c) => e.spillSize("s", r, c),
      arrayFormula: (r, c) => e.arrayFormula("s", r, c),
    },
  ]);
  const files = unzipSync(new Uint8Array(buf));
  const text = (p: string) => (files[p] ? strFromU8(files[p]) : undefined);
  return { buf, text, sheet: text("xl/worksheets/sheet1.xml")! };
}

/** A part's text with Windows line ends as Unix ones (XlsxWriter on Windows writes CRLF). */
const lf = (s: string | undefined) => s?.replace(/\r\n/g, "\n");

describe("a download's formulas", () => {
  const cells = {
    "4,1": "=SUM(LEN(A1:A3))",
    "0,3": "=FILTER(A1:A3,LEN(A1:A3)>3)",
    "0,4": "=LEN(A1)",
  };
  // The first write loads the file library: seconds alone, more beside the suite.
  beforeAll(() => download(cells), 60_000);
  it("one that works over arrays goes out as a one-cell dynamic array formula", async () => {
    const { sheet } = await download(cells);
    expect(sheet).toMatch(/<c r="B5" cm="1"[^>]*><f t="array" ref="B5">SUM\(LEN\(A1:A3\)\)<\/f>/);
  });
  it("one that spills goes out as a dynamic array formula over what it fills", async () => {
    const { sheet } = await download(cells);
    expect(sheet).toMatch(
      /<c r="D1" cm="1"[^>]*><f t="array" ref="D1:D2">_xlfn\._xlws\.FILTER\(A1:A3,LEN\(A1:A3\)&gt;3\)<\/f>/,
    );
    // The cell below holds the value it shows, with no mark of its own.
    expect(sheet).toMatch(/<c r="D2"(?![^>]*cm=)[^>]*>/);
  });
  it("one that needs neither stays a plain formula", async () => {
    const { sheet } = await download(cells);
    expect(sheet).toMatch(/<c r="E1"(?![^>]*cm=)[^>]*><f>LEN\(A1\)<\/f>/);
  });
  it("the mark is Excel's: the metadata part, its content type, the workbook's link", async () => {
    const { text } = await download(cells);
    expect(text("xl/metadata.xml")).toBe(DYNAMIC_METADATA_XML);
    expect(text("[Content_Types].xml")).toContain(
      '<Override PartName="/xl/metadata.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheetMetadata+xml"/>',
    );
    expect(text("xl/_rels/workbook.xml.rels")).toMatch(
      /<Relationship Id="rId\d+" Type="http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006\/relationships\/sheetMetadata" Target="metadata\.xml"\/>/,
    );
    // Each relationship keeps an id of its own.
    const ids = [...text("xl/_rels/workbook.xml.rels")!.matchAll(/Id="(rId\d+)"/g)].map(
      (m) => m[1],
    );
    expect(new Set(ids).size).toBe(ids.length);
  });
  it("is what Excel's own writer puts in the file (XlsxWriter's reference)", () => {
    const b = readFileSync(resolve(process.cwd(), "tests/fixtures/sheets/xlsxwriter-dynamic.xlsx"));
    const ref = unzipSync(new Uint8Array(b));
    expect(lf(strFromU8(ref["xl/metadata.xml"]))).toBe(DYNAMIC_METADATA_XML);
    const sheet = strFromU8(ref["xl/worksheets/sheet1.xml"]);
    expect(sheet).toMatch(/<c r="B5" cm="1"><f t="array" ref="B5">SUM\(LEN\(A1:A3\)\)<\/f>/);
    expect(sheet).toMatch(/<c r="D1" cm="1"[^>]*><f t="array" ref="D1:D2">/);
    expect(sheet).toMatch(/<c r="E1"><f>LEN\(A1\)<\/f>/);
  });
  it("a workbook with none gets no metadata part", async () => {
    const { text, sheet } = await download({ "0,4": "=LEN(A1)", "1,4": "=SUM(A1:A3)" });
    expect(text("xl/metadata.xml")).toBeUndefined();
    expect(sheet).not.toContain("cm=");
  });
  it("File → Download as Excel asks the workbook's engine", () => {
    expect(readFileSync("src/components/sheets/download.ts", "utf8")).toMatch(
      /arrayFormula: \(r, c\) => opts\.engine\.arrayFormula\(tab\.id, r, c\),/,
    );
  });
  it("comes back in computing as before", async () => {
    const { buf } = await download(cells);
    const back = await readXlsx(buf, { maxCells: 1000 });
    const e = new WorkbookEngine([{ id: "s", name: "Data", grid: back.sheets[0].grid }]);
    e.recalcAll();
    expect(e.getInput("s", 4, 1)?.i).toBe("=SUM(LEN(A1:A3))");
    expect(e.getValue("s", 4, 1)).toBe(14);
    expect([e.getValue("s", 0, 3), e.getValue("s", 1, 3)]).toEqual(["three", "eleven"]);
  });
});
