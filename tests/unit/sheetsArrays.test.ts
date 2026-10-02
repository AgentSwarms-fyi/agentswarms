// Array formulas, answered as Excel answers them. Found probing the idioms
// people use every day (SUMPRODUCT with ISNUMBER(SEARCH()), MAX(IF()),
// TEXTJOIN(IF()), counts over whole columns): 15 of 24 were wrong, silently.
//   R144 functions of one value looked only at an array's first element;
//   R145 IF over an array took each branch's first value;
//   R146 arithmetic over a whole column left out the blank rows past the data.
import { describe, expect, it } from "vitest";

import { MAX_ROWS } from "@/lib/sheets/a1";
import { extend, tailOf, wholeRange, withTail, zipN } from "@/lib/sheets/formula/arrays";
import { WorkbookEngine } from "@/lib/sheets/engine";

// S: A1:A3 apple, banana, cherry; B1:B3 10, 20, 30; D1:D2 banana, kiwi.
// T: A1 apple, A5 x; B1 5, B5 7 (used five rows deep).
function engine() {
  const cells = (m: Record<string, string>) =>
    Object.fromEntries(Object.entries(m).map(([k, i]) => [k, { i }]));
  return new WorkbookEngine([
    {
      id: "s",
      name: "S",
      kind: "grid",
      grid: {
        cells: cells({
          "0,0": "apple",
          "1,0": "banana",
          "2,0": "cherry",
          "0,1": "10",
          "1,1": "20",
          "2,1": "30",
          "0,3": "banana",
          "1,3": "kiwi",
        }),
      },
    },
    {
      id: "t",
      name: "T",
      kind: "grid",
      grid: { cells: cells({ "0,0": "apple", "4,0": "x", "0,1": "5", "4,1": "7" }) },
    },
  ]);
}
const e = engine();
const at = (f: string) => e.evaluateAt("s", 0, 6, f);
const M = MAX_ROWS;

describe("R144: a function of one value, given an array, answers for each element", () => {
  it("the IS functions and NOT", () => {
    expect(at("=SUMPRODUCT(--ISBLANK(A1:A5))")).toBe(2);
    expect(at("=SUMPRODUCT(--NOT(ISBLANK(A1:A5)))")).toBe(3);
    expect(at("=SUMPRODUCT(--ISTEXT(A1:A5))")).toBe(3);
    expect(at("=SUMPRODUCT(--ISNUMBER(B1:B5))")).toBe(3);
    expect(at("=SUMPRODUCT(--ISERROR(B1:B3/0))")).toBe(3);
  });

  it("text, maths and dates", () => {
    expect(at('=SUMPRODUCT(--ISNUMBER(SEARCH("an",A1:A5)))')).toBe(1);
    expect(at('=SUMPRODUCT(--ISNUMBER(FIND("e",A1:A5)))')).toBe(2);
    expect(at("=SUMPRODUCT(LEN(A1:A3))")).toBe(17);
    expect(at("=SUMPRODUCT(ROUND(B1:B3/7,0))")).toBe(8);
    expect(at("=SUMPRODUCT(--(YEAR(DATE(2026,{1,2},1))=2026))")).toBe(2);
  });

  it("the one-value argument of a function that takes ranges: lookups and criteria", () => {
    expect(at('=SUM(IFNA(MATCH(A1:A3,{"apple","cherry"},0),0))')).toBe(3);
    expect(at('=SUM(COUNTIF(A:A,{"apple","cherry"}))')).toBe(2);
    expect(at('=SUM(SUMIF(A:A,{"apple","cherry"},B:B))')).toBe(40);
    expect(at('=SUM(COUNTIFS(A:A,{"apple","banana"},B:B,">15"))')).toBe(1);
    expect(at('=SUM(SUMIFS(B:B,A:A,{"apple","cherry"}))')).toBe(40);
    expect(at("=SUM(IFERROR(VLOOKUP(D1:D2,A1:B3,2,FALSE),0))")).toBe(20);
    expect(at("=SUM(XLOOKUP(D1:D2,A1:A3,B1:B3,0))")).toBe(20);
    // The range arguments themselves never lift.
    expect(at('=MATCH("banana",A:A,0)')).toBe(2);
    expect(at('=VLOOKUP("banana",A:B,2,FALSE)')).toBe(20);
  });

  it("one value in, one value out, as before", () => {
    expect(at("=ISBLANK(A5)")).toBe(true);
    expect(at('=IF(A1="apple","y","n")')).toBe("y");
    expect(at('=COUNTIF(A:A,"apple")')).toBe(1);
  });
});

describe("R145: IF over an array takes each branch's element in the same place", () => {
  it("MAX(IF()), TEXTJOIN(IF()), SUM(IF())", () => {
    expect(at('=MAX(IF(A1:A3<>"banana",B1:B3))')).toBe(30);
    expect(at('=TEXTJOIN(",",TRUE,IF(B1:B3>15,A1:A3,""))')).toBe("banana,cherry");
    expect(at('=SUM(IF(A1:A5="",1,0))')).toBe(2);
    // With no "else", FALSE, which COUNTA counts.
    expect(at('=COUNTA(IF(A1:A5<>"",A1:A5))')).toBe(5);
  });

  it("IFERROR and IFNA replace each error with the fallback's element", () => {
    expect(e.evaluateAt("s", 0, 6, '=IFERROR(B1:B3/{0;1;0},"z")', { array: true })).toEqual([
      ["z"],
      [20],
      ["z"],
    ]);
    // A fallback that is an array gives each error its own element.
    expect(e.evaluateAt("s", 0, 6, "=IFERROR(B1:B3/{0;1;0},A1:A3)", { array: true })).toEqual([
      ["apple"],
      [20],
      ["cherry"],
    ]);
    expect(
      e.evaluateAt("s", 0, 6, '=IFNA(MATCH(A1:A3,{"apple","cherry"},0),0)', { array: true }),
    ).toEqual([[1], [0], [2]]);
  });
});

describe("R146: arithmetic over a whole column counts the blank rows past the data", () => {
  it("SUMPRODUCT, SUM, COUNT, AVERAGE, MIN, MAX, MEDIAN", () => {
    expect(at('=SUMPRODUCT(--(A:A<>"x"))')).toBe(M);
    expect(at('=SUMPRODUCT(--(A:A=""))')).toBe(M - 3);
    expect(at("=SUMPRODUCT(ISBLANK(A:A)*1)")).toBe(M - 3);
    expect(at("=SUMPRODUCT(--(LEN(A:A)=0))")).toBe(M - 3);
    expect(at('=SUM(--(A:A=""))')).toBe(M - 3);
    expect(at('=COUNT(IF(A:A="",1))')).toBe(M - 3);
    expect(at('=AVERAGE(IF(A:A="",0,1))')).toBeCloseTo(3 / M, 12);
    expect(at('=MIN(IF(A:A="",5,B:B))')).toBe(5);
    expect(at('=MAX(IF(A:A="",-1,B:B))')).toBe(30);
    expect(at('=MEDIAN(IF(A:A="",0,B:B))')).toBe(0);
    // Blank rows that multiply to 0 change nothing.
    expect(at('=SUMPRODUCT((A:A="apple")*(B:B))')).toBe(10);
    expect(at('=SUMPRODUCT(--(A:A<>""),B:B)')).toBe(60);
    expect(at("=SUM(A:B)")).toBe(60);
    expect(at("=COUNTA(A:A)")).toBe(3);
  });

  it("whole columns of sheets used to different depths line up", () => {
    expect(at('=SUMPRODUCT((A:A="apple")*(T!B:B))')).toBe(5);
    // Rows 2, 3 and 5 differ; every other row matches, blank against blank.
    expect(at("=SUMPRODUCT(--(A:A=T!A:A))")).toBe(M - 3);
  });

  it("AND, OR, ROWS, INDEX and MATCH see the blank rows", () => {
    expect(at('=AND(A:A<>"zzz")')).toBe(true);
    expect(at('=OR(A:A="")')).toBe(true);
    expect(at('=ROWS(A:A="")')).toBe(M);
    expect(at('=INDEX(A:A="",500)')).toBe(true);
    // The first empty row, a well-known idiom.
    expect(at('=MATCH(TRUE,INDEX(A:A="",0),0)')).toBe(4);
  });

  it("spilled into the grid, a whole column shows only the rows the sheet uses", () => {
    const g = engine();
    g.setInput("s", 0, 8, '=A:A=""');
    expect(g.spillSize("s", 0, 8)).toEqual({ rows: 3, cols: 1 });
  });
});

describe("the tail itself", () => {
  it("a whole column read three rows deep has the rest as a blank tail", () => {
    const m = wholeRange([["a"], ["b"], ["c"]], "cols");
    expect(tailOf(m)).toEqual({ axis: "rows", n: M - 3, line: [null] });
  });

  it("operators carry it, a single row repeats across it, a shorter array drops it", () => {
    const col = wholeRange([[1], [2]], "cols");
    const plus = zipN([col, 10], ([x, y]) =>
      (x as number | null) === null ? y : (x as number) + (y as number),
    );
    expect(plus).toEqual([[11], [12]]);
    expect(tailOf(plus)?.line).toEqual([10]);
    const row = zipN([wholeRange([[1, 2]], "cols"), [[5, 6]]], ([x, y]) => `${x}|${y}`);
    expect(tailOf(row)?.line).toEqual(["null|5", "null|6"]);
    // A three-row array against a whole column: its rows past three are #N/A
    // in Excel; the answer keeps only what was read.
    expect(tailOf(zipN([col, [[1], [2], [3]]], ([x]) => x))).toBeUndefined();
  });

  it("extending makes part of the tail explicit, and the counts still add up", () => {
    const t = { axis: "rows" as const, n: 5, line: [0] };
    const m = withTail([[1]], t);
    const ex = extend(m, t, 3);
    expect(ex.m).toEqual([[1], [0], [0]]);
    expect(ex.t.n).toBe(3);
  });
});
