// Financial functions a loan or investment sheet uses (R177). Before, CUMIPMT,
// CUMPRINC, MIRR, FVSCHEDULE, SYD, ISPMT, PDURATION and RRI were #NAME?,
// though formula.js has them; an Excel file using them showed only its saved
// values. The expected values are Microsoft's worked examples.

import { describe, expect, it } from "vitest";
import { WorkbookEngine, type GridData } from "@/lib/sheets/engine";
import { FUNCTION_HELP } from "@/lib/sheets/functionHelp";
import { toFileFormula } from "@/lib/sheets/xlsx";

function at(formula: string, cells: Record<string, string> = {}): unknown {
  const grid: GridData = { cells: { "20,5": { i: formula } } };
  for (const [k, i] of Object.entries(cells)) grid.cells[k] = { i };
  const e = new WorkbookEngine([{ id: "s", name: "S", grid }]);
  e.recalcAll();
  return e.getValue("s", 20, 5);
}

describe("loan and investment functions", () => {
  it("CUMIPMT and CUMPRINC: the second year of a 30-year loan", () => {
    expect(at("=CUMIPMT(0.09/12,360,125000,13,24,0)")).toBeCloseTo(-11135.23213, 4);
    expect(at("=CUMPRINC(0.09/12,360,125000,13,24,0)")).toBeCloseTo(-934.1071234, 4);
    expect(at("=CUMIPMT(0.09/12,360,125000,1,1,0)")).toBeCloseTo(-937.5, 6);
  });
  it("CUMIPMT is #NUM! for a loan of nothing or a period out of range", () => {
    expect(at("=CUMIPMT(0.09/12,360,-125000,13,24,0)")).toMatchObject({ err: "#NUM!" });
    expect(at("=CUMIPMT(0.09/12,360,125000,0,24,0)")).toMatchObject({ err: "#NUM!" });
  });
  it("MIRR, skipping a blank cell among the flows as Excel does", () => {
    expect(at("=MIRR({-120000,39000,30000,21000,37000,46000},0.1,0.12)")).toBeCloseTo(0.126094, 6);
    // A1:A7 holds the same flows with a blank at A3.
    const flows = {
      "0,0": "-120000",
      "1,0": "39000",
      "3,0": "30000",
      "4,0": "21000",
      "5,0": "37000",
      "6,0": "46000",
    };
    expect(at("=MIRR(A1:A7,0.1,0.12)", flows)).toBeCloseTo(0.126094, 6);
  });
  it("FVSCHEDULE (a blank rate is none), SYD, ISPMT, PDURATION and RRI", () => {
    expect(at("=FVSCHEDULE(1,{0.09,0.11,0.1})")).toBeCloseTo(1.33089, 10);
    expect(at("=FVSCHEDULE(1,A1:A3)", { "0,0": "0.09", "2,0": "0.1" })).toBeCloseTo(1.199, 10);
    expect(at("=SYD(30000,7500,10,1)")).toBeCloseTo(4090.909091, 5);
    expect(at("=SYD(30000,7500,10,10)")).toBeCloseTo(409.0909091, 6);
    expect(at("=ISPMT(0.1/12,1,36,8000000)")).toBeCloseTo(-64814.81481, 4);
    expect(at("=PDURATION(0.025,2000,2200)")).toBeCloseTo(3.859866163, 8);
    expect(at("=RRI(96,10000,11000)")).toBeCloseTo(0.0009933, 7);
  });
  it("go into a download as Excel names them, and autocomplete describes the loan ones", () => {
    expect(toFileFormula("=PDURATION(0.025,2000,2200)+RRI(96,10000,11000)")).toBe(
      "_xlfn.PDURATION(0.025,2000,2200)+_xlfn.RRI(96,10000,11000)",
    );
    expect(toFileFormula("=CUMIPMT(1,2,3,1,1,0)")).toBe("CUMIPMT(1,2,3,1,1,0)");
    expect(FUNCTION_HELP.CUMIPMT.cat).toBe("Financial");
    expect(FUNCTION_HELP.CUMPRINC.sig).toMatch(/^CUMPRINC\(rate, nper, pv/);
  });
});
