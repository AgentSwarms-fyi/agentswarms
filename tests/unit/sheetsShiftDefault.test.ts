// Insert cells / Delete cells start on the direction the selection's shape
// suggests (R267): sideways for a tall selection, up or down otherwise. The
// dialog always started on down (or up), so a column of cells inserted with
// Enter pushed the whole column below it.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseRangeA1 } from "@/lib/sheets/a1";
import { defaultShift } from "@/lib/sheets/shiftCells";

const r = (a1: string) => parseRangeA1(a1)!;

describe("defaultShift", () => {
  it("one cell, or a wide selection, moves its neighbours down (insert) or up (delete)", () => {
    for (const a of ["B2", "B2:F2", "B2:F4"]) {
      expect(defaultShift("insert", r(a)), a).toBe("down");
      expect(defaultShift("delete", r(a)), a).toBe("up");
    }
  });

  it("a tall selection moves them right (insert) or left (delete)", () => {
    for (const a of ["B2:B9", "B2:C9"]) {
      expect(defaultShift("insert", r(a)), a).toBe("right");
      expect(defaultShift("delete", r(a)), a).toBe("left");
    }
  });

  it("a square selection counts as wide, as one cell does", () => {
    expect(defaultShift("insert", r("B2:D4"))).toBe("down");
    expect(defaultShift("delete", r("B2:D4"))).toBe("up");
  });
});

describe("the dialog", () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

  it("starts on the choice it is given", () => {
    expect(read("src/components/sheets/ShiftCellsDialog.tsx")).toContain(
      "useState<ShiftChoice>(initial)",
    );
  });

  it("is given defaultShift's choice for the selection", () => {
    expect(read("src/components/sheets/WorkbookEditor.tsx")).toContain(
      "initial={defaultShift(shiftAsk, range)}",
    );
  });
});
