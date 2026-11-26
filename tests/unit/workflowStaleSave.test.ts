// Two tabs on one workflow (R289, sweep 9). workflowSave wrote the whole
// workflow over whatever was stored, so a save from a second tab undid the
// first's rename. Only the save sets this table's updated_at — runs and the
// scheduler write other columns and no trigger moves it — so updated_at is the
// version: the save lands only on the one the page read. Pinned by reading the
// server function and the page. Since R541 the write itself is the one
// definition path (definition.server.ts) that a repository update and a CI
// deploy also take; the editor's save hands it the version it read.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const fns = read("src/utils/workflows.functions.ts");
const server = read("src/utils/workflows/definition.server.ts");
const page = read("src/routes/_authenticated/workflows.tsx");

describe("workflowSave", () => {
  it("updates only on the version the page read, when it sends one", () => {
    expect(fns).toContain("expectedUpdatedAt: z.string().min(1).optional(),");
    expect(fns).toMatch(
      /data\.overwrite\s*\? \{ overwrite: true \}\s*: \{ expectedUpdatedAt: data\.expectedUpdatedAt as string \}/,
    );
    expect(server).toMatch(
      /\.eq\("id", id\)\s*\.eq\("user_id", userId\);\s*if \(opts\.expectedUpdatedAt\) q = q\.eq\("updated_at", opts\.expectedUpdatedAt\);\s*const \{ data: row, error \} = await q\.select\("id, updated_at"\)\.maybeSingle\(\);/,
    );
    expect(server).toContain("return { ok: true, updatedAt: String(row.updated_at) };");
  });

  it("tells a workflow that moved on from one that is gone", () => {
    expect(server).toMatch(
      /if \(opts\.expectedUpdatedAt\) \{[^]*?if \(stillError\) return \{ ok: false, error: stillError\.message \};\s*if \(still\) \{\s*return \{\s*ok: false,\s*stale: true,/,
    );
    expect(server).toMatch(
      /\}\s*return \{ ok: false, error: "Workflow not found" \};\s*\}\s*return \{ ok: true, updatedAt/,
    );
  });

  it("is the only writer that sets updated_at", () => {
    const sets = (fns + server).match(/updated_at: new Date\(\)\.toISOString\(\)/g) ?? [];
    expect(sets).toHaveLength(1);
    // The repository link records its own sync time and leaves the version alone.
    expect(read("src/utils/mlRepo.server.ts")).not.toMatch(/from\("workflows"\)\s*\.update\(/);
    // A run, a claim by the scheduler or a status write must not move it.
    expect(read("src/utils/workflows/run.server.ts")).not.toMatch(/updated_at:(?!\s*string)/);
  });
});

describe("the workflows page", () => {
  it("keeps the version it read and the one each save returns", () => {
    expect(page).toMatch(/versionRef\.current = w\.updated_at \|\| null;\s*setStale\(false\);/);
    expect(page).toMatch(
      /\} else \{\s*versionRef\.current = res\.updatedAt;\s*setStale\(false\);\s*setSavedAs\(sent\);/,
    );
  });

  it("sends the version, except when asked to overwrite", () => {
    expect(page).toMatch(
      /\.\.\.\(overwrite\s*\? \{ overwrite: true as const \}\s*: \{ expectedUpdatedAt: versionRef\.current \?\? undefined \}\),/,
    );
    expect(page).toMatch(
      /if \(!res\.ok\) \{\s*if \(res\.stale\) setStale\(true\);\s*toast\.error\(res\.error\);/,
    );
  });

  it("says so, with Reload, which re-runs the load, and Overwrite with mine", () => {
    expect(page).toMatch(/\{stale && \(\s*<span[^>]*data-testid="workflow-stale"/);
    expect(page).toContain("onClick={() => setLoadNonce((n) => n + 1)}");
    expect(page).toMatch(/\}, \[getFn, signedIn, selectedId, loadRuns, loadNonce\]\);/);
    expect(page).toMatch(/onClick=\{\(\) => void save\(true\)\}\s*>\s*Overwrite with mine/);
  });
});
