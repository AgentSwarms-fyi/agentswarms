// Never hand the narrator a sum of averages.
//
// Asked "What is average salary by department?", the BI agent wrote the SQL
// correctly (AVG(...) GROUP BY department), drew the right chart, and returned
// six correct rows — then said in prose:
//
//   "The average salary across all departments is approximately $790.6k. The
//    highest average salary is in the People department at about $144.4k,
//    while the lowest is in Marketing at around $123.4k."
//
// $790.6k is the SUM of the six departmental averages. The real average is
// $131.8k. The sentence was wrong by exactly the number of groups, contained
// two other numbers that were right, and sat directly beneath a chart whose
// own axis stopped at 160k.
//
// The narrator did not invent it. describeResultFacts computes arithmetic in
// code precisely so the model cannot — and it offered `total=790.65` as an
// authoritative fact for a column named avg_salary. Given one total for an
// "average" column, calling it the average is the obvious reading.
//
// So the fix is upstream of the wording: a column that is already an average
// gets a mean and no sum at all.
import { describe, expect, it } from "vitest";

import { describeResultFacts, isPreAggregated } from "@/lib/biAgent";

/** The exact result that produced the bad sentence, from hr_roster. */
const salaryByDept = {
  columns: ["Department", "avg_salary"],
  rows: [
    { Department: "People", avg_salary: 144400 },
    { Department: "Support", avg_salary: 133300 },
    { Department: "Sales", avg_salary: 132500 },
    { Department: "Engineering", avg_salary: 131300 },
    { Department: "Finance", avg_salary: 125800 },
    { Department: "Marketing", avg_salary: 123400 },
  ],
  row_count: 6,
} as never;

describe("facts for an already-averaged column", () => {
  it("offers the mean, not the sum", () => {
    const facts = describeResultFacts(salaryByDept);
    // 790700 / 6 = 131783.33 — the number the sentence should have carried.
    expect(facts).toContain("avg=131783.33");
  });

  it("does not offer the sum of averages at all", () => {
    const facts = describeResultFacts(salaryByDept);
    expect(facts).not.toContain("total=");
    // The precise wrong number, so a regression is recognisable on sight.
    expect(facts).not.toContain("790700");
  });

  it("says why the sum is missing", () => {
    // A fact block that is merely silent about the total invites the model to
    // work one out from the rows it can see.
    expect(describeResultFacts(salaryByDept)).toMatch(/sum omitted/i);
  });

  it("still reports the extremes and who holds them", () => {
    const facts = describeResultFacts(salaryByDept);
    expect(facts).toContain("max=144400 (People)");
    expect(facts).toContain("min=123400 (Marketing)");
  });

  it("keeps the total for a genuinely additive column", () => {
    // The guard must not eat real totals: revenue by region SHOULD sum.
    const revenue = {
      columns: ["region", "total_revenue"],
      rows: [
        { region: "EMEA", total_revenue: 100 },
        { region: "AMER", total_revenue: 300 },
      ],
      row_count: 2,
    } as never;
    const facts = describeResultFacts(revenue);
    expect(facts).toContain("total=400");
    expect(facts).toContain("avg=200");
  });
});

describe("isPreAggregated", () => {
  it("recognises averages under the names SQL actually produces", () => {
    for (const c of [
      "avg_salary",
      "salary_avg",
      "average_order_value",
      "mean_latency",
      "median_ttr",
    ]) {
      expect(isPreAggregated(c), c).toBe(true);
    }
  });

  it("recognises rates, ratios and per-unit measures", () => {
    for (const c of [
      "conversion_rate",
      "win_ratio",
      "pct_complete",
      "percent_on_time",
      "profit_margin",
      "revenue_per_seat",
      "per_capita_spend",
      "quality_score",
    ]) {
      expect(isPreAggregated(c), c).toBe(true);
    }
  });

  it("leaves additive measures alone", () => {
    for (const c of [
      "revenue",
      "total_revenue",
      "sales",
      "quantity",
      "headcount",
      "orders",
      "cost_usd",
      // "average" must be a whole word: an "averaged_flag" column is odd, but
      // "coverage" and "operating_cost" must not trip a substring match.
      "coverage",
      "operating_cost",
    ]) {
      expect(isPreAggregated(c), c).toBe(false);
    }
  });
});
