// The SQL models editor's unsaved draft (R276, sweep 8). Close, another
// model, New model, a link and a closed tab all dropped it without a word;
// the editor kept no record of what was saved. The page is not rendered in
// unit tests; the wiring is pinned by reading its source.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const src = readFileSync(join(process.cwd(), "src/routes/_authenticated/sql-models.tsx"), "utf8");

describe("the SQL models editor", () => {
  it("records what was opened and what a save sent", () => {
    expect(src).toContain(
      "const unsaved = draft !== null && savedDraft !== JSON.stringify(draft);",
    );
    expect(src).toMatch(
      /const openDraft = \(d: Draft \| null\) => \{\s*setDraft\(d\);\s*setSavedDraft\(d \? JSON\.stringify\(d\) : null\);/,
    );
    expect(src).toContain("setSavedDraft(JSON.stringify({ ...draft, id: res.id }));");
  });

  it("speaks of a model's changes as them and a new model as it", () => {
    expect(src).toContain(
      "body: savedName ? `They are not saved. ${what} them.` : `It is not saved. ${what} it.`,",
    );
  });

  it("asks only when something is unsaved", () => {
    expect(src).toMatch(
      /async function mayDiscard\(what: string\): Promise<boolean> \{\s*if \(!unsaved\) return true;/,
    );
  });

  it("asks before New model, another model and Close replace or drop the draft", () => {
    expect(src).toMatch(
      /if \(!\(await mayDiscard\("Starting a new model replaces"\)\)\) return;\s*setPreview\(null\);\s*openDraft\(emptyDraft\(/,
    );
    expect(src).toMatch(
      /if \(!\(await mayDiscard\("Opening another model replaces"\)\)\) return;\s*setPreview\(null\);\s*openDraft\(draftOf\(m\)\);/,
    );
    expect(src).toMatch(/if \(await mayDiscard\("Closing the editor drops"\)\) openDraft\(null\);/);
    // Nothing sets a draft behind the record's back.
    expect(src).not.toMatch(
      /setDraft\(draftOf\(m\)\)|setDraft\(emptyDraft\(|onClick=\{\(\) => setDraft\(null\)\}/,
    );
  });

  it("asks before a link leaves, and lets the browser ask before the tab closes", () => {
    expect(src).toMatch(
      /useBlocker\(\{\s*shouldBlockFn: async \(\) => !\(await mayDiscard\("Leaving the page drops"\)\),\s*enableBeforeUnload: unsaved,\s*disabled: !unsaved,\s*\}\);/,
    );
  });
});
