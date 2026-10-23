// Two tabs on one notebook (R283, sweep 9). Each save wrote the whole notebook
// over whatever was stored, so the later tab's save silently undid the
// earlier one while the earlier tab still said "Saved". A save now lands only
// on the `updated_at` this page read or last wrote, and a newer write from
// elsewhere stops it instead. The helpers are tested as functions; the page's
// wiring is pinned by reading its source.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { makeSaveQueue, readGuardedSave } from "@/lib/guardedSave";

const page = readFileSync(
  join(process.cwd(), "src/routes/_authenticated/notebooks.py.$pyNotebookId.tsx"),
  "utf8",
);

describe("readGuardedSave", () => {
  it("takes the new version from the row the update returned", () => {
    expect(
      readGuardedSave({ data: [{ updated_at: "2026-10-05T08:00:01.5+00:00" }], error: null }, "it"),
    ).toEqual({ ok: true, version: "2026-10-05T08:00:01.5+00:00" });
  });

  it("calls no row back stale: the row moved on since this page's version", () => {
    const r = readGuardedSave({ data: [], error: null }, "this notebook");
    expect(r).toEqual({
      ok: false,
      stale: true,
      error: "this notebook was changed in another tab or session after this page read it",
    });
    expect(readGuardedSave({ data: null, error: null }, "it")).toMatchObject({ stale: true });
  });

  it("keeps a failed write apart from a stale one", () => {
    expect(readGuardedSave({ data: null, error: { message: "offline" } }, "it")).toEqual({
      ok: false,
      stale: false,
      error: "offline",
    });
  });
});

describe("makeSaveQueue", () => {
  it("runs saves one at a time, in the order they were asked for", async () => {
    const queue = makeSaveQueue();
    const log: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const first = queue(async () => {
      log.push("first start");
      await gate;
      log.push("first end");
      return 1;
    });
    const second = queue(async () => {
      log.push("second start");
      return 2;
    });
    await Promise.resolve();
    expect(log).toEqual(["first start"]);
    release();
    expect(await first).toBe(1);
    expect(await second).toBe(2);
    expect(log).toEqual(["first start", "first end", "second start"]);
  });

  it("does not let a save that threw stop the next", async () => {
    const queue = makeSaveQueue();
    const failed = queue(async () => {
      throw new Error("boom");
    });
    await expect(failed).rejects.toThrow("boom");
    expect(await queue(async () => "ran")).toBe("ran");
  });
});

describe("the Python notebook", () => {
  it("reads the version with the notebook", () => {
    expect(page).toContain('.select("id, title, cells, updated_at")');
    expect(page).toMatch(/versionRef\.current = data\.updated_at;\s*setStale\(false\);/);
  });

  it("saves only on that version, through the queue, and moves to the version it wrote", () => {
    expect(page).toMatch(/saveQueueRef\.current\(async \(\) => \{/);
    expect(page).toMatch(
      /\.eq\("id", pyNotebookId\)\s*\.eq\("updated_at", versionRef\.current\)\s*\.select\("updated_at"\);/,
    );
    expect(page).toMatch(
      /const saved = readGuardedSave\(res, "this notebook"\);\s*if \(!saved\.ok\) \{\s*if \(saved\.stale\) setStale\(true\);\s*return saved\.error;\s*\}\s*versionRef\.current = saved\.version;/,
    );
  });

  it("stops autosaving once stale, and says so with a way to reload", () => {
    expect(page).toContain("|| !unsaved || stale) return;");
    expect(page).toMatch(/\{stale && \(\s*<div[^>]*data-testid="notebook-stale"/);
    expect(page).toMatch(
      /reloadingRef\.current = true;\s*window\.location\.reload\(\);[^]*?Reload/,
    );
  });
});
