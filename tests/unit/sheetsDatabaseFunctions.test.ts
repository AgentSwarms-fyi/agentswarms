// Excel's database functions on Microsoft's tree example (R259).
//
// formula.js has DSUM and the rest and does not read criteria as Excel does:
// its DSUM of the apple trees' profit was every tree's (502.8, not 225). So
// they are written in the engine, and every answer below is worked out by
// hand from the six rows of the table, so none rests on a remembered number.
import { describe, expect, it } from "vitest";

import { WorkbookEngine } from "@/lib/sheets/engine";
import type { Value } from "@/lib/sheets/formula/values";

const cells: Record<string, { i: string }> = {};
/** put("A10", "Tree") — 1-based A1 references, as a person would write them. */
function put(ref: string, v: string | number) {
  const m = /^([A-Z]+)(\d+)$/.exec(ref)!;
  const col = [...m[1]].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  cells[`${Number(m[2]) - 1},${col}`] = { i: String(v) };
}
function row(start: string, values: (string | number)[]) {
  const m = /^([A-Z]+)(\d+)$/.exec(start)!;
  values.forEach((v, k) => put(`${String.fromCharCode(m[1].charCodeAt(0) + k)}${m[2]}`, v));
}

// The database, A10:E16.
row("A10", ["Tree", "Height", "Age", "Yield", "Profit"]);
row("A11", ["Apple", 18, 20, 14, 105]);
row("A12", ["Pear", 12, 12, 10, 96]);
row("A13", ["Cherry", 13, 14, 9, 105]);
row("A14", ["Apple", 14, 15, 10, 75]);
row("A15", ["Pear", 9, 8, 8, 76.8]);
row("A16", ["Apple", 8, 9, 6, 45]);
// Criteria ranges.
row("G1", ["Tree", "Height"]); // apple AND taller than 10: Apple 18, Apple 14
row("G2", ["Apple", ">10"]);
put("J1", "Tree"); // apple OR pear
put("J2", "Apple");
put("J3", "Pear");
row("L1", ["Tree", "Height", "Height"]); // apple between 10 and 16 high: Apple 14 only
row("L2", ["Apple", ">10", "<16"]);
put("P1", "Tree"); // a blank criterion: no condition, every tree
put("R1", "Tree"); // bare text is "begins with"
put("R2", "Ap");
put("T1", "Tree"); // "=Pea" is exact: no tree is called Pea
put("T2", '="=Pea"');
put("V1", "Tree"); // nothing matches
put("V2", "Plum");
put("X1", "TREE"); // a criteria label in another case still names the field
put("X2", "Apple");

const e = new WorkbookEngine([{ id: "s", name: "S", kind: "grid", grid: { cells } }]);
const plain = (v: Value): unknown =>
  Array.isArray(v) ? v.map(plain) : v && typeof v === "object" && "err" in v ? { err: v.err } : v;
const at = (f: string): unknown => {
  const v = plain(e.evaluateAt("s", 39, 25, f, { array: true })) as unknown;
  return Array.isArray(v) && v.length === 1 && Array.isArray(v[0]) && v[0].length === 1
    ? v[0][0]
    : v;
};
const n = (f: string) => at(f) as number;
const DB = "A10:E16";

describe("the database functions, on Microsoft's tree example", () => {
  it("DAVERAGE", () => {
    expect(n(`=DAVERAGE(${DB},"Yield",G1:H2)`)).toBe(12); // (14 + 10) / 2
    expect(n(`=DAVERAGE(${DB},3,P1:P2)`)).toBe(13); // ages 20+12+14+15+8+9 = 78, / 6
  });

  it("DSUM: the apple trees, and the apple trees 10 to 16 high", () => {
    expect(n(`=DSUM(${DB},"Profit",X1:X2)`)).toBe(225); // 105 + 75 + 45
    expect(n(`=DSUM(${DB},"Profit",L1:N2)`)).toBe(75); // Apple 14 only
  });

  it("rows are OR, a row's cells are AND", () => {
    expect(n(`=DMAX(${DB},"Profit",J1:J3)`)).toBe(105); // max of 105, 96, 75, 76.8, 45
    expect(n(`=DMIN(${DB},"Profit",G1:H2)`)).toBe(75); // min of 105, 75
    expect(n(`=DPRODUCT(${DB},"Yield",J1:J3)`)).toBe(14 * 10 * 10 * 8 * 6);
  });

  it("DCOUNT and DCOUNTA, with and without a field", () => {
    expect(n(`=DCOUNT(${DB},"Age",G1:H2)`)).toBe(2);
    expect(n(`=DCOUNT(${DB},,G1:H2)`)).toBe(2); // no field: the matching records
    expect(n(`=DCOUNTA(${DB},"Tree",X1:X2)`)).toBe(3);
  });

  it("DGET: one record, none, or too many", () => {
    expect(n(`=DGET(${DB},"Yield",L1:N2)`)).toBe(10);
    expect(at(`=DGET(${DB},"Yield",V1:V2)`)).toEqual({ err: "#VALUE!" });
    expect(at(`=DGET(${DB},"Yield",G1:H2)`)).toEqual({ err: "#NUM!" });
  });

  it("the spread: sample and population", () => {
    // Yields of apple or pear trees: 14, 10, 10, 8, 6. Mean 9.6; squares sum to 35.2.
    expect(n(`=DVAR(${DB},"Yield",J1:J3)`)).toBeCloseTo(35.2 / 4, 12);
    expect(n(`=DVARP(${DB},"Yield",J1:J3)`)).toBeCloseTo(35.2 / 5, 12);
    expect(n(`=DSTDEV(${DB},"Yield",J1:J3)`)).toBeCloseTo(Math.sqrt(35.2 / 4), 12);
    expect(n(`=DSTDEVP(${DB},"Yield",J1:J3)`)).toBeCloseTo(Math.sqrt(35.2 / 5), 12);
  });
});

describe("Excel's criteria rules", () => {
  it("bare text is 'begins with', and '=text' is exact", () => {
    expect(n(`=DSUM(${DB},"Profit",R1:R2)`)).toBe(225); // "Ap" -> the apples
    expect(n(`=DSUM(${DB},"Profit",T1:T2)`)).toBe(0); // "=Pea" -> no tree is called Pea
  });

  it("a blank criterion is no condition at all", () => {
    expect(n(`=DSUM(${DB},"Profit",P1:P2)`)).toBeCloseTo(502.8, 10);
  });

  it("a field is a label in any case, or a column number", () => {
    expect(n(`=DSUM(${DB},"profit",X1:X2)`)).toBe(225);
    expect(n(`=DSUM(${DB},5,X1:X2)`)).toBe(225);
    expect(at(`=DSUM(${DB},"Weight",X1:X2)`)).toEqual({ err: "#VALUE!" });
  });

  it("nothing matched: an average has nothing to divide, a maximum is 0", () => {
    expect(at(`=DAVERAGE(${DB},"Yield",V1:V2)`)).toEqual({ err: "#DIV/0!" });
    expect(n(`=DMAX(${DB},"Yield",V1:V2)`)).toBe(0);
  });
});
