// Functions Excel has that Sheets lacked (R147), each checked against the
// answer Excel's documentation gives. Found listing 187 everyday functions:
// 41 were #NAME? when typed, and seven of those had been listed for the
// formula.js long tail and never registered, without a word, because
// formula.js exports them as groups (STDEV.S and STDEV.P under STDEV).
import { describe, expect, it } from "vitest";

import { WorkbookEngine } from "@/lib/sheets/engine";
import { TABLE_PUSHDOWN } from "@/lib/sheets/formula/evaluate";
import { FUNCTION_NAMES, LIBRARY_NAMES } from "@/lib/sheets/formula/functions";
import { dateSerial, type Value } from "@/lib/sheets/formula/values";

// A1:A5 = 1..5, A6 = SUBTOTAL(9,A1:A5); the filter hides row 2, row 4 is hidden by hand.
// B1:B8 = 2,4,4,4,5,5,7,9. D1 = A1*2. Sheet "Q 3" has 42 in D4.
function engine() {
  const cells: Record<string, { i: string }> = {};
  [1, 2, 3, 4, 5].forEach((v, r) => (cells[`${r},0`] = { i: String(v) }));
  cells["5,0"] = { i: "=SUBTOTAL(9,A1:A5)" };
  [2, 4, 4, 4, 5, 5, 7, 9].forEach((v, r) => (cells[`${r},1`] = { i: String(v) }));
  cells["0,3"] = { i: "=A1*2" };
  return new WorkbookEngine([
    {
      id: "s",
      name: "S",
      kind: "grid",
      grid: { cells, filter: { range: "A1:A6", cols: {}, hidden: [1] }, hiddenRows: [3] },
    },
    { id: "q", name: "Q 3", kind: "grid", grid: { cells: { "3,3": { i: "42" } } } },
  ]);
}
const e = engine();
const plain = (v: Value): unknown =>
  Array.isArray(v) ? v.map(plain) : v && typeof v === "object" && "err" in v ? { err: v.err } : v;
const at = (f: string) => {
  const v = plain(e.evaluateAt("s", 9, 9, f, { array: true })) as unknown;
  return Array.isArray(v) && v.length === 1 && Array.isArray(v[0]) && v[0].length === 1
    ? v[0][0]
    : v;
};

describe("R147: every function listed is there", () => {
  it("each name listed for formula.js registers, so a silent miss fails here", () => {
    const have = new Set(FUNCTION_NAMES);
    expect(LIBRARY_NAMES.filter((n) => !have.has(n))).toEqual([]);
  });

  it("each function the lakehouse computes over a table sheet also works on a grid", () => {
    const have = new Set(FUNCTION_NAMES);
    expect([...TABLE_PUSHDOWN].filter((n) => !have.has(n))).toEqual([]);
  });

  it("the legacy names Excel still takes", () => {
    expect(at("=STDEV(B1:B8)")).toBeCloseTo(2.138089935299395, 12);
    expect(at("=VAR(B1:B8)")).toBeCloseTo(4.571428571428571, 12);
    expect(at("=PERCENTILE({1,2,3,4},0.25)")).toBe(1.75);
    expect(at("=QUARTILE({1,2,3,4},1)")).toBe(1.75);
    expect(at("=RANK(3,{1,3,5})")).toBe(2);
    expect(at("=MODE({1,2,2,3})")).toBe(2);
    expect(at("=FORECAST.LINEAR(4,{2,4,6},{1,2,3})")).toBe(8);
  });
});

describe("R147: SUBTOTAL, as Excel counts it", () => {
  it("leaves out filtered rows, hand-hidden ones for 101–111, and other subtotals", () => {
    expect(at("=SUBTOTAL(9,A1:A5)")).toBe(13); // row 2 filtered out
    expect(at("=SUBTOTAL(109,A1:A5)")).toBe(9); // row 4 hidden by hand too
    expect(at("=SUBTOTAL(9,A1:A6)")).toBe(13); // A6 is a subtotal: not counted again
    expect(at("=SUBTOTAL(1,A1:A5)")).toBe(13 / 4);
    expect(at("=SUBTOTAL(3,A1:A6)")).toBe(4);
    expect(at("=SUBTOTAL(12,A1:A5)")).toEqual({ err: "#VALUE!" });
  });

  it("recomputes when a filter is applied or cleared", () => {
    const g = engine();
    expect(g.getValue("s", 5, 0)).toBe(13);
    g.setGridMeta("s", { filter: { range: "A1:A6", cols: {} } });
    expect(g.getValue("s", 5, 0)).toBe(15);
  });
});

describe("R147: lookups, references and names", () => {
  it("LOOKUP, vector and array forms", () => {
    expect(at('=LOOKUP(4,{1,3,5},{"a","b","c"})')).toBe("b");
    expect(at("=LOOKUP(6,{1,3,5})")).toBe(5);
    expect(at('=LOOKUP(3,{1,"a";3,"b";5,"c"})')).toBe("b");
    expect(at("=LOOKUP(0,{1,3,5})")).toEqual({ err: "#N/A" });
  });

  it("OFFSET, INDIRECT and ADDRESS", () => {
    expect(at("=OFFSET(A1,1,0)")).toBe(2);
    expect(at("=SUM(OFFSET(A1,0,0,3,1))")).toBe(6);
    expect(at("=OFFSET(A1,-1,0)")).toEqual({ err: "#REF!" });
    expect(at('=INDIRECT("A"&3)')).toBe(3);
    expect(at('=SUM(INDIRECT("A1:A3"))')).toBe(6);
    expect(at("=INDIRECT(\"'Q 3'!D4\")")).toBe(42);
    expect(at('=INDIRECT("nope")')).toEqual({ err: "#REF!" });
    expect(at("=ADDRESS(2,3)")).toBe("$C$2");
    expect(at("=ADDRESS(2,3,4)")).toBe("C2");
    expect(at("=ADDRESS(2,3,2)")).toBe("C$2");
    expect(at('=ADDRESS(2,3,1,TRUE,"Sheet 1")')).toBe("'Sheet 1'!$C$2");
    expect(at("=ADDRESS(2,3,1,FALSE)")).toBe("R2C3");
  });

  it("LET gives values names", () => {
    expect(at("=LET(x,2,y,3,x*y)")).toBe(6);
    expect(at("=LET(x,A1:A3,SUM(x))")).toBe(6);
    expect(at("=LET(x,2,LET(y,x+1,x*y))")).toBe(6);
    expect(at("=LET(x,2)")).toEqual({ err: "#VALUE!" });
  });

  it("HYPERLINK, ISREF, ISFORMULA, FORMULATEXT", () => {
    expect(at('=HYPERLINK("https://x.com","X")')).toBe("X");
    expect(at('=HYPERLINK("https://x.com")')).toBe("https://x.com");
    expect(at("=ISREF(A1)")).toBe(true);
    expect(at("=ISREF(1)")).toBe(false);
    expect(at("=ISREF(OFFSET(A1,1,0))")).toBe(true);
    expect(at("=ISFORMULA(D1)")).toBe(true);
    expect(at("=ISFORMULA(A1)")).toBe(false);
    expect(at("=FORMULATEXT(D1)")).toBe("=A1*2");
    expect(at("=FORMULATEXT(A1)")).toEqual({ err: "#N/A" });
  });
});

describe("R147: numbers, times and dates", () => {
  it("TIME, TIMEVALUE, NUMBERVALUE, SUMSQ", () => {
    expect(at("=TIME(14,30,0)")).toBeCloseTo(0.6041666666666666, 12);
    expect(at("=TIME(25,0,0)")).toBeCloseTo(1 / 24, 12);
    expect(at('=TIMEVALUE("6:30 PM")')).toBeCloseTo(0.7708333333333334, 12);
    expect(at('=NUMBERVALUE("2.500,27",",",".")')).toBe(2500.27);
    expect(at('=NUMBERVALUE("3.5%")')).toBeCloseTo(0.035, 12);
    expect(at("=SUMSQ(3,4)")).toBe(25);
    expect(at("=SUMSQ(B1:B2)")).toBe(20);
  });

  it("CEILING.MATH and FLOOR.MATH, negatives included", () => {
    expect(at("=CEILING.MATH(4.3)")).toBe(5);
    expect(at("=CEILING.MATH(-4.3)")).toBe(-4);
    expect(at("=CEILING.MATH(-4.3,1,1)")).toBe(-5);
    expect(at("=FLOOR.MATH(4.7)")).toBe(4);
    expect(at("=FLOOR.MATH(-4.3)")).toBe(-5);
    expect(at("=FLOOR.MATH(-4.3,1,1)")).toBe(-4);
  });

  it("working days with any weekend, and trends", () => {
    // September 2026 starts on a Tuesday: 22 weekdays, 26 days that are not Sundays.
    expect(at("=NETWORKDAYS.INTL(DATE(2026,9,1),DATE(2026,9,30))")).toBe(22);
    expect(at("=NETWORKDAYS.INTL(DATE(2026,9,1),DATE(2026,9,30),11)")).toBe(26);
    expect(at('=NETWORKDAYS.INTL(DATE(2026,9,1),DATE(2026,9,30),"0000011")')).toBe(22);
    expect(at("=WORKDAY.INTL(DATE(2026,9,4),1)")).toBe(dateSerial(2026, 9, 7));
    expect(at("=TREND({1,2,3},{1,2,3},4)")).toBe(4);
    expect(at("=GROWTH({2,4,8},{1,2,3},4)")).toBeCloseTo(16, 9);
    expect(at("=FREQUENCY({1,2,2,3,5},{2,4})")).toEqual([[3], [1], [1]]);
  });
});

describe("R147: shaping arrays and splitting text", () => {
  it("TAKE, DROP, CHOOSECOLS, CHOOSEROWS, VSTACK, HSTACK, TOCOL, TOROW", () => {
    expect(at("=TAKE({1,2;3,4;5,6},2)")).toEqual([
      [1, 2],
      [3, 4],
    ]);
    expect(at("=TAKE({1,2;3,4;5,6},-1)")).toEqual([[5, 6]]);
    expect(at("=TAKE({1,2;3,4;5,6},,1)")).toEqual([[1], [3], [5]]);
    expect(at("=DROP({1,2;3,4;5,6},1)")).toEqual([
      [3, 4],
      [5, 6],
    ]);
    expect(at("=CHOOSECOLS({1,2;3,4;5,6},-1)")).toEqual([[2], [4], [6]]);
    expect(at("=CHOOSEROWS({1,2;3,4;5,6},1,3)")).toEqual([
      [1, 2],
      [5, 6],
    ]);
    expect(at("=VSTACK({1,2},{3})")).toEqual([
      [1, 2],
      [3, { err: "#N/A" }],
    ]);
    expect(at("=HSTACK({1;2},{3;4})")).toEqual([
      [1, 3],
      [2, 4],
    ]);
    expect(at("=TOCOL({1,2;3,4},0,TRUE)")).toEqual([[1], [3], [2], [4]]);
    expect(at("=TOROW({1;2})")).toEqual([[1, 2]]);
  });

  it("TEXTSPLIT, TEXTBEFORE, TEXTAFTER", () => {
    expect(at('=TEXTSPLIT("a,b;c,d",",",";")')).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
    expect(at('=TEXTSPLIT("a,,b",",",,TRUE)')).toEqual([["a", "b"]]);
    expect(at('=TEXTSPLIT("a,b;c",",",";")')).toEqual([
      ["a", "b"],
      ["c", { err: "#N/A" }],
    ]);
    expect(at('=TEXTBEFORE("john.smith@x.com","@")')).toBe("john.smith");
    expect(at('=TEXTAFTER("a-b-c","-",2)')).toBe("c");
    expect(at('=TEXTAFTER("a-b-c","-",-1)')).toBe("c");
    expect(at('=TEXTBEFORE("a-b-c","-",-1)')).toBe("a-b");
    expect(at('=TEXTBEFORE("abc","-")')).toEqual({ err: "#N/A" });
    expect(at('=TEXTBEFORE("abc","-",,,,"none")')).toBe("none");
    expect(at('=TEXTAFTER("abc","-",1,0,1)')).toBe("");
  });
});
