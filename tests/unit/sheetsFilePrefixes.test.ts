// Every newer Excel function the engine computes goes into a download with
// the prefix Excel reads it by (R172). Before, NUMBERVALUE, ISFORMULA and
// FORMULATEXT went out bare, and Excel, which recalculates a download on
// open, showed #NAME? for them. The list is XlsxWriter's
// (tests/fixtures/sheets/excel-future-functions.txt).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FUNCTIONS } from "@/lib/sheets/formula/functions";
import { fromFileFormula, toFileFormula } from "@/lib/sheets/xlsx";

const FUTURE = readFileSync(
  resolve(process.cwd(), "tests/fixtures/sheets/excel-future-functions.txt"),
  "utf8",
)
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith("#"));
/** name → how the file holds it. */
const inFile = new Map(FUTURE.map((f) => [f.replace(/^_xlws\./, ""), `_xlfn.${f}`]));

describe("a download's newer functions", () => {
  it("every one the engine computes carries Excel's prefix", () => {
    const known = [...inFile.keys()].filter((name) => FUNCTIONS[name]);
    expect(known.length).toBeGreaterThan(50);
    const bare = known.filter((name) => toFileFormula(`=${name}(1)`) !== `${inFile.get(name)}(1)`);
    expect(bare).toEqual([]);
  });
  it("NUMBERVALUE, ISFORMULA and FORMULATEXT among them", () => {
    expect(toFileFormula('=NUMBERVALUE("1,5",",")+ISFORMULA(A1)&FORMULATEXT(A1)')).toBe(
      '_xlfn.NUMBERVALUE("1,5",",")+_xlfn.ISFORMULA(A1)&_xlfn.FORMULATEXT(A1)',
    );
    expect(fromFileFormula("_xlfn.NUMBERVALUE(B2)+_xlfn.ISFORMULA(A1)")).toBe(
      "NUMBERVALUE(B2)+ISFORMULA(A1)",
    );
  });
  it("and no older function does", () => {
    for (const name of ["SUM", "VLOOKUP", "NETWORKDAYS.INTL", "WORKDAY.INTL", "FORECAST", "TEXT"])
      expect(toFileFormula(`=${name}(1)`)).toBe(`${name}(1)`);
  });
});
