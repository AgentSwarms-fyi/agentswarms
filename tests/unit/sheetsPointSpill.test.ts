// Point mode over a spilled array (R266). Dragging across the whole of a spill
// while typing a formula writes the spill's own reference, A1#, as Excel does,
// so the formula follows the array when it grows or shrinks. It wrote A1:A3,
// fixed to the array's size on the day the formula was typed.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { WorkbookEngine } from "@/lib/sheets/engine";
import { pointedReference, spillExtentIn } from "@/lib/sheets/selection";

const at = (row: number, col: number) => ({ row, col });

describe("pointedReference", () => {
  // A spill anchored at B2, three rows by two columns: B2:C4.
  const spilled = (row: number, col: number) =>
    row === 1 && col === 1 ? { rows: 3, cols: 2 } : undefined;

  it("is the spill's reference when the drag covers exactly the spill", () => {
    expect(pointedReference(at(1, 1), at(3, 2), spilled)).toBe("B2#");
    expect(pointedReference(at(3, 2), at(1, 1), spilled)).toBe("B2#"); // dragged up and left
    expect(pointedReference(at(3, 1), at(1, 2), spilled)).toBe("B2#"); // across the other diagonal
  });

  it("is a plain range for part of a spill, or more than it", () => {
    expect(pointedReference(at(1, 1), at(2, 2), spilled)).toBe("B2:C3");
    expect(pointedReference(at(2, 1), at(3, 2), spilled)).toBe("B3:C4");
    expect(pointedReference(at(1, 1), at(4, 2), spilled)).toBe("B2:C5");
    // As many rows as the spill, but one of its two columns.
    expect(pointedReference(at(1, 1), at(3, 1), spilled)).toBe("B2:B4");
    expect(pointedReference(at(1, 1), at(1, 2), spilled)).toBe("B2:C2");
  });

  it("is one cell when one cell is clicked, the anchor included", () => {
    expect(pointedReference(at(1, 1), at(1, 1), spilled)).toBe("B2");
    expect(pointedReference(at(5, 5), at(5, 5), spilled)).toBe("F6");
  });
});

describe("spillExtentIn, on a real workbook", () => {
  const engine = new WorkbookEngine([
    {
      id: "s",
      name: "S",
      kind: "grid",
      grid: {
        cells: {
          "0,0": { i: "=SEQUENCE(3)" }, // A1:A3
          "0,2": { i: "=SEQUENCE(3)" }, // C1, blocked by C2
          "1,2": { i: "x" },
          "0,4": { i: "=SEQUENCE(1)" }, // E1, one value: no spill
        },
      },
    },
  ]);
  const spilled = spillExtentIn(engine, "s");

  it("writes A1# over a spill that spilled", () => {
    expect(pointedReference(at(0, 0), at(2, 0), spilled)).toBe("A1#");
  });

  it("writes a plain range over a blocked spill, which has no A1#", () => {
    expect(engine.getValue("s", 0, 2)).toMatchObject({ err: "#SPILL!" });
    expect(pointedReference(at(0, 2), at(2, 2), spilled)).toBe("C1:C3");
  });

  it("writes one cell for a one-value array", () => {
    expect(pointedReference(at(0, 4), at(0, 4), spilled)).toBe("E1");
  });

  it("is read by the engine: =SUM(A1#) adds the spill", () => {
    const sum = engine.evaluateAt(
      "s",
      9,
      9,
      `=SUM(${pointedReference(at(0, 0), at(2, 0), spilled)})`,
      {
        array: false,
      },
    );
    expect(sum).toBe(6);
  });
});

describe("the grid", () => {
  it("writes what pointedReference says while a formula is dragged across cells", () => {
    const src = readFileSync(join(process.cwd(), "src/components/sheets/SheetGrid.tsx"), "utf8");
    expect(src).toContain("pointedReference(d.start, hit, spillExtentIn(engine, tabId))");
  });
});
