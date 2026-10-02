// Excel's implicit intersection, @ (R162). A plain formula in a file is one
// from Excel before dynamic arrays: where it expects one value and meets a
// range, it takes the value in the formula's own row. Before: such a file's
// =Price*Qty over whole columns spilled a column into #SPILL! and stray
// values, =A2:A4 spilled three names, and =SUM(LEN(A2:A4)) was 9, not 3.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import { WorkbookEngine, type GridData } from "@/lib/sheets/engine";
import {
  intersectionsForFile,
  refIsRange,
  singleFromFile,
  withIntersections,
} from "@/lib/sheets/formula/implicit";
import { parseFormula } from "@/lib/sheets/formula/parser";
import { readXlsx, writeXlsx, type ImportResult } from "@/lib/sheets/xlsx";

const ranges =
  (...names: string[]) =>
  (n: string) =>
    names.includes(n.toLowerCase());

describe("where an older formula takes one value", () => {
  const at = (f: string, names = ranges()) => withIntersections(f, names);
  it("a range or a range's name where one value is expected", () => {
    expect(at("=Price*Qty", ranges("price", "qty"))).toBe("=@Price*@Qty");
    expect(at("=B:B*C:C")).toBe("=@B:B*@C:C");
    expect(at("=A2:A4")).toBe("=@A2:A4");
    expect(at("=SUM(LEN(A2:A4))")).toBe("=SUM(LEN(@A2:A4))");
    expect(at('=IF(A2:A4>1,"y","n")')).toBe('=IF(@A2:A4>1,"y","n")');
    expect(at('=IF(A2:A4,"y","n")')).toBe('=IF(@A2:A4,"y","n")');
    expect(at("=IFERROR(A2:A4,0)")).toBe("=IFERROR(@A2:A4,0)");
    expect(at("=SUMIF(A:A,D:D,B:B)")).toBe("=SUMIF(A:A,@D:D,B:B)");
    expect(at("=VLOOKUP(A:A,Data!B:C,2,0)")).toBe("=VLOOKUP(@A:A,Data!B:C,2,0)");
    expect(at("=-Other!A2:A4")).toBe("=-@Other!A2:A4");
  });
  it("not where every Excel works over arrays, or takes a range as it is", () => {
    expect(at("=SUMPRODUCT((C2:C4>1)*B2:B4)")).toBe("=SUMPRODUCT((C2:C4>1)*B2:B4)");
    expect(at("=LOOKUP(2,1/(C2:C4>0),B2:B4)")).toBe("=LOOKUP(2,1/(C2:C4>0),B2:B4)");
    expect(at("=INDEX(B:B,MATCH(A2,C:C,0))")).toBe("=INDEX(B:B,MATCH(A2,C:C,0))");
    expect(at('=SUM(B2:B4)+COUNTIF(A:A,"x")')).toBe('=SUM(B2:B4)+COUNTIF(A:A,"x")');
    expect(at("=A1+Rate*2", ranges())).toBe("=A1+Rate*2");
    expect(at("=A1:A1*2")).toBe("=A1:A1*2");
  });
  it("a name is several cells when its reference is", () => {
    expect(refIsRange("Orders!$B:$B")).toBe(true);
    expect(refIsRange("Orders!$B$2:$B$9")).toBe(true);
    expect(refIsRange("Orders!$B$2")).toBe(false);
  });
});

function engineOf(cells: Record<string, string>, names?: { name: string; ref: string }[]) {
  const grid: GridData = { cells: {} };
  for (const [key, i] of Object.entries(cells)) grid.cells[key] = { i };
  const e = new WorkbookEngine([{ id: "s", name: "Orders", grid }]);
  if (names) e.setDefinedNames(names);
  e.recalcAll();
  return e;
}

describe("@ in a formula", () => {
  const data = {
    "1,0": "Pen",
    "2,0": "Ink",
    "3,0": "Pad",
    "1,1": "2",
    "2,1": "10",
    "3,1": "4",
  };
  it("takes the cell in the formula's own row from a column", () => {
    const e = engineOf({ ...data, "2,5": "=@A2:A4", "2,6": "=@B:B*2" });
    expect(e.getValue("s", 2, 5)).toBe("Ink");
    expect(e.getValue("s", 2, 6)).toBe(20);
  });
  it("is #VALUE! outside the range, and a whole column holds every row", () => {
    const e = engineOf({ ...data, "4,5": "=@A2:A4" });
    expect(e.getValue("s", 4, 5)).toEqual(expect.objectContaining({ err: "#VALUE!" }));
    // Row 10, below Other's four rows of data: Other!B10, a blank.
    const w = new WorkbookEngine([
      { id: "s", name: "Orders", grid: { cells: { "9,5": { i: "=@Other!B:B" } } } },
      { id: "o", name: "Other", grid: { cells: { "3,1": { i: "4" } } } },
    ]);
    w.recalcAll();
    expect(w.getValue("s", 9, 5)).toBe(0);
  });
  it("from a row, the formula's own column; from a block, both", () => {
    const e = engineOf({ ...data, "0,1": "hdr", "6,1": "=@A1:C1", "2,2": "=@A1:B4" });
    expect(e.getValue("s", 6, 1)).toBe("hdr");
    // C3 is in rows 1-4 but not in columns A-B.
    expect(e.getValue("s", 2, 2)).toEqual(expect.objectContaining({ err: "#VALUE!" }));
  });
  it("a name over a column, and an array's first value", () => {
    const e = engineOf({ ...data, "3,4": "=@Price*2", "0,6": "=@SEQUENCE(3)+10" }, [
      { name: "Price", ref: "Orders!$B:$B" },
    ]);
    expect(e.getValue("s", 3, 4)).toBe(8);
    expect(e.getValue("s", 0, 6)).toBe(11);
    // One value, not a spill of three.
    expect(e.spillSize("s", 0, 6)).toBeUndefined();
    expect(e.getValue("s", 1, 6)).toBeNull();
  });
  it("parses as one value taken from what follows", () => {
    expect(parseFormula("@A2:A4*2")).toMatchObject({
      k: "bin",
      left: { k: "single", arg: { k: "range" } },
    });
    expect(() => parseFormula("A1@B1")).toThrow();
  });
  it("tells a download the formula works over no array", () => {
    const e = engineOf({ ...data, "2,5": '=@A2:A4&"!"', "2,6": '=A2:A4&"!"' });
    e.getValue("s", 2, 5);
    e.getValue("s", 2, 6);
    expect(e.arrayFormula("s", 2, 5)).toBe(false);
    expect(e.arrayFormula("s", 2, 6)).toBe(true);
  });
});

describe("R161's check, for functions that work over arrays by themselves", () => {
  it("IF's condition, IFERROR's value", () => {
    const e = engineOf({
      "0,0": "1",
      "1,0": "0",
      "2,0": "3",
      "4,1": "=SUM(IF(A1:A3,1,0))",
      "4,2": "=SUM(IFERROR(A1:A3,0))",
      "4,3": "=IF(A1,1,0)",
    });
    for (const c of [1, 2, 3]) e.getValue("s", 4, c);
    expect(e.getValue("s", 4, 1)).toBe(2);
    expect(e.arrayFormula("s", 4, 1)).toBe(true);
    expect(e.arrayFormula("s", 4, 2)).toBe(true);
    expect(e.arrayFormula("s", 4, 3)).toBe(false);
  });
});

describe("an @ in a file", () => {
  it("is dropped where the older reading takes one value anyway", () => {
    expect(intersectionsForFile("=@Price*@Qty", false)).toBe("=Price*Qty");
    expect(intersectionsForFile("=SUM(LEN(@A2:A4))", false)).toBe("=SUM(LEN(A2:A4))");
  });
  it("is Excel's SINGLE where it would not, or in a dynamic formula", () => {
    expect(intersectionsForFile("=SUM(@A1:A3)", false)).toBe("=SUM(_xlfn.SINGLE(A1:A3))");
    expect(intersectionsForFile("=@A2:A4&B1:B3", true)).toBe("=_xlfn.SINGLE(A2:A4)&B1:B3");
    expect(intersectionsForFile("=@SEQUENCE(3)", false)).toBe("=_xlfn.SINGLE(SEQUENCE(3))");
  });
  it("comes in from Excel's SINGLE", () => {
    expect(singleFromFile("=SUM(SINGLE(A1:A3))")).toBe("=SUM(@(A1:A3))");
    expect(singleFromFile('="SINGLE(A1)"')).toBe('="SINGLE(A1)"');
  });
});

describe("a file of older formulas (openpyxl-legacy.xlsx)", () => {
  let file: ImportResult;
  let e: WorkbookEngine;
  beforeAll(async () => {
    const b = readFileSync(resolve(process.cwd(), "tests/fixtures/sheets/openpyxl-legacy.xlsx"));
    file = await readXlsx(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), {
      maxCells: 1000,
    });
    e = new WorkbookEngine([{ id: "s", name: "Orders", grid: file.sheets[0].grid }]);
    e.setDefinedNames(file.names ?? []);
    e.recalcAll();
  }, 60_000);
  const at = (a1: string) => {
    const col = a1.charCodeAt(0) - 65;
    const row = Number(a1.slice(1)) - 1;
    return { input: e.getInput("s", row, col)?.i, value: e.getValue("s", row, col) };
  };
  it("computes as older Excel did, row by row", () => {
    expect(["D2", "D3", "D4"].map((a) => at(a).value)).toEqual([10, 10, 12]);
    expect(["E2", "E3", "E4"].map((a) => at(a).value)).toEqual([10, 10, 12]);
    expect(at("F2").value).toBe("Pen");
    expect(at("F3").value).toBeNull();
    expect(at("G5").value).toEqual(expect.objectContaining({ err: "#VALUE!" }));
    expect(at("H2").value).toBe(3);
    // Nothing spills into the rows below the data.
    expect(at("D5").value).toBeNull();
  });
  it("shows the @ Excel 365 shows", () => {
    expect(at("D2").input).toBe("=@Price*@Qty");
    expect(at("E2").input).toBe("=@B:B*@C:C");
    expect(at("H2").input).toBe("=SUM(LEN(@A2:A4))");
  });
  it("leaves alone what every Excel works over arrays, and an array formula", () => {
    expect(at("I2")).toEqual({ input: "=SUMPRODUCT((C2:C4>1)*B2:B4)", value: 6 });
    expect(at("J2")).toEqual({ input: "=LOOKUP(2,1/(C2:C4>0),B2:B4)", value: 4 });
    expect(at("K2")).toEqual({ input: "=SUM(B2:B4)", value: 16 });
    expect(at("L2")).toEqual({ input: "=SUM(LEN(A2:A4))", value: 9 });
  });
  it("reads Excel 365's SINGLE as its @", () => {
    expect(at("M2")).toEqual({ input: '=@(A2:A4)&"!"', value: "Pen!" });
  });
  it("goes back out as it came in", async () => {
    const buf = await writeXlsx([
      {
        kind: "grid",
        name: "Orders",
        grid: e.snapshot("s")!,
        value: (r, c) => e.getValue("s", r, c),
        spill: (r, c) => e.spillSize("s", r, c),
        arrayFormula: (r, c) => e.arrayFormula("s", r, c),
      },
    ]);
    const xml = strFromU8(unzipSync(new Uint8Array(buf))["xl/worksheets/sheet1.xml"]);
    expect(xml).toMatch(/<c r="D2"(?![^>]*cm=)[^>]*><f>Price\*Qty<\/f>/);
    expect(xml).toMatch(/<c r="H2"(?![^>]*cm=)[^>]*><f>SUM\(LEN\(A2:A4\)\)<\/f>/);
    expect(xml).toMatch(/<c r="L2" cm="1"[^>]*><f t="array" ref="L2">SUM\(LEN\(A2:A4\)\)<\/f>/);
    expect(xml).not.toContain("@");
  });
});
