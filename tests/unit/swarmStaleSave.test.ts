// Two tabs on one swarm (R288, sweep 9). The canvas saved name, nodes and
// edges over whatever was stored, so a save from a second tab undid the
// first's rename. Runs, deploys and publishing write the row too, so the save
// now compares the stored definition with the one the page read, and updates
// only on the `updated_at` of that read. The form is tested as a function; the
// page's wiring is pinned by reading its source.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { swarmStoredForm } from "@/lib/swarmVersions";

const page = readFileSync(join(process.cwd(), "src/routes/_authenticated/swarms.tsx"), "utf8");

const row = {
  name: "R109 chat echo",
  nodes: [{ id: "n1", type: "input", position: { x: 10, y: 20 }, data: { label: "Input" } }],
  edges: [{ id: "e1", source: "n1", target: "n2", label: "yes" }],
};

describe("swarmStoredForm", () => {
  it("reads a row the same after a jsonb round trip reorders its keys", () => {
    expect(
      swarmStoredForm({
        edges: [{ label: "yes", target: "n2", source: "n1", id: "e1" }],
        nodes: [{ data: { label: "Input" }, position: { y: 20, x: 10 }, type: "input", id: "n1" }],
        name: "R109 chat echo",
      }),
    ).toBe(swarmStoredForm(row));
  });

  it("ignores the row's other columns and changes with the definition", () => {
    expect(swarmStoredForm({ ...row, published_nodes: [], updated_at: "x" } as typeof row)).toBe(
      swarmStoredForm(row),
    );
    expect(swarmStoredForm({ ...row, name: "R109 chat echo A288" })).not.toBe(swarmStoredForm(row));
    expect(swarmStoredForm({ ...row, nodes: [...row.nodes, { id: "n3" }] as never })).not.toBe(
      swarmStoredForm(row),
    );
  });
});

describe("the swarm canvas", () => {
  it("records the definition of every row it opens or creates", () => {
    expect(page).toMatch(
      /setSwarmId\(row\.id\);\s*storedFormRef\.current = swarmStoredForm\(row\);/,
    );
    // The first swarm, a new one, the one created after a delete, and a first save.
    expect(page.match(/storedFormRef\.current = swarmStoredForm\(created\);/g)).toHaveLength(4);
  });

  it("compares the stored definition before writing, unless overwriting", () => {
    expect(page).toMatch(
      /\.select\("name, nodes, edges, updated_at"\)\s*\.eq\("id", swarmId\)\s*\.maybeSingle\(\);/,
    );
    expect(page).toMatch(
      /!overwrite &&\s*storedFormRef\.current !== null &&\s*swarmStoredForm\(stored\) !== storedFormRef\.current\s*\) \{\s*setSaving\(false\);\s*setStale\(true\);/,
    );
  });

  it("lands only on the row it read, and records what it wrote", () => {
    expect(page).toMatch(
      /\.eq\("id", swarmId\)\s*\.eq\("updated_at", stored\.updated_at\)\s*\.select\("name, nodes, edges"\)\s*\.maybeSingle\(\);/,
    );
    expect(page).toMatch(
      /storedFormRef\.current = swarmStoredForm\(written\);\s*setStale\(false\);/,
    );
  });

  it("does not hand the click event to save as an overwrite", () => {
    expect(page).not.toContain("onClick={handleSave}");
    expect(page).toContain("onClick={() => void handleSave()}");
  });

  it("says so, with Reload and Overwrite with mine", () => {
    expect(page).toMatch(/\{stale && \(\s*<span[^>]*data-testid="swarm-stale"/);
    expect(page).toMatch(/applySwarmRow\(data\);\s*\}\}\s*>\s*Reload/);
    expect(page).toMatch(/onClick=\{\(\) => void handleSave\(true\)\}\s*>\s*Overwrite with mine/);
  });
});
