// R124: in the dark theme a filled cell with no text color of its own showed
// the theme's near-white text on its (usually light) fill — the pink of a
// "greater than" rule, a pale header — and could not be read. Text over a
// fill is now dark on a light fill and white on a dark one.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { inkOn, luminance } from "@/lib/sheets/ink";

describe("text over a fill", () => {
  it("is dark on the light fills rules and headers use", () => {
    for (const fill of ["#FFC7CE", "#C6EFCE", "#FFEB9C", "#DDEBF7", "#FFFFFF", "#fff"])
      expect(inkOn(fill)).toBe("#1f1f1f");
  });

  it("is white on dark fills", () => {
    for (const fill of ["#1F4E78", "#9C0006", "#000000", "#595959"])
      expect(inkOn(fill)).toBe("#ffffff");
  });

  it("is left alone without a fill, or with one it cannot read", () => {
    expect(inkOn(undefined)).toBeUndefined();
    expect(inkOn("red")).toBeUndefined();
    expect(luminance("#12345")).toBeNull();
  });

  it("measures brightness the way WCAG does", () => {
    expect(luminance("#000000")).toBe(0);
    expect(luminance("#ffffff")).toBeCloseTo(1, 6);
    expect(luminance("#808080")).toBeCloseTo(0.2159, 3);
  });

  it("is what the grid falls back to when a filled cell has no color of its own", () => {
    const src = readFileSync("src/components/sheets/SheetGrid.tsx", "utf8");
    const draw = src.slice(src.indexOf("const drawCell = "), src.indexOf("const node = ("));
    expect(draw).toMatch(/\?\?\s*inkOn\(bg\);/);
    // The fill is known before the color is chosen from it.
    expect(draw.indexOf("const bg = ")).toBeLessThan(draw.indexOf("inkOn(bg)"));
  });

  it("and what a thumbnail falls back to", () => {
    const src = readFileSync("src/components/sheets/WorkbookThumb.tsx", "utf8");
    expect(src).toContain("color: cell?.fg ?? inkOn(cell?.bg),");
  });
});
