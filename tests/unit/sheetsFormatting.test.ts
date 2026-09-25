// Sheets formatting: the geometry the grid draws with, merges, borders,
// links, fonts, row heights that follow their content, and the number-format
// buttons. Pure functions; the UI round in docs/UI_TEST_RESULTS.md drives
// the same things through the browser.
import { describe, expect, it } from "vitest";

import { adjustDecimals, formatColor, formatValue } from "@/lib/sheets/format";
import { AxisGeometry, clampZoom, stepZoom } from "@/lib/sheets/geometry";
import {
  autoRowHeights,
  shiftIndex,
  shiftIndexList,
  shiftIndexRecord,
  wrapLines,
} from "@/lib/sheets/layout";
import {
  addMerge,
  cellsLostByMerge,
  expandToMerges,
  mergeAt,
  parseMerges,
  removeMerges,
  shiftMerges,
} from "@/lib/sheets/merge";
import { moveCells } from "@/lib/sheets/ops";
import {
  bordersFor,
  cssBorder,
  fontPx,
  fontStack,
  linkProblem,
  normalizeColor,
  normalizeLink,
  parseInternalLink,
} from "@/lib/sheets/style";
import { WorkbookEngine } from "@/lib/sheets/engine";
import { startsEdit } from "@/lib/sheets/selection";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { gridSchema } from "@/utils/sheets/schemas";

describe("geometry", () => {
  const sizes = [24, 0, 40, 24];
  const g = new AxisGeometry(4, (i) => sizes[i]);
  it("places items by prefix sums, a hidden one taking no room", () => {
    expect([g.start(0), g.start(1), g.start(2), g.start(3), g.total]).toEqual([0, 24, 24, 64, 88]);
    expect(g.size(1)).toBe(0);
  });
  it("finds the item under a pixel, never a hidden one", () => {
    expect(g.indexAt(0)).toBe(0);
    expect(g.indexAt(23)).toBe(0);
    expect(g.indexAt(24)).toBe(2);
    expect(g.indexAt(63)).toBe(2);
    expect(g.indexAt(64)).toBe(3);
    expect(g.indexAt(10_000)).toBe(3);
    // Past the end, with the last column hidden: the last one showing.
    const lastHidden = new AxisGeometry(3, (i) => [24, 24, 0][i]);
    expect(lastHidden.indexAt(100)).toBe(1);
  });
  it("zooms in steps of ten within Excel's bounds", () => {
    expect(stepZoom(100, 1)).toBe(110);
    expect(stepZoom(100, -1)).toBe(90);
    expect(stepZoom(125, 1)).toBe(130);
    expect(stepZoom(125, -1)).toBe(120);
    expect(stepZoom(400, 1)).toBe(400);
    expect(clampZoom(5)).toBe(25);
    expect(clampZoom(Number.NaN)).toBe(100);
  });
});

describe("merged cells", () => {
  it("grows a selection until it cuts no merge", () => {
    const m = parseMerges(["B1:B3", "C3:D4"]);
    expect(expandToMerges({ r0: 1, c0: 1, r1: 1, c1: 2 }, m)).toEqual({
      r0: 0,
      c0: 1,
      r1: 3,
      c1: 3,
    });
    expect(mergeAt(m, 2, 1)).toEqual({ r0: 0, c0: 1, r1: 2, c1: 1 });
    expect(mergeAt(m, 5, 5)).toBeUndefined();
  });
  it("replaces merges it overlaps; Merge Across merges row by row", () => {
    expect(addMerge(["A1:B2", "F1:G1"], { r0: 1, c0: 1, r1: 2, c1: 2 }, "merge")).toEqual([
      "F1:G1",
      "B2:C3",
    ]);
    expect(addMerge([], { r0: 0, c0: 0, r1: 2, c1: 1 }, "across")).toEqual([
      "A1:B1",
      "A2:B2",
      "A3:B3",
    ]);
    // A one-cell "merge" is no merge.
    expect(addMerge([], { r0: 0, c0: 0, r1: 2, c1: 0 }, "across")).toEqual([]);
    expect(removeMerges(["A1:B2", "F1:G1"], { r0: 0, c0: 0, r1: 0, c1: 0 })).toEqual(["F1:G1"]);
  });
  it("names the values a merge would throw away", () => {
    const filled = (r: number, c: number) => (r === 0 && c === 0) || (r === 1 && c === 1);
    expect(cellsLostByMerge({ r0: 0, c0: 0, r1: 1, c1: 1 }, "merge", filled)).toEqual([
      { row: 1, col: 1 },
    ]);
    // Across keeps each row's first cell.
    expect(cellsLostByMerge({ r0: 0, c0: 0, r1: 1, c1: 1 }, "across", (r, c) => c === 0)).toEqual(
      [],
    );
  });
  it("moves, grows, shrinks and drops merges as rows and columns come and go", () => {
    expect(shiftMerges(["B2:C3"], "rows", 0, 1)).toEqual(["B3:C4"]);
    expect(shiftMerges(["B2:C3"], "rows", 2, 2)).toEqual(["B2:C5"]); // inserted inside: grows
    expect(shiftMerges(["B2:C3"], "rows", 1, -1)).toEqual(["B2:C2"]); // lost a row
    expect(shiftMerges(["B2:B3"], "rows", 1, -2)).toEqual([]); // gone
    expect(shiftMerges(["B2:C2"], "cols", 2, -1)).toEqual([]); // one cell left: no merge
    expect(shiftMerges(["B2:D2"], "cols", 0, 2)).toEqual(["D2:F2"]);
  });
});

describe("row and column bookkeeping", () => {
  it("shifts indexes and drops deleted ones", () => {
    expect(shiftIndex(5, 3, 2)).toBe(7);
    expect(shiftIndex(2, 3, 2)).toBe(2);
    expect(shiftIndex(4, 3, -2)).toBeNull();
    expect(shiftIndex(6, 3, -2)).toBe(4);
    expect(shiftIndexRecord({ "1": 30, "4": 50 }, 2, -2)).toEqual({ "1": 30, "2": 50 });
    expect(shiftIndexRecord({ "2": 40, "3": 41 }, 2, -2)).toEqual({});
    expect(shiftIndexList([0, 3, 9], 3, 1)).toEqual([0, 4, 10]);
  });
  it("moveCells carries row heights, hidden rows and merges with the cells", () => {
    const g = moveCells(
      {
        cells: { "5,0": { i: "x" } },
        rowHeights: { "5": 40 },
        hiddenRows: [6],
        merges: ["A6:B7"],
        colWidths: { "0": 80 },
      },
      "rows",
      2,
      3,
    );
    expect(g.cells).toEqual({ "8,0": { i: "x" } });
    expect(g.rowHeights).toEqual({ "8": 40 });
    expect(g.hiddenRows).toEqual([9]);
    expect(g.merges).toEqual(["A9:B10"]);
    expect(g.colWidths).toEqual({ "0": 80 });
    const c = moveCells({ cells: {}, colWidths: { "3": 90 }, hiddenCols: [2, 3] }, "cols", 2, -1);
    expect(c.colWidths).toEqual({ "2": 90 });
    expect(c.hiddenCols).toEqual([2]);
  });
});

describe("wrapped text and larger fonts grow their rows", () => {
  const measure = (s: string) => s.length * 7;
  it("counts wrapped lines at spaces, inside long words and at line breaks", () => {
    expect(wrapLines("hello world", 100, measure)).toBe(1);
    expect(wrapLines("hello world again", 80, measure)).toBe(2);
    expect(wrapLines("a\nb\nc", 100, measure)).toBe(3);
    expect(wrapLines("x".repeat(30), 70, measure)).toBe(3);
  });
  it("grows a row for its wrapped cell, not past a height set by hand", () => {
    const cells = {
      "0,0": { i: "one two three four five six", s: { wrap: true } },
      "1,0": { i: "big", s: { sz: 24 } },
      "2,0": { i: "one two three four five six", s: { wrap: true } },
      "3,0": { i: "plain" },
    };
    const h = autoRowHeights({
      cells,
      manual: { "2": 30 },
      base: 24,
      colWidth: () => 100,
      text: (r) => cells[`${r},0` as keyof typeof cells].i,
      measure: (t) => t.length * 7,
    });
    expect(h.get(0)).toBeGreaterThan(24 * 2);
    expect(h.get(1)).toBeGreaterThan(24);
    expect(h.has(2)).toBe(false);
    expect(h.has(3)).toBe(false);
  });
});

describe("borders", () => {
  const range = { r0: 0, c0: 0, r1: 1, c1: 1 };
  const thin = { s: "thin" as const, c: "#000000" };
  it("outside borders only on the range's edges", () => {
    expect(bordersFor("outside", range, 0, 0, undefined, thin)).toEqual({ t: thin, l: thin });
    expect(bordersFor("outside", range, 1, 1, undefined, thin)).toEqual({ b: thin, r: thin });
  });
  it("inside borders only between cells", () => {
    expect(bordersFor("inside", range, 0, 0, undefined, thin)).toEqual({ b: thin, r: thin });
    expect(bordersFor("inside", range, 1, 1, undefined, thin)).toEqual({ t: thin, l: thin });
  });
  it("keeps other sides, and No border clears all four", () => {
    expect(bordersFor("top", range, 0, 1, { b: thin }, thin)).toEqual({ b: thin, t: thin });
    expect(bordersFor("none", range, 0, 0, { b: thin }, thin)).toBeUndefined();
    expect(bordersFor("thick-outside", range, 0, 0, undefined, thin)).toEqual({
      t: { s: "thick", c: "#000000" },
      l: { s: "thick", c: "#000000" },
    });
  });
  it("draws as CSS", () => {
    expect(cssBorder({ s: "double", c: "#FF0000" })).toBe("3px double #FF0000");
    expect(cssBorder({ s: "dashed" })).toBe("1px dashed #000000");
  });
});

describe("colors, fonts and links", () => {
  it("reads colors as #RRGGBB, from files too", () => {
    expect(normalizeColor("#abc")).toBe("#AABBCC");
    expect(normalizeColor("FF4472C4")).toBe("#4472C4");
    expect(normalizeColor("red")).toBeUndefined();
    expect(normalizeColor("url(javascript:x)")).toBeUndefined();
  });
  it("scales font sizes against 11 pt and quotes an unknown font name", () => {
    expect(fontPx(11)).toBe(13);
    expect(fontPx(22, 2)).toBe(52);
    expect(fontStack("Calibri")).toContain("Carlito");
    expect(fontStack('Evil"; x: y')).toBe('"Evil; x: y", sans-serif');
  });
  it("stores web, mail and in-workbook links, and nothing that runs code", () => {
    expect(normalizeLink("example.com/a")).toBe("https://example.com/a");
    expect(normalizeLink("http://x.org")).toBe("http://x.org/");
    expect(normalizeLink("someone@example.com")).toBe("mailto:someone@example.com");
    expect(normalizeLink("mailto:a@b.co")).toBe("mailto:a@b.co");
    expect(normalizeLink("#'Q1 Sales'!B3")).toBe("#'Q1 Sales'!B3");
    expect(normalizeLink("javascript:alert(1)")).toBeNull();
    expect(normalizeLink("JaVaScRiPt:alert(1)")).toBeNull();
    expect(normalizeLink("data:text/html,<script>")).toBeNull();
    // A scheme that parses with a host is still not a web address.
    expect(normalizeLink("javascript://example.com/%0Aalert(1)")).toBeNull();
    expect(normalizeLink("ftp://files.example.com/a")).toBeNull();
    expect(normalizeLink("file://server/share")).toBeNull();
    expect(normalizeLink("hello")).toBeNull();
    expect(linkProblem("javascript:alert(1)")).toMatch(/Only web/);
    expect(linkProblem("")).toBe("Type an address");
    expect(parseInternalLink("#'Q1 ''Sales'''!$B$3")).toEqual({ sheet: "Q1 'Sales'", ref: "B3" });
    expect(parseInternalLink("#C7")).toEqual({ ref: "C7" });
  });
});

describe("number-format buttons", () => {
  it("adds and removes decimal places in every section", () => {
    expect(adjustDecimals("#,##0", 1)).toBe("#,##0.0");
    expect(adjustDecimals("#,##0.0", -1)).toBe("#,##0");
    expect(adjustDecimals("0.00%", 1)).toBe("0.000%");
    expect(adjustDecimals('"$"#,##0.00;[Red]-"$"#,##0.00', -1)).toBe('"$"#,##0.0;[Red]-"$"#,##0.0');
    expect(adjustDecimals("0.00E+00", 1)).toBe("0.000E+00");
    expect(adjustDecimals("yyyy-mm-dd", 1)).toBe("yyyy-mm-dd");
  });
  it("starts General from the places the value shows", () => {
    expect(adjustDecimals(undefined, 1, 3.14159)).toBe("0.000000");
    expect(adjustDecimals("General", -1, 2.5)).toBe("0");
    expect(adjustDecimals(null, 1, 7)).toBe("0.0");
  });
  it("paints a section's [Color]", () => {
    const code = "#,##0.00;[Red]-#,##0.00";
    expect(formatColor(-5, code)).toBe("#FF0000");
    expect(formatColor(5, code)).toBeUndefined();
    expect(formatColor(5, "[Color10]0")).toBe("#008000");
    expect(formatValue(-5, code)).toBe("-5.00");
  });
});

describe("the engine keeps a cell's link and the new style keys", () => {
  it("stores and clears links alongside the input", () => {
    const e = new WorkbookEngine([{ id: "s", name: "Sheet1", kind: "grid", grid: { cells: {} } }]);
    e.setInputs("s", [{ row: 0, col: 0, input: "Docs", link: "https://example.com/" }]);
    expect(e.getInput("s", 0, 0)).toEqual({ i: "Docs", l: "https://example.com/" });
    e.setInputs("s", [{ row: 0, col: 0, input: "Docs", link: null }]);
    expect(e.getInput("s", 0, 0)).toEqual({ i: "Docs" });
    e.setInputs("s", [{ row: 0, col: 0, input: "", link: "https://example.com/" }]);
    // A link with nothing to click is kept (Excel keeps it on an empty cell too).
    expect(e.getInput("s", 0, 0)?.l).toBe("https://example.com/");
  });
});

describe("what a grid save accepts", () => {
  const ok = (grid: unknown) => gridSchema.safeParse(grid).success;
  it("takes the formatting a sheet can hold", () => {
    expect(
      ok({
        cells: {
          "0,0": {
            i: "x",
            l: "https://example.com/",
            s: {
              b: true,
              st: true,
              font: "Georgia",
              sz: 14,
              color: "#FF0000",
              bg: "#FFFF00",
              va: "middle",
              wrap: true,
              ind: 2,
              bd: { t: { s: "thin", c: "#000000" }, b: { s: "double" } },
            },
          },
        },
        merges: ["A1:B2"],
        hiddenRows: [3],
        hiddenCols: [1],
        hideGrid: true,
      }),
    ).toBe(true);
  });
  it("refuses a link that runs code, a color that is not one, and unknown keys", () => {
    expect(ok({ cells: { "0,0": { i: "x", l: "javascript:alert(1)" } } })).toBe(false);
    expect(ok({ cells: { "0,0": { i: "x", s: { color: "red;background:url(x)" } } } })).toBe(false);
    expect(ok({ cells: { "0,0": { i: "x", s: { font: 'a"b' } } } })).toBe(false);
    expect(ok({ cells: { "0,0": { i: "x", s: { bd: { t: { s: "wavy" } } } } } })).toBe(false);
    expect(ok({ cells: {}, merges: ["not a range"] })).toBe(false);
    expect(ok({ cells: {}, surprise: 1 })).toBe(false);
  });
});

describe("the keyboard stays where the person is working", () => {
  it("R116: a bare line break reaching the grid does not start an edit", () => {
    expect(startsEdit("\n")).toBe(false);
    expect(startsEdit("\r\n")).toBe(false);
    expect(startsEdit("")).toBe(false);
    expect(startsEdit("a")).toBe(true);
    expect(startsEdit("東京")).toBe(true);
    expect(startsEdit(" ")).toBe(true);
  });
  it("the app's search palette leaves Ctrl+K to a control that claimed it", () => {
    const src = readFileSync(resolve(process.cwd(), "src/components/CommandPalette.tsx"), "utf8");
    const guard = src.indexOf("if (e.defaultPrevented) return;");
    const shortcut = src.indexOf('e.key.toLowerCase() === "k"');
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(shortcut);
    const editor = readFileSync(
      resolve(process.cwd(), "src/components/sheets/WorkbookEditor.tsx"),
      "utf8",
    );
    const at = editor.indexOf('k === "k"');
    const branch = editor.slice(at, editor.indexOf("openLinkDialog();", at));
    expect(branch).toContain("e.preventDefault();");
    expect(branch).toContain("e.stopPropagation();");
  });
});
