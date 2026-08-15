// Generating a dashboard from a governed model, without letting the model out.
//
// The whole value of pointing "Generate with AI" at a semantic model is that
// the compiler writes every SQL statement. That holds only if the planner is
// confined to the declared vocabulary — one metric name it invented, passed
// through, and the guarantee is gone for that widget while the dashboard looks
// exactly the same.
//
// So these tests are mostly about refusal: what happens when the model returns
// something that does not exist, does not fit, or is a duplicate wearing a
// second name.
import { describe, expect, it } from "vitest";

import type { MetricModelOption } from "@/components/bi/biDataContext";
import {
  ALLOWED_GRAINS,
  GOVERNED_CHART_TYPES,
  GOVERNED_PLANNER_SYSTEM,
  describeModelForPlanner,
  timeDimensions,
  toSemanticQuery,
  validatePlan,
  validateSuggestion,
} from "@/lib/biGenerateSemantic";

const model: MetricModelOption = {
  name: "sales_model",
  label: "Sales",
  metrics: [
    { name: "revenue", agg: "sum", format: "currency", currency: "USD" },
    { name: "order_count", agg: "count" },
  ],
  dimensions: [
    { name: "region", type: "string" },
    { name: "channel", type: "string" },
    { name: "order_date", type: "time" },
  ],
};

const ok = (raw: Parameters<typeof validateSuggestion>[0]) => validateSuggestion(raw, model);

describe("the planner is confined to declared names", () => {
  it("accepts a suggestion built only from declarations", () => {
    const r = ok({
      title: "Revenue by region",
      chartType: "bar",
      metrics: ["revenue"],
      dimensions: ["region"],
    });
    expect(r.ok).toBe(true);
    expect(r.ok && r.widget.metrics).toEqual(["revenue"]);
  });

  it("REFUSES a metric the model never declared", () => {
    // The central guarantee. `profit` sounds plausible and does not exist; the
    // compiler could not build it, and quietly swapping in `revenue` would
    // answer a different question under this widget's title.
    const r = ok({
      title: "Profit by region",
      chartType: "bar",
      metrics: ["profit"],
      dimensions: ["region"],
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.rejected.reason).toContain("profit");
    expect(!r.ok && r.rejected.reason).toMatch(/not defined on this semantic model/);
  });

  it("REFUSES a dimension the model never declared", () => {
    const r = ok({
      title: "Revenue by rep",
      chartType: "bar",
      metrics: ["revenue"],
      dimensions: ["sales_rep"],
    });
    expect(!r.ok && r.rejected.reason).toContain("sales_rep");
  });

  it("names the offending item, because a reason nobody can act on is not a reason", () => {
    const r = ok({ title: "x", chartType: "bar", metrics: ["margin_pct"], dimensions: ["region"] });
    expect(!r.ok && r.rejected.reason).not.toMatch(/^invalid/i);
    expect(!r.ok && r.rejected.reason).toContain("margin_pct");
  });

  it("refuses a suggestion with no metric at all", () => {
    expect(ok({ title: "Empty", chartType: "bar", metrics: [], dimensions: ["region"] }).ok).toBe(
      false,
    );
  });
});

describe("a chart must be able to show what it was given", () => {
  it("refuses a KPI that was given a dimension", () => {
    // A KPI with a breakdown is a category list pretending to be one number.
    const r = ok({
      title: "Revenue",
      chartType: "kpi",
      metrics: ["revenue"],
      dimensions: ["region"],
    });
    expect(!r.ok && r.rejected.reason).toMatch(/single figure/i);
  });

  it("accepts a KPI with no dimensions", () => {
    expect(ok({ title: "Revenue", chartType: "kpi", metrics: ["revenue"] }).ok).toBe(true);
  });

  it("refuses a pie with two dimensions", () => {
    const r = ok({
      title: "Split",
      chartType: "pie",
      metrics: ["revenue"],
      dimensions: ["region", "channel"],
    });
    expect(!r.ok && r.rejected.reason).toMatch(/more than 1 dimension/i);
  });

  it("refuses a pie with none", () => {
    expect(ok({ title: "Split", chartType: "pie", metrics: ["revenue"], dimensions: [] }).ok).toBe(
      false,
    );
  });

  it("refuses a chart type the dashboard cannot build", () => {
    const r = ok({
      title: "Flow",
      chartType: "sankey",
      metrics: ["revenue"],
      dimensions: ["region"],
    });
    expect(!r.ok && r.rejected.reason).toMatch(/not a chart type/i);
  });

  it("covers every governed chart type it claims to support", () => {
    for (const t of GOVERNED_CHART_TYPES) {
      const dims = t === "kpi" ? [] : ["region"];
      expect(ok({ title: t, chartType: t, metrics: ["revenue"], dimensions: dims }).ok, t).toBe(
        true,
      );
    }
  });
});

describe("time rollups", () => {
  it("accepts a grain on a declared time dimension", () => {
    const r = ok({
      title: "Revenue over time",
      chartType: "line",
      metrics: ["revenue"],
      dimensions: ["order_date"],
      grains: { order_date: "month" },
    });
    expect(r.ok && r.widget.grains).toEqual({ order_date: "month" });
  });

  it("refuses a grain on a dimension that is not a time", () => {
    // Compiles to a date truncation over something that is not a date.
    const r = ok({
      title: "Revenue by region",
      chartType: "bar",
      metrics: ["revenue"],
      dimensions: ["region"],
      grains: { region: "month" },
    });
    expect(!r.ok && r.rejected.reason).toMatch(/not a time dimension/i);
  });

  it("refuses a rollup the compiler does not know", () => {
    const r = ok({
      title: "Revenue",
      chartType: "line",
      metrics: ["revenue"],
      dimensions: ["order_date"],
      grains: { order_date: "fortnight" },
    });
    expect(!r.ok && r.rejected.reason).toMatch(/not a time rollup/i);
  });

  it("ignores a grain on a dimension this widget does not group by", () => {
    // Noise rather than an error — the grain simply has nothing to apply to.
    const r = ok({
      title: "Revenue by region",
      chartType: "bar",
      metrics: ["revenue"],
      dimensions: ["region"],
      grains: { order_date: "month" },
    });
    expect(r.ok).toBe(true);
    expect(r.ok && r.widget.grains).toBeUndefined();
  });

  it("finds the time dimensions of a model", () => {
    expect(timeDimensions(model)).toEqual(["order_date"]);
  });

  it("offers only grains the compiler supports", () => {
    expect([...ALLOWED_GRAINS]).toEqual(["day", "week", "month", "quarter", "year"]);
  });
});

describe("a plan keeps its rejects", () => {
  it("returns the widgets that survived AND the ones that did not", () => {
    // Silently producing 2 of 3 hands someone a dashboard they believe is
    // complete. Both halves reach the dialog.
    const plan = validatePlan(
      [
        { title: "Revenue", chartType: "kpi", metrics: ["revenue"] },
        { title: "Profit", chartType: "kpi", metrics: ["profit"] },
        { title: "By region", chartType: "bar", metrics: ["revenue"], dimensions: ["region"] },
      ],
      model,
    );
    expect(plan.widgets).toHaveLength(2);
    expect(plan.rejected).toHaveLength(1);
    expect(plan.rejected[0].title).toBe("Profit");
  });

  it("drops a duplicate query even when it was given a different name", () => {
    const plan = validatePlan(
      [
        {
          title: "Revenue by region",
          chartType: "bar",
          metrics: ["revenue"],
          dimensions: ["region"],
        },
        {
          title: "Regional revenue",
          chartType: "bar",
          metrics: ["revenue"],
          dimensions: ["region"],
        },
      ],
      model,
    );
    expect(plan.widgets).toHaveLength(1);
    expect(plan.rejected[0].reason).toMatch(/duplicate/i);
  });

  it("treats the same fields in a different order as the same query", () => {
    const plan = validatePlan(
      [
        { title: "A", chartType: "table", metrics: ["revenue"], dimensions: ["region", "channel"] },
        { title: "B", chartType: "table", metrics: ["revenue"], dimensions: ["channel", "region"] },
      ],
      model,
    );
    expect(plan.widgets).toHaveLength(1);
  });

  it("survives junk from the model without throwing", () => {
    for (const junk of [null, undefined, {}, "nope", [null], [{ title: 5 }]]) {
      expect(() => validatePlan(junk, model)).not.toThrow();
    }
  });
});

describe("what the planner is shown", () => {
  it("lists the declared metrics with their aggregation", () => {
    const text = describeModelForPlanner(model);
    expect(text).toContain("revenue (sum, currency)");
    expect(text).toContain("order_count (count)");
  });

  it("lists the dimensions with their types", () => {
    expect(describeModelForPlanner(model)).toContain("order_date (time)");
  });

  it("does NOT show the physical tables or columns", () => {
    // Showing the schema invites the planner to reach past the semantic layer,
    // which is the behaviour this whole path exists to prevent.
    const text = describeModelForPlanner(model);
    expect(text).not.toMatch(/\bSELECT\b|\bFROM\b|table|column/i);
  });

  it("says when the model is under a restrictive share policy", () => {
    expect(describeModelForPlanner({ ...model, scoped: true })).toMatch(/scoped view/i);
  });

  it("tells the model it may not invent measures or write SQL", () => {
    expect(GOVERNED_PLANNER_SYSTEM).toMatch(/do not write SQL/i);
    expect(GOVERNED_PLANNER_SYSTEM).toMatch(/do not invent measures/i);
  });
});

describe("the query handed to the compiler", () => {
  it("carries the model, metrics, dimensions and grains", () => {
    const q = toSemanticQuery(
      {
        title: "Revenue over time",
        chartType: "line",
        metrics: ["revenue"],
        dimensions: ["order_date"],
        grains: { order_date: "month" },
      },
      "sales_model",
    );
    expect(q).toEqual({
      model: "sales_model",
      metrics: ["revenue"],
      dimensions: ["order_date"],
      grains: { order_date: "month" },
      limit: 200,
    });
  });

  it("does not cap a KPI, which returns one row by construction", () => {
    const q = toSemanticQuery(
      { title: "Revenue", chartType: "kpi", metrics: ["revenue"], dimensions: [] },
      "sales_model",
    );
    expect(q.limit).toBeUndefined();
    expect(q.dimensions).toBeUndefined();
  });

  it("never carries SQL — the compiler writes that", () => {
    const q = toSemanticQuery(
      { title: "x", chartType: "bar", metrics: ["revenue"], dimensions: ["region"] },
      "sales_model",
    );
    expect(Object.keys(q)).not.toContain("sql");
  });
});
