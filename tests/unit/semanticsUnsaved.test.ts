// The Semantic Layer page's unsaved model draft (R277, sweep 8). Another
// model, New model, a link and a closed tab all dropped it without a word.
// The page is not rendered in unit tests; the wiring is pinned by its source.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const src = readFileSync(join(process.cwd(), "src/routes/_authenticated/semantics.tsx"), "utf8");

describe("the semantic model editor", () => {
  it("records what was opened and what a save sent", () => {
    expect(src).toContain(
      "const unsaved = draft !== null && savedDraft !== JSON.stringify(draft);",
    );
    expect(src).toMatch(
      /const openDraft = useCallback\(\(d: Draft \| null\) => \{\s*setDraft\(d\);\s*setSavedDraft\(d \? JSON\.stringify\(d\) : null\);/,
    );
    expect(src).toContain("setSavedDraft(JSON.stringify({ ...draft, id: res.id }));");
    // Every place that opens a model opens it as saved.
    expect(src).toMatch(/openDraft\(\{\s*id: m\.id as string,/);
    expect(src).toMatch(/openDraft\(\{\s*\.\.\.emptyDraft\(\),\s*name: slug\(table\),/);
    expect(src).not.toMatch(/setDraft\(\{\s*id: m\.id as string,|setDraft\(emptyDraft\(\)\)/);
  });

  it("asks only when something is unsaved, in the right number", () => {
    expect(src).toMatch(
      /async function mayDiscard\(what: string\): Promise<boolean> \{\s*if \(!unsaved\) return true;/,
    );
    expect(src).toContain(
      "body: savedName ? `They are not saved. ${what} them.` : `It is not saved. ${what} it.`,",
    );
  });

  it("asks before another model or New model replaces the draft", () => {
    expect(src).toMatch(
      /if \(!\(await mayDiscard\("Starting a new model replaces"\)\)\) return;\s*openDraft\(emptyDraft\(\)\);/,
    );
    expect(src).toMatch(
      /void mayDiscard\("Opening another model replaces"\)\.then\(\(go\) => \{\s*if \(go\) editModel\(m\);/,
    );
  });

  it("asks before a link leaves, and lets the browser ask before the tab closes", () => {
    expect(src).toMatch(
      /useBlocker\(\{\s*shouldBlockFn: async \(\) => !\(await mayDiscard\("Leaving the page drops"\)\),\s*enableBeforeUnload: unsaved,\s*disabled: !unsaved,\s*\}\);/,
    );
  });
});
