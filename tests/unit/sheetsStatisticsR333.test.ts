// Statistics Excel has (R333).
//
// FOUND IN R329's inventory: these were #NAME?. formula.js has most, but its
// T.TEST ignores tails and type (0.192 for every test, the page's paired one
// being 0.196), its F.TEST was 0.614 for the page's 0.648, its CHISQ.TEST is
// rounded to six places, and its MODE.MULT is in the wrong order and shape.
//
// The page examples come from each function's page in Excel's documentation.
// The other t-test values come from an independent oracle: the incomplete
// beta by Numerical Recipes' continued fraction, in Python, written apart
// from the engine's jStat. Welch's degrees of freedom are not rounded, as
// Excel's T.TEST does (the Analysis ToolPak rounds them; T.TEST does not).
import { describe, expect, it } from "vitest";

import { WorkbookEngine } from "@/lib/sheets/engine";
import { FUNCTIONS, LIFTS } from "@/lib/sheets/formula/functions";
import type { Value } from "@/lib/sheets/formula/values";
import { FUNCTION_HELP } from "@/lib/sheets/functionHelp";
import { toFileFormula } from "@/lib/sheets/xlsx";

// A1:A9 and B1:B9 are T.TEST's page example; A11 is text and A12 TRUE.
const cells: Record<string, { i: string }> = {};
[3, 4, 5, 8, 9, 1, 2, 4, 5].forEach((v, r) => (cells[`${r},0`] = { i: String(v) }));
[6, 19, 3, 2, 14, 4, 5, 17, 1].forEach((v, r) => (cells[`${r},1`] = { i: String(v) }));
cells["10,0"] = { i: "n/a" };
cells["11,0"] = { i: "TRUE" };
const e = new WorkbookEngine([{ id: "s", name: "S", kind: "grid", grid: { cells } }]);
const plain = (v: Value): unknown =>
  Array.isArray(v) ? v.map(plain) : v && typeof v === "object" && "err" in v ? { err: v.err } : v;
const at = (f: string) => {
  const v = plain(e.evaluateAt("s", 20, 5, f, { array: true })) as unknown;
  return Array.isArray(v) && v.length === 1 && Array.isArray(v[0]) && v[0].length === 1
    ? v[0][0]
    : v;
};
/** To 9 significant digits. */
const same = (got: unknown, want: number) => {
  expect(typeof got, JSON.stringify(got)).toBe("number");
  expect(Math.abs((got as number) / want - 1)).toBeLessThan(1e-9);
};

const NEW = [
  ...["T.TEST", "TTEST", "F.TEST", "FTEST", "Z.TEST", "ZTEST", "CHISQ.TEST", "CHITEST", "COVAR"],
  ...["PEARSON", "STEYX", "SKEW.P", "STDEVPA", "VARPA", "MODE.MULT", "PROB", "SUMX2MY2"],
  ...["SUMX2PY2", "SUMXMY2", "BINOM.DIST.RANGE"],
];

describe("each is known, has help, and goes into a file as Excel names it", () => {
  it.each(NEW)("%s", (name) => {
    expect(FUNCTIONS[name]).toBeTypeOf("function");
    expect(FUNCTION_HELP[name]?.sig.startsWith(`${name}(`)).toBe(true);
  });
  it("with _xlfn. on the ones Excel added after 2007", () => {
    expect(toFileFormula("=T.TEST(A1:A9,B1:B9,2,1)+TTEST(A1:A9,B1:B9,2,1)+SKEW.P(A1:A9)")).toBe(
      "_xlfn.T.TEST(A1:A9,B1:B9,2,1)+TTEST(A1:A9,B1:B9,2,1)+_xlfn.SKEW.P(A1:A9)",
    );
  });
});

describe("the t-test", () => {
  it.each([
    // The page's example.
    ["=T.TEST(A1:A9, B1:B9, 2, 1)", 0.196015784925283],
    ["=TTEST(A1:A9, B1:B9, 2, 1)", 0.196015784925283],
    // The oracle's.
    ["=T.TEST(A1:A9, B1:B9, 1, 1)", 0.0980078924626413],
    ["=T.TEST(A1:A9, B1:B9, 2, 2)", 0.191995886760396],
    ["=T.TEST(A1:A9, B1:B9, 1, 2)", 0.0959979433801981],
    // Welch's, at 10.2552 degrees of freedom, unrounded.
    ["=T.TEST(A1:A9, B1:B9, 2, 3)", 0.202293923368678],
    ["=T.TEST(A1:A9, B1:B9, 1, 3)", 0.101146961684339],
    // Arrays of different sizes: the pooled variance weighs each by its own.
    ["=T.TEST(A1:A9, B1:B5, 2, 2)", 0.13661889795746007],
    ["=T.TEST(A1:A9, B1:B5, 2, 3)", 0.27455922622496887],
  ])("%s is %s", (f, want) => {
    expect(Math.abs((at(f) as number) / want - 1)).toBeLessThan(1e-7);
  });

  it("is the same either way round, and with the types written as decimals", () => {
    same(at("=T.TEST(B1:B9, A1:A9, 2, 3)"), at("=T.TEST(A1:A9, B1:B9, 2, 3)") as number);
    same(at("=T.TEST(A1:A9, B1:B9, 2.9, 1.5)"), at("=T.TEST(A1:A9, B1:B9, 2, 1)") as number);
  });

  it.each([
    ["=T.TEST(A1:A9, B1:B9, 3, 1)", "#NUM!"],
    ["=T.TEST(A1:A9, B1:B9, 2, 4)", "#NUM!"],
    ["=T.TEST(A1:A9, B1:B9, 2, 0)", "#NUM!"],
    // Paired arrays of different sizes.
    ["=T.TEST(A1:A8, B1:B9, 2, 1)", "#N/A"],
    ["=T.TEST({1}, {2}, 2, 2)", "#DIV/0!"],
    ["=T.TEST({1,1}, {2,2}, 2, 2)", "#DIV/0!"],
    ["=T.TEST(A1:A9, B1:B9, 2)", "#N/A"],
  ])("%s is %s", (f, want) => {
    expect(at(f)).toEqual({ err: want });
  });
});

describe("the other tests", () => {
  it.each([
    ["=F.TEST({6,7,9,15,21}, {20,28,31,38,40})", 0.64831785],
    ["=FTEST({6,7,9,15,21}, {20,28,31,38,40})", 0.64831785],
    ["=Z.TEST({3,6,7,8,6,5,4,2,1,9}, 4)", 0.090574],
    ["=Z.TEST({3,6,7,8,6,5,4,2,1,9}, 6)", 0.863043],
    ["=ZTEST({3,6,7,8,6,5,4,2,1,9}, 4)", 0.090574],
    ["=CHISQ.TEST({58,35;11,25;10,23}, {45.35,47.65;17.56,18.44;16.09,16.91})", 0.0003082],
    ["=CHITEST({58,35;11,25;10,23}, {45.35,47.65;17.56,18.44;16.09,16.91})", 0.0003082],
  ])("%s is %s", (f, want) => {
    expect(at(f) as number).toBeCloseTo(want, f.includes("CHI") ? 7 : 6);
  });

  it("agree with the oracle beyond the pages' digits", () => {
    same(at("=F.TEST({6,7,9,15,21}, {20,28,31,38,40})"), 0.648317846786175);
    same(
      at("=CHISQ.TEST({58,35;11,25;10,23}, {45.35,47.65;17.56,18.44;16.09,16.91})"),
      0.0003081920170083095,
    );
    // Z.TEST with sigma given is 1 − Φ((mean − x)/(σ/√n)): the mean is 5.1.
    same(at("=Z.TEST({3,6,7,8,6,5,4,2,1,9}, 4, 2)"), 0.04099516050019153);
  });

  it.each([
    ["=F.TEST({1}, {1,2})", "#DIV/0!"],
    ["=F.TEST({2,2}, {1,2})", "#DIV/0!"],
    ["=Z.TEST(A11, 4)", "#N/A"],
    ["=Z.TEST({1,2}, 1, 0)", "#DIV/0!"],
    ["=CHISQ.TEST({1,2}, {1,2,3})", "#N/A"],
    ["=CHISQ.TEST({1,2}, {0,2})", "#DIV/0!"],
    ["=CHISQ.TEST(1, 1)", "#N/A"],
  ])("%s is %s", (f, want) => {
    expect(at(f)).toEqual({ err: want });
  });

  it("Z.TEST lifts its x", () => {
    const v = at("=Z.TEST({3,6,7,8,6,5,4,2,1,9}, {4,6})") as number[][];
    expect(v[0][0]).toBeCloseTo(0.090574, 6);
    expect(v[0][1]).toBeCloseTo(0.863043, 6);
    expect(LIFTS.has("Z.TEST")).toBe(true);
  });
});

describe("the rest, as on their pages", () => {
  it.each([
    ["=COVAR({3,2,4,5,6}, {9,7,12,15,17})", 5.2],
    ["=PEARSON({9,7,5,3,1}, {10,6,1,5,3})", 0.699379],
    ["=STEYX({2,3,9,1,8,7,5}, {6,5,11,7,5,4,4})", 3.305719],
    ["=SKEW.P({3,4,5,2,3,4,5,6,4,7})", 0.303193],
    ["=STDEVPA({1345,1301,1368,1322,1310,1370,1318,1350,1303,1299})", 26.05456],
    ["=VARPA({1345,1301,1368,1322,1310,1370,1318,1350,1303,1299})", 678.84],
    ["=PROB({0,1,2,3}, {0.2,0.3,0.1,0.4}, 2)", 0.1],
    ["=PROB({0,1,2,3}, {0.2,0.3,0.1,0.4}, 1, 3)", 0.8],
    // These add up to 0.9999999999999999 as stored, and to 1 at Excel's 15 digits.
    ["=PROB({1,2,3}, {0.7,0.2,0.1}, 2, 3)", 0.3],
    ["=SUMX2MY2({2,3,9,1,8,7,5}, {6,5,11,7,5,4,4})", -55],
    ["=SUMX2PY2({2,3,9,1,8,7,5}, {6,5,11,7,5,4,4})", 521],
    ["=SUMXMY2({2,3,9,1,8,7,5}, {6,5,11,7,5,4,4})", 79],
    ["=BINOM.DIST.RANGE(60, 0.75, 48)", 0.084],
    ["=BINOM.DIST.RANGE(60, 0.75, 45, 50)", 0.524],
  ])("%s is %s", (f, want) => {
    expect(at(f) as number).toBeCloseTo(want, f.includes("BINOM") ? 3 : 5);
  });

  it("MODE.MULT lists every most frequent value down a column, in the order they appear", () => {
    expect(at("=MODE.MULT({1,2,3,4,3,2,1,2,3,5,6,1})")).toEqual([[1], [2], [3]]);
    expect(at("=MODE.MULT({5,5,2,2,9})")).toEqual([[5], [2]]);
    expect(at("=MODE.MULT({1,2,3})")).toEqual({ err: "#N/A" });
  });

  it("STDEVPA and VARPA count text as 0 and TRUE as 1 from a range", () => {
    // A9:A12 is 5, a blank, "n/a" and TRUE: 5, 0 and 1, the blank left out.
    same(at("=VARPA(A9:A12)"), 14 / 3);
    same(at("=STDEVPA(A9:A12)"), Math.sqrt(14 / 3));
  });

  it.each([
    ["=PROB({0,1}, {0.5,0.6}, 1)", "#NUM!"],
    ["=PROB({0,1}, {1.5,-0.5}, 1)", "#NUM!"],
    ["=PROB({0,1,2}, {0.5,0.5}, 1)", "#N/A"],
    ["=STEYX({1,2}, {1,2})", "#DIV/0!"],
    ["=SKEW.P({1,2})", "#DIV/0!"],
    ["=SUMXMY2({1,2}, {1,2,3})", "#N/A"],
    ["=BINOM.DIST.RANGE(60, 1.5, 45)", "#NUM!"],
    ["=BINOM.DIST.RANGE(60, 0.75, 61)", "#NUM!"],
    ["=BINOM.DIST.RANGE(60, 0.75, 50, 45)", "#NUM!"],
  ])("%s is %s", (f, want) => {
    expect(at(f)).toEqual({ err: want });
  });
});
