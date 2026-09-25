// R121: popovers drawn over the grid (a filter's search box, a validation
// list, a link's buttons) render in a portal, but React bubbles their key
// presses up the component tree to the grid, which took them as typing in
// the active cell. The grid handles only keys pressed inside its own DOM.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(
  resolve(__dirname, "../../src/components/sheets/SheetGrid.tsx"),
  "utf8",
);

describe("the grid and keys from popovers over it", () => {
  // React bubbles a portal's events up the component tree, not the DOM, so
  // only a DOM check tells the grid's own keys from a popover's.
  it("guards its key handler with the grid's own DOM", () => {
    // The scroll container's handler: keys from outside its DOM are ignored.
    const i = source.indexOf('role="grid"');
    const handler = source.slice(i, source.indexOf("onScroll={onScroll}", i));
    expect(handler).toMatch(
      /onKeyDown=\{\(e\) => \{\s*if \(!e\.currentTarget\.contains\(e\.target as Node\)\) return;\s*onKey\(e\);/,
    );
  });
});
