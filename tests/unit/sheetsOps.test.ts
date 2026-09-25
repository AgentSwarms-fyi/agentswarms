// Sheets: inserting/deleting rows and columns, fill, and the clipboard format.
import { describe, expect, it } from "vitest";

import { parseA1 } from "@/lib/sheets/a1";
import { impliedFormat } from "@/lib/sheets/cellView";
import { parseNumberText } from "@/lib/sheets/formula/values";
import { adjustFormula, fillEdits, moveCells, parseTsv, toTsv } from "@/lib/sheets/ops";

describe("inserting and deleting rows and columns rewrites formulas", () => {
  it("moves a reference below an insertion, absolute or not", () => {
    expect(adjustFormula("=A5+$B$5+A2", "Sheet1", "Sheet1", "rows", 3, 2)).toBe("=A7+$B$7+A2");
  });

  it("grows a range that spans the insertion and leaves one above it alone", () => {
    expect(adjustFormula("=SUM(A1:A10)", "Sheet1", "Sheet1", "rows", 4, 3)).toBe("=SUM(A1:A13)");
    expect(adjustFormula("=SUM(A1:A3)", "Sheet1", "Sheet1", "rows", 4, 3)).toBe("=SUM(A1:A3)");
  });

  it("turns a reference into deleted cells into #REF! and shrinks a range", () => {
    expect(adjustFormula("=A4*2", "Sheet1", "Sheet1", "rows", 3, -2)).toBe("=#REF!*2");
    expect(adjustFormula("=A8", "Sheet1", "Sheet1", "rows", 3, -2)).toBe("=A6");
    expect(adjustFormula("=SUM(A1:A10)", "Sheet1", "Sheet1", "rows", 3, -2)).toBe("=SUM(A1:A8)");
    expect(adjustFormula("=SUM(A4:A5)", "Sheet1", "Sheet1", "rows", 3, -2)).toBe("=SUM(#REF!)");
  });

  it("only touches references to the changed sheet", () => {
    expect(adjustFormula("=Data!A5+A5", "Sheet1", "Data", "rows", 0, 1)).toBe("=Data!A6+A5");
    expect(adjustFormula("=A5", "Data", "Data", "rows", 0, 1)).toBe("=A6");
  });

  it("columns work the same way, and whole rows ignore column changes", () => {
    expect(adjustFormula("=C1+SUM(B:D)", "Sheet1", "Sheet1", "cols", 1, 1)).toBe("=D1+SUM(C:E)");
    expect(adjustFormula("=SUM(2:3)", "Sheet1", "Sheet1", "cols", 0, 5)).toBe("=SUM(2:3)");
  });

  it("moves the cells themselves", () => {
    const g = moveCells(
      { cells: { "0,0": { i: "a" }, "3,0": { i: "b" }, "5,0": { i: "c" } } },
      "rows",
      3,
      -1,
    );
    expect(g.cells).toEqual({ "0,0": { i: "a" }, "4,0": { i: "c" } });
  });
});

describe("fill", () => {
  const grid = (cells: Record<string, string>) => {
    const m = new Map<string, { i: string }>();
    for (const [a, i] of Object.entries(cells)) {
      const p = parseA1(a)!;
      m.set(`${p.row},${p.col}`, { i });
    }
    return (r: number, c: number) => m.get(`${r},${c}`);
  };

  it("continues a number series and shifts formulas", () => {
    const get = grid({ A1: "2", A2: "4", B1: "=A1*10", B2: "=A2*10" });
    const edits = fillEdits({ r0: 0, c0: 0, r1: 1, c1: 1 }, { r0: 0, c0: 0, r1: 3, c1: 1 }, get);
    const byCell = Object.fromEntries(edits.map((e) => [`${e.row},${e.col}`, e.input]));
    expect(byCell["2,0"]).toBe("6");
    expect(byCell["3,0"]).toBe("8");
    expect(byCell["2,1"]).toBe("=A3*10");
    expect(byCell["3,1"]).toBe("=A4*10");
  });

  it("continues Item 1, Item 2 and repeats plain text", () => {
    const get = grid({ A1: "Item 09", B1: "north", B2: "south" });
    const a = fillEdits({ r0: 0, c0: 0, r1: 0, c1: 0 }, { r0: 0, c0: 0, r1: 2, c1: 0 }, get);
    expect(a.map((e) => e.input)).toEqual(["Item 10", "Item 11"]);
    const b = fillEdits({ r0: 0, c0: 1, r1: 1, c1: 1 }, { r0: 0, c0: 1, r1: 3, c1: 1 }, get);
    expect(b.map((e) => e.input)).toEqual(["north", "south"]);
  });

  it("fills right as well as down", () => {
    const get = grid({ A1: "=A2" });
    const e = fillEdits({ r0: 0, c0: 0, r1: 0, c1: 0 }, { r0: 0, c0: 0, r1: 0, c1: 2 }, get);
    expect(e.map((x) => x.input)).toEqual(["=B2", "=C2"]);
  });
});

describe("the clipboard", () => {
  it("round-trips tabs, newlines and quotes the way Excel writes them", () => {
    const rows = [
      ["a", "b\tc", 'say "hi"'],
      ["line1\nline2", "", "x"],
    ];
    expect(parseTsv(toTsv(rows))).toEqual(rows);
  });

  it("reads what Excel puts on the clipboard (CRLF, trailing newline)", () => {
    expect(parseTsv("1\t2\r\n3\t4\r\n")).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
  });
});

describe("typed text picks up a format", () => {
  it("like Excel", () => {
    expect(impliedFormat("12%")).toBe("0%");
    expect(impliedFormat("12.5%")).toBe("0.00%");
    expect(impliedFormat("$1,200")).toBe('"$"#,##0');
    // A negative dollar amount, written any of the ways Excel reads it.
    for (const t of ["-$350.00", "$-350.00", "($350.00)"])
      expect(impliedFormat(t)).toBe('"$"#,##0.00');
    for (const t of ["-$350.00", "$-350.00", "($350.00)", "-350"])
      expect(parseNumberText(t)).toBe(-350);
    expect(parseNumberText("$-")).toBeNull();
    expect(impliedFormat("2024-01-05")).toBe("yyyy-mm-dd");
    expect(impliedFormat("=A1")).toBeUndefined();
    expect(impliedFormat("hello")).toBeUndefined();
  });
});
