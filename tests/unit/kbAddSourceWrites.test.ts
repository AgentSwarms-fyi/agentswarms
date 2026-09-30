// Knowledge: Add Source under a refused document insert, and the list while
// it loads (R192).
//
// FOUND IN R192, on the hot deploy of R191. On the fixture base "R192
// add-source", two .txt files were added with the first document insert
// refused from the browser: "2 files added", the dialog closed, Documents (1),
// and Sources (2) with "r192-alpha.txt · ok · 0 docs" — a source row that
// said its file was there. And with the base list's read held for six
// seconds, the page said "No knowledge bases yet." beside "New Knowledge
// Base" until it landed. Pinned by source: both live in components.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { listState } from "@/lib/listState";

const DIALOG = readFileSync("src/components/knowledge/AddSourceDialog.tsx", "utf8");
const PAGE = readFileSync("src/routes/_authenticated/knowledge.tsx", "utf8");

const slice = (src: string, from: string, to: string) => {
  const a = src.indexOf(from);
  expect(a).toBeGreaterThan(0);
  const b = src.indexOf(to, a);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
};

describe("withdrawSource", () => {
  const fn = slice(DIALOG, "async function withdrawSource(", "export function AddSourceDialog(");

  it("takes back a source whose document did not land, or marks it when it cannot", () => {
    expect(fn).toContain('.from("kb_sources").delete().eq("id", sourceId)');
    const failed = fn.indexOf("if (error) {");
    expect(failed).toBeGreaterThan(0);
    expect(fn.slice(failed)).toContain(
      '.update({ status: "error", error: `The document was not saved: ${why}` })',
    );
  });
});

describe("the File tab", () => {
  const loop = slice(DIALOG, "const notAdded:", "toast.success(`${added} file");

  it("keeps each document insert's error, and withdraws the source with it", () => {
    expect(loop).toMatch(/const \{ data: insertedDoc, error: docErr \} = await supabase/);
    const failed = loop.indexOf("if (docErr || !insertedDoc) {");
    expect(failed).toBeGreaterThan(0);
    const branch = loop.slice(failed, loop.indexOf("continue;", failed));
    expect(branch).toContain("await withdrawSource(src.id, why);");
    expect(branch).toContain("notAdded.push({ file: f, why });");
    expect(loop.indexOf("newDocIds.push(insertedDoc.id);")).toBeGreaterThan(failed);
  });

  it("counts a file whose source was refused as not added", () => {
    const at = loop.indexOf("if (srcErr || !src) {");
    expect(at).toBeGreaterThan(0);
    expect(loop.slice(at, loop.indexOf("continue;", at))).toContain("notAdded.push({ file: f,");
  });

  it("says how many landed, keeps the rest in the dialog, and does not close it", () => {
    expect(loop).toContain("const added = files.length - notAdded.length;");
    const partial = loop.indexOf("if (notAdded.length > 0) {");
    expect(partial).toBeGreaterThan(0);
    const branch = loop.slice(partial);
    expect(branch).toMatch(/added > 0\s*\?\s*`\$\{added\} of \$\{files\.length\} files added`/);
    expect(branch).toContain("setFiles(notAdded.map((n) => n.file));");
    expect(branch).toMatch(/setFiles\(notAdded\.map\(\(n\) => n\.file\)\);\s*return;/);
    expect(branch).not.toContain("onOpenChange(false)");
  });

  it("says a lone failed file was NOT added, and refreshes the lists either way", () => {
    // FOUND DRIVING THE FIX: the first cut said "The file was added" for a
    // file that was not, and skipped the refresh, so a source it could not
    // withdraw (marked as an error) did not show.
    const branch = loop.slice(loop.indexOf("if (notAdded.length > 0) {"));
    expect(branch).toMatch(/notAdded\.length === 1\s*\?\s*"The file was not added"/);
    expect(branch).toContain("`None of the ${notAdded.length} files were added`");
    expect(branch).toMatch(/onAdded\(\);\s*setFiles\(notAdded\.map/);
  });
});

describe("the Manual tab", () => {
  it("withdraws the source when its document did not land", () => {
    const manual = slice(DIALOG, 'tab === "manual"', "// file");
    const failed = manual.indexOf("if (docErr || !insertedDoc) {");
    expect(failed).toBeGreaterThan(0);
    expect(manual.slice(failed, manual.indexOf("return;", failed))).toContain(
      "await withdrawSource(src.id, why);",
    );
  });
});

describe("the knowledge base list", () => {
  it("is loading, not empty, until its read lands", () => {
    expect(listState({ loaded: false, error: null, count: 0 })).toBe("loading");
    const load = slice(PAGE, "async function loadBases() {", "\n  }\n");
    expect(load).toContain("setBasesLoaded(true);");
    expect(PAGE).toContain(
      "const basesState = listState({ loaded: basesLoaded, error: basesError, count: bases.length });",
    );
    const at = PAGE.indexOf(') : basesState === "loading" ? (');
    expect(at).toBeGreaterThan(0);
    expect(PAGE.slice(at, at + 200)).toContain("Loading your knowledge bases…");
    expect(PAGE.indexOf('basesState === "empty"', at)).toBeGreaterThan(at);
  });
});
