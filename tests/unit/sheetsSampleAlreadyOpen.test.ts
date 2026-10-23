// Opening a sample you already have does not quietly make a second one.
//
// FOUND IN R243, from the Sheets round's own leftovers list: "Opening a sample
// twice makes two workbooks with the same name. The tile could say that one is
// already open." The tile imported on every click, so the gallery ended up
// with two rows carrying the same name, the same art and no way to tell which
// one holds your edits — and the usual way to get there is to open a sample,
// look at it, come back later and click it again, having forgotten.
//
// A second copy is a real thing to want (the first has been written in, and a
// clean one is wanted beside it), so this asks rather than refuses, and
// declining opens the one you already have instead of doing nothing.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const SRC = readFileSync("src/routes/_authenticated/sheets.tsx", "utf8");
const openSample = SRC.slice(
  SRC.indexOf("const openSample = async"),
  SRC.indexOf("setLoadingSample(s.file);"),
);

describe("a sample that is already a workbook", () => {
  it("asks before importing a second copy", () => {
    expect(openSample).toContain("confirmAsk(");
    expect(openSample).toMatch(/You already have/);
    expect(openSample).toMatch(/second workbook with the same name/i);
  });

  it("opens the one you have when you decline, rather than doing nothing", () => {
    // A confirm whose cancel path is a dead end teaches the reader to click
    // through it.
    const decline = openSample.slice(openSample.indexOf("if (!ok)"));
    expect(decline).toContain("navigate(");
    expect(decline).toContain("workbookId: mine.id");
  });

  it("matches only the caller's OWN workbooks", () => {
    // A workbook SHARED with you under the same name is not yours to reopen,
    // and sending the reader into someone else's copy would be worse than the
    // duplicate this round is about.
    const finder = SRC.slice(
      SRC.indexOf("const sampleAlreadyOpen"),
      SRC.indexOf("const openSample"),
    );
    expect(finder).toContain('w.role === "owner"');
    expect(finder).toContain("w.name === title");
  });

  it("says so on the tile, before the click", () => {
    expect(SRC).toContain("alreadyOpen={sampleAlreadyOpen(s.title) !== null}");
    expect(SRC).toMatch(/Already in your workbooks/);
  });

  it("still imports when the reader asks for another copy", () => {
    // The guard must not become a refusal: past the confirm, the original
    // import path runs unchanged.
    const after = SRC.slice(SRC.indexOf("setLoadingSample(s.file);"));
    expect(after).toContain("setImportOpen(true);");
    expect(after).toContain("new File([blob], s.file");
    // And it must be REACHABLE. Asserting the import text exists is not the
    // same as asserting the function gets there: a mutant that put a bare
    // `return;` in front of it left every one of those strings in place and
    // survived. Exactly one early return belongs before the import — the
    // decline — so a second one is a path that never imports.
    const beforeImport = openSample;
    expect((beforeImport.match(/\breturn;/g) ?? []).length, "an extra early return").toBe(1);
  });
});
