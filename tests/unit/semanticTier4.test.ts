// Parameters, hierarchies, fiscal plumbing and the currency ride-along —
// the tier-4 surface that is REFUSALS and CONTRACTS rather than arithmetic
// (the arithmetic is executed in tests/differential/fiscalCalendar.test.ts).
//
// Everything here calls the REAL functions — the exported zod schemas, the
// real validateHierarchies, the real compiler — never a re-implementation.
import { describe, expect, it } from "vitest";

import {
  compileSemanticQuery,
  formatSemanticCatalog,
  resolveParamValues,
  substituteParams,
  truncateExpr,
  type SemanticDimension,
  type SemanticModel,
  type SemanticQuery,
} from "@/lib/semanticLayer";
import { hierarchySchema, parameterSchema, validateHierarchies } from "@/utils/semantic.functions";
import { widgetFromSemantic } from "@/lib/biDashboards";

const model = (over: Partial<SemanticModel>): SemanticModel =>
  ({
    name: "m",
    source: { kind: "data_table", table: "orders" },
    dimensions: [{ name: "region", sql: "region", type: "categorical" }],
    metrics: [{ name: "total", agg: "sum", sql: "amount" }],
    ...over,
  }) as SemanticModel;

describe("resolveParamValues — the refusal surface", () => {
  const declared = model({
    parameters: [
      { name: "rate", type: "number", default: 0.1 },
      { name: "tier", type: "string", default: "gold" },
    ],
  });
  const q = (params?: SemanticQuery["params"]): SemanticQuery => ({ model: "m", params });

  it("refuses an unknown parameter and names the declared ones", () => {
    expect(() => resolveParamValues(declared, q({ nope: 1 }), "postgres")).toThrow(
      /Unknown parameter "nope".*rate, tier/,
    );
  });

  it("refuses a non-numeric value for a number parameter", () => {
    expect(() => resolveParamValues(declared, q({ rate: "abc" }), "postgres")).toThrow(
      /must be a number/,
    );
  });

  it("refuses a declared parameter with neither value nor default", () => {
    const noDefault = model({ parameters: [{ name: "x", type: "number" }] });
    expect(() => resolveParamValues(noDefault, { model: "m" }, "postgres")).toThrow(
      /needs a value — it has no default/,
    );
  });

  it("escapes string values as literals — quotes are doubled, not executable", () => {
    const vals = resolveParamValues(declared, q({ tier: "O'Brien" }), "postgres");
    expect(vals.get("tier")).toBe("'O''Brien'");
  });

  it("numbers are normalised (no quotes) and overrides beat defaults", () => {
    const vals = resolveParamValues(declared, q({ rate: 0.25 }), "postgres");
    expect(vals.get("rate")).toBe("0.25");
    expect(resolveParamValues(declared, q(), "postgres").get("rate")).toBe("0.1");
  });
});

describe("substituteParams — token handling", () => {
  const vals = new Map([["rate", "0.25"]]);

  it("replaces every occurrence, with or without inner whitespace", () => {
    expect(substituteParams("{{rate}} + {{ rate }} + {{  rate  }}", vals)).toBe(
      "0.25 + 0.25 + 0.25",
    );
  });

  it("an unresolved token is a refusal, never passed through as SQL", () => {
    expect(() => substituteParams("amount * {{unknown}}", vals)).toThrow(
      /undeclared parameter "\{\{unknown\}\}"/,
    );
  });

  it("compile refuses a fragment naming an undeclared parameter", () => {
    const m = model({
      metrics: [{ name: "total", agg: "sum", sql: "amount * {{ghost}}" }],
    });
    expect(() => compileSemanticQuery(m, { model: "m", metrics: ["total"] })).toThrow(/ghost/);
  });

  it("join ON conditions may not use parameters — the graph must stay structural", () => {
    const m = model({
      parameters: [{ name: "x", type: "number", default: 1 }],
      joins: [{ table: "customers", on: "orders.customer_id = {{x}}", type: "left" }],
    });
    expect(() => compileSemanticQuery(m, { model: "m", metrics: ["total"] })).toThrow(
      /join conditions must stay structural/i,
    );
  });
});

describe("parameterSchema — the storage boundary", () => {
  it("accepts a well-formed number parameter", () => {
    expect(parameterSchema.safeParse({ name: "rate", type: "number", default: 0.1 }).success).toBe(
      true,
    );
  });

  it("refuses a number parameter whose default is not a number", () => {
    const res = parameterSchema.safeParse({ name: "rate", type: "number", default: "abc" });
    expect(res.success).toBe(false);
  });

  it("refuses an empty-string default — unattended compiles use it", () => {
    const res = parameterSchema.safeParse({ name: "tier", type: "string", default: "  " });
    expect(res.success).toBe(false);
  });

  it("refuses a name that could not be a {{token}}", () => {
    expect(parameterSchema.safeParse({ name: "1bad", type: "number", default: 1 }).success).toBe(
      false,
    );
    expect(parameterSchema.safeParse({ name: "a-b", type: "string", default: "x" }).success).toBe(
      false,
    );
  });
});

describe("hierarchies — declared drill paths", () => {
  const dims: SemanticDimension[] = [
    { name: "region", sql: "region", type: "categorical" },
    { name: "subregion", sql: "subregion", type: "categorical" },
    { name: "city", sql: "city", type: "categorical" },
  ];

  it("accepts a valid path over existing dimensions", () => {
    expect(() =>
      validateHierarchies([{ name: "geo", levels: ["region", "subregion", "city"] }], dims),
    ).not.toThrow();
  });

  it("refuses a level that is not a dimension, and lists what IS", () => {
    expect(() =>
      validateHierarchies([{ name: "geo", levels: ["region", "planet"] }], dims),
    ).toThrow(/"planet".*region, subregion, city/s);
  });

  it("refuses a repeated level", () => {
    expect(() =>
      validateHierarchies([{ name: "geo", levels: ["region", "region"] }], dims),
    ).toThrow(/repeats level "region"/);
  });

  it("the schema wants 2–6 levels — one level is not a path", () => {
    expect(hierarchySchema.safeParse({ name: "geo", levels: ["region"] }).success).toBe(false);
    expect(
      hierarchySchema.safeParse({ name: "geo", levels: ["a", "b", "c", "d", "e", "f", "g"] })
        .success,
    ).toBe(false);
    expect(hierarchySchema.safeParse({ name: "geo", levels: ["region", "city"] }).success).toBe(
      true,
    );
  });
});

describe("truncateExpr — fiscal grains per dialect", () => {
  it("July start shifts forward 6 months, then reads the calendar year", () => {
    const pg = truncateExpr("day", "fiscal_year", "postgres", 7);
    expect(pg).toContain("INTERVAL '6 month'");
    expect(pg).toContain("EXTRACT(YEAR FROM");
    const sf = truncateExpr("day", "fiscal_quarter", "snowflake", 7);
    expect(sf).toContain("DATEADD(month, 6,");
    expect(sf).toMatch(/YEAR\(.*\) \* 10 \+ QUARTER\(/);
  });

  it("a January start shifts by zero months", () => {
    expect(truncateExpr("day", "fiscal_year", "postgres", 1)).toContain("INTERVAL '0 month'");
  });

  it("refuses fiscal grains on AlaSQL", () => {
    expect(() => truncateExpr("day", "fiscal_year", "alasql", 7)).toThrow(/AlaSQL/);
  });

  it("refuses a start month outside 1–12", () => {
    expect(() => truncateExpr("day", "fiscal_year", "postgres", 0)).toThrow(/1–12/);
    expect(() => truncateExpr("day", "fiscal_quarter", "postgres", 13)).toThrow(/1–12/);
  });
});

describe("the agent catalog discloses tier-4 vocabulary", () => {
  const rich = model({
    fiscalYearStartMonth: 7,
    parameters: [
      { name: "min_amount", type: "number", default: 100, description: "floor for big deals" },
    ],
    hierarchies: [{ name: "geo", levels: ["region", "subregion", "city"] }],
    dimensions: [
      { name: "region", sql: "region", type: "categorical" },
      { name: "subregion", sql: "subregion", type: "categorical" },
      { name: "city", sql: "city", type: "categorical" },
    ],
  });

  it("prints the drill path in order", () => {
    expect(formatSemanticCatalog([rich])).toContain("hierarchy geo: region → subregion → city");
  });

  it("prints each parameter with type, default and description", () => {
    const text = formatSemanticCatalog([rich]);
    expect(text).toContain("param {{min_amount}}:number (default 100)");
    expect(text).toContain("floor for big deals");
  });

  it("explains the fiscal calendar only when one is configured", () => {
    const text = formatSemanticCatalog([rich]);
    expect(text).toContain("fiscal year starts in month 7");
    expect(text).toContain("named by the calendar year it ends in");
    // A model on the calendar year must NOT carry the note — noise an agent
    // would repeat to users as if it meant something.
    expect(formatSemanticCatalog([model({})])).not.toContain("fiscal year starts");
  });
});

describe("widgetFromSemantic — the currency ride-along", () => {
  const base = {
    title: "t",
    model: "m",
    metrics: ["total"],
    dimensions: ["region"],
    filters: undefined,
    grains: undefined,
    compare: undefined,
    columns: ["region", "total"],
    rows: [],
    sql: "SELECT 1",
  };

  it("a currency metric charts as currency, code included", () => {
    const kpi = widgetFromSemantic({
      ...base,
      chartType: "kpi",
      format: "currency",
      currency: "USD",
    });
    expect(kpi.chart).toMatchObject({ type: "kpi", format: "currency", currency: "USD" });
    const bar = widgetFromSemantic({
      ...base,
      chartType: "bar",
      format: "currency",
      currency: "EUR",
    });
    expect(bar.chart).toMatchObject({ type: "bar", format: "currency", currency: "EUR" });
  });

  it("percent travels without a currency code", () => {
    const w = widgetFromSemantic({ ...base, chartType: "kpi", format: "percent" });
    expect(w.chart).toMatchObject({ format: "percent" });
    expect(w.chart).not.toHaveProperty("currency");
  });

  it("plain numbers add nothing — the chart default already renders them", () => {
    const w = widgetFromSemantic({ ...base, chartType: "kpi", format: "number" });
    expect(w.chart).not.toHaveProperty("format");
  });

  it("a currency code without the currency format is ignored, not half-applied", () => {
    const w = widgetFromSemantic({ ...base, chartType: "kpi", currency: "USD" });
    expect(w.chart).not.toHaveProperty("currency");
    expect(w.chart).not.toHaveProperty("format");
  });
});

describe("fiscal compare shift", () => {
  it("prior_period over a fiscal_quarter axis shifts by three months", () => {
    const m = model({
      fiscalYearStartMonth: 7,
      dimensions: [{ name: "day", sql: "day", type: "time" }],
    });
    const compiled = compileSemanticQuery(
      m,
      {
        model: "m",
        metrics: ["total"],
        dimensions: ["day"],
        grains: { day: "fiscal_quarter" },
        compare: "prior_period",
      },
      { dialect: "postgres" },
    );
    expect(compiled.sql).toContain("INTERVAL '3 month'");
    expect(compiled.columns).toContain("total_prev");
  });
});
