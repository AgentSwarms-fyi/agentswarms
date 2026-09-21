// The workbench's Refresh button, under a failed read.
//
// Found by driving /data-sql with every user_data_rows request rejected (99 of
// them) and pressing Refresh. The mount path catches a failed hydration and
// toasts "Could not load datasets"; the Refresh handler had no try at all:
//
//   async function refreshTables() {
//     setLoadingTables(true);
//     const tables = await hydrateFromSupabase();
//     setDatasets(tables);
//     setLoadingTables(false);
//   }
//
// So the rejection went unhandled (the console showed it: "Uncaught (in
// promise) could not count rows of ..."), setLoadingTables(false) never ran, the
// icon spun indefinitely, and nothing on screen said the refresh had failed.
// The dataset list stayed as it was — which is right, a failed refresh is not
// an empty account — but a control that silently does nothing under failure is
// a control the user keeps pressing.
//
// This is what R46 made visible: the checked reader now THROWS on a failed
// window instead of registering a partial table, and the first call site to
// meet that throw was one with nowhere to put it.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const SRC = readFileSync("src/routes/_authenticated/data-sql.tsx", "utf8");

/** The refresh handler, bounded by the function that follows it. */
function refreshHandler(): string {
  const i = SRC.indexOf("async function refreshTables()");
  expect(i, "refreshTables is gone").toBeGreaterThan(0);
  const j = SRC.indexOf("async function ", i + 10);
  return SRC.slice(i, j > 0 ? j : i + 1200);
}

describe("the workbench refresh under a failed read", () => {
  it("wraps the hydration in a try, not a bare await", () => {
    const h = refreshHandler();
    expect(h).toMatch(/try \{\s*const tables = await hydrateFromSupabase\(\);/);
  });

  it("tells the user the refresh failed", () => {
    // Pinned as the call expression, not the words: a comment quoting the
    // message would satisfy a bare toContain.
    expect(refreshHandler()).toMatch(/catch \(e\) \{\s*toast\.error\(`Could not refresh datasets:/);
  });

  it("always clears the spinner, in a finally", () => {
    // The stuck spinner was the visible half of the defect: a promise that
    // rejected between setLoadingTables(true) and setLoadingTables(false).
    expect(refreshHandler()).toMatch(/finally \{\s*setLoadingTables\(false\);\s*\}/);
  });

  it("never empties the list on failure", () => {
    // A failed refresh is not an empty account. The last good read stays on
    // screen and the toast says why it is not newer.
    //
    // The catch block is pinned by its syntax, `catch (e) {`, and only its body
    // is read. A bare /catch[^}]*setDatasets/ matched the word "catches" in the
    // comment above the try and ran forward into the try's own setDatasets.
    const h = refreshHandler();
    expect(h).not.toMatch(/setDatasets\(\[\]\)/);
    const block = h.match(/catch \(e\) \{([^}]*)\}/);
    expect(block, "no catch (e) block").not.toBeNull();
    expect(block![1]).not.toMatch(/setDatasets/);
  });

  it("leaves the mount path's own handling alone", () => {
    // The initial load already did the right thing; this round is about the
    // second entry point that did not.
    expect(SRC).toMatch(/toast\.error\(`Could not load datasets: \$\{\(e as Error\)\.message\}`\)/);
  });
});
