import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// R246. The helper in src/utils/lastOneGuard.ts is only worth anything if the
// guards actually use it, and the shape it replaces is easy to write again:
// count what is left, decide, then write. These tests read the source, because
// the race they prevent cannot be driven against the real database from here.

const SRC = join(process.cwd(), "src");

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/**
 * A count taken for a "keep at least one" decision, with the write that
 * follows it in the same handler. The pattern is deliberately about the
 * DECISION, not about counting: plenty of counts are only ever reported.
 */
function countThenDecide(source: string): number {
  const lines = source.split("\n");
  let found = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes('count: "exact", head: true')) continue;
    // The guard, within a few lines of the count that feeds it.
    const window = lines.slice(i, i + 8).join("\n");
    if (/\(count \?\? 0\) <= 1|count === 1|count < 2/.test(window)) found++;
  }
  return found;
}

describe("the last-one guards", () => {
  it("counts before deciding nowhere in src", () => {
    const offenders = tsFiles(SRC)
      .filter((f) => !f.endsWith("lastOneGuard.ts"))
      .map((f) => [f, countThenDecide(readFileSync(f, "utf8"))] as const)
      .filter(([, n]) => n > 0)
      .map(([f]) => f.slice(SRC.length + 1).replace(/\\/g, "/"));
    // Was 2 on 2026-10-04: sheets.functions.ts (a workbook left with no
    // sheets, and unopenable afterwards) and iam.functions.ts (a deployment
    // left with no superadmin, and no way to grant the role back).
    expect(offenders).toEqual([]);
  });

  it("deletes a sheet through the guard", () => {
    const src = readFileSync(join(SRC, "utils", "sheets.functions.ts"), "utf8");
    const fn = src.slice(src.indexOf("export const sheetsDeleteTab"));
    const body = fn.slice(0, fn.indexOf("export const sheetsReorderTabs"));
    expect(body).toContain("deleteKeepingAtLeastOne");
    expect(body).toContain("A workbook keeps at least one sheet");
    // The whole row, or the restore cannot put back what it deleted: a tab's
    // cells are its own `grid` column, and user_id is NOT NULL.
    expect(body).toContain('.select("*")');
    expect(body).toContain("insert(row)");
  });

  it("demotes a superadmin through the guard", () => {
    const src = readFileSync(join(SRC, "utils", "iam.functions.ts"), "utf8");
    const fn = src.slice(src.indexOf("export const iamRevokeSuperadmin"));
    const body = fn.slice(0, fn.indexOf("export const iamListGroups"));
    expect(body).toContain("deleteKeepingAtLeastOne");
    expect(body).toContain("Cannot demote the last superadmin");
    // R246's second defect here: the count's own error was dropped, so an
    // unreadable table reported the deployment's last superadmin as a fact.
    expect(body).toMatch(/Could not count the superadmins/);
    expect(body).toContain("insert(row)");
  });

  it("tells an empty workbook apart from one that is still opening", () => {
    const src = readFileSync(
      join(process.cwd(), "src", "components", "sheets", "WorkbookEditor.tsx"),
      "utf8",
    );
    expect(src).toContain("This workbook has no sheets.");
    // The empty state must come FIRST: the spinner's condition (!tabId) is
    // also true of an empty workbook, so a check after it never runs. Anchored
    // on the rendered JSX, not the word — the comment above it says "Opening…"
    // too, and matching that would compare the wrong two places.
    const spinner = src.indexOf("/> Opening…");
    expect(spinner).toBeGreaterThan(-1);
    expect(src.indexOf("This workbook has no sheets.")).toBeLessThan(spinner);
    // And it must offer the way out, not just name the problem.
    expect(src).toContain("Add a sheet");
    // The condition itself, not only the words it renders: a mutant that made
    // the branch unreachable left every string above in place.
    expect(src).toContain("if (engine && tabs.length === 0) {");
  });
});
