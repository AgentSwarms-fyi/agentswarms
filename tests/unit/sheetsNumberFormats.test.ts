// Excel's number formats that a quick reading missed (R163). Before: a
// duration's [h]:mm showed ":12" for 36 hours (Excel's built-in format 46 is
// [h]:mm:ss), [$€-2] lost its €, fractions showed a rounded whole number,
// conditions ([<10]) were ignored, and DD/MM/YYYY printed those letters.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { inferType } from "@/lib/sheets/export";
import { formatColor, formatValue, isDateFormat } from "@/lib/sheets/format";
import { WorkbookEngine } from "@/lib/sheets/engine";
import { readXlsx, type ImportResult } from "@/lib/sheets/xlsx";

describe("a file's formats, as Excel shows them (openpyxl-formats.xlsx)", () => {
  let file: ImportResult;
  beforeAll(async () => {
    const b = readFileSync(resolve(process.cwd(), "tests/fixtures/sheets/openpyxl-formats.xlsx"));
    file = await readXlsx(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), {
      maxCells: 1000,
    });
  }, 60_000);
  it("every row shows what column C says Excel shows", () => {
    const cells = file.sheets[0].grid.cells;
    const rows: [string, string, string][] = [];
    for (let r = 1; cells[`${r},0`]; r++) {
      const c = cells[`${r},0`];
      const shown = formatValue(Number(c.i), c.f);
      rows.push([cells[`${r},1`].i, shown, cells[`${r},2`].i.replace(/^'/, "")]);
    }
    expect(rows.length).toBe(15);
    for (const [code, shown, excel] of rows)
      expect({ code, shown }).toEqual({ code, shown: excel });
  });
});

describe("durations", () => {
  it("count hours, minutes or seconds past a day", () => {
    expect(formatValue(1.5, "[h]:mm")).toBe("36:00");
    expect(formatValue(1.5, "[hh]:mm:ss")).toBe("36:00:00");
    expect(formatValue(0.0625, "[mm]:ss")).toBe("90:00");
    expect(formatValue(0.0625, "[ss]")).toBe("5400");
    expect(formatValue(10 / 24 + 30 / 1440, "[h]:mm")).toBe("10:30");
  });
  it("a negative one is #s, as a negative time is", () => {
    expect(formatValue(-0.5, "[h]:mm")).toBe("########");
  });
  it("is a number, not a date, where a date matters (a saved column, a chart's labels)", () => {
    expect(isDateFormat("[h]:mm:ss")).toBe(false);
    expect(isDateFormat("h:mm")).toBe(true);
    const col = [1.5, 0.25].map((v) => ({ v, input: { i: String(v), f: "[h]:mm" } }));
    expect(inferType(col)).toBe("DOUBLE");
  });
  it("TEXT() uses the same", () => {
    const e = new WorkbookEngine([
      { id: "s", name: "S", grid: { cells: { "0,0": { i: '=TEXT(1.5,"[h]:mm")' } } } },
    ]);
    e.recalcAll();
    expect(e.getValue("s", 0, 0)).toBe("36:00");
  });
});

describe("currency tags", () => {
  it("show their symbol, and a locale alone shows nothing", () => {
    expect(formatValue(1234.5, "[$€-2] #,##0.00")).toBe("€ 1,234.50");
    expect(formatValue(1234.5, "[$£-809]#,##0.00")).toBe("£1,234.50");
    expect(formatValue(1234.5, "[$USD] #,##0")).toBe("USD 1,235");
    expect(formatValue(45000, "[$-409]mmmm d, yyyy")).toBe("March 15, 2023");
  });
});

describe("fractions", () => {
  it("the nearest with as many digits as allowed, or the denominator written", () => {
    expect(formatValue(1.5, "# ?/?")).toBe("1 1/2");
    expect(formatValue(0.75, "?/?")).toBe("3/4");
    expect(formatValue(1.5, "?/?")).toBe("3/2");
    expect(formatValue(2.625, "# ?/8")).toBe("2 5/8");
    // A denominator written is kept, near or not: 0.3 in quarters is 1/4, not 2/7.
    expect(formatValue(0.3, "?/4")).toBe("1/4");
    expect(formatValue(1.3, "# ??/16")).toBe("1  5/16");
    expect(formatValue(0.3333, "# ??/??").trim()).toBe("1/3");
    // ? holds a space where a digit is not: "3  16/113", aligned.
    expect(formatValue(3.14159, "# ???/???")).toBe("3  16/113");
    expect(formatValue(-1.25, "# ?/?")).toBe("-1 1/4");
  });
  it("a whole number leaves the fraction's place blank", () => {
    expect(formatValue(2, "# ?/?").trimEnd()).toBe("2");
    expect(formatValue(1.99, "# ?/?").trimEnd()).toBe("2");
  });
});

describe("conditions", () => {
  it("choose the section; one without a condition takes the rest", () => {
    expect(formatValue(12, '[<10]"small";"big"')).toBe("big");
    expect(formatValue(5, '[<10]"small";"big"')).toBe("small");
    expect(formatValue(-5, '[<10]"small";"big"')).toBe("small");
    const hml = '[>=100]"high";[<50]"low";"mid"';
    expect([150, 20, 75].map((v) => formatValue(v, hml))).toEqual(["high", "low", "mid"]);
    expect(formatValue(1500000, '[>=1000000]0.0,,"M";[>=1000]0.0,"K";0')).toBe("1.5M");
    expect(formatValue(2500, '[>=1000000]0.0,,"M";[>=1000]0.0,"K";0')).toBe("2.5K");
    expect(formatValue(-2500, '[>=1000000]0.0,,"M";[>=1000]0.0,"K";0')).toBe("-2500");
  });
  it("and the colour comes from the section chosen", () => {
    const code = "[Blue][>=100]0;[Red][<50]0;0";
    expect(formatColor(150, code)).toBe("#0000FF");
    expect(formatColor(20, code)).toBe("#FF0000");
    expect(formatColor(75, code)).toBeUndefined();
  });
  it("without conditions, positive;negative;zero as before", () => {
    expect(formatValue(-1234.5, "#,##0.00;[Red](#,##0.00)")).toBe("(1,234.50)");
    expect(formatColor(-1234.5, "#,##0.00;[Red](#,##0.00)")).toBe("#FF0000");
    expect(formatValue(0, '#,##0.00;(#,##0.00);"-"')).toBe("-");
    expect(formatValue(-5, "0")).toBe("-5");
  });
});

describe("Excel's spacing codes, as in its Accounting format", () => {
  // Built-in format 44. *x fills the cell's width in Excel; here it is left out.
  const acct = '_("$"* #,##0.00_);_("$"* \\(#,##0.00\\);_("$"* "-"??_);_(@_)';
  it("_x is a space as wide as x, and *x no text", () => {
    expect(formatValue(1234.5, acct)).toBe(" $1,234.50 ");
    expect(formatValue(-1234.5, acct)).toBe(" $(1,234.50)");
    expect(formatValue(0, acct).trim()).toBe("$-");
    expect(formatValue("abc", acct)).toBe(" abc ");
    // Text, then dashes to the cell's edge in Excel.
    expect(formatValue("abc", "@*-")).toBe("abc");
    expect(formatValue(1234.5, "#,##0_);[Red](#,##0)")).toBe("1,235 ");
    expect(formatValue(1234.5, "* #,##0")).toBe("1,235");
    expect(formatValue(45000, "yyyy-mm-dd_)")).toBe("2023-03-15 ");
  });
  it("is not a digit or a date code", () => {
    expect(isDateFormat(acct)).toBe(false);
    expect(formatValue(-5, '[<0]"neg"_0;0')).toBe("neg ");
  });
});

describe("dates in capitals, as LibreOffice writes them", () => {
  it("read as the same codes", () => {
    expect(formatValue(45000, "DD/MM/YYYY")).toBe("15/03/2023");
    expect(formatValue(45000, "MM/DD/YY")).toBe("03/15/23");
    expect(formatValue(45000.75, "HH:MM:SS")).toBe("18:00:00");
    expect(formatValue(45000, "D MMMM YYYY")).toBe("15 March 2023");
    expect(formatValue(45000.75, "h:mm am/pm")).toBe("6:00 pm");
  });
});
