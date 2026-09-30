// Working days counted backwards (R173). Before, NETWORKDAYS from a later
// date to an earlier one gave the calendar days between them, weekends and
// holidays included: Friday back to Monday was -3 (Excel -5), and a year
// backwards -364 (Excel -262). 2024-01-08 is a Monday, 2024-01-12 a Friday.

import { describe, expect, it } from "vitest";
import { WorkbookEngine, type GridData } from "@/lib/sheets/engine";

function at(formula: string): unknown {
  const grid: GridData = {
    cells: { "0,0": { i: "2024-01-10" }, "1,0": { i: "2024-01-12 18:00" }, "5,5": { i: formula } },
  };
  const e = new WorkbookEngine([{ id: "s", name: "S", grid }]);
  e.recalcAll();
  return e.getValue("s", 5, 5);
}

describe("NETWORKDAYS backwards is minus NETWORKDAYS forwards", () => {
  it("over a week, a weekend's edges, and a year", () => {
    expect(at("=NETWORKDAYS(DATE(2024,1,8),DATE(2024,1,12))")).toBe(5);
    expect(at("=NETWORKDAYS(DATE(2024,1,12),DATE(2024,1,8))")).toBe(-5);
    expect(at("=NETWORKDAYS(DATE(2024,1,14),DATE(2024,1,6))")).toBe(-5);
    expect(at("=NETWORKDAYS(DATE(2024,12,31),DATE(2024,1,1))")).toBe(-262);
  });
  it("with holidays, and in NETWORKDAYS.INTL with its weekend", () => {
    expect(at("=NETWORKDAYS(DATE(2024,1,12),DATE(2024,1,8),A1)")).toBe(-4);
    expect(at("=NETWORKDAYS.INTL(DATE(2024,1,12),DATE(2024,1,8))")).toBe(-5);
    expect(at("=NETWORKDAYS.INTL(DATE(2024,1,12),DATE(2024,1,8),1,A1)")).toBe(-4);
    // Weekend 7 is Friday and Saturday: Monday to Thursday and the Sunday count.
    expect(at("=NETWORKDAYS.INTL(DATE(2024,1,14),DATE(2024,1,8),7)")).toBe(-5);
    expect(at('=NETWORKDAYS.INTL(DATE(2024,1,14),DATE(2024,1,8),"0000011")')).toBe(-5);
  });
  it("one day is one, whatever the hours, and a Saturday none", () => {
    expect(at("=NETWORKDAYS(A2,DATE(2024,1,12))")).toBe(1);
    expect(at("=NETWORKDAYS(DATE(2024,1,13),DATE(2024,1,13))")).toBe(0);
  });
  it("an error in a date stays an error", () => {
    expect(at("=NETWORKDAYS(1/0,DATE(2024,1,8))")).toMatchObject({ err: "#DIV/0!" });
  });
});
