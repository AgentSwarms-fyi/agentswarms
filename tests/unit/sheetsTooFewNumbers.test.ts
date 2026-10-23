// A statistic with too few numbers answers Excel's error, never a number
// (R261, from the Sheets queue's "a list with no numbers is an error, not
// always Excel's code").
//
// The probe found worse than codes: STDEV.S and VAR.S of no numbers were 0,
// and HARMEAN(0) was 0. A 0 is read as an answer; nobody questions it. Each
// code below is the one the function's own page states (quoted where short).
import { describe, expect, it } from "vitest";

import { WorkbookEngine } from "@/lib/sheets/engine";
import { FUNCTION_NAMES } from "@/lib/sheets/formula/functions";
import type { Value } from "@/lib/sheets/formula/values";

// A1:A3 blank; B1 text.
const e = new WorkbookEngine([
  { id: "s", name: "S", kind: "grid", grid: { cells: { "0,1": { i: "text" } } } },
]);
const plain = (v: Value): unknown =>
  Array.isArray(v) ? v.map(plain) : v && typeof v === "object" && "err" in v ? { err: v.err } : v;
const at = (f: string): unknown => {
  const v = plain(e.evaluateAt("s", 19, 9, f, { array: true })) as unknown;
  return Array.isArray(v) && v.length === 1 && Array.isArray(v[0]) && v[0].length === 1
    ? v[0][0]
    : v;
};
const ERR = (code: string) => ({ err: code });

describe("never a number where Excel refuses", () => {
  it("a sample spread needs two numbers: none is #DIV/0!, not 0", () => {
    for (const f of ["STDEV.S", "STDEV", "VAR.S", "VAR"]) {
      expect(at(`=${f}(A1:A3)`)).toEqual(ERR("#DIV/0!"));
      expect(at(`=${f}(5)`)).toEqual(ERR("#DIV/0!"));
    }
    // And with two it is a number again: (5,7) has mean 6, squares 1+1 over 1.
    expect(at("=VAR.S(5,7)")).toBe(2);
    expect(at("=STDEV.S(5,7)")).toBeCloseTo(Math.SQRT2, 14);
  });

  it("HARMEAN: any value of 0 or less is #NUM!, not 0", () => {
    expect(at("=HARMEAN(0)")).toEqual(ERR("#NUM!"));
    expect(at("=HARMEAN(2,-1)")).toEqual(ERR("#NUM!"));
    expect(at("=HARMEAN(1,2,4)")).toBeCloseTo(3 / (1 + 1 / 2 + 1 / 4), 14);
  });
});

describe("Excel's code where it differed", () => {
  it("a population spread of nothing is #DIV/0!; of one number it is 0", () => {
    for (const f of ["STDEV.P", "VAR.P", "STDEVP", "VARP"]) {
      expect(at(`=${f}(A1:A3)`)).toEqual(ERR("#DIV/0!"));
      expect(at(`=${f}(5)`)).toBe(0);
    }
  });

  it("SKEW below three values and KURT below four are #DIV/0!", () => {
    expect(at("=SKEW(1,2)")).toEqual(ERR("#DIV/0!"));
    expect(at("=KURT(1,2,3)")).toEqual(ERR("#DIV/0!"));
    expect(typeof at("=SKEW(1,2,4)")).toBe("number");
    expect(typeof at("=KURT(1,2,3,7)")).toBe("number");
  });

  it("LARGE, SMALL, PERCENTILE and QUARTILE of an empty list are #NUM!", () => {
    for (const f of [
      "LARGE",
      "SMALL",
      "PERCENTILE",
      "PERCENTILE.INC",
      "QUARTILE",
      "QUARTILE.INC",
    ]) {
      expect(at(`=${f}(A1:A3,1)`)).toEqual(ERR("#NUM!"));
    }
  });

  it("GEOMEAN of nothing is #NUM!, and MODE of nothing #N/A", () => {
    expect(at("=GEOMEAN(A1:A3)")).toEqual(ERR("#NUM!"));
    expect(at("=MODE(A1:A3)")).toEqual(ERR("#N/A"));
    expect(at("=MODE.SNGL(B1)")).toEqual(ERR("#N/A"));
  });

  it("text in a range is not a number for them either", () => {
    expect(at("=STDEV.S(B1)")).toEqual(ERR("#DIV/0!"));
  });
});

describe("two old names that were #NAME?", () => {
  it("VARP is VAR.P, and VARA counts text as 0 and TRUE as 1", () => {
    expect(FUNCTION_NAMES).toContain("VARP");
    expect(FUNCTION_NAMES).toContain("VARA");
    expect(at("=VARP(1,2,3,4)")).toBe(1.25); // mean 2.5, squares 2.25+0.25+0.25+2.25 = 5, / 4
    expect(at("=VARA(1,2,3,4)")).toBeCloseTo(5 / 3, 14);
  });
});
