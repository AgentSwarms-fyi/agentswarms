// Two tabs on one workflow (R289, sweep 9). workflowSave wrote the whole
// workflow over whatever was stored, so a save from a second tab undid the
// first's rename. Only the save sets this table's updated_at — runs and the
// scheduler write other columns and no trigger moves it — so updated_at is the
// version: the save lands only on the one the page read. Pinned by reading the
// server function and the page.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const server = read("src/utils/workflows.functions.ts");
const page = read("src/routes/_authenticated/workflows.tsx");

describe("workflowSave", () => {
  it("updates only on the version the page read, when it sends one", () => {
    expect(server).toContain("expectedUpdatedAt: z.string().min(1).optional(),");
    expect(server).toMatch(
      /\.eq\("id", data\.id\)\s*\.eq\("user_id", userId\);\s*if \(data\.expectedUpdatedAt\) q = q\.eq\("updated_at", data\.expectedUpdatedAt\);\s*const \{ data: row, error \} = await q\.select\("id, updated_at"\)\.maybeSingle\(\);/,
    );
    expect(server).toContain("return { ok: true, updatedAt: String(row.updated_at) };");
  });

  it("tells a workflow that moved on from one that is gone", () => {
    expect(server).toMatch(
      /if \(data\.expectedUpdatedAt\) \{[^]*?if \(stillError\) return \{ ok: false, error: stillError\.message \};\s*if \(still\) \{\s*return \{\s*ok: false,\s*stale: true,/,
    );
    expect(server).toMatch(
      /\}\s*return \{ ok: false, error: "Workflow not found" \};\s*\}\s*return \{ ok: true, updatedAt/,
    );
  });

  it("is the only writer that sets updated_at", () => {
    const sets = server.match(/updated_at: new Date\(\)\.toISOString\(\)/g) ?? [];
    expect(sets).toHaveLength(1);
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
