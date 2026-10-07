// CELL and INFO (R339).
//
// FOUND IN R329's inventory: both were #NAME?, so the common
// =MID(CELL("filename",A1),FIND("]",CELL("filename",A1))+1,255), which gives
// a sheet its own name, did not work, nor =IF(CELL("type",A1)="v",A1*2,0),
// the example at the top of CELL's page. The format codes below are CELL's
// page's table, copied cell by cell from the page.
import { describe, expect, it } from "vitest";

import { WorkbookEngine } from "@/lib/sheets/engine";
import { formatCode, negativeColor, parentheses } from "@/lib/sheets/formula/cellInfo";
import { FUNCTIONS } from "@/lib/sheets/formula/functions";
import type { Value } from "@/lib/sheets/formula/values";
import { FUNCTION_HELP } from "@/lib/sheets/functionHelp";
import { toFileFormula } from "@/lib/sheets/xlsx";

describe('CELL("format"): the page\'s codes for the built-in formats', () => {
  it("each row of the page's table", () => {
    const table: [string, string][] = [
      ["General", "G"],
      ["0", "F0"],
      ["#,##0", ",0"],
      ["0.00", "F2"],
      ["#,##0.00", ",2"],
      ["$#,##0_);($#,##0)", "C0"],
      ["$#,##0_);[Red]($#,##0)", "C0-"],
      ["$#,##0.00_);($#,##0.00)", "C2"],
      ["$#,##0.00_);[Red]($#,##0.00)", "C2-"],
      ["0%", "P0"],
      ["0.00%", "P2"],
      ["0.00E+00", "S2"],
      ["# ?/?", "G"],
      ["# ??/??", "G"],
      ["m/d/yy", "D4"],
      ["m/d/yy h:mm", "D4"],
      ["mm/dd/yy", "D4"],
      ["d-mmm-yy", "D1"],
      ["dd-mmm-yy", "D1"],
      ["d-mmm", "D2"],
      ["dd-mmm", "D2"],
      ["mmm-yy", "D3"],
      ["mm/dd", "D5"],
      ["h:mm AM/PM", "D7"],
      ["h:mm:ss AM/PM", "D6"],
      ["h:mm", "D9"],
      ["h:mm:ss", "D8"],
    ];
    for (const [code, want] of table) expect(formatCode(code), code).toBe(want);
  });

  it('"()" for parentheses on positive numbers, and Sheets\' own formats', () => {
    expect(formatCode("(#,##0);(#,##0)")).toBe(",0()");
    expect(formatCode("0.00_);[Red](0.00)")).toBe("F2-");
    expect(formatCode('"$"#,##0.00')).toBe("C2");
    expect(formatCode("yyyy-mm-dd")).toBe("D4");
    expect(formatCode("yyyy-mm-dd hh:mm")).toBe("D4");
    expect(formatCode("hh:mm:ss")).toBe("D8");
    expect(formatCode("@")).toBe("G");
    expect(formatCode(undefined)).toBe("G");
  });

  it('"color" and "parentheses"', () => {
    expect(negativeColor("$#,##0_);[Red]($#,##0)")).toBe(1);
    expect(negativeColor("$#,##0_);($#,##0)")).toBe(0);
    expect(negativeColor("0.00")).toBe(0);
    expect(parentheses("(#,##0);(#,##0)")).toBe(1);
    expect(parentheses("$#,##0_);($#,##0)")).toBe(0);
  });
});

function workbook(book?: string) {
  const e = new WorkbookEngine(
    [
      {
        id: "s",
        name: "S",
        kind: "grid",
        grid: {
          cells: {
            "0,2": { i: "Name" },
            "1,2": { i: "42", f: "$#,##0.00_);[Red]($#,##0.00)" },
            "2,2": { i: "Right", s: { align: "right" } },
            "3,2": { i: "Mid", s: { align: "center" } },
            "4,2": { i: '="formula text"' },
            "5,2": { i: "0.5", f: "0%" },
            "9,9": { i: '=CELL("filename",A1)' },
            "10,9": { i: '=CELL("width",D1)' },
          },
          colWidths: { "3": 75, "4": 100 },
        },
      },
      { id: "q", name: "Q3 Data", kind: "grid", grid: { cells: { "3,2": { i: "7" } } } },
    ],
    undefined,
    { book },
  );
  const plain = (v: Value): unknown =>
    Array.isArray(v) ? v.map(plain) : v && typeof v === "object" && "err" in v ? { err: v.err } : v;
  const at = (f: string, row = 30, col = 20) => {
    const v = plain(e.evaluateAt("s", row, col, f, { array: true })) as unknown;
    return Array.isArray(v) && v.length === 1 && Array.isArray(v[0]) && v[0].length === 1
      ? v[0][0]
      : v;
  };
  return { e, at };
}

describe("CELL: where a cell is, and what it holds", () => {
  const { at } = workbook("Plan.xlsx");

  it('"address", "row" and "col", of the upper-left cell', () => {
    expect(at('=CELL("address",B2)')).toBe("$B$2");
    expect(at('=CELL("address",B2:D9)')).toBe("$B$2");
    expect(at("=CELL(\"address\",'Q3 Data'!C4)")).toBe("'[Plan.xlsx]Q3 Data'!$C$4");
    expect(at('=CELL("row",B5)')).toBe(5);
    expect(at('=CELL("col",D1)')).toBe(4);
    expect(at('=CELL("ROW",B5)')).toBe(5);
  });

  it('"contents" is the value, not the formula', () => {
    expect(at('=CELL("contents",C2)')).toBe(42);
    expect(at('=CELL("contents",C5)')).toBe("formula text");
  });

  it('"type": b for blank, l for text typed in, v for anything else', () => {
    expect(at('=CELL("type",E1)')).toBe("b");
    expect(at('=CELL("type",C1)')).toBe("l");
    expect(at('=CELL("type",C2)')).toBe("v");
    expect(at('=CELL("type",C5)')).toBe("v");
    // The page's own example: A1*2 only when A1 holds a value.
    expect(at('=IF(CELL("type",C2)="v",C2*2,0)')).toBe(84);
    expect(at('=IF(CELL("type",C1)="v",C1*2,0)')).toBe(0);
  });

  it("without a reference, the formula's own cell", () => {
    expect(at('=CELL("address")', 6, 6)).toBe("$G$7");
    expect(at('=CELL("row")', 6, 6)).toBe(7);
  });
});

describe("CELL: what a cell looks like", () => {
  const { at } = workbook("Plan.xlsx");

  it('"format", "color" and "parentheses" from the cell\'s number format', () => {
    expect(at('=CELL("format",C2)')).toBe("C2-");
    expect(at('=CELL("format",C6)')).toBe("P0");
    expect(at('=CELL("format",C1)')).toBe("G");
    expect(at('=CELL("color",C2)')).toBe(1);
    expect(at('=CELL("color",C6)')).toBe(0);
    expect(at('=CELL("parentheses",C2)')).toBe(0);
  });

  it('"prefix": \' " ^ by the alignment of text typed in, "" for anything else', () => {
    expect(at('=CELL("prefix",C1)')).toBe("'");
    expect(at('=CELL("prefix",C3)')).toBe('"');
    expect(at('=CELL("prefix",C4)')).toBe("^");
    expect(at('=CELL("prefix",C2)')).toBe("");
    expect(at('=CELL("prefix",C5)')).toBe("");
  });

  it('"width": characters, rounded, and whether the width is the default', () => {
    // 75 pixels is 10 characters; 100 is 13.57, rounded to 14; the 104-pixel default is 14.
    expect(at('=CELL("width",D1)')).toEqual([[10, false]]);
    expect(at('=CELL("width",E1)')).toEqual([[14, false]]);
    expect(at('=CELL("width",A1)')).toEqual([[14, true]]);
  });

  it('"protect": every cell is locked, as in Excel until one is unlocked', () => {
    expect(at('=CELL("protect",C1)')).toBe(1);
  });
});

describe('CELL("filename"): the workbook\'s file name and the sheet', () => {
  it("gives a sheet its own name by the usual formula", () => {
    const { at } = workbook("Plan.xlsx");
    expect(at('=CELL("filename",A1)')).toBe("[Plan.xlsx]S");
    expect(at('=MID(CELL("filename",A1),FIND("]",CELL("filename",A1))+1,255)')).toBe("S");
    expect(at("=CELL(\"filename\",'Q3 Data'!A1)")).toBe("[Plan.xlsx]Q3 Data");
  });

  it('is "" when the workbook has no name, as Excel\'s is before a save', () => {
    expect(workbook().at('=CELL("filename",A1)')).toBe("");
  });

  it("follows a rename, and a column's new width", () => {
    const { e } = workbook("Plan.xlsx");
    expect(e.getValue("s", 9, 9)).toBe("[Plan.xlsx]S");
    expect(e.setBook("Plan 2027.xlsx")).toBe(true);
    expect(e.getValue("s", 9, 9)).toBe("[Plan 2027.xlsx]S");
    expect(e.setBook("Plan 2027.xlsx")).toBe(false);
    expect(e.getValue("s", 10, 9)).toBe(10);
    e.setGridMeta("s", { colWidths: { "3": 145 } });
    expect(e.getValue("s", 10, 9)).toBe(20);
  });

  it("follows a new number format or alignment at once", () => {
    const { e } = workbook("Plan.xlsx");
    e.setInputs("s", [
      { row: 12, col: 9, input: '=CELL("format",C6)' },
      { row: 13, col: 9, input: '=CELL("prefix",C1)' },
    ]);
    expect(e.getValue("s", 12, 9)).toBe("P0");
    e.setFormat("s", [{ row: 5, col: 2 }], "0.00");
    expect(e.getValue("s", 12, 9)).toBe("F2");
    expect(e.getValue("s", 13, 9)).toBe("'");
    e.setStyle("s", [{ row: 0, col: 2 }], { align: "center" });
    expect(e.getValue("s", 13, 9)).toBe("^");
  });

  it("follows them too as the page applies them, with the cell's text unchanged", () => {
    // FOUND IN THE UI: the toolbar gives a cell its format and style through
    // setInputs, with the same text, which recomputed nothing.
    const { e } = workbook("Plan.xlsx");
    e.setInputs("s", [
      { row: 12, col: 9, input: '=CELL("format",C6)' },
      { row: 13, col: 9, input: '=CELL("prefix",C1)' },
    ]);
    e.setInputs("s", [{ row: 5, col: 2, input: "0.5", format: '"$"#,##0.00' }]);
    expect(e.getValue("s", 12, 9)).toBe("C2");
    e.setInputs("s", [{ row: 0, col: 2, input: "Name", style: { align: "center" } }]);
    expect(e.getValue("s", 13, 9)).toBe("^");
  });
});

describe("CELL's refusals", () => {
  const { at } = workbook("Plan.xlsx");
  it("an info_type it does not know, or a reference that is not one", () => {
    expect(at('=CELL("colour",C1)')).toEqual({ err: "#VALUE!" });
    expect(at('=CELL("type",5)')).toEqual({ err: "#VALUE!" });
    expect(at('=CELL("type",1/0)')).toEqual({ err: "#DIV/0!" });
    expect(at("=CELL()")).toEqual({ err: "#N/A" });
  });
});

describe("INFO: what a browser can say", () => {
  const { at } = workbook("Plan.xlsx");
  it("the workbook's sheets, Excel's recalculation and release", () => {
    expect(at('=INFO("numfile")')).toBe(2);
    expect(at('=INFO("recalc")')).toBe("Automatic");
    expect(at('=INFO("release")')).toBe("16.0");
    expect(at('=INFO("origin")')).toBe("$A:$A$1");
    expect(at('=INFO("directory")')).toBe("");
  });

  it('"system" is pcdos or mac, and "osversion" is text', () => {
    expect(["pcdos", "mac"]).toContain(at('=INFO("system")'));
    expect(typeof at('=INFO("osversion")')).toBe("string");
  });

  it("the memory types are #N/A, as on the page; others #VALUE!", () => {
    for (const t of ["memavail", "memused", "totmem"])
      expect(at(`=INFO("${t}")`)).toEqual({ err: "#N/A" });
    expect(at('=INFO("weather")')).toEqual({ err: "#VALUE!" });
  });
});

describe("the two in the workbook", () => {
  it("are functions with help, and a file keeps their names as they are", () => {
    for (const name of ["CELL", "INFO"]) {
      expect(FUNCTIONS[name], name).toBeTypeOf("function");
      expect(FUNCTION_HELP[name]?.sig, name).toMatch(new RegExp(`^${name}\\(`));
    }
    expect(toFileFormula('=CELL("type",A1)&INFO("recalc")')).toBe('CELL("type",A1)&INFO("recalc")');
  });
});
