// The long-tail functions read their arguments as Excel does (R170). Before,
// with A1 1, A2 blank and A3 3: GEOMEAN(A1:A3) was 0, SMALL(A1:A3,2) 1,
// PERCENTILE(A1:A3,0.5) 1, NPV(0.1,A1:A3) discounted the blank as a period,
// CORREL and SLOPE paired it with a number, SUMSQ and RANK over text were
// #VALUE!, and VSTACK("Name",A1:A3) and TAKE(A1,1) were #VALUE!.

import { describe, expect, it } from "vitest";
import { WorkbookEngine, type GridData } from "@/lib/sheets/engine";

// A1 1, A2 blank, A3 3, A4 "x", A5 TRUE; B1:B5 2, 4, 6, 8, 10.
const base: GridData["cells"] = {
  "0,0": { i: "1" },
  "2,0": { i: "3" },
  "3,0": { i: "x" },
  "4,0": { i: "TRUE" },
  "0,1": { i: "2" },
  "1,1": { i: "4" },
  "2,1": { i: "6" },
  "3,1": { i: "8" },
  "4,1": { i: "10" },
};

/** The value of `formula` at F11, and below it for a spill. */
function at(formula: string, rows = 1): unknown {
  const grid: GridData = { cells: { ...base, "10,5": { i: formula } } };
  const e = new WorkbookEngine([{ id: "s", name: "S", grid }]);
  e.recalcAll();
  const first = e.getValue("s", 10, 5);
  if (rows === 1) return first;
  return Array.from({ length: rows }, (_, i) => e.getValue("s", 10 + i, 5));
}

describe("a blank cell in a range is not a 0", () => {
  it("in the averages and spreads", () => {
    expect(at("=GEOMEAN(A1:A3)")).toBeCloseTo(Math.sqrt(3), 12);
    expect(at("=HARMEAN(A1:A3)")).toBe(1.5);
    expect(at("=DEVSQ(A1:A3)")).toBe(2);
    expect(at("=SKEW(A1:A3,5)")).toBeCloseTo(0, 12);
    expect(at("=STDEV(A1:A3)")).toBeCloseTo(Math.SQRT2, 12);
  });
  it("in the ranks and percentiles", () => {
    expect(at("=SMALL(A1:A3,2)")).toBe(3);
    expect(at("=PERCENTILE(A1:A3,0.5)")).toBe(2);
    expect(at("=QUARTILE(A1:A3,2)")).toBe(2);
    expect(at("=RANK(3,A1:A3,1)")).toBe(2);
    expect(at("=RANK.EQ(3,A1:A3,1)")).toBe(2);
    expect(at("=RANK.AVG(3,A1:A3)")).toBe(1);
    expect(at("=RANK(4,A1:A3)")).toMatchObject({ err: "#N/A" });
    expect(at("=RANK.AVG(4,A1:A3)")).toMatchObject({ err: "#N/A" });
    expect(at("=PERCENTILE.INC(A1:A3,0.5)")).toBe(2);
    expect(at("=QUARTILE.INC(A1:A3,2)")).toBe(2);
  });
  it("in NPV, which does not count it as a period", () => {
    expect(at("=NPV(0.1,A1:A3)")).toBeCloseTo(1 / 1.1 + 3 / 1.21, 12);
    // A blank rate is 0, and is not one of the values.
    expect(at("=NPV(A2,A1:A3)")).toBe(4);
    expect(at("=IRR({-10,6,6})")).toBeCloseTo(0.1306623863, 9);
  });
  it("in STDEVA, which counts text and TRUE but not blanks", () => {
    expect(at("=STDEVA(A1:A3)")).toBeCloseTo(Math.SQRT2, 12);
    // 1, 3, 0 ("x"), 1 (TRUE)
    const xs = [1, 3, 0, 1];
    const m = xs.reduce((a, b) => a + b) / 4;
    const sd = Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / 3);
    expect(at("=STDEVA(A1:A5)")).toBeCloseTo(sd, 12);
  });
});

describe("text and TRUE in a range are left out", () => {
  it("as SUM leaves them out", () => {
    expect(at("=SUMSQ(A1:A5)")).toBe(10);
    expect(at("=RANK(3,A1:A5)")).toBe(1);
    expect(at("=MODE(A1:A4,1)")).toBe(1);
    expect(at("=MODE.SNGL(A1:A4,1)")).toBe(1);
    expect(at("=VAR.P(A1:A5)")).toBe(1);
    expect(at("=STDEV.P(A1:A5)")).toBe(1);
    expect(at("=PERCENTILE.EXC(A1:A5,0.5)")).toBe(2);
  });
  it("while a value typed into the call still counts, and typed text is #VALUE!", () => {
    expect(at("=SUMSQ(TRUE,2)")).toBe(5);
    expect(at('=SUMSQ("x")')).toEqual({ err: "#VALUE!" });
    expect(at("=STDEV(A1:A3,#N/A)")).toEqual({ err: "#N/A" });
  });
});

describe("two ranges side by side drop a row where either is not a number", () => {
  it("CORREL, SLOPE, INTERCEPT, RSQ, COVARIANCE and FORECAST", () => {
    // Left: (1,2) and (3,6); the blank A2 takes B2's 4 out with it.
    expect(at("=CORREL(A1:A3,B1:B3)")).toBeCloseTo(1, 12);
    expect(at("=SLOPE(B1:B3,A1:A3)")).toBeCloseTo(2, 12);
    expect(at("=INTERCEPT(B1:B3,A1:A3)")).toBeCloseTo(0, 12);
    expect(at("=RSQ(B1:B3,A1:A3)")).toBeCloseTo(1, 12);
    expect(at("=COVARIANCE.P(A1:A3,B1:B3)")).toBeCloseTo(2, 12);
    expect(at("=FORECAST(2,B1:B3,A1:A3)")).toBeCloseTo(4, 12);
    expect(at("=FORECAST.LINEAR(2,B1:B3,A1:A3)")).toBeCloseTo(4, 12);
    expect(at("=COVARIANCE.S(A1:A3,B1:B3)")).toBeCloseTo(4, 12);
  });
  it("and are #N/A when their sizes differ, and pass on an error in either", () => {
    expect(at("=CORREL(A1:A2,B1:B3)")).toMatchObject({ err: "#N/A" });
    expect(at("=CORREL({1,2,3},{2,#DIV/0!,6})")).toMatchObject({ err: "#DIV/0!" });
    expect(at("=SLOPE({2,#NUM!,6},{1,2,3})")).toMatchObject({ err: "#NUM!" });
  });
});

describe("one value where an array is wanted", () => {
  it("VSTACK and HSTACK take it as a 1×1 array", () => {
    expect(at('=VSTACK("Name",A1:A3)', 4)).toEqual(["Name", 1, 0, 3]);
    expect(at("=VSTACK(1,2)", 2)).toEqual([1, 2]);
    expect(at("=VSTACK(A2,A3)", 2)).toEqual([0, 3]);
  });
  it("TAKE, CHOOSECOLS and LARGE take one cell", () => {
    expect(at("=TAKE(A1,1)")).toBe(1);
    expect(at("=CHOOSECOLS(A3,1)")).toBe(3);
    expect(at("=CHOOSEROWS(A1:A3,-1)")).toBe(3);
    expect(at("=LARGE(A1,1)")).toBe(1);
    expect(at("=DROP(A1,1)")).toMatchObject({ err: "#CALC!" });
  });
});
