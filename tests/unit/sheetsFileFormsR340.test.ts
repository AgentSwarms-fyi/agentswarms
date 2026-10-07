// ECMA.CEILING, and SINGLE and ANCHORARRAY typed as calls (R340).
//
// FOUND IN R329's inventory: the three were #NAME?. SINGLE(x) and
// ANCHORARRAY(A2) are the forms Excel's files hold for @x and A2#; a file's
// were read already (R162, R171), but typed, or pasted from a tool that
// shows the file's text, they were unknown. ECMA.CEILING is the name
// ISO.CEILING had in Excel 2010's beta, kept for files; its examples come
// from BetterSolutions' page on it (Microsoft publishes none).
import { describe, expect, it } from "vitest";

import { WorkbookEngine } from "@/lib/sheets/engine";
import { FUNCTIONS } from "@/lib/sheets/formula/functions";
import { parseFormula } from "@/lib/sheets/formula/parser";
import type { Value } from "@/lib/sheets/formula/values";
import { FUNCTION_HELP } from "@/lib/sheets/functionHelp";
import { toFileFormula } from "@/lib/sheets/xlsx";

function sheet(cells: Record<string, string>) {
  const grid = { cells: Object.fromEntries(Object.entries(cells).map(([k, i]) => [k, { i }])) };
  const e = new WorkbookEngine([{ id: "s", name: "S", kind: "grid", grid }]);
  e.recalcAll();
  const plain = (v: Value): unknown =>
    Array.isArray(v) ? v.map(plain) : v && typeof v === "object" && "err" in v ? { err: v.err } : v;
  const at = (f: string, row = 30, col = 20) => {
    const v = plain(e.evaluateAt("s", row, col, f, { array: true })) as unknown;
    return Array.isArray(v) && v.length === 1 && Array.isArray(v[0]) && v[0].length === 1
      ? v[0][0]
      : v;
  };
  return { e, at, value: (r: number, c: number) => plain(e.getValue("s", r, c)) };
}

describe("ECMA.CEILING: ISO.CEILING under its earlier name", () => {
  const { at } = sheet({});
  it("BetterSolutions' examples", () => {
    expect(at("=ECMA.CEILING(1.9,1)")).toBe(2);
    expect(at("=ECMA.CEILING(3.1,3)")).toBe(6);
    expect(at("=ECMA.CEILING(-1.1,1)")).toBe(-1);
    expect(at("=ECMA.CEILING(8.26,0.05)")).toBeCloseTo(8.3, 12);
    expect(at("=ECMA.CEILING(50,0)")).toBe(0);
    expect(at('=ECMA.CEILING("",1)')).toEqual({ err: "#VALUE!" });
  });

  it("is ISO.CEILING for any signs, and takes its significance", () => {
    for (const [n, s] of [
      [7.3, 2],
      [-7.3, 2],
      [7.3, -2],
      [-7.3, -2],
      [0.04, 0.25],
    ])
      expect(at(`=ECMA.CEILING(${n},${s})`), `${n},${s}`).toBe(at(`=ISO.CEILING(${n},${s})`));
    expect(at("=ECMA.CEILING(1.9)")).toEqual({ err: "#N/A" });
  });

  it("answers for each cell of a range, as ISO.CEILING does", () => {
    expect(at("=ECMA.CEILING({1.2;2.5},1)")).toEqual([[2], [3]]);
  });
});

describe("SINGLE(x), typed: the file's form of @x", () => {
  const { at, value } = sheet({ "0,1": "=SEQUENCE(3)", "1,2": "=SINGLE(B1:B3)*10" });

  it("takes the value in the formula's own row, as @ does", () => {
    expect(value(1, 2)).toBe(20);
    expect(at("=SINGLE(B1:B3)", 2, 4)).toBe(3);
    expect(at("=SINGLE(B1:B3)", 2, 4)).toBe(at("=@B1:B3", 2, 4));
    expect(at("=SINGLE(B1:B3)", 5, 4)).toEqual({ err: "#VALUE!" });
  });

  it("an array's first value; one argument only", () => {
    expect(at("=SINGLE({4,5,6})")).toBe(4);
    expect(at("=SINGLE()")).toEqual({ err: "#N/A" });
    expect(at("=SINGLE(A1,A2)")).toEqual({ err: "#N/A" });
  });
});

describe("ANCHORARRAY(A2), typed: the file's form of A2#", () => {
  it("is the spill of the cell, read as A2# is", () => {
    const { at } = sheet({ "0,1": "=SEQUENCE(3)" });
    expect(at("=SUM(ANCHORARRAY(B1))")).toBe(6);
    expect(at("=ROWS(ANCHORARRAY(B1))")).toBe(3);
    expect(at("=SUM(ANCHORARRAY(B1))")).toBe(at("=SUM(B1#)"));
    expect(parseFormula("ANCHORARRAY(B1)")).toMatchObject({ k: "cell", spill: true });
  });

  it("follows the spill when it grows", () => {
    const { e, value } = sheet({ "0,1": "=SEQUENCE(3)", "2,0": "=SUM(ANCHORARRAY(B1))" });
    expect(value(2, 0)).toBe(6);
    e.setInput("s", 0, 1, "=SEQUENCE(5)");
    expect(value(2, 0)).toBe(15);
  });

  it("a cell that does not spill is #REF!, as A9# is; a range is #VALUE!", () => {
    const { at } = sheet({ "8,0": "4" });
    expect(at("=ANCHORARRAY(A9)")).toEqual(at("=A9#"));
    expect(at("=ANCHORARRAY(A9)")).toEqual({ err: "#REF!" });
    expect(at("=ANCHORARRAY(B1:B2)")).toEqual({ err: "#VALUE!" });
  });
});

describe("the three in the workbook", () => {
  it("are functions with help where a person would type them, and go to a file as Excel's", () => {
    for (const name of ["ECMA.CEILING", "SINGLE", "ANCHORARRAY"])
      expect(FUNCTIONS[name], name).toBeTypeOf("function");
    expect(FUNCTION_HELP["ECMA.CEILING"]?.sig).toMatch(/^ECMA\.CEILING\(/);
    expect(toFileFormula("=SINGLE(B1:B3)*10")).toBe("_xlfn.SINGLE(B1:B3)*10");
    expect(toFileFormula("=SUM(ANCHORARRAY(B1))")).toBe("SUM(_xlfn.ANCHORARRAY(B1))");
  });
});
