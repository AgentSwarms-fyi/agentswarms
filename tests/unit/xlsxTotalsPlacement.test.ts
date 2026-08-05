// Two BoQ workbooks, two unrelated runs, the same broken totals row:
//
//   A9 "TOTAL"  B9 =SUM(G2:G8)     G9 empty
//   A5 "Total"  B5 =SUM(I2:I4)     I5 empty — while J5, K5 and L5 in the SAME
//                                  row were placed under their own columns
//
// It screenshots perfectly, because the builder caches a computed value next to
// the formula. It is still wrong twice over: the number sits under an unrelated
// heading ("OCI Shape"), and the rollup sheet's grand total pointed at
// 'BOQ Line Items'!G9 — the sensible cell, which is empty — so the whole
// workbook's headline figure resolves to 0 the first time Excel recalculates.
//
// Data-bound sheets never had this: they place totals by header NAME. Only
// literal sheets, authored positionally by the model, land in column B whatever
// they sum.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { alignColumnAggregates, columnIndex } from "@/lib/docGen/xlsxRepair";
import type { XlsxLiteralSheet } from "@/lib/docGen/types";

const BUILD = readFileSync("src/lib/docGen/build.ts", "utf8");
const PLAN = readFileSync("src/lib/docGen/plan.ts", "utf8");
const PLAYGROUND = readFileSync("src/routes/_authenticated/playground.tsx", "utf8");

const sheet = (rows: XlsxLiteralSheet["rows"], headers: string[] = []): XlsxLiteralSheet => ({
  name: "BOQ",
  headers,
  rows,
});

describe("columnIndex maps A1 letters", () => {
  it("handles single and multi-letter columns", () => {
    expect(columnIndex("A")).toBe(0);
    expect(columnIndex("B")).toBe(1);
    expect(columnIndex("G")).toBe(6);
    expect(columnIndex("I")).toBe(8);
    expect(columnIndex("Z")).toBe(25);
    expect(columnIndex("AA")).toBe(26);
    expect(columnIndex("AB")).toBe(27);
  });
});

describe("a column's total goes under that column", () => {
  it("fixes the observed SUM(I2:I4) stranded in column B", () => {
    // The real row: label, misplaced compute total, then three correct totals.
    const row = [
      "Total",
      { formula: "SUM(I2:I4)" },
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      { formula: "SUM(J2:J4)" },
      { formula: "SUM(K2:K4)" },
      { formula: "SUM(L2:L4)" },
    ];
    const { sheet: fixed, moves } = alignColumnAggregates(sheet([row]));
    const out = fixed.rows[0];

    expect(out[8]).toEqual({ formula: "SUM(I2:I4)" }); // column I
    expect(out[1]).toBeNull(); // column B vacated
    // The correctly-placed totals must not be disturbed.
    expect(out[9]).toEqual({ formula: "SUM(J2:J4)" });
    expect(out[10]).toEqual({ formula: "SUM(K2:K4)" });
    expect(out[11]).toEqual({ formula: "SUM(L2:L4)" });
    expect(out[0]).toBe("Total");
    expect(moves).toEqual(["SUM(I2:I4) → column I"]);
  });

  it("fixes the other observed shape, where the row is too short to reach G", () => {
    // ["TOTAL", =SUM(G2:G8)] — only two cells, so column G does not exist yet.
    const { sheet: fixed, moves } = alignColumnAggregates(
      sheet([["TOTAL", { formula: "SUM(G2:G8)" }]]),
    );
    const out = fixed.rows[0];
    expect(out).toHaveLength(7);
    expect(out[6]).toEqual({ formula: "SUM(G2:G8)" });
    expect(out[1]).toBeNull();
    expect(moves).toHaveLength(1);

    // Every intervening cell must be a real null, not an array HOLE. Assigning
    // past the end (`row[6] = x`) grows the array with holes, and build.ts
    // writes rows via `row.map(toXlsxCell)` — map SKIPS holes, so they survive
    // into the sheet instead of becoming empty cells.
    const present = Array.from({ length: out.length }, (_, i) => i in out);
    expect(present).toEqual([true, true, true, true, true, true, true]);
  });

  it("leaves a correctly-placed total exactly where it is", () => {
    const row = ["Total", null, null, null, null, null, { formula: "SUM(G2:G8)" }];
    const { sheet: fixed, moves } = alignColumnAggregates(sheet([row]));
    expect(moves).toEqual([]);
    expect(fixed.rows[0]).toBe(row); // untouched, not merely equal
  });

  it("refuses to move onto an occupied cell", () => {
    // Someone meant something by this layout; we do not understand it, so we
    // leave it rather than overwrite a value.
    const row = ["Total", { formula: "SUM(C2:C4)" }, 42];
    const { moves, sheet: fixed } = alignColumnAggregates(sheet([row]));
    expect(moves).toEqual([]);
    expect(fixed.rows[0][2]).toBe(42);
  });

  it("ignores multi-column ranges, which are not a column total", () => {
    // The range must start in a DIFFERENT column from the cell, or the
    // target===col short-circuit hides whether the range width was checked.
    const { sheet: fixed, moves } = alignColumnAggregates(
      sheet([["Total", { formula: "SUM(C2:E4)" }]]),
    );
    expect(moves).toEqual([]);
    expect(fixed.rows[0][1]).toEqual({ formula: "SUM(C2:E4)" }); // stayed put
    expect(fixed.rows[0][2]).toBeUndefined(); // nothing written to column C
  });

  it("ignores cross-sheet references", () => {
    // A rollup pointing at the detail sheet is correct by construction, and its
    // column letter refers to a DIFFERENT sheet.
    const row = ["Total", { formula: "SUM('Bill of Quantities'!K2:K8)" }];
    const { moves } = alignColumnAggregates(sheet([row]));
    expect(moves).toEqual([]);
  });

  it("ignores arithmetic that merely contains a range", () => {
    const { moves } = alignColumnAggregates(sheet([["Total", { formula: "SUM(I2:I4)*12" }]]));
    expect(moves).toEqual([]);
  });

  it("leaves literal values and plain cells alone", () => {
    const rows = [
      ["Web Tier", 4, 0.03, 730],
      ["App Tier", 6, 0.03, 730],
    ];
    const { sheet: fixed, moves } = alignColumnAggregates(sheet(rows));
    expect(moves).toEqual([]);
    expect(fixed.rows).toBe(rows);
  });

  it("handles AVERAGE/MIN/MAX/COUNT the same way", () => {
    for (const fn of ["AVERAGE", "MIN", "MAX", "COUNT", "COUNTA", "MEDIAN"]) {
      const { sheet: fixed } = alignColumnAggregates(
        sheet([["Stat", { formula: `${fn}(D2:D9)` }]]),
      );
      expect(fixed.rows[0][3]).toEqual({ formula: `${fn}(D2:D9)` });
    }
  });

  it("fixes several strays in one row without losing any", () => {
    const row = ["Total", { formula: "SUM(E2:E4)" }, { formula: "SUM(F2:F4)" }];
    const { sheet: fixed, moves } = alignColumnAggregates(sheet([row]));
    expect(fixed.rows[0][4]).toEqual({ formula: "SUM(E2:E4)" });
    expect(fixed.rows[0][5]).toEqual({ formula: "SUM(F2:F4)" });
    expect(moves).toHaveLength(2);
  });
});

describe("the builder applies it, and does not do it silently", () => {
  it("runs the alignment during materialization", () => {
    expect(BUILD).toContain("alignColumnAggregates(s)");
    expect(BUILD).toContain("return { sheets: aligned, repairs };");
  });

  it("tells the user a cell moved", () => {
    expect(PLAYGROUND).toContain("materialized.repairs?.length");
    expect(PLAYGROUND).toContain("Fixed the layout of a totals row");
  });
});

describe("the Deep renderer does not hand LibreOffice value-less cells", () => {
  // The client plan can be perfect and the file still come out wrong. openpyxl
  // wrote the totals row correctly; the LibreOffice recalc round-trip then
  // collapsed the run of styled-but-empty cells and dragged the next formula
  // left. Measured in the container, same plan, recalc on vs off:
  //
  //   recalc=False   H4 =SUM(H2:H3)      recalc=True   B4 =SUM(H2:H3)
  //
  // Not writing a cell that has no value fixes it. There is no pytest harness
  // in this repo, so this guards the line from a revert.
  const RENDERER = readFileSync("docgen-service/renderer_xlsx.py", "utf8");

  it("returns before materialising a cell with no value", () => {
    const guard = RENDERER.indexOf("if value is None:\n        return 0");
    const create = RENDERER.indexOf("cell = ws.cell(row=r, column=c)");
    expect(guard).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(create);
  });

  it("no longer writes an explicit None value", () => {
    expect(RENDERER).not.toContain("cell.value = None");
  });
});

describe("the planner is told both rules", () => {
  it("requires a total to sit in the column it sums", () => {
    expect(PLAN).toContain("SAME COLUMN as the values it sums");
    expect(PLAN).toContain("Pad the row with nulls");
  });

  it("requires a roll-up to reference the detail sheet, not copy it", () => {
    // The other half of the same failure: a rollup of copied constants stops
    // agreeing with its own line items the moment a quantity changes.
    expect(PLAN).toContain("must REFERENCE the detail sheet, never restate");
    expect(PLAN).toContain("'Bill of Quantities'!K2");
  });
});
