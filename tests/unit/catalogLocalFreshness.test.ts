// The Data Catalog showed a row count it read once and never re-read.
//
// FOUND BY MEASUREMENT while proving dataset versioning works. Sequence:
// upload 10 rows over a 364-row dataset in the Workbench tab, switch to the
// Catalog tab. The list and the detail drawer both still said ROWS 364. So did
// they after pressing the only visible "Refresh" — which turned out to be the
// Workbench's Database Explorer refresh, not a catalog one. Restoring a version
// from inside the drawer had the same problem in reverse: a toast saying
// "Restored 364 rows" over a drawer still reading 10.
//
// Three reasons, all structural:
//   1. `reload()` refetched CRAWLED assets only; local datasets were hydrated
//      in the mount effect and nowhere else.
//   2. The parent keeps both panes mounted and toggles `hidden`, so the mount
//      effect never runs again for the life of the page.
//   3. Restore had no way to tell the catalog its rows had changed.
//
// A stale count on a data catalog is the same species of bug as a truncated
// chart: the screen states a fact about the data that is not true, and nothing
// indicates it. These are source-level guards because there is no React test
// harness in this repo; each one is mutation-verified.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const CATALOG = readFileSync("src/components/catalog/CatalogView.tsx", "utf8");
const PANEL = readFileSync("src/components/catalog/DatasetQualityPanel.tsx", "utf8");
const PAGE = readFileSync("src/routes/_authenticated/data-sql.tsx", "utf8");

describe("local datasets are re-read, not read once", () => {
  it("hydration lives in a reusable callback, not only in the mount effect", () => {
    expect(CATALOG).toMatch(/const reloadLocal = useCallback/);
  });

  it("Refresh covers local datasets as well as crawled ones", () => {
    // `reload` used to await five listers and no local hydration, so half the
    // list it was refreshing stayed frozen.
    const reload = CATALOG.slice(
      CATALOG.indexOf("const reload = useCallback"),
      CATALOG.indexOf("const termDefs"),
    );
    expect(reload, "reload() no longer re-reads local datasets").toContain("reloadLocal()");
  });

  it("the pane re-reads when it becomes visible again", () => {
    // Both panes stay mounted behind `hidden`; without this the count is
    // whatever it was when the page first loaded.
    expect(CATALOG).toMatch(/if \(active && !wasActive\.current\) void reloadLocal\(\)/);
    expect(PAGE, "the parent never tells the catalog it is on screen").toMatch(
      /active=\{view === "catalog"\}/,
    );
  });

  it("a restore tells the catalog its rows changed", () => {
    expect(PANEL).toMatch(/await onDatasetChanged\?\.\(\)/);
    expect(CATALOG).toMatch(/onDatasetChanged=\{onDatasetChanged\}/);
  });

  it("and the open drawer is re-pointed at the fresh asset", () => {
    // Refreshing the LIST but not `selected` would leave the drawer — the
    // place the number is actually read — showing the pre-restore count.
    const handler = CATALOG.slice(
      CATALOG.indexOf("onDatasetChanged={async () =>"),
      CATALOG.indexOf("onDatasetChanged={async () =>") + 400,
    );
    expect(handler).toContain("await reloadLocal()");
    expect(handler).toMatch(/setSelected\(/);
    expect(handler, "the sheet keeps its stale copy").toMatch(/fresh\.find/);
  });

  it("re-reads only the local half on a tab switch", () => {
    // Guard on the guard: re-running the full `reload()` on every toggle would
    // re-crawl sources the user did not ask to re-crawl. The visibility effect
    // must call reloadLocal, not reload.
    const effect = CATALOG.slice(
      CATALOG.indexOf("const wasActive = useRef(active)"),
      CATALOG.indexOf("const wasActive = useRef(active)") + 300,
    );
    expect(effect).toContain("reloadLocal()");
    expect(effect, "a tab switch is triggering a full catalog reload").not.toMatch(
      /void reload\(\)/,
    );
  });
});
