// Sheets: the Excel formula engine, checked against what Excel answers.
import { describe, expect, it } from "vitest";

import { WorkbookEngine, literalValue } from "@/lib/sheets/engine";
import { parseFormula } from "@/lib/sheets/formula/parser";
import { lex } from "@/lib/sheets/formula/lexer";
import { renameSheetInFormula, shiftFormula } from "@/lib/sheets/formula/shift";
import { formatValue } from "@/lib/sheets/format";
import { colIndex, colLetters, parseA1 } from "@/lib/sheets/a1";
import { dateSerial } from "@/lib/sheets/formula/values";

/** A one-sheet workbook from { A1: "input", ... }; returns a value reader. */
function book(
  cells: Record<string, string>,
  extra: { name: string; cells: Record<string, string> }[] = [],
) {
  const toGrid = (c: Record<string, string>) => {
    const out: Record<string, { i: string }> = {};
    for (const [a, i] of Object.entries(c)) {
      const p = parseA1(a)!;
      out[`${p.row},${p.col}`] = { i };
    }
    return { cells: out };
  };
  const e = new WorkbookEngine([
    { id: "s1", name: "Sheet1", kind: "grid", grid: toGrid(cells) },
    ...extra.map((x, k) => ({
      id: `x${k}`,
      name: x.name,
      kind: "grid" as const,
      grid: toGrid(x.cells),
    })),
  ]);
  const v = (a: string, sheet = "s1") => {
    const p = parseA1(a)!;
    return e.getValue(sheet, p.row, p.col);
  };
  const set = (a: string, input: string, sheet = "s1") => {
    const p = parseA1(a)!;
    e.setInput(sheet, p.row, p.col, input);
  };
  return { e, v, set };
}
const errOf = (x: unknown) =>
  x && typeof x === "object" && "err" in x ? (x as { err: string }).err : x;

describe("A1 addressing", () => {
  it("round-trips column letters to XFD", () => {
    for (const [l, i] of [
      ["A", 0],
      ["Z", 25],
      ["AA", 26],
      ["AZ", 51],
      ["XFD", 16383],
    ] as const) {
      expect(colIndex(l)).toBe(i);
      expect(colLetters(i)).toBe(l);
    }
    expect(colIndex("XFE")).toBe(-1);
  });
});

describe("the lexer and parser", () => {
  it("reads references of every shape", () => {
    const t = lex("SUM(A1:B2, $C$3, 'My Sheet'!D4, Other!E:E, 2:3, Orders[amount], [@qty])");
    const kinds = t.filter((x) => ["cell", "range", "struct"].includes(x.t)).map((x) => x.t);
    expect(kinds).toEqual(["range", "cell", "cell", "range", "range", "struct", "struct"]);
  });

  it("does not take a function name for a cell (LOG10, DAYS360)", () => {
    expect(lex("LOG10(100)")[0]).toMatchObject({ t: "func", name: "LOG10" });
  });

  it("follows Excel's precedence: -2^2 is 4, 2^3^2 is 64, & below +", () => {
    const { v } = book({
      A1: "=-2^2",
      A2: "=2^3^2",
      A3: '=1+2&"x"',
      A4: "=10%",
      A5: "=2*3+4",
      A6: "=2+3*4",
    });
    expect(v("A1")).toBe(4);
    expect(v("A2")).toBe(64);
    expect(v("A3")).toBe("3x");
    expect(v("A4")).toBe(0.1);
    expect(v("A5")).toBe(10);
    expect(v("A6")).toBe(14);
  });

  it("refuses a malformed formula with a reason", () => {
    expect(() => parseFormula("SUM(1,")).toThrow();
    const { v, e } = book({ A1: "=1+" });
    expect(errOf(v("A1"))).toBe("#NAME?");
    expect(e.getErrorDetail("s1", 0, 0)).toBeTruthy();
  });
});

describe("literals", () => {
  it("types what is typed", () => {
    expect(literalValue("42")).toBe(42);
    expect(literalValue("1,234.5")).toBe(1234.5);
    expect(literalValue("12%")).toBe(0.12);
    expect(literalValue("TRUE")).toBe(true);
    expect(literalValue("'42")).toBe("42");
    expect(literalValue("2024-01-05")).toBe(dateSerial(2024, 1, 5));
    expect(literalValue("hello")).toBe("hello");
    expect(literalValue("")).toBe(null);
  });
});

describe("arithmetic and errors", () => {
  it("propagates errors and divides by zero honestly", () => {
    const { v } = book({
      A1: "=1/0",
      A2: "=A1+1",
      A3: '="a"+1',
      A4: "=B9+1",
      A5: '=IFERROR(1/0,"none")',
    });
    expect(errOf(v("A1"))).toBe("#DIV/0!");
    expect(errOf(v("A2"))).toBe("#DIV/0!");
    expect(errOf(v("A3"))).toBe("#VALUE!");
    expect(v("A4")).toBe(1); // a blank is 0
    expect(v("A5")).toBe("none");
  });

  it("compares like Excel: text case-insensitive, numbers below text", () => {
    const { v } = book({ A1: '="abc"="ABC"', A2: '=1<"a"', A3: "=TRUE>1", A4: '=""=B9' });
    expect(v("A1")).toBe(true);
    expect(v("A2")).toBe(true);
    expect(v("A3")).toBe(true);
    expect(v("A4")).toBe(true);
  });

  it("reports a cycle instead of hanging", () => {
    const { v } = book({ A1: "=B1+1", B1: "=A1+1", C1: "=SUM(C1:C2)" });
    expect(errOf(v("A1"))).toBe("#CYCLE!");
    expect(errOf(v("B1"))).toBe("#CYCLE!");
    expect(errOf(v("C1"))).toBe("#CYCLE!");
  });
});

describe("aggregates", () => {
  const cells = { A1: "10", A2: "20", A3: "x", A4: "TRUE", A5: "", A6: "=1/0" };
  it("skip text and booleans in references but coerce direct arguments", () => {
    const { v } = book({
      ...cells,
      A6: "",
      B1: "=SUM(A1:A5)",
      B2: '=SUM(1,"2",TRUE)',
      B3: '=SUM("x")',
      B4: "=AVERAGE(A1:A5)",
      B5: "=COUNT(A1:A5)",
      B6: "=COUNTA(A1:A5)",
      B7: "=MIN(A1:A5)",
      B8: "=MAX(A1:A5)",
      B9: "=AVERAGE(C1:C3)",
    });
    expect(v("B1")).toBe(30);
    expect(v("B2")).toBe(4);
    expect(errOf(v("B3"))).toBe("#VALUE!");
    expect(v("B4")).toBe(15);
    expect(v("B5")).toBe(2);
    expect(v("B6")).toBe(4); // 10, 20, "x", TRUE
    expect(v("B7")).toBe(10);
    expect(v("B8")).toBe(20);
    expect(errOf(v("B9"))).toBe("#DIV/0!");
  });

  it("propagates an error inside the range", () => {
    const { v } = book({ ...cells, B1: "=SUM(A1:A6)" });
    expect(errOf(v("B1"))).toBe("#DIV/0!");
  });

  it("SUMIF(S) / COUNTIF(S) read Excel criteria, wildcards included", () => {
    const { v } = book({
      A1: "apple",
      A2: "banana",
      A3: "apricot",
      A4: "cherry",
      B1: "5",
      B2: "15",
      B3: "25",
      B4: "35",
      C1: '=SUMIF(A1:A4,"ap*",B1:B4)',
      C2: '=SUMIF(B1:B4,">10")',
      C3: '=COUNTIF(A1:A4,"<>banana")',
      C4: '=COUNTIFS(A1:A4,"a*",B1:B4,">=25")',
      C5: '=AVERAGEIF(A1:A4,"?pple",B1:B4)',
      C6: '=SUMIFS(B1:B4,A1:A4,"*r*")',
      C7: '=COUNTIF(A1:A4,"APPLE")',
    });
    expect(v("C1")).toBe(30);
    expect(v("C2")).toBe(75);
    expect(v("C3")).toBe(3);
    expect(v("C4")).toBe(1);
    expect(v("C5")).toBe(5);
    expect(v("C6")).toBe(60);
    expect(v("C7")).toBe(1);
  });
});

describe("logic", () => {
  it("IF evaluates only the branch it takes", () => {
    const { v } = book({
      A1: "=IF(TRUE,1,1/0)",
      A2: "=IF(FALSE,1)",
      A3: "=IF(1>2,,5)",
      A4: '=IFS(B1>5,"big",TRUE,"small")',
      B1: "3",
    });
    expect(v("A1")).toBe(1);
    expect(v("A2")).toBe(false);
    expect(v("A3")).toBe(5);
    expect(v("A4")).toBe("small");
  });

  it("AND/OR ignore text in ranges, and SWITCH falls through to its default", () => {
    const { v } = book({
      A1: "TRUE",
      A2: "x",
      A3: "=AND(A1:A2)",
      A4: '=SWITCH(2,1,"one",2,"two","other")',
      A5: '=SWITCH(9,1,"one","other")',
    });
    expect(v("A3")).toBe(true);
    expect(v("A4")).toBe("two");
    expect(v("A5")).toBe("other");
  });
});

describe("lookups", () => {
  const data = {
    A1: "id",
    B1: "name",
    C1: "price",
    A2: "1",
    B2: "Widget",
    C2: "9.5",
    A3: "2",
    B3: "Gadget",
    C3: "12",
    A4: "3",
    B4: "<5",
    C4: "4",
  };
  it("VLOOKUP exact and approximate, MATCH, INDEX", () => {
    const { v } = book({
      ...data,
      E1: "=VLOOKUP(2,A2:C4,2,FALSE)",
      E2: "=VLOOKUP(2.5,A2:C4,3,TRUE)",
      E3: "=VLOOKUP(9,A2:C4,2,FALSE)",
      E4: '=VLOOKUP("<5",B2:C4,2,FALSE)',
      E5: '=MATCH("gadget",B2:B4,0)',
      E6: "=INDEX(A2:C4,3,2)",
      E7: '=VLOOKUP("W*",B2:C4,2,FALSE)',
    });
    expect(v("E1")).toBe("Gadget");
    expect(v("E2")).toBe(12);
    expect(errOf(v("E3"))).toBe("#N/A");
    expect(v("E4")).toBe(4); // the text "<5", not "less than 5"
    expect(v("E5")).toBe(2);
    expect(v("E6")).toBe("<5");
    expect(v("E7")).toBe(9.5);
  });

  it("XLOOKUP with if_not_found, match modes and last-to-first search", () => {
    const { v } = book({
      ...data,
      A5: "2",
      B5: "Gadget v2",
      C5: "13",
      E1: "=XLOOKUP(3,A2:A5,B2:B5)",
      E2: '=XLOOKUP(7,A2:A5,B2:B5,"none")',
      E3: "=XLOOKUP(2.5,A2:A5,C2:C5,,-1)",
      E4: "=XLOOKUP(2,A2:A5,B2:B5,,0,-1)",
      E5: "=XLOOKUP(7,A2:A5,B2:B5)",
    });
    expect(v("E1")).toBe("<5");
    expect(v("E2")).toBe("none");
    expect(v("E3")).toBe(12);
    expect(v("E4")).toBe("Gadget v2");
    expect(errOf(v("E5"))).toBe("#N/A");
  });
});

describe("text and dates", () => {
  it("text functions", () => {
    const { v } = book({
      A1: "  Hello   World ",
      B1: "=TRIM(A1)",
      B2: '=LEFT("abcdef",2)&RIGHT("abcdef",2)&MID("abcdef",3,2)',
      B3: '=SUBSTITUTE("a-b-c","-","+",2)',
      B4: '=TEXTJOIN(", ",TRUE,"a","","b")',
      B5: '=PROPER("hello WORLD")',
      B6: '=SEARCH("W*d","hello world")',
      B7: '=FIND("o","hello world",6)',
      B8: '=VALUE("abc")',
      B9: '=LEN("héllo")',
    });
    expect(v("B1")).toBe("Hello World");
    expect(v("B2")).toBe("abefcd");
    expect(v("B3")).toBe("a-b+c");
    expect(v("B4")).toBe("a, b");
    expect(v("B5")).toBe("Hello World");
    expect(v("B6")).toBe(7);
    expect(v("B7")).toBe(8);
    expect(errOf(v("B8"))).toBe("#VALUE!");
    expect(v("B9")).toBe(5);
  });

  it("dates are Excel serials, never shifted by the time zone", () => {
    const { v } = book({
      A1: "=DATE(2024,1,5)",
      A2: '=YEAR(A1)&"-"&MONTH(A1)&"-"&DAY(A1)',
      A3: "=EOMONTH(A1,1)",
      A4: "=EDATE(DATE(2024,1,31),1)",
      A5: '=TEXT(A1,"yyyy-mm-dd ddd")',
      A6: "=WEEKDAY(A1)",
      A7: "=DATE(2024,13,1)",
    });
    expect(v("A1")).toBe(45296);
    expect(v("A2")).toBe("2024-1-5");
    expect(v("A3")).toBe(dateSerial(2024, 2, 29));
    expect(v("A4")).toBe(dateSerial(2024, 2, 29));
    expect(v("A5")).toBe("2024-01-05 Fri");
    expect(v("A6")).toBe(6);
    expect(v("A7")).toBe(dateSerial(2025, 1, 1));
  });
});

describe("number formats", () => {
  it("formats like Excel", () => {
    expect(formatValue(1234.567, "#,##0.00")).toBe("1,234.57");
    expect(formatValue(0.1234, "0.0%")).toBe("12.3%");
    expect(formatValue(-5, "0.00")).toBe("-5.00");
    expect(formatValue(-5, "0.00;(0.00)")).toBe("(5.00)");
    expect(formatValue(1234.5, '"$"#,##0.00')).toBe("$1,234.50");
    expect(formatValue(12345, "0.00E+00")).toBe("1.23E+04");
    expect(formatValue(1500000, '#,##0,,"M"')).toBe("2M");
    expect(formatValue(45296.5, "yyyy-mm-dd hh:mm")).toBe("2024-01-05 12:00");
    expect(formatValue(0.75, "h:mm AM/PM")).toBe("6:00 PM");
    expect(formatValue(5, "0.##")).toBe("5.");
    expect(formatValue(1 / 3, "General")).toBe("0.3333333333");
    expect(formatValue("abc", "@")).toBe("abc");
  });
});

describe("dynamic arrays spill", () => {
  it("spills into empty neighbours and is #SPILL! when blocked", () => {
    const { v, set } = book({
      A1: "b",
      A2: "a",
      A3: "b",
      C1: "=UNIQUE(A1:A3)",
      D1: "=SEQUENCE(2,3)",
    });
    expect(v("C1")).toBe("b");
    expect(v("C2")).toBe("a");
    expect(v("C3")).toBe(null);
    expect(v("D1")).toBe(1);
    expect(v("F2")).toBe(6);
    set("E2", "blocker");
    expect(errOf(v("D1"))).toBe("#SPILL!");
    expect(v("F2")).toBe(null);
    set("E2", "");
    expect(v("F2")).toBe(6);
  });

  it("a formula reading a spilled cell sees the spill, and follows it", () => {
    const { v, set } = book({ A1: "=SEQUENCE(3)", B1: "=SUM(A1:A3)", B2: "=A3*10" });
    expect(v("B1")).toBe(6);
    expect(v("B2")).toBe(30);
    set("A1", "=SEQUENCE(3,1,10)");
    expect(v("B1")).toBe(33);
    expect(v("B2")).toBe(120);
  });

  it("FILTER and SORT", () => {
    const { v } = book({
      A1: "3",
      A2: "1",
      A3: "2",
      B1: "=SORT(A1:A3)",
      C1: "=FILTER(A1:A3,A1:A3>1)",
      D1: '=FILTER(A1:A3,A1:A3>9,"none")',
    });
    expect([v("B1"), v("B2"), v("B3")]).toEqual([1, 2, 3]);
    expect([v("C1"), v("C2")]).toEqual([3, 2]);
    expect(v("D1")).toBe("none");
  });
});

describe("recalculation", () => {
  it("recomputes what depends on an edit, through ranges and other sheets", () => {
    const { v, set } = book({ A1: "1", A2: "2", A3: "=SUM(A1:A2)", B1: "=Data!A1*2" }, [
      { name: "Data", cells: { A1: "=Sheet1!A3+100" } },
    ]);
    expect(v("A3")).toBe(3);
    expect(v("B1")).toBe(206);
    set("A2", "10");
    expect(v("A3")).toBe(11);
    expect(v("B1")).toBe(222);
  });

  it("a whole-column reference follows new rows", () => {
    const { v, set } = book({ A1: "1", B1: "=SUM(A:A)" });
    expect(v("B1")).toBe(1);
    set("A50", "5");
    expect(v("B1")).toBe(6);
  });

  it("an unknown sheet is #REF! and an unknown function #NAME?", () => {
    const { v } = book({ A1: "=Nope!A1", A2: "=NOPE(1)", A3: "=someName" });
    expect(errOf(v("A1"))).toBe("#REF!");
    expect(errOf(v("A2"))).toBe("#NAME?");
    expect(errOf(v("A3"))).toBe("#NAME?");
  });
});

describe("copy and fill", () => {
  it("shifts relative references and keeps absolute ones", () => {
    expect(shiftFormula("=A1+$B$1+B$2+$C3", 1, 1)).toBe("=B2+$B$1+C$2+$C4");
    expect(shiftFormula("=SUM(A1:A3)", 2, 0)).toBe("=SUM(A3:A5)");
    expect(shiftFormula("=SUM(A:A)", 5, 1)).toBe("=SUM(B:B)");
    expect(shiftFormula('=A1&"A1"', 1, 0)).toBe('=A2&"A1"');
    expect(shiftFormula("=A1", -1, 0)).toBe("=#REF!");
    expect(shiftFormula("=Data!A1*2", 0, 1)).toBe("=Data!B1*2");
  });

  it("follows a sheet rename", () => {
    expect(renameSheetInFormula("=Data!A1+'Data'!B2+Other!C3", "Data", "My Data")).toBe(
      "='My Data'!A1+'My Data'!B2+Other!C3",
    );
  });
});
