// The ETL pipeline editor's unsaved edits (R275, sweep 8). The editor knew it
// had them — Save turns on — but "← Pipelines", a link and a closed tab all
// left without a word. The page is not rendered in unit tests; the wiring is
// pinned by reading its source, as the workflow and swarm editors' are.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const src = readFileSync(join(process.cwd(), "src/routes/_authenticated/etl.tsx"), "utf8");
const editor = src.slice(src.indexOf("function PipelineEditor("));

describe("the pipeline editor", () => {
  it("asks only when something is unsaved, by the name it is saved under", () => {
    expect(editor).toMatch(
      /async function mayLeave\(what: string\): Promise<boolean> \{\s*if \(!dirty\) return true;[^]*?title: `Discard the changes to "\$\{savedName\}"\?`/,
    );
    expect(editor).toContain("setSavedName(row.name);");
    expect(editor).toContain("setSavedName(p.name);");
  });

  it("asks before the back button returns to the list", () => {
    expect(editor).toMatch(
      /onClick=\{async \(\) => \{\s*if \(await mayLeave\("Going back to the list drops them\."\)\) onBack\(\);\s*\}\}\s*>\s*← Pipelines/,
    );
    expect(editor).not.toContain('<Button variant="ghost" size="sm" onClick={onBack}>');
  });

  it("asks before a link leaves, and lets the browser ask before the tab closes", () => {
    expect(editor).toMatch(
      /useBlocker\(\{\s*shouldBlockFn: async \(\) => !\(await mayLeave\("Leaving the pipeline drops them\."\)\),\s*enableBeforeUnload: dirty,\s*disabled: !dirty,\s*\}\);/,
    );
    // Before the editor's early return, so it is called on every render.
    expect(editor.indexOf("useBlocker({")).toBeLessThan(
      editor.indexOf("  if (!p) {\n    return ("),
    );
  });
});
