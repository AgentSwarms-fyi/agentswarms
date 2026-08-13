// Chart choice — the stage after SQL that the eval never looks at.
//
// A perfect query still produces a bad answer if it is drawn as the wrong
// chart: a pie of forty slices, a line over unordered categories, a bar chart
// of one number. The NL-to-SQL score says nothing about any of that.
//
// suggestChart is part code, part model. The two SHORT-CIRCUITS below decide
// without asking, so they can be tested here for free and in CI forever. The
// model-backed path needs a session and a paid call, so it is measured
// deliberately rather than on every push — see the note at the bottom for what
// it scored when it was run.
import { describe, expect, it } from "vitest";

import { suggestChart } from "@/lib/biAgent";

const plan = { intent: "x", tables: [], steps: [] } as never;
const result = (columns: string[], rows: Record<string, unknown>[]) =>
  ({ columns, rows, row_count: rows.length }) as never;

describe("the shapes that are decided without asking a model", () => {
  it("draws an empty result as a table, not an empty chart", async () => {
    // An axis with no bars reads as "zero", which is a different answer from
    // "no rows matched".
    const spec = await suggestChart({
      question: "Sales for region ZZ?",
      result: result(["region", "sales"], []),
      plan,
    });
    expect(spec.type).toBe("table");
  });

  it("draws a single number as a KPI, not a one-bar chart", async () => {
    const spec = await suggestChart({
      question: "What is total revenue?",
      result: result(["total"], [{ total: 91_234 }]),
      plan,
    });
    expect(spec.type).toBe("kpi");
    expect((spec as { valueField?: string }).valueField).toBe("total");
  });

  it("draws a labelled single value as a KPI captioned with its label", async () => {
    // `EMEA | 1,043,887` — one row, one label, one measure — used to fall
    // through to the model and come back a bar chart containing a single
    // bar. A bar exists to compare, and there is nothing to compare with;
    // the label carries the only extra information, so it becomes the
    // caption. Measured in the AI Analyst after a step was narrowed to one
    // region.
    const spec = await suggestChart({
      question: "Total sales in EMEA",
      result: result(["region", "total_sales"], [{ region: "EMEA", total_sales: 1_043_887 }]),
      plan,
    });
    expect(spec.type).toBe("kpi");
    expect((spec as { valueField?: string }).valueField).toBe("total_sales");
    expect((spec as { label?: string }).label).toBe("EMEA");
  });

  it("keeps the step's intent as the caption when several labels compete", async () => {
    // "EMEA" alone reads as a caption; "EMEA, SMB, 2026-01" describes a
    // slice no single label can carry, so picking one would editorialise.
    const spec = await suggestChart({
      question: "EMEA SMB sales in January",
      result: result(
        ["region", "segment", "month", "total_sales"],
        [{ region: "EMEA", segment: "SMB", month: "2026-01", total_sales: 42 }],
      ),
      plan: { intent: "EMEA SMB sales in January", tables: [], steps: [] } as never,
    });
    expect(spec.type).toBe("kpi");
    expect((spec as { label?: string }).label).toBe("EMEA SMB sales in January");
  });

  it("does not short-circuit a single row carrying several NUMBERS", async () => {
    // One row of three numbers is a real chart question, not a KPI: it can
    // legitimately be a combo or a small table, and guessing which would be
    // worse than asking. The rule is one row and exactly one number.
    //
    // Asserted by the ROUTE TAKEN rather than the chart returned: both
    // short-circuits RETURN, and only the model path can throw, so a rejection
    // is proof this shape reached the model. Asserting a chart type here would
    // need a paid call and would make the suite flaky on a model's judgement.
    //
    // The MESSAGE is deliberately not matched. It used to expect /not signed
    // in/, which passes on a machine with a .env and fails in CI without one,
    // where the Supabase client throws "Missing Supabase environment
    // variables" first. Both prove the same thing; pinning either one makes
    // the test a check on the environment rather than on the short-circuit.
    await expect(
      suggestChart({
        question: "Revenue, cost and margin",
        result: result(["revenue", "cost", "margin"], [{ revenue: 10, cost: 6, margin: 4 }]),
        plan,
      }),
    ).rejects.toThrow();
  });
});

// ── Model-backed chart choice, measured 2026-08-04 ────────────────────────────
//
// Driven through the real suggestChart in a signed-in browser, since llmJson
// posts to a relative /api/bi and cannot run from Node. 7/7:
//
//   single scalar          -> kpi      (short-circuit)
//   empty result           -> table    (short-circuit)
//   4 regions x sales      -> bar
//   12 months x revenue    -> line
//   40 SKUs x units        -> bar      (NOT pie — the classic mistake)
//   spend vs revenue       -> scatter
//   3-way share            -> pie
//
// Not asserted here: it costs a call per case and the result is a model's
// judgement, so pinning it would make this suite flaky and expensive. The
// value is the record — a future change that starts drawing forty-slice pies
// has a documented baseline to be compared against.
