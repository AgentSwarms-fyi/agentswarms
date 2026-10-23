// VDB (R265): depreciation over a span of periods by declining balance,
// switching to straight line when that is larger. formula.js does not have it,
// so it was #NAME?. Every answer below is worked out, not remembered: while no
// switch happens, the declining balance from period s to period e is
// cost * ((1 - r)^s - (1 - r)^e) with r = factor / life; a part period is that
// period's share; and the pieces of a life add up to cost - salvage.
import { describe, expect, it } from "vitest";

import { WorkbookEngine } from "@/lib/sheets/engine";
import { FUNCTION_NAMES } from "@/lib/sheets/formula/functions";
import type { Value } from "@/lib/sheets/formula/values";

const e = new WorkbookEngine([{ id: "s", name: "S", kind: "grid", grid: { cells: {} } }]);
const plain = (v: Value): unknown =>
  Array.isArray(v) ? v.map(plain) : v && typeof v === "object" && "err" in v ? { err: v.err } : v;
const at = (f: string): unknown => plain(e.evaluateAt("s", 9, 9, f, { array: false }));
const n = (f: string): number => at(f) as number;
/** Declining balance from period s to period e, while no switch happens. */
const declining = (cost: number, life: number, s: number, end: number, factor = 2) =>
  cost * (Math.pow(1 - factor / life, s) - Math.pow(1 - factor / life, end));

describe("VDB", () => {
  it("is a function", () => expect(FUNCTION_NAMES).toContain("VDB"));

  it("gives Microsoft's six examples, each also worked out", () => {
    // Cost 2400, salvage 300, a life of 10 years.
    expect(n("=VDB(2400,300,3650,0,1)")).toBeCloseTo(declining(2400, 3650, 0, 1), 9); // 1.32
    expect(n("=VDB(2400,300,120,0,1)")).toBeCloseTo(40, 9);
    expect(n("=VDB(2400,300,10,0,1)")).toBeCloseTo(480, 9);
    expect(n("=VDB(2400,300,120,6,18)")).toBeCloseTo(declining(2400, 120, 6, 18), 9); // 396.31
    expect(n("=VDB(2400,300,120,6,18,1.5)")).toBeCloseTo(declining(2400, 120, 6, 18, 1.5), 9); // 311.81
    expect(n("=VDB(2400,300,10,0,0.875,1.5)")).toBeCloseTo(0.875 * 2400 * 0.15, 9); // 315
    expect(
      ["=VDB(2400,300,3650,0,1)", "=VDB(2400,300,120,6,18)", "=VDB(2400,300,120,6,18,1.5)"].map(
        (f) => n(f).toFixed(2),
      ),
    ).toEqual(["1.32", "396.31", "311.81"]);
  });

  it("switches to straight line when that is larger", () => {
    // Factor 1: 240, then 216; in year 3 the declining 194.40 is less than the
    // straight line over what remains, (2400 - 240 - 216 - 300) / 8 = 205.50.
    expect(n("=VDB(2400,300,10,0,1,1)")).toBeCloseTo(240, 9);
    expect(n("=VDB(2400,300,10,1,2,1)")).toBeCloseTo(216, 9);
    expect(n("=VDB(2400,300,10,2,3,1)")).toBeCloseTo(205.5, 9);
    expect(n("=VDB(2400,300,10,9,10,1)")).toBeCloseTo(205.5, 9);
  });

  it("does not switch when told not to", () => {
    expect(n("=VDB(2400,300,10,0,10,1.5,TRUE)")).toBeCloseTo(2400 * (1 - Math.pow(0.85, 10)), 9);
    expect(n("=VDB(2400,300,10,0,10,1.5,FALSE)")).toBeCloseTo(2100, 9);
  });

  it("gives a part period its share of that period, switching or not", () => {
    // Factor 1.5 declines by 360, 306, 260.10 in years 1-3, before any switch.
    for (const tail of ["", ",FALSE", ",TRUE"]) {
      expect(n(`=VDB(2400,300,10,0.5,2.5,1.5${tail})`)).toBeCloseTo(180 + 306 + 130.05, 9);
      expect(n(`=VDB(2400,300,10,2.25,2.75,1.5${tail})`)).toBeCloseTo(130.05, 9);
    }
  });

  it("depreciates a whole life to the salvage value, at any factor", () => {
    for (const factor of [1, 1.5, 2, 3]) {
      expect(n(`=VDB(2400,300,10,0,10,${factor})`)).toBeCloseTo(2100, 9);
    }
  });

  it("adds up across a split at a part period, before and after the switch", () => {
    for (const [cut, factor] of [
      [2.5, 2],
      [7.3, 2],
      [4.4, 1],
      [6.25, 1.5],
      [8.9, 1.5],
    ]) {
      const a = n(`=VDB(2400,300,10,0,${cut},${factor})`);
      const b = n(`=VDB(2400,300,10,${cut},10,${factor})`);
      expect(a + b).toBeCloseTo(2100, 9);
    }
  });

  it("is #NUM! for a span it cannot depreciate", () => {
    for (const f of [
      "=VDB(2400,300,10,5,4)", // starts after it ends
      "=VDB(2400,300,10,0,11)", // ends after the life
      "=VDB(2400,300,10,-1,1)",
      "=VDB(-2400,300,10,0,1)",
      "=VDB(2400,300,0,0,0)",
      "=VDB(2400,300,10,0,1,0)",
    ]) {
      expect(at(f), f).toEqual({ err: "#NUM!" });
    }
  });

  it("needs five arguments", () => {
    expect(at("=VDB(2400,300,10,0)")).toEqual({ err: "#N/A" });
  });
});
