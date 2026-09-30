// A formula's number format from the cells it reads (R168). Before: =A1+30
// over a date showed 45030, =A1 showed 45000, and =SUM of dollars 1500.5.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { formulaFormat, type FormatAt } from "@/lib/sheets/formulaFormat";

// A1 a date, B1:B2 dollars, C1 a percentage, D1 General, E1 text; Other!A1 a date.
const formats: Record<string, string> = {
  "S!0,0": "yyyy-mm-dd",
  "S!0,1": '"$"#,##0.00',
  "S!1,1": '"$"#,##0.00',
  "S!0,2": "0%",
  "S!0,3": "General",
  "S!0,4": "@",
  "S!1,0": "yyyy-mm-dd",
  "Other!0,0": "d-mmm-yy",
};
const at: FormatAt = (sheet, r, c) => formats[`${sheet ?? "S"}!${r},${c}`];
const f = (formula: string) => formulaFormat(formula, at);

describe("the format a formula takes", () => {
  it("a reference's own", () => {
    expect(f("=A1")).toBe("yyyy-mm-dd");
    expect(f("=Other!A1")).toBe("d-mmm-yy");
    expect(f("=D1")).toBeUndefined();
    expect(f("=E1")).toBeUndefined();
    expect(f("=D1+A1")).toBe("yyyy-mm-dd");
  });
  it("the first formatted operand of + or -", () => {
    expect(f("=A1+30")).toBe("yyyy-mm-dd");
    expect(f("=30+A1")).toBe("yyyy-mm-dd");
    expect(f("=B1-5")).toBe('"$"#,##0.00');
    expect(f("=-B1")).toBe('"$"#,##0.00');
  });
  it("two dates apart are a number of days", () => {
    expect(f("=A2-A1")).toBeUndefined();
    expect(f("=A1+A2")).toBe("yyyy-mm-dd");
  });
  it("SUM, AVERAGE, MIN, MAX and the ROUNDs take their first argument's", () => {
    expect(f("=SUM(B1:B2)")).toBe('"$"#,##0.00');
    expect(f("=ROUND(B1,0)")).toBe('"$"#,##0.00');
    expect(f("=MAX(A1:A2)")).toBe("yyyy-mm-dd");
    expect(f("=SUM(B:B)")).toBeUndefined();
  });
  it("other formulas take none: * and /, text, lookups", () => {
    expect(f("=B1*2")).toBeUndefined();
    expect(f("=C1/2")).toBeUndefined();
    expect(f('=A1&"!"')).toBeUndefined();
    expect(f("=VLOOKUP(1,A1:B2,2,0)")).toBeUndefined();
    expect(f("=COUNT(A1:A2)")).toBeUndefined();
    expect(f("=YEAR(A1)")).toBeUndefined();
    expect(f("=A1")).toBe("yyyy-mm-dd");
    expect(f("A1+1")).toBeUndefined();
    expect(f("=A1+")).toBeUndefined();
  });
});

describe("the grid", () => {
  it("gives a formula its format when it is entered into a cell without one", () => {
    const ed = readFileSync("src/components/sheets/WorkbookEditor.tsx", "utf8");
    expect(ed).toMatch(
      /const fmt = prev\?\.f\s*\? undefined\s*: \(impliedFormat\(text\) \?\?\s*formulaFormat\(text,/,
    );
    expect(ed).toMatch(
      /return id \? effectiveFormat\(engine\?\.getInput\(id, r, c\)\) : undefined;/,
    );
  });
});
