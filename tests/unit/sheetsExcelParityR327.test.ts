// Four places Sheets answered differently from Excel (R327).
//
// FOUND IN R327, probing the engine against the gap list:
// - UPPER and LOWER used JavaScript's full case mapping: =UPPER("ß") was "SS";
// - the comparison operators compared the stored doubles: =0.1+0.2=0.3 was FALSE;
// - INDIRECT refused R1C1 text outright;
// - AGGREGATE was #NAME?.
import { describe, expect, it } from "vitest";

import { WorkbookEngine } from "@/lib/sheets/engine";
import type { Value } from "@/lib/sheets/formula/values";

// A1:A5 = 1..5 with row 2 filtered out and row 4 hidden by hand; A6 = SUBTOTAL(9,A1:A5).
// B1:B5 = 10, 20, =1/0, 40, 50. Sheet "Other" has 7 in B2.
function engine() {
  const cells: Record<string, { i: string }> = {};
  [1, 2, 3, 4, 5].forEach((v, r) => (cells[`${r},0`] = { i: String(v) }));
  cells["5,0"] = { i: "=SUBTOTAL(9,A1:A5)" };
  ["10", "20", "=1/0", "40", "50"].forEach((v, r) => (cells[`${r},1`] = { i: v }));
  return new WorkbookEngine([
    {
      id: "s",
      name: "S",
      kind: "grid",
      grid: { cells, filter: { range: "A1:A6", cols: {}, hidden: [1] }, hiddenRows: [3] },
    },
    { id: "o", name: "Other", kind: "grid", grid: { cells: { "1,1": { i: "7" } } } },
  ]);
}
const e = engine();
const plain = (v: Value): unknown =>
  Array.isArray(v) ? v.map(plain) : v && typeof v === "object" && "err" in v ? { err: v.err } : v;
/** Evaluated at J10 (row 9, column 9), clear of the data. */
const at = (f: string) => {
  const v = plain(e.evaluateAt("s", 9, 9, f, { array: true })) as unknown;
  return Array.isArray(v) && v.length === 1 && Array.isArray(v[0]) && v[0].length === 1
    ? v[0][0]
    : v;
};

describe("UPPER and LOWER change case one character for one, as Excel does", () => {
  it.each([
    ['=UPPER("ß")', "ß"],
    ['=UPPER("straße")', "STRAßE"],
    ['=UPPER("ﬁne")', "ﬁNE"],
    ['=UPPER("abc é")', "ABC É"],
    ['=LOWER("İSTANBUL")', "istanbul"],
    ['=LOWER("ΟΔΟΣ")', "οδοσ"],
    ['=LOWER("ABC É")', "abc é"],
  ])("%s is %s", (f, want) => {
    expect(at(f)).toBe(want);
  });
});

describe("the comparison operators compare numbers to 15 significant digits", () => {
  it.each([
    ["=0.1+0.2=0.3", true],
    ["=0.1+0.2<>0.3", false],
    ["=(0.1+0.2)>0.3", false],
    ["=(0.1+0.2)<0.3", false],
    ["=(0.1+0.2)>=0.3", true],
    ["=1=1+1E-15", true],
    ["=1=1+1E-14", false],
    ["=1.1+2.2=3.3", true],
    ['=IF(0.1+0.2=0.3,"same","different")', "same"],
    ["=2<3", true],
    ['="a"="A"', true],
    ["=0=0", true],
  ])("%s is %s", (f, want) => {
    expect(at(f)).toBe(want);
  });

  it("but MATCH still compares the stored values, as Excel's does", () => {
    expect(at("=MATCH(0.3,{0.1,0.2,0.30000000000000004},0)")).toEqual({ err: "#N/A" });
  });
});

describe("INDIRECT reads R1C1 text", () => {
  it.each([
    ['=INDIRECT("R1C1",FALSE)', 1],
    ['=INDIRECT("R4C1",FALSE)', 4],
    ['=INDIRECT("r1c2",FALSE)', 10],
    ['=SUM(INDIRECT("R1C1:R5C1",FALSE))', 15],
    ['=INDIRECT("Other!R2C2",FALSE)', 7],
    // J10 is row 10, column 10: R[-9]C[-9] is A1, R[-8]C[-9] is A2.
    ['=INDIRECT("R[-9]C[-9]",FALSE)', 1],
    ['=INDIRECT("R[-8]C[-9]",FALSE)', 2],
  ])("%s is %s", (f, want) => {
    expect(at(f)).toBe(want);
  });

  it("and says what it wanted when the text is not R1C1, or is off the sheet", () => {
    expect(at('=INDIRECT("A1",FALSE)')).toEqual({ err: "#REF!" });
    expect(at('=INDIRECT("R[-20]C",FALSE)')).toEqual({ err: "#REF!" });
  });

  it("still reads A1 text by default", () => {
    expect(at('=INDIRECT("A3")')).toBe(3);
  });
});

describe("AGGREGATE", () => {
  it.each([
    // 1..5, with row 2 filtered and row 4 hidden by hand; option 4 ignores nothing.
    ["=AGGREGATE(9,4,A1:A5)", 15],
    ["=AGGREGATE(9,5,A1:A5)", 9],
    ["=AGGREGATE(1,5,A1:A5)", 3],
    ["=AGGREGATE(4,1,A1:A5)", 5],
    ["=AGGREGATE(2,4,A1:A6)", 6],
    // A6 is a SUBTOTAL: options 0 to 3 leave it out, 4 to 7 count it.
    ["=AGGREGATE(9,0,A1:A6)", 15],
    ["=AGGREGATE(9,4,A1:A6)", 28],
    // B3 is #DIV/0!: options 2, 3, 6 and 7 skip it.
    ["=AGGREGATE(9,6,B1:B5)", 120],
    ["=AGGREGATE(4,2,B1:B5)", 50],
    ["=AGGREGATE(12,6,B1:B5)", 30],
    // 14 to 19 take an array and k; errors in a computed array are skipped too.
    ["=AGGREGATE(14,4,A1:A5,2)", 4],
    ["=AGGREGATE(15,4,A1:A5,1)", 1],
    ["=AGGREGATE(14,6,A1:A5/(A1:A5<4),1)", 3],
    ["=AGGREGATE(15,6,A1:A5/(A1:A5>2),1)", 3],
    ["=AGGREGATE(16,4,A1:A5,0.5)", 3],
    ["=AGGREGATE(17,4,A1:A5,1)", 2],
  ])("%s is %s", (f, want) => {
    expect(at(f)).toBe(want);
  });

  it.each([
    ["=AGGREGATE(9,4,B1:B5)", "#DIV/0!"],
    ["=AGGREGATE(20,4,A1:A5)", "#VALUE!"],
    ["=AGGREGATE(9,8,A1:A5)", "#VALUE!"],
    ["=AGGREGATE(14,4,A1:A5)", "#VALUE!"],
    ["=AGGREGATE(9,4)", "#VALUE!"],
  ])("%s is %s", (f, want) => {
    expect(at(f)).toEqual({ err: want });
  });
});
