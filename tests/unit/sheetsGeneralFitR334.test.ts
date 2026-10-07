// A General number in a column too narrow for it (R334).
//
// FOUND IN R333, testing in the browser: CHISQ.TEST's 0.000308192017 showed
// as ########## in a default-width column, where Excel shows 0.000308192.
// Excel rounds a General number to fit (fewer decimals, then scientific)
// and shows #### only when nothing fits; a number with a format of its own
// does show ####. Widths here are in characters.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { generalToFit, numberToFit } from "@/lib/sheets/format";

const fit = (n: number, width: number) => generalToFit(n, (s) => s.length <= width);

describe("a General number rounds to fit its column", () => {
  it.each([
    // It fits: shown as General writes it.
    [0.000308192017, 14, "0.000308192017"],
    // Fewer decimals while a digit that is not 0 is left.
    [0.000308192017, 11, "0.000308192"],
    [0.000308192017, 8, "0.000308"],
    [0.000308192017, 6, "0.0003"],
    [1234.5678, 6, "1234.6"],
    [1234.5678, 4, "1235"],
    [1 / 3, 6, "0.3333"],
    [-1234567.891, 8, "-1234568"],
    [99999.99, 7, "100000"],
    // Rounded from the 15-digit decimal, as Excel rounds, not from the double.
    [2.675, 4, "2.68"],
    [1.005, 4, "1.01"],
    // Then scientific, with fewer digits.
    [0.000308192017, 5, "3E-04"],
    [123456789, 8, "1.23E+08"],
    [123456789, 6, "1E+08"],
    [12345678901.5, 8, "1.23E+10"],
    [-1234567.891, 6, "-1E+06"],
    [99999.99, 5, "1E+05"],
    [-0.0004, 6, "-4E-04"],
    // 1.5E-07 is a hair under 1.5E-07 as a double; Excel's digits round it up.
    [1.5e-7, 6, "2E-07"],
  ])("%s in %s characters is %s", (n, width, want) => {
    expect(fit(n, width)).toBe(want);
  });

  it.each([
    [1234.5678, 3],
    [0.000308192017, 4],
    [-0.0004, 5],
    [99999.99, 4],
  ])("and is #### when nothing fits: %s in %s characters", (n, width) => {
    expect(fit(n, width)).toBeNull();
  });
});

describe("a number with a format of its own keeps ####, as in Excel", () => {
  it("General rounds, whether written or left out", () => {
    const fits = (s: string) => s.length <= 8;
    expect(numberToFit(0.000308192017, undefined, fits)).toBe("0.000308");
    expect(numberToFit(0.000308192017, "General", fits)).toBe("0.000308");
    expect(numberToFit(0.000308192017, " general ", fits)).toBe("0.000308");
  });
  it("any other format does not", () => {
    const fits = (s: string) => s.length <= 8;
    for (const f of ["0.00", "#,##0", "0.00%", "$#,##0.00", "yyyy-mm-dd", "0.00E+00"])
      expect(numberToFit(123456789.5, f, fits), f).toBeNull();
  });
});

describe("the grid", () => {
  it("rounds a General number to fit before it shows ####", () => {
    // Pinned on the use: the cell's own text, its format and the width it has.
    const src = readFileSync(resolve("src/components/sheets/SheetGrid.tsx"), "utf8");
    expect(src).toMatch(
      /numberToFit\(value, effectiveFormat\(input\), \(s\) => measureText\(s, font\) <= inner\)[\s\S]{0,120}fitted \?\? "#"\.repeat/,
    );
  });
});
