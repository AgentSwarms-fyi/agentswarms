// Swarms: a create or delete that failed is said, and the list stays true.
//
// FOUND FROM THE UI. With every DELETE to swarms rejected, "Swarm deleted"
// toasted and the swarm left the list, until a reload brought it back; a
// create whose insert failed did nothing at all, with no word.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const page = readFileSync("src/routes/_authenticated/swarms.tsx", "utf8");
const between = (start: string, end: string) => {
  const i = page.indexOf(start);
  expect(i, start).toBeGreaterThanOrEqual(0);
  const j = page.indexOf(end, i);
  expect(j, end).toBeGreaterThan(i);
  return page.slice(i, j);
};

describe("creating a swarm", () => {
  const fn = between("const handleNewSwarm = async", "const performDeleteSwarm = async");

  it("keeps the insert's error and says when it failed", () => {
    expect(fn).toContain("const { data: created, error } = await supabase");
    expect(fn).toContain("if (error || !created) {");
    expect(fn).toContain('toast.error("Could not create a swarm"');
    // The failure return comes before the success path.
    expect(fn.indexOf("if (error || !created) {")).toBeLessThan(
      fn.indexOf('toast.success("New swarm created")'),
    );
  });
});

describe("deleting a swarm", () => {
  const fn = between("const performDeleteSwarm = async", 'toast.success("Swarm deleted");');

  it("keeps the delete's error, and a failed delete changes nothing on screen", () => {
    expect(fn).toContain('const { error: deleteError } = await supabase.from("swarms").delete()');
    expect(fn).toContain('toast.error("Could not delete the swarm"');
    // The failure block RETURNS, before the list is touched — a toast alone
    // would still drop the swarm from the list.
    const start = fn.indexOf("if (deleteError) {");
    const end = fn.indexOf("\n    }\n", start);
    expect(end).toBeGreaterThan(start);
    expect(fn.slice(start, end)).toContain("return;");
    expect(fn.indexOf("if (deleteError) {")).toBeLessThan(
      fn.indexOf("const remaining = swarmList.filter"),
    );
    expect(page).not.toMatch(/^\s*await supabase\.from\("swarms"\)\.delete\([^\n]*;\s*$/m);
  });

  it("says when the fresh swarm after the last delete could not be created", () => {
    expect(fn).toContain('toast.error("Deleted, but could not create a fresh swarm to open"');
  });
});
