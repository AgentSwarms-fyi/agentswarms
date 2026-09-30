// A number turned into text by a formula, as Excel turns it (R175): to 15
// significant digits. Before, text took the cell's narrow General display
// (11 digits, 10 significant): =A1&"-"&B1 over 123456789012 and 1234567.891234
// gave "1.23457E+11-1234567.891", LEN(1/3) was 12 (Excel 17), and a lookup on
// a key built that way found nothing. Also DOLLAR's negative, "$(1,234.57)".

import { describe, expect, it } from "vitest";
import { WorkbookEngine, type GridData } from "@/lib/sheets/engine";
import { formatGeneral, numberText } from "@/lib/sheets/formula/values";

function at(formula: string): unknown {
  const grid: GridData = {
    cells: {
      "0,0": { i: "123456789012" },
      "0,1": { i: "1234567.891234" },
      "0,2": { i: "'123456789012" },
      "0,3": { i: "found" },
      "5,5": { i: formula },
    },
  };
  const e = new WorkbookEngine([{ id: "s", name: "S", grid }]);
  e.recalcAll();
  return e.getValue("s", 5, 5);
}

describe("a number as text", () => {
  it("whole numbers up to 15 digits are written out", () => {
    expect(numberText(123456789012)).toBe("123456789012");
    expect(numberText(999999999999999)).toBe("999999999999999");
    expect(numberText(-100000000000000)).toBe("-100000000000000");
    expect(numberText(0)).toBe("0");
  });
  it("fractions to 15 significant digits, without float noise", () => {
    expect(numberText(1 / 3)).toBe("0.333333333333333");
    expect(numberText(-2 / 3)).toBe("-0.666666666666667");
    expect(numberText(0.1 + 0.2)).toBe("0.3");
    expect(numberText(1234567.891234)).toBe("1234567.891234");
    expect(numberText(99999999999999.9)).toBe("99999999999999.9");
    expect(numberText(0.000001)).toBe("0.000001");
  });
  it("scientific from 1E+15 and below 1E-9", () => {
    expect(numberText(1e15)).toBe("1E+15");
    expect(numberText(1.2345678901234568e17)).toBe("1.23456789012346E+17");
    expect(numberText(1e20)).toBe("1E+20");
    expect(numberText(1e-10)).toBe("1E-10");
    expect(numberText(-3.5e-12)).toBe("-3.5E-12");
  });
  it("while a cell's General display stays narrow", () => {
    expect(formatGeneral(123456789012)).toBe("1.23457E+11");
    expect(formatGeneral(1 / 3)).toBe("0.3333333333");
  });
});

describe("in formulas", () => {
  it("joining, LEN, LEFT and TEXTJOIN", () => {
    expect(at('=A1&"-"&B1')).toBe("123456789012-1234567.891234");
    expect(at("=LEN(1/3)")).toBe(17);
    expect(at("=LEN(A1)")).toBe(12);
    expect(at("=LEFT(B1,9)")).toBe("1234567.8");
    expect(at('=TEXTJOIN("|",TRUE,A1:B1,0.1+0.2)')).toBe("123456789012|1234567.891234|0.3");
  });
  it("a lookup on a key built from a number finds it", () => {
    expect(at('=VLOOKUP(A1&"",C1:D1,2,FALSE)')).toBe("found");
  });
  it("DOLLAR brackets a negative outside the sign", () => {
    expect(at("=DOLLAR(-1234.567)")).toBe("($1,234.57)");
    expect(at("=DOLLAR(1234.567)")).toBe("$1,234.57");
    expect(at("=DOLLAR(-1234.567,1)")).toBe("($1,234.6)");
    expect(at("=DOLLAR(1/0)")).toMatchObject({ err: "#DIV/0!" });
  });
});
