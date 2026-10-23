// The Agent-Specific Limits say whether anything enforces them.
//
// FOUND IN R294. The Budgets page offered "Cap daily spend per agent and
// optionally auto-disable on limit reached", and nothing read agent_limits
// but the page and its loader. Driven: an agent with a $0 daily limit and
// auto-disable on answered two messages, both traced with a cost, and stayed
// active. Enforcing it needs the spend aggregate to filter by agent, which is
// a migration, so the page and the in-app doc now say the limits are stored,
// not enforced.
//
// The sentence is tied to the code rather than pinned: while nothing else
// names agent_limits, the page and the doc must say so; the day something
// does (a guard, a worker, a trigger in a migration), they must stop.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/** Where agent_limits is only defined, edited, loaded or described. */
const NOT_ENFORCEMENT = [
  join("src", "integrations", "supabase", "types.ts"),
  join("src", "routes", "_authenticated", "budgets.tsx"),
  join("src", "lib", "budgetLoad.ts"),
  join("src", "routes", "docs.budgets.tsx"),
  join("src", "components", "docs", "docsIndex.ts"),
  // The table, its policy and its updated_at trigger.
  join("supabase", "migrations", "20260416211055_d42dd9c5-7a9f-465d-b043-991410672f9c.sql"),
];

const readers = [...walk("src"), ...walk(join("supabase", "migrations"))].filter(
  (f) =>
    /\.(ts|tsx|sql)$/.test(f) &&
    !NOT_ENFORCEMENT.includes(f) &&
    readFileSync(f, "utf8").includes("agent_limits"),
);

const page = readFileSync("src/routes/_authenticated/budgets.tsx", "utf8");
const doc = readFileSync("src/routes/docs.budgets.tsx", "utf8");

describe("the Agent-Specific Limits", () => {
  it("say they are not enforced exactly while nothing enforces them", () => {
    const pageSays = page.includes("<strong>not enforced yet</strong>");
    const docSays = doc.includes('title="Agent-specific limits are stored, not enforced"');
    if (readers.length === 0) {
      expect(pageSays).toBe(true);
      expect(docSays).toBe(true);
    } else {
      // Something reads them now: check it enforces both the figure and the
      // switch, then take the sentences out of the page and the doc.
      expect({ readers, pageSays, docSays }).toEqual({ readers, pageSays: false, docSays: false });
    }
  });

  it("no longer promise to cap and switch off", () => {
    expect(page).not.toContain("Cap daily spend per agent and optionally auto-disable");
  });
});
