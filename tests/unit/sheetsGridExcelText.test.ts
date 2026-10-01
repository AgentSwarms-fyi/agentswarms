// The grid's TEXT, number formats and PROPER, as Excel writes them (R199).
//
// FOUND IN R199, from R198's grid-vs-table probe, driven in the workbook
// "R199 grid text": with 2.675 in A1, =TEXT(A1,"0.00") showed 2.67 beside
// =ROUND(A1,2) showing 2.68; =PROPER("ÉCOLE normale") showed "éCole Normale";
// and =TEXT(A5,"0.00") over a blank showed nothing. Excel says 2.68, 2.68,
// "École Normale" and "0.00".
import { describe, expect, it } from "vitest";

import { WorkbookEngine } from "@/lib/sheets/engine";
import { excelFixed, formatValue } from "@/lib/sheets/format";

function value(formula: string, cells: Record<string, string> = {}): unknown {
  const grid: Record<string, { i: string }> = { "9,9": { i: formula } };
  for (const [k, v] of Object.entries(cells)) grid[k] = { i: v };
  const e = new WorkbookEngine([{ id: "g", name: "G", kind: "grid", grid: { cells: grid } }]);
  return e.getValue("g", 9, 9);
}

describe("excelFixed", () => {
  it("rounds the decimal Excel shows, not the binary stored", () => {
    expect(excelFixed(2.675, 2)).toBe("2.68");
    expect(excelFixed(1.005, 2)).toBe("1.01");
    expect(excelFixed(0.125, 2)).toBe("0.13");
    expect(excelFixed(2.5, 0)).toBe("3");
    expect(excelFixed(0.1 + 0.2, 2)).toBe("0.30");
    // 17 digits stored, 15 kept: 0.01 + 0.075 is 0.08499999999999999 in
    // binary and 0.085 to Excel, which shows 0.09.
    expect(excelFixed(0.01 + 0.075, 2)).toBe("0.09");
    expect(excelFixed(0.03 + 0.285, 2)).toBe("0.32");
  });

  it("leaves what was already exact, and the tiny and the huge, as toFixed does", () => {
    expect(excelFixed(1234567.891, 2)).toBe("1234567.89");
    expect(excelFixed(3, 2)).toBe("3.00");
    expect(excelFixed(1e-7, 2)).toBe("0.00");
    expect(excelFixed(1.5e21, 0)).toBe((1.5e21).toFixed(0));
  });
});

describe("the grid", () => {
  it("formats 2.675 as 2.68 in TEXT and in a cell, as its own ROUND does", () => {
    expect(value('=TEXT(A1,"0.00")', { "0,0": "2.675" })).toBe("2.68");
    expect(value("=ROUND(A1,2)", { "0,0": "2.675" })).toBe(2.68);
    expect(formatValue(2.675, "0.00")).toBe("2.68");
    expect(formatValue(-2.675, "#,##0.00")).toBe("-2.68");
    expect(value('=TEXT(0.01+0.075,"0.00")')).toBe("0.09");
  });

  it("reads a blank as 0 in TEXT", () => {
    expect(value('=TEXT(A5,"0.00")')).toBe("0.00");
    expect(value('=TEXT(A5,"#,##0")')).toBe("0");
  });

  it("capitalises words that start with any letter", () => {
    expect(value('=PROPER("ÉCOLE normale")')).toBe("École Normale");
    expect(value('=PROPER("ñandú y ÁRBOL")')).toBe("Ñandú Y Árbol");
    // Digits and punctuation still end a word, as in Excel.
    expect(value(`=PROPER("o'neil 2-way")`)).toBe("O'Neil 2-Way");
    // A letter with a two-letter capital is not grown: "ß" was never "SS".
    expect(value('=PROPER("ß straße ﬁne")')).toBe("ß Straße ﬁne");
  });
});
