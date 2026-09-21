// Budgets: a cap or limit whose save failed is undone on screen and said,
// and the page's auto-save status is what the last write did.
//
// FOUND FROM THE UI. With every PATCH to budget_settings rejected, the cap
// typed as 25 read "$1.79 / $25.00", no toast; the page's button toasted
// "All settings auto-saved"; a reload put the saved $20.00 back.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { saveStatusText } from "@/lib/saveStatus";

const page = readFileSync("src/routes/_authenticated/budgets.tsx", "utf8");
const at = new Date(2026, 8, 22, 9, 5);

describe("saveStatusText", () => {
  it("promises auto-save only before anything was written", () => {
    expect(saveStatusText(null)).toBe("Settings auto-save on change");
  });

  it("says when the last write landed", () => {
    expect(saveStatusText({ ok: true, at })).toMatch(/^Saved \d{1,2}:\d{2}/);
  });

  it("names a failed write, and never calls it saved", () => {
    const t = saveStatusText({ ok: false, error: "budget: Failed to fetch", at });
    expect(t).toBe("Not saved — budget: Failed to fetch");
    expect(t).not.toMatch(/\bSaved\b/);
  });
});

describe("the Budgets page", () => {
  it("keeps the error of every write", () => {
    // A bare `await …update/insert(…);` STATEMENT drops its result. The loader's
    // `createBudget: async () => await …insert(…)` returns it to loadBudgetData,
    // which checks it — so the statement form, ending in a semicolon, is what
    // must be gone.
    expect(page).not.toMatch(
      /^\s*await supabase\.from\("(budget_settings|agent_limits)"\)\.(update|insert)\([^;\n]*;\s*$/m,
    );
    expect((page.match(/const \{ error \} = await supabase/g) ?? []).length).toBe(2);
    expect(page).toContain("const { data, error } = await supabase");
  });

  it("undoes a failed write on screen and says why", () => {
    const upd = page.slice(
      page.indexOf("const updateBudget = async"),
      page.indexOf("const upsertLimit = async"),
    );
    expect(upd).toContain("const before = budget;");
    expect(upd).toContain("setBudget(before);");
    expect(upd).toContain('failedSave("budget", error);');
    const lim = page.slice(
      page.indexOf("const upsertLimit = async"),
      page.indexOf("if (loadError !== null)"),
    );
    expect(lim).toContain("setLimits(before);");
    expect((lim.match(/failedSave\("agent limit"/g) ?? []).length).toBe(2);
    expect(page).toContain("The value shown is what is saved.");
  });

  it("reports the last write's outcome, never a constant", () => {
    expect(page).not.toContain('toast.success("All settings auto-saved")');
    expect(page).toContain("{saveStatusText(saveState)}");
    expect(page).toContain("? toast.error(saveStatusText(saveState))");
    // Recorded by BOTH writers — the budget update and the limit upsert — not
    // just one of them.
    expect((page.match(/setSaveState\(\{ ok: true, at: new Date\(\) \}\);/g) ?? []).length).toBe(2);
    const upd = page.slice(
      page.indexOf("const updateBudget = async"),
      page.indexOf("const upsertLimit = async"),
    );
    expect(upd).toContain("setSaveState({ ok: true, at: new Date() });");
  });
});
