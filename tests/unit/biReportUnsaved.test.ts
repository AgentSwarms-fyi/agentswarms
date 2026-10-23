// A BI report's unsaved blocks (R278, sweep 8). The report kept no record of
// what was saved, so its back link, any other link and a closed tab left
// unsaved blocks behind without a word. The page is not rendered in unit
// tests; the wiring is pinned by reading its source.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const src = readFileSync(
  join(process.cwd(), "src/routes/_authenticated/bi_.report.$reportId.tsx"),
  "utf8",
);

describe("the BI report", () => {
  it("records what was loaded and what a save sent", () => {
    expect(src).toContain(
      "const unsaved = report !== null && savedAs !== null && JSON.stringify(report) !== savedAs;",
    );
    expect(src).toMatch(
      /setReport\(loaded\);\s*setSavedAs\(JSON\.stringify\(loaded\)\);\s*setSavedName\(loaded\.name\);/,
    );
    expect(src).toContain("const sent = JSON.stringify(report);");
    // R284: the save also takes the version it got back, before the record.
    expect(src).toMatch(
      /else \{\s*versionRef\.current = res\.updatedAt;\s*setStale\(false\);\s*setSavedAs\(sent\);\s*setSavedName\(report\.name\);/,
    );
  });

  it("asks before a link leaves, by the saved name, and lets the browser ask before the tab closes", () => {
    expect(src).toMatch(
      /useBlocker\(\{\s*shouldBlockFn: async \(\) =>\s*!\(await confirmAsk\(\{\s*title: `Discard the changes to "\$\{savedName\}"\?`,[^]*?enableBeforeUnload: \(\) => unsaved && !reloadingRef\.current,\s*disabled: !unsaved,\s*\}\);/,
    );
    // Before the early returns, so it is called on every render.
    expect(src.indexOf("useBlocker({")).toBeLessThan(
      src.indexOf("  if (loading) return <Skeleton"),
    );
  });

  it("says when something is unsaved", () => {
    expect(src).toMatch(/\{unsaved && \(\s*<span[^>]*data-testid="report-unsaved"/);
  });
});
