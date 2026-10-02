// The swarm Versions dialog: one Enter, one version; a delete asks first (R207).
//
// FOUND IN R207, driven on the canvas of "R109 chat echo" with the browser's
// fault injector answering the version insert and delete itself (nothing was
// written or removed):
// - "R207 double enter" and two Enters sent two inserts 16 ms apart: Enter
//   called saveVersion past the button's disabled={saving}, and the second
//   key lands before React re-renders;
// - the trash icon sent its DELETE on the first click, no confirm, and the
//   list read "No versions yet", beside a Restore that asks first.
// Pinned by source, as R190's writes: no component test runner here.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SRC = readFileSync("src/components/swarms/SwarmVersionsDialog.tsx", "utf8");

describe("Save version", () => {
  it("is guarded by a ref, set before the first await and cleared after", () => {
    expect(SRC).toContain("const savingRef = useRef(false);");
    const save = SRC.slice(
      SRC.indexOf("const saveVersion = async"),
      SRC.indexOf("const restore ="),
    );
    expect(save).toMatch(
      /if \(!swarmId \|\| !user \|\| savingRef\.current\) return;\s*savingRef\.current = true;/,
    );
    expect(save.indexOf("savingRef.current = true;")).toBeLessThan(save.indexOf("await "));
    expect(save).toMatch(/\}\);\s*savingRef\.current = false;\s*setSaving\(false\);/);
  });

  it("is what Enter calls", () => {
    expect(SRC).toContain('if (e.key === "Enter") void saveVersion();');
  });
});

describe("the trash", () => {
  it("opens a confirm, and deletes only from its action", () => {
    const trash = SRC.slice(
      SRC.indexOf('title="Delete version"') - 600,
      SRC.indexOf("</AlertDialog>", SRC.indexOf('title="Delete version"')),
    );
    expect(trash).toContain("<AlertDialogTrigger asChild>");
    expect(trash).toMatch(/Delete “\{v\.label\}”\?/);
    expect(trash.replace(/\s+/g, " ")).toContain(
      "is removed for good and cannot be restored afterwards",
    );
    expect(trash).toMatch(/<AlertDialogAction onClick=\{\(\) => void remove\(v\.id\)\}>\s*Delete/);
    // No button deletes on its own click.
    expect(SRC.match(/onClick=\{\(\) => void remove\(v\.id\)\}/g)?.length).toBe(1);
  });

  it("says why a delete failed", () => {
    expect(SRC).toContain(
      'toast.error("Could not delete version", { description: error.message });',
    );
  });
});
