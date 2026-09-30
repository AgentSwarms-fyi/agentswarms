// WEEKDAY's return types 11 to 17, and DAYS360 (R174). Before, WEEKDAY(d,11)
// was #NUM! and DAYS360 #NAME?. The DAYS360 cases are Microsoft's examples
// (1/1/2011, 1/30/2011, 2/1/2011, 12/31/2011) and the US method's edges.

import { describe, expect, it } from "vitest";
import { WorkbookEngine, type GridData } from "@/lib/sheets/engine";
import { FUNCTION_HELP } from "@/lib/sheets/functionHelp";

function at(formula: string, rows = 1): unknown {
  const grid: GridData = { cells: { "5,5": { i: formula } } };
  const e = new WorkbookEngine([{ id: "s", name: "S", grid }]);
  e.recalcAll();
  if (rows === 1) return e.getValue("s", 5, 5);
  return Array.from({ length: rows }, (_, i) => e.getValue("s", 5, 5 + i));
}

describe("WEEKDAY's return types", () => {
  // 2024-01-01 was a Monday, 2024-01-07 a Sunday.
  it("11 to 17 number the week from Monday to Sunday", () => {
    const monday = [11, 12, 13, 14, 15, 16, 17].map((t) => at(`=WEEKDAY(DATE(2024,1,1),${t})`));
    expect(monday).toEqual([1, 7, 6, 5, 4, 3, 2]);
    const sunday = [11, 12, 13, 14, 15, 16, 17].map((t) => at(`=WEEKDAY(DATE(2024,1,7),${t})`));
    expect(sunday).toEqual([7, 6, 5, 4, 3, 2, 1]);
  });
  it("1, 2 and 3 as before; 4 and 18 are #NUM!", () => {
    expect([1, 2, 3].map((t) => at(`=WEEKDAY(DATE(2024,1,1),${t})`))).toEqual([2, 1, 0]);
    expect(at("=WEEKDAY(DATE(2024,1,1),4)")).toMatchObject({ err: "#NUM!" });
    expect(at("=WEEKDAY(DATE(2024,1,1),18)")).toMatchObject({ err: "#NUM!" });
  });
});

describe("DAYS360", () => {
  it("Microsoft's examples", () => {
    expect(at("=DAYS360(DATE(2011,1,30),DATE(2011,2,1))")).toBe(1);
    expect(at("=DAYS360(DATE(2011,1,1),DATE(2011,12,31))")).toBe(360);
    expect(at("=DAYS360(DATE(2011,1,1),DATE(2011,2,1))")).toBe(30);
  });
  it("the US method's 31st and last of February; the European method's 31st", () => {
    expect(at("=DAYS360(DATE(2024,1,31),DATE(2024,3,31))")).toBe(60);
    expect(at("=DAYS360(DATE(2024,2,29),DATE(2024,3,31))")).toBe(30);
    expect(at("=DAYS360(DATE(2023,2,28),DATE(2023,3,31))")).toBe(30);
    expect(at("=DAYS360(DATE(2024,2,28),DATE(2024,3,31))")).toBe(33);
    expect(at("=DAYS360(DATE(2024,1,1),DATE(2024,12,31),TRUE)")).toBe(359);
    expect(at("=DAYS360(DATE(2024,1,31),DATE(2024,3,31),TRUE)")).toBe(60);
    expect(at("=DAYS360(DATE(2024,1,15),DATE(2024,3,31),TRUE)")).toBe(75);
  });
  it("backwards is negative, times are dropped, errors pass through", () => {
    expect(at("=DAYS360(DATE(2011,2,1),DATE(2011,1,30))")).toBe(-1);
    expect(at("=DAYS360(DATE(2011,1,1)+0.9,DATE(2011,2,1))")).toBe(30);
    expect(at("=DAYS360(1/0,DATE(2011,2,1))")).toMatchObject({ err: "#DIV/0!" });
    expect(at("=DAYS360(DATE(2011,2,1))")).toMatchObject({ err: "#N/A" });
  });
  it("works over arrays and has help", () => {
    expect(at("=DAYS360(DATE(2011,1,1),{40575,40908})", 2)).toEqual([30, 360]);
    expect(FUNCTION_HELP.DAYS360.sig).toBe("DAYS360(start_date, end_date, [method])");
  });
});
