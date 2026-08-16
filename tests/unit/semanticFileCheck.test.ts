// Checking exported semantic models in CI.
//
// The whole value of this check is that a pull request can fail on it, so the
// failures worth testing are the two that make it USELESS: passing something
// broken, and passing when it checked nothing at all.
//
// It is equally important that it does not cry wolf. The export writes
// dashboards and notebooks into the same tree, and a check that flagged those
// as broken models would be turned off within a week.
import { describe, expect, it } from "vitest";

import {
  checkSemanticFiles,
  checkSemanticModel,
  formatCheckReport,
  metricRefsIn,
  paramRefsIn,
  readSemanticFile,
} from "@/lib/semanticFileCheck";
import type { SemanticModel } from "@/lib/semanticLayer";

const model = (over: Partial<SemanticModel> = {}): SemanticModel => ({
  name: "orders",
  source: { kind: "data_table", table: "orders" },
  primaryKey: "order_id",
  dimensions: [
    { name: "region", sql: "region" },
    { name: "status", sql: "status" },
  ],
  metrics: [{ name: "revenue", agg: "sum", sql: "amount" }],
  ...over,
});

const errs = (m: SemanticModel) =>
  checkSemanticModel(m, "f.json")
    .filter((p) => p.severity === "error")
    .map((p) => p.message);
const warns = (m: SemanticModel) =>
  checkSemanticModel(m, "f.json")
    .filter((p) => p.severity === "warning")
    .map((p) => p.message);

const file = (name: string, doc: unknown) => ({
  path: name,
  content: JSON.stringify({ kind: "semantic_model", ...(doc as object) }),
});

describe("a clean model passes", () => {
  it("reports no errors", () => {
    expect(errs(model())).toEqual([]);
  });

  it("collects rather than throwing", () => {
    // The app's save path throws on the first problem, which is right for a
    // form. A CI check that reports one error per run is one nobody runs twice.
    const broken = model({
      dimensions: [{ name: "1bad", sql: "x" }],
      metrics: [{ name: "also bad", agg: "sum", sql: "y" }],
      hierarchies: [{ name: "h", levels: ["nope", "gone"] }],
    });
    expect(errs(broken).length).toBeGreaterThanOrEqual(4);
  });
});

describe("references that resolve to nothing", () => {
  it("catches a hierarchy level that is not a dimension", () => {
    const p = errs(model({ hierarchies: [{ name: "geo", levels: ["region", "city"] }] }));
    expect(p.some((m) => /city/.test(m) && /not a dimension/.test(m))).toBe(true);
  });

  it("catches a derived metric referencing a metric that was deleted", () => {
    // The compiler substitutes each {ref} with that metric's own aggregate, so
    // a dangling ref is a query that refuses in front of whoever asked.
    const p = errs(
      model({
        metrics: [
          { name: "revenue", agg: "sum", sql: "amount" },
          { name: "aov", agg: "derived", sql: "{revenue} / NULLIF({orders}, 0)" },
        ],
      }),
    );
    expect(p.some((m) => /\{orders\}/.test(m))).toBe(true);
  });

  it("catches a derived metric referencing itself", () => {
    const p = errs(model({ metrics: [{ name: "loop", agg: "derived", sql: "{loop} + 1" }] }));
    expect(p.some((m) => /references itself/.test(m))).toBe(true);
  });

  it("catches a rollup mapping a field that is not on the model", () => {
    const p = errs(
      model({
        rollups: [
          {
            name: "daily",
            table: "orders_daily",
            dimensions: [{ dimension: "ghost", column: "g" }],
            metrics: [],
          },
        ],
      } as Partial<SemanticModel>),
    );
    expect(p.some((m) => /ghost/.test(m))).toBe(true);
  });

  it("catches a {{parameter}} nobody declared", () => {
    // The compiler REFUSES an undeclared parameter rather than guessing, so
    // this is a query that cannot run — findable offline.
    const p = errs(model({ metrics: [{ name: "adj", agg: "sum", sql: "amount * {{uplift}}" }] }));
    expect(p.some((m) => /\{\{uplift\}\}/.test(m))).toBe(true);
  });

  it("accepts a {{parameter}} that IS declared", () => {
    const p = errs(
      model({
        parameters: [{ name: "uplift", type: "number", default: 1 }],
        metrics: [{ name: "adj", agg: "sum", sql: "amount * {{uplift}}" }],
      }),
    );
    expect(p).toEqual([]);
  });

  it("looks for parameters in joins and filters too, not just metric sql", () => {
    const p = errs(
      model({
        joins: [{ table: "t", on: "a.id = t.id AND t.year = {{yr}}", cardinality: "many_to_one" }],
        metrics: [{ name: "m", agg: "sum", sql: "x", filters: ["status = {{st}}"] }],
      }),
    );
    expect(p.filter((m) => /not a declared parameter/.test(m))).toHaveLength(2);
  });
});

describe("definitions that cannot compile", () => {
  it("catches a field name that is not an identifier", () => {
    expect(errs(model({ dimensions: [{ name: "Order Date", sql: "x" }] })).length).toBeGreaterThan(
      0,
    );
  });

  it("catches a dimension and a metric sharing a name", () => {
    // They compile to the same SQL alias and one silently wins.
    const p = errs(
      model({
        dimensions: [{ name: "revenue", sql: "r" }],
        metrics: [{ name: "revenue", agg: "sum", sql: "amount" }],
      }),
    );
    expect(p.some((m) => /Duplicate field name/.test(m))).toBe(true);
  });

  it("catches an aggregation with nothing to aggregate", () => {
    expect(errs(model({ metrics: [{ name: "m", agg: "sum" }] })).length).toBeGreaterThan(0);
    // count is the exception — it needs no column.
    expect(errs(model({ metrics: [{ name: "n", agg: "count" }] }))).toEqual([]);
  });

  it("catches a join with no ON condition", () => {
    const p = errs(model({ joins: [{ table: "customers", on: "" } as never] }));
    expect(p.some((m) => /ON condition/.test(m))).toBe(true);
  });

  it("catches two sources of truth for the fiscal year", () => {
    const p = errs(
      model({
        fiscalYearStartMonth: 7,
        calendar: { table: "cal", dateColumn: "d", grains: [] } as never,
      }),
    );
    expect(p.some((m) => /cannot both define the fiscal year/.test(m))).toBe(true);
  });

  it("catches a model with nothing on it", () => {
    const p = errs(model({ dimensions: [], metrics: [] }));
    expect(p.some((m) => /no dimensions and no metrics/.test(m))).toBe(true);
  });
});

describe("warnings do not fail the build, but are said", () => {
  it("flags an undeclared join cardinality without erroring", () => {
    // Models saved before cardinality existed compile exactly as before, and
    // Validate measures it either way — but a reviewer should see it.
    const m = model({ joins: [{ table: "items", on: "o.id = items.order_id" }] });
    expect(errs(m).filter((x) => /cardinality/.test(x))).toEqual([]);
    expect(warns(m).some((x) => /cardinality/.test(x))).toBe(true);
  });

  it("flags a missing primary key", () => {
    expect(warns(model({ primaryKey: undefined })).some((m) => /primary key/i.test(m))).toBe(true);
  });

  it("flags a required parameter, which is usually an oversight", () => {
    const m = model({
      parameters: [{ name: "yr", type: "number" }],
      metrics: [{ name: "x", agg: "sum", sql: "a * {{yr}}" }],
    });
    expect(errs(m)).toEqual([]);
    expect(warns(m).some((x) => /no default/.test(x))).toBe(true);
  });
});

describe("it does not cry wolf on the rest of the export tree", () => {
  it("skips a dashboard file rather than calling it a broken model", () => {
    const r = checkSemanticFiles([
      { path: "d/dash.json", content: JSON.stringify({ kind: "bi_dashboard", name: "Sales" }) },
      file("m/orders.json", model()),
    ]);
    expect(r.checked).toBe(1);
    expect(r.skipped).toBe(1);
    expect(r.ok).toBe(true);
  });

  it("still reports a file that is not JSON at all", () => {
    const r = checkSemanticFiles([{ path: "m/broken.json", content: "{oops" }]);
    expect(r.ok).toBe(false);
    expect(r.problems[0].message).toMatch(/Not valid JSON/);
  });
});

describe("two files declaring one model name", () => {
  it("is an error, because one of them silently wins", () => {
    // Only findable across the tree, which is why it is not in the per-model
    // check.
    const r = checkSemanticFiles([
      file("a/orders.json", model()),
      file("b/orders.json", model({ metrics: [{ name: "revenue", agg: "count" }] })),
    ]);
    expect(r.ok).toBe(false);
    expect(r.problems.some((p) => /also declared in a\/orders\.json/.test(p.message))).toBe(true);
  });

  it("matches case-insensitively, since the names collide in the app too", () => {
    const r = checkSemanticFiles([
      file("a.json", model()),
      file("b.json", model({ name: "Orders" })),
    ]);
    expect(r.ok).toBe(false);
  });
});

describe("the report says what it did NOT check", () => {
  it("names the warehouse-only checks it cannot do", () => {
    // A green check that implied the definitions were verified against the
    // warehouse would be the most expensive false confidence here.
    const out = formatCheckReport(checkSemanticFiles([file("m.json", model())]));
    expect(out).toMatch(/Structure only/);
    expect(out).toMatch(/fans out/);
    expect(out).toMatch(/run Validate in the app/);
  });

  it("counts models and non-model files separately", () => {
    const out = formatCheckReport(
      checkSemanticFiles([
        file("m.json", model()),
        { path: "d.json", content: JSON.stringify({ kind: "bi_dashboard" }) },
      ]),
    );
    expect(out).toMatch(/1 semantic model checked, 1 non-model file skipped/);
  });

  it("is ok only when there are no errors", () => {
    expect(checkSemanticFiles([file("m.json", model())]).ok).toBe(true);
    expect(checkSemanticFiles([file("m.json", model({ primaryKey: undefined }))]).ok).toBe(true);
    expect(checkSemanticFiles([file("m.json", model({ dimensions: [], metrics: [] }))]).ok).toBe(
      false,
    );
  });
});

describe("the reference scanners", () => {
  it("finds parameter refs with and without spaces", () => {
    expect(paramRefsIn("a {{ x }} b {{y}}")).toEqual(["x", "y"]);
  });

  it("finds metric refs", () => {
    expect(metricRefsIn("{revenue} / NULLIF({orders},0)")).toEqual(["revenue", "orders"]);
  });

  it("does not mistake a parameter for a metric ref", () => {
    // {{x}} is a parameter; {x} is a metric. A scanner that conflated them
    // would report a declared parameter as a missing metric.
    expect(metricRefsIn("{{param}}")).not.toContain("param");
  });
});

describe("reading a file", () => {
  it("returns no model and no problems for a non-model doc", () => {
    const r = readSemanticFile("x.json", JSON.stringify({ kind: "bi_dashboard" }));
    expect(r.model).toBeNull();
    expect(r.problems).toEqual([]);
  });

  it("returns the model for a semantic_model doc", () => {
    const r = readSemanticFile(
      "x.json",
      JSON.stringify({ kind: "semantic_model", name: "orders" }),
    );
    expect(r.model?.name).toBe("orders");
  });
});

describe("an exported file is a DATABASE ROW, not a SemanticModel", () => {
  // FOUND BY RUNNING THE CLI. Every fixture above is built from the camelCase
  // type, so they all passed while a real exported file — which the exporter
  // produces by spreading the DB row — read `primaryKey: undefined` and warned
  // about a key that was right there in the JSON. Idealised fixtures cannot
  // catch a boundary that idealises the boundary.
  const exported = {
    kind: "semantic_model",
    name: "orders",
    source_kind: "warehouse",
    source_table: "ANALYTICS.MART.orders",
    connection_id: "conn-1",
    primary_key: "order_id",
    fiscal_year_start_month: 7,
    dimensions: [{ name: "region", sql: "region" }],
    metrics: [{ name: "revenue", agg: "sum", sql: "amount" }],
  };

  it("reads primary_key, so it does not warn about a key that is present", () => {
    const r = checkSemanticFiles([{ path: "m.json", content: JSON.stringify(exported) }]);
    expect(r.problems.filter((p) => /primary key/i.test(p.message))).toEqual([]);
  });

  it("reads fiscal_year_start_month, so the two-calendars check can fire", () => {
    const both = { ...exported, calendar: { table: "cal", dateColumn: "d", grains: [] } };
    const r = checkSemanticFiles([{ path: "m.json", content: JSON.stringify(both) }]);
    expect(r.ok).toBe(false);
    expect(r.problems.some((p) => /cannot both define the fiscal year/.test(p.message))).toBe(true);
  });

  it("rebuilds the source from source_kind and source_table", () => {
    const { model } = readSemanticFile("m.json", JSON.stringify(exported));
    expect(model?.source).toEqual({
      kind: "warehouse",
      connectionId: "conn-1",
      table: "ANALYTICS.MART.orders",
    });
  });

  it("still accepts a camelCase document, so in-app callers work unchanged", () => {
    const { model } = readSemanticFile(
      "m.json",
      JSON.stringify({
        kind: "semantic_model",
        name: "o",
        primaryKey: "id",
        dimensions: [],
        metrics: [],
      }),
    );
    expect(model?.primaryKey).toBe("id");
  });
});
