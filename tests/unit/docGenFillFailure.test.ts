// A deck whose data could not be read, versus a deck with no data connected.
//
// materializePptxWithBI caught a failed hydration as `datasets = []` and
// returned { visuals: 0, filled: 0 } — the same report a plan with no charts
// gets. The caller's "N of M visuals could be filled" warning needs visuals > 0
// to fire, so a failed read produced a deck with every chart silently replaced
// by bullets and no word on screen. Measured by generating a two-slide deck in
// the playground with every user_data_tables request rejected.
//
// Behavioural: the real filler against a hydration that rejects, one that
// answers no datasets, and a plan that asks for no visuals at all.
import { describe, expect, it, vi } from "vitest";

const engine = vi.hoisted(() => ({
  hydrate: vi.fn<() => Promise<unknown[]>>(),
}));

vi.mock("@/lib/sqlEngine", () => ({
  hydrateFromSupabase: () => engine.hydrate(),
  runQuery: vi.fn(),
  runQueryUnlimited: vi.fn(),
}));

vi.mock("@/lib/biAgent", () => ({
  generateSql: vi.fn(),
  loadSavedMetrics: vi.fn(async () => []),
  loadSemantics: vi.fn(async () => []),
  planQuestion: vi.fn(),
}));

const PLAN = {
  slides: [
    { title: "Sales by region", chart: { query: "total sales by region" } },
    { title: "Rows", kpiQuery: "how many rows" },
    { title: "Trend", chart: { query: "sales by month" } },
    { title: "Closing", bullets: ["thanks"] },
  ],
} as never;

describe("materializePptxWithBI, when the datasets cannot be read", () => {
  it("reports the visuals it was asked for and the reason none were filled", async () => {
    engine.hydrate.mockRejectedValueOnce(new Error("injected: user_data_tables unreachable"));
    const { materializePptxWithBI } = await import("@/lib/docGen/biData");
    const report = await materializePptxWithBI(PLAN, {});
    expect(report.visuals, "the two charts the plan asked for").toBe(2);
    expect(report.filled).toBe(0);
    expect(report.error).toMatch(
      /could not read your datasets: injected: user_data_tables unreachable/,
    );
  });

  it("says nothing of an error when there genuinely are no datasets", async () => {
    engine.hydrate.mockResolvedValueOnce([]);
    const { materializePptxWithBI } = await import("@/lib/docGen/biData");
    const report = await materializePptxWithBI(PLAN, {});
    expect(report).toEqual({ visuals: 2, filled: 0 });
  });

  it("does not read at all for a plan with no visuals", async () => {
    engine.hydrate.mockClear();
    const { materializePptxWithBI } = await import("@/lib/docGen/biData");
    const report = await materializePptxWithBI({ slides: [{ title: "Only words" }] } as never, {});
    expect(report).toEqual({ visuals: 0, filled: 0 });
    expect(engine.hydrate).not.toHaveBeenCalled();
  });
});

describe("the playground, when the fill report carries a read failure", () => {
  it("says so before it would ever say 'N of M visuals could be filled'", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/routes/_authenticated/playground.tsx", "utf8");
    const i = src.indexOf("const fill = await materializePptxWithBI(plan, { model });");
    expect(i).toBeGreaterThan(0);
    const after = src.slice(i, i + 900);
    const err = after.indexOf("if (fill.error) {");
    const warn = after.indexOf("fill.visuals > 0 && fill.filled < fill.visuals");
    expect(err, "no fill.error branch").toBeGreaterThan(0);
    expect(warn, "the partial-fill warning is gone").toBeGreaterThan(err);
    expect(after.slice(err, warn)).toMatch(
      /toast\.error\(`Charts could not be filled — \$\{fill\.error\}`/,
    );
  });
});
