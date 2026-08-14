// What-if scenarios. Most of what matters here is what a scenario REFUSES to
// be: an identical query relabelled, a parameter the model never declared, a
// number that is really a typo. A scenario that quietly changes nothing, or
// quietly changes something else, is worse than no scenario at all — it
// answers a question the reader believes they asked.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  buildScenario,
  describeScenario,
  scenarioDelta,
  scenarioLevers,
  type ScenarioParameter,
} from "@/lib/analystScenario";
import { governedCatalogFrom } from "@/lib/biAgent";
import type { SemanticQuery } from "@/lib/semanticLayer";

const params: ScenarioParameter[] = [
  { name: "commission_rate", type: "number", default: 0.1, label: "Commission rate" },
  { name: "region_focus", type: "string", default: "EMEA" },
];

const baseline: SemanticQuery = {
  model: "sales",
  metrics: ["net_revenue"],
  filters: [{ field: "segment", op: "=", value: "Enterprise" }],
};

describe("what a step can be asked differently", () => {
  it("offers the declared assumptions and the step's own filters", () => {
    const levers = scenarioLevers(baseline, params);
    expect(levers.parameters.map((p) => p.name)).toEqual(["commission_rate", "region_focus"]);
    expect(levers.filters).toEqual([{ field: "segment", op: "=", value: "Enterprise" }]);
  });

  it("offers nothing when there is nothing to vary — and says so by being empty", () => {
    // A model with no parameters and a step with no filters. The UI has to
    // show this as "nothing to vary", not a control that does nothing.
    expect(scenarioLevers({ model: "m", metrics: ["x"] }, [])).toEqual({
      parameters: [],
      filters: [],
    });
    expect(scenarioLevers(undefined, params).filters).toEqual([]);
  });

  it("excludes relative-date filters — a window is not an assumption", () => {
    const q: SemanticQuery = {
      model: "sales",
      metrics: ["x"],
      filters: [
        { field: "order_date", op: "last_n_days", value: 30 },
        { field: "region", op: "=", value: "EMEA" },
      ],
    };
    expect(scenarioLevers(q, []).filters.map((f) => f.field)).toEqual(["region"]);
  });
});

describe("building the scenario", () => {
  it("varies a declared assumption and records the change", () => {
    const plan = buildScenario({
      baseline,
      parameters: params,
      paramOverrides: { commission_rate: "0.15" },
    })!;
    expect(plan.query.params).toEqual({ commission_rate: 0.15 });
    expect(plan.changes).toEqual([
      { kind: "parameter", name: "commission_rate", from: "0.1", to: "0.15" },
    ]);
    // Everything else is untouched — that is what makes the difference
    // attributable to the one change.
    expect(plan.query.metrics).toEqual(["net_revenue"]);
    expect(plan.query.filters).toEqual([{ field: "segment", op: "=", value: "Enterprise" }]);
  });

  it("varies scope by rewriting a filter's value", () => {
    const plan = buildScenario({
      baseline,
      parameters: params,
      filterOverrides: { segment: "SMB" },
    })!;
    expect(plan.query.filters).toEqual([{ field: "segment", op: "=", value: "SMB" }]);
    expect(plan.changes).toEqual([
      { kind: "filter", name: "segment", from: "Enterprise", to: "SMB" },
    ]);
  });

  it("splits a list for the operators that take one", () => {
    const q: SemanticQuery = {
      model: "sales",
      metrics: ["x"],
      filters: [{ field: "region", op: "in", value: ["EMEA"] }],
    };
    const plan = buildScenario({
      baseline: q,
      parameters: [],
      filterOverrides: { region: "EMEA, AMER" },
    })!;
    expect(plan.query.filters).toEqual([{ field: "region", op: "in", value: ["EMEA", "AMER"] }]);
  });

  it("REFUSES a no-op rather than presenting the same numbers as a scenario", () => {
    // Re-running the identical query under a "scenario" heading invites the
    // reader to conclude the change was tested and made no difference.
    expect(
      buildScenario({ baseline, parameters: params, paramOverrides: { commission_rate: "0.1" } }),
    ).toBeNull();
    expect(
      buildScenario({ baseline, parameters: params, filterOverrides: { segment: "Enterprise" } }),
    ).toBeNull();
    expect(buildScenario({ baseline, parameters: params })).toBeNull();
    expect(
      buildScenario({ baseline, parameters: params, paramOverrides: { commission_rate: "  " } }),
    ).toBeNull();
  });

  it("ignores a parameter the model never declared", () => {
    // The compiler would refuse it anyway; refusing here means the label
    // never claims an assumption that was not applied.
    expect(
      buildScenario({ baseline, parameters: params, paramOverrides: { invented: "9" } }),
    ).toBeNull();
  });

  it("ignores a non-number for a number parameter — that is a typo, not a scenario", () => {
    expect(
      buildScenario({ baseline, parameters: params, paramOverrides: { commission_rate: "high" } }),
    ).toBeNull();
  });

  it("ignores a filter override for a field the step does not filter on", () => {
    const plan = buildScenario({
      baseline,
      parameters: params,
      filterOverrides: { country: "France" },
      paramOverrides: { region_focus: "AMER" },
    })!;
    expect(plan.changes.map((c) => c.name)).toEqual(["region_focus"]);
    expect(plan.query.filters).toEqual([{ field: "segment", op: "=", value: "Enterprise" }]);
  });

  it("carries several changes at once", () => {
    const plan = buildScenario({
      baseline,
      parameters: params,
      paramOverrides: { commission_rate: "0.2" },
      filterOverrides: { segment: "SMB" },
    })!;
    expect(plan.changes).toHaveLength(2);
    expect(describeScenario(plan.changes)).toBe(
      "Scenario — commission_rate 0.1 → 0.2, segment Enterprise → SMB",
    );
  });

  it("labels nothing when nothing changed", () => {
    expect(describeScenario([])).toBe("");
  });
});

describe("the delta, computed rather than eyeballed", () => {
  it("reports the change and the percentage change per metric", () => {
    const d = scenarioDelta(
      ["net_revenue", "orders"],
      [{ net_revenue: 1000, orders: 50 }],
      [{ net_revenue: 1150, orders: 50 }],
    );
    expect(d).toEqual([
      { metric: "net_revenue", baseline: 1000, scenario: 1150, change: 150, pctChange: 0.15 },
      { metric: "orders", baseline: 50, scenario: 50, change: 0, pctChange: 0 },
    ]);
  });

  it("returns null percentage from a zero baseline rather than Infinity", () => {
    expect(scenarioDelta(["x"], [{ x: 0 }], [{ x: 5 }])[0]).toEqual({
      metric: "x",
      baseline: 0,
      scenario: 5,
      change: 5,
      pctChange: null,
    });
  });

  it("refuses to compare grouped results — matching rows wrongly is worse", () => {
    expect(
      scenarioDelta(
        ["x"],
        [
          { region: "EMEA", x: 1 },
          { region: "AMER", x: 2 },
        ],
        [
          { region: "EMEA", x: 3 },
          { region: "AMER", x: 4 },
        ],
      ),
    ).toEqual([]);
    expect(scenarioDelta(["x"], [], [{ x: 1 }])).toEqual([]);
  });

  it("skips a metric that is not a number on either side", () => {
    expect(scenarioDelta(["x", "label"], [{ x: 1, label: "a" }], [{ x: 2, label: "b" }])).toEqual([
      { metric: "x", baseline: 1, scenario: 2, change: 1, pctChange: 1 },
    ]);
  });

  it("reads numerics that arrive as strings, as warehouses send them", () => {
    expect(scenarioDelta(["x"], [{ x: "100" }], [{ x: "125" }])[0].pctChange).toBeCloseTo(0.25, 10);
  });
});

describe("the assumptions have to reach the UI at all", () => {
  it("carries a model's declared parameters through the catalog", () => {
    // Without this the panel renders zero assumptions for every model and
    // what-if silently degrades to filter-only — the feature looks present
    // and does half of what it says.
    const rows = [
      {
        name: "sales",
        label: null,
        source_kind: "data_table",
        source_table: "saas_sales",
        dimensions: [],
        metrics: [{ name: "net_revenue" }],
        parameters: [{ name: "commission_rate", type: "number", default: 0.1 }],
      },
    ] as unknown as Parameters<typeof governedCatalogFrom>[1];
    const [model] = governedCatalogFrom([{ name: "saas_sales" }] as never, rows);
    expect(model.parameters).toEqual([{ name: "commission_rate", type: "number", default: 0.1 }]);
  });

  it("treats a model with no parameters as having none, not undefined", () => {
    const rows = [
      {
        name: "m",
        label: null,
        source_kind: "data_table",
        source_table: "t",
        dimensions: [],
        metrics: [],
      },
    ] as unknown as Parameters<typeof governedCatalogFrom>[1];
    expect(governedCatalogFrom([{ name: "t" }] as never, rows)[0].parameters).toEqual([]);
  });
});

describe("the wiring, and the honesty it has to preserve", () => {
  const page = readFileSync("src/routes/_authenticated/ai-analyst.tsx", "utf8");
  const lib = readFileSync("src/lib/aiAnalyst.ts", "utf8");

  it("offers what-if only on a governed step — nothing else can be recompiled", () => {
    expect(page).toMatch(
      /\{s\.governed && \(\s*<button[\s\S]{0,220}Re-run this step under a different assumption/,
    );
  });

  it("compiles the scenario SERVER-side, through the same path as the baseline", () => {
    const fn = page.slice(page.indexOf("const runScenarioAt = useCallback("));
    const body = fn.slice(0, fn.indexOf("const rewriteTurn"));
    expect(body).toContain("runSemanticFn({ data: { accessToken: token, query: plan.query } })");
    // Same model's declared parameters — not a free-text bag.
    expect(body).toContain("parameters: model?.parameters ?? []");
  });

  it("does NOT mark the findings stale — the measured result never changed", () => {
    // withStaleAnswer is right for an edited step and wrong here: a scenario
    // adds a hypothetical beside the measurement without touching it, so the
    // write-up still describes exactly what it described before.
    const fn = page.slice(page.indexOf("const runScenarioAt = useCallback("));
    const body = fn.slice(0, fn.indexOf("const rewriteTurn"));
    // The absence of a CALL, not of the word: the code comments on why it
    // does not stale the answer, and a bare substring check trips on that.
    expect(body).not.toMatch(/withStaleAnswer\s*\(/);
    expect(body).toContain("trimTurnForStorage({ ...t, steps })");
  });

  it("refuses a no-op scenario out loud rather than re-showing the same numbers", () => {
    const fn = page.slice(page.indexOf("const runScenarioAt = useCallback("));
    expect(fn.slice(0, fn.indexOf("const rewriteTurn"))).toMatch(
      /if \(!plan\) \{[\s\S]{0,180}Nothing changed/,
    );
  });

  it("renders the scenario as an estimate, beside the measured result", () => {
    expect(page).toContain("not measured data; what the numbers would be under this assumption");
    // The baseline table and the scenario block are separate elements: the
    // scenario must never be the thing the reader takes for the answer.
    expect(page).toMatch(/\{s\.scenario && \(/);
  });

  it("says so plainly when a model has nothing to vary", () => {
    expect(page).toContain("declares no parameters and this step has");
    expect(page).toContain("nothing a scenario could vary");
  });

  it("keeps the scenario on the step, out of the findings (type guard)", () => {
    const type = lib.slice(lib.indexOf("export type AnalystStep = {"));
    expect(type.slice(0, type.indexOf("\n};"))).toMatch(/scenario\?: \{/);
    expect(lib).toMatch(/never fed\s*\n\s*\* into the findings/);
  });
});

describe("the catalog has to be loaded before it is read", () => {
  const page = readFileSync("src/routes/_authenticated/ai-analyst.tsx", "utf8");

  it("fills the governed cache before resolving the catalog", () => {
    // governedCatalogFor reads a module-level cache that ensureGovernedCatalog
    // fills asynchronously. Reading it first yields an empty catalog, and the
    // symptom is the worst kind of wrong: a model that declares parameters
    // reports "declares no parameters", which reads as a fact about the model
    // rather than a loading race. Measured live.
    const effect = page.slice(page.indexOf("const tables = await hydrateFromSupabase();"));
    const body = effect.slice(0, effect.indexOf("} catch (e) {"));
    expect(body).toContain("ensureGovernedCatalog()");
    expect(body).toContain("setCatalog(governedCatalogFor(tables))");
    expect(body.indexOf("ensureGovernedCatalog()")).toBeLessThan(
      body.indexOf("setCatalog(governedCatalogFor(tables))"),
    );
  });

  it("holds the catalog in state, not a memo over datasets alone", () => {
    // A memo keyed on `datasets` computes once, against whatever the cache
    // held at that moment, and never recomputes when the cache later fills.
    expect(page).toMatch(
      /const \[catalog, setCatalog\] = useState<GovernedModelFields\[\]>\(\[\]\)/,
    );
    expect(page).not.toMatch(/const catalog = useMemo\(\(\) => governedCatalogFor/);
  });

  it("passes that resolved catalog to the loop and the scenario runner", () => {
    // Re-reading the cache at call time reintroduces the race for a cold
    // first question.
    expect(page).not.toMatch(/catalog: governedCatalogFor\(scope\.datasets\)/);
    expect(page).toMatch(
      /const model = catalog\.find\(\(m\) => m\.name === step\.governed\?\.model\)/,
    );
  });
});
