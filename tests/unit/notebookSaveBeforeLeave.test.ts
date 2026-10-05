// A Python notebook's edit, dropped by a link taken before the autosave
// (R279, sweep 8). The autosave timer is cleared when the page unmounts, so a
// link inside its 1.2 s, or after a save that failed, left without a word and
// the edit was gone. Now a link saves first and asks only when that fails,
// and the tab asks while anything is unsaved. The decision is tested as a
// function; the page's wiring is pinned by reading its source.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { holdForSave } from "@/hooks/use-save-before-leave";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const hook = read("src/hooks/use-save-before-leave.ts");
const page = read("src/routes/_authenticated/notebooks.py.$pyNotebookId.tsx");

describe("holdForSave", () => {
  it("lets a link go once the save succeeds, without asking", async () => {
    const ask = vi.fn(async () => false);
    expect(await holdForSave(async () => null, ask)).toBe(false);
    expect(ask).not.toHaveBeenCalled();
  });

  it("asks with the reason when the save fails, and holds on Cancel", async () => {
    const ask = vi.fn(async () => false);
    expect(await holdForSave(async () => "permission denied", ask)).toBe(true);
    expect(ask).toHaveBeenCalledWith("permission denied");
  });

  it("leaves on Leave anyway", async () => {
    expect(
      await holdForSave(
        async () => "offline",
        async () => true,
      ),
    ).toBe(false);
  });

  it("treats a save that throws as one that failed", async () => {
    const ask = vi.fn(async () => false);
    const saveNow = async (): Promise<string | null> => {
      throw new Error("Failed to fetch");
    };
    expect(await holdForSave(saveNow, ask)).toBe(true);
    expect(ask).toHaveBeenCalledWith("Failed to fetch");
  });
});

describe("useSaveBeforeLeave", () => {
  it("guards links and the tab only while something is unsaved", () => {
    expect(hook).toMatch(/shouldBlockFn: \(\) =>\s*holdForSave\(saveNow,/);
    expect(hook).toContain("enableBeforeUnload: () => unsaved && !reloading?.current,");
    expect(hook).toContain("disabled: !unsaved,");
  });
});

describe("the Python notebook", () => {
  it("records what was loaded and what a save sent", () => {
    expect(page).toContain(
      "const unsaved = form !== null && savedAs !== null && form !== savedAs;",
    );
    expect(page).toContain(
      "setSavedAs(JSON.stringify({ title: data.title, cells: loadedCells }));",
    );
    // Recorded only once the update came back without an error.
    expect(page).toMatch(/if \(error\) return error\.message;\s*setSavedAs\(form\);/);
  });

  it("saves only what is unsaved, and saves or asks before leaving", () => {
    expect(page).toContain(
      "if (!mayAutosave({ hydrated: loadedRef.current, cells }) || !unsaved) return;",
    );
    expect(page).toContain(
      "useSaveBeforeLeave({ unsaved, saveNow, name: savedTitle, reloading: reloadingRef });",
    );
    // Before the early returns, so it is called on every render.
    expect(page.indexOf("useSaveBeforeLeave({")).toBeLessThan(page.indexOf("  if (loadError) {"));
  });

  it("lets a restore reload the page without the tab's question", () => {
    expect(page).toMatch(
      /onRestored=\{\(\) => \{\s*reloadingRef\.current = true;\s*window\.location\.reload\(\);/,
    );
  });

  it("says what is unsaved by the record, not by the last save's reply", () => {
    expect(page).toMatch(
      /saving > 0 \? \(\s*"Saving…"\s*\) : unsaved \? \(\s*<span data-testid="notebook-unsaved">/,
    );
  });
});
