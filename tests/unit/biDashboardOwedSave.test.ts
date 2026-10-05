// A BI dashboard's edit, dropped after "Save failed" (R281, sweep 8). The
// dashboard autosaves 700 ms after an edit and had no guard at all: a closed
// tab inside that window, or any way out after a save failed, dropped the edit
// without a question. Its save state could not say what was owed — the
// filters' save sets "saved" while a pages save still waits on its timer — so
// the page now keeps what is owed, clears it only by the save that wrote
// exactly that, and leaves through R279's useSaveBeforeLeave. The page is not
// rendered in unit tests; the wiring is pinned by reading its source.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const src = readFileSync(
  join(process.cwd(), "src/routes/_authenticated/bi_.$dashboardId.tsx"),
  "utf8",
);

describe("the BI dashboard's owed saves", () => {
  it("owes the pages from the edit until the save that wrote exactly them", () => {
    expect(src).toMatch(
      /if \(readOnly \|\| conflictRef\.current\) return;\s*owedPagesRef\.current = nextPages;\s*syncOwed\(\);/,
    );
    expect(src).toMatch(
      /await commitPatch\(\{\s*pages: nextPages[^}]*\}\);\s*if \(owedPagesRef\.current === nextPages\) owedPagesRef\.current = null;/,
    );
    expect(src).toMatch(
      /saveTimer\.current = null;\s*writePages\(nextPages\)\.catch\(onSaveError\);/,
    );
  });

  it("owes the filters until their save comes back", () => {
    expect(src).toMatch(
      /owedFiltersRef\.current = next;\s*syncOwed\(\);\s*setSaveState\("saving"\);\s*commitPatch\(\{ filters: next/,
    );
    expect(src).toMatch(
      /\.then\(\(\) => \{\s*if \(owedFiltersRef\.current === next\) owedFiltersRef\.current = null;/,
    );
  });

  it("owes nothing once a load shows what is stored, and drops a waiting save", () => {
    expect(src).toMatch(
      /conflictRef\.current = false;[^]*?if \(saveTimer\.current\) clearTimeout\(saveTimer\.current\);\s*saveTimer\.current = null;\s*owedPagesRef\.current = null;\s*owedFiltersRef\.current = null;\s*setOwed\(false\);/,
    );
  });

  it("saves what is owed before leaving, and says why when it cannot", () => {
    expect(src).toContain(
      'if (conflictRef.current) return "this dashboard was changed in another session";',
    );
    expect(src).toMatch(
      /const owedPages = owedPagesRef\.current;\s*if \(owedPages\) await writePages\(owedPages\);/,
    );
    expect(src).toMatch(/catch \(e\) \{\s*onSaveError\(e\);\s*return saveFailureText\(e\);/);
    expect(src).toMatch(/useSaveBeforeLeave\(\{\s*unsaved: owed && !readOnly,\s*saveNow,/);
    // Before the early returns, so it is called on every render.
    expect(src.indexOf("useSaveBeforeLeave({")).toBeLessThan(src.indexOf("  if (row === null) {"));
  });

  it("does not say Saved while a save is still owed", () => {
    expect(
      src.match(/saveState === "saving" \|\| \(saveState === "saved" && owed\)/g),
    ).toHaveLength(2);
  });
});
