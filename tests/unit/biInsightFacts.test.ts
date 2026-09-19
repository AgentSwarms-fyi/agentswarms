// The insight card said 48% + 39% + 19%.
//
// Found by pressing **AI insight** on the "Sales by Region" bar of an
// AI-generated dashboard. Under the heading "What the data shows" it read:
// EMEA $1.0M (48%), AMER $837k (39%), APJ $415k (19%) — three shares of one
// total that sum to 106%. No denominator makes that true; the model had the
// rows and did the division itself.
//
// The prompt had asked it to "quote real numbers from the data", which it did
// for the dollars. The percentages were not in the data at all. So the
// division is now done here, over every row, and the prompt tells the model to
// quote these figures rather than derive any of its own.
//
// This file is about the arithmetic. What the model then writes is its own
// business — but it can no longer be asked to compute what it is bad at.
import { describe, expect, it } from "vitest";

import {
  formatInsightFacts,
  computeInsightFacts,
  insightFacts,
  queryRowLimit,
} from "@/lib/biInsightFacts";

/** The widget that produced the finding, at the values it showed. */
const regions = [
  { region: "EMEA", total_sales: 1000000 },
  { region: "AMER", total_sales: 837000 },
  { region: "APJ", total_sales: 415000 },
];

describe("the facts handed to an insight card", () => {
  it("gives shares that sum to 100, not 106", () => {
    const out = insightFacts(["region", "total_sales"], regions);
    expect(out).toContain("EMEA=1000000 (44.4%)");
    expect(out).toContain("AMER=837000 (37.2%)");
    expect(out).toContain("APJ=415000 (18.4%)");
    const pcts = [...out.matchAll(/\((\d+\.\d)%\)/g)].map((m) => Number(m[1]));
    expect(pcts).toHaveLength(3);
    expect(Math.round(pcts.reduce((a, b) => a + b, 0))).toBe(100);
  });

  it("states the total, so a card never has to add up the rows", () => {
    const out = insightFacts(["region", "total_sales"], regions);
    expect(out).toContain("total=2252000");
    expect(out).toContain("min=415000");
    expect(out).toContain("max=1000000");
    expect(out).toContain("ROWS: 3");
  });

  it("computes over every row, not the 30 the prompt samples", () => {
    // The prompt sends 30 rows but the card speaks about the whole result.
    const many = Array.from({ length: 200 }, (_, i) => ({ k: `c${i}`, v: 10 }));
    expect(insightFacts(["k", "v"], many)).toContain("total=2000");
  });
});

describe("a query that capped itself", () => {
  // Found by driving the product. The AI generated a widget titled "Revenue by
  // Region" whose SQL ended `ORDER BY total_revenue DESC LIMIT 1`, so the bar
  // chart drew a single bar — and the insight card then wrote "AMER accounts
  // for 100% of the total revenue" and "there are no other regions
  // contributing". Both are true of the rows the widget holds and false about
  // the business, and every figure in them verifies, which is the most
  // dangerous shape a generated claim can take.
  const rows = [{ region: "AMER", total_revenue: 25875 }];
  const cols = ["region", "total_revenue"];
  const CAPPED =
    "SELECT region, SUM(revenue) AS total_revenue FROM analytics.bi_demo_sales " +
    "GROUP BY region ORDER BY total_revenue DESC NULLS LAST LIMIT 1";

  it("reads the cap off the query", () => {
    expect(queryRowLimit(CAPPED)).toBe(1);
    expect(queryRowLimit("SELECT a FROM t LIMIT 10;")).toBe(10);
    expect(queryRowLimit("SELECT a FROM t")).toBeNull();
    expect(queryRowLimit(undefined)).toBeNull();
    // A LIMIT buried in a subquery is not the result's cap.
    expect(queryRowLimit("SELECT * FROM (SELECT a FROM t LIMIT 5) x")).toBeNull();
  });

  it("states the cap instead of shares, so 100% is never offered", () => {
    const out = insightFacts(cols, rows, CAPPED);
    expect(out).toContain("PARTIAL");
    expect(out).toContain("LIMIT 1");
    expect(out).toMatch(/do not call anything 100%/i);
    expect(out).toMatch(/not say other categories are absent/i);
    // The shares line must be gone: a share of a truncated result is a share
    // of nothing, and printing one is what invites the sentence.
    expect(out).not.toContain("SHARE OF");
    expect(out).not.toContain("sum to 100%");
  });

  it("still states the totals, which are true of the rows shown", () => {
    const out = insightFacts(cols, rows, CAPPED);
    expect(out).toContain("total=25875");
    expect(out).toContain("ROWS: 1");
  });

  it("changes nothing when the query set no cap", () => {
    const full = [
      { region: "AMER", total_revenue: 25875 },
      { region: "EMEA", total_revenue: 15525 },
    ];
    const out = insightFacts(cols, full, "SELECT region, SUM(revenue) FROM t GROUP BY region");
    expect(out).toContain("SHARE OF");
    expect(out).not.toContain("PARTIAL");
  });

  it("formats the caveat from the structured facts too", () => {
    const f = computeInsightFacts(cols, rows);
    expect(formatInsightFacts(f!, 1)).toContain("PARTIAL");
    expect(formatInsightFacts(f!, null)).not.toContain("PARTIAL");
  });
});

describe("what it refuses to state", () => {
  it("gives no shares for a column that can go negative", () => {
    // A "share" of profit where one row is a loss is arithmetic that means
    // nothing — stating it would be the same mistake in a new place.
    const profit = [
      { region: "EMEA", profit: 5000 },
      { region: "AMER", profit: -2000 },
    ];
    const out = insightFacts(["region", "profit"], profit);
    expect(out).toContain("total=3000");
    expect(out).not.toContain("%");
  });

  it("gives no shares when a category appears twice", () => {
    // Two "EMEA" rows mean the rows are not a breakdown, and "EMEA = 40%"
    // would be one of them presented as all of them.
    const dup = [
      { region: "EMEA", v: 10 },
      { region: "EMEA", v: 30 },
      { region: "APJ", v: 60 },
    ];
    expect(insightFacts(["region", "v"], dup)).not.toContain("%");
  });

  it("gives no shares for a long result nobody would read as a breakdown", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ k: `c${i}`, v: 1 }));
    const out = insightFacts(["k", "v"], many);
    expect(out).toContain("total=40");
    expect(out).not.toContain("%");
  });

  it("says nothing at all when there is no measure", () => {
    expect(insightFacts(["a", "b"], [{ a: "x", b: "y" }])).toBe("");
    expect(insightFacts(["a"], [])).toBe("");
  });

  it("does not total a column of timestamps", () => {
    // date_trunc columns arrive as epoch numbers; summing them yields a
    // number with no meaning, presented with the authority of a total.
    const rows = [
      { d: 1667260800000, sales: 10 },
      { d: 1669852800000, sales: 20 },
    ];
    const out = insightFacts(["d", "sales"], rows);
    expect(out).toContain("sales: total=30");
    expect(out).not.toContain("d: total");
  });

  it("does not total a column of years either", () => {
    const rows = [
      { y: 2023, sales: 10 },
      { y: 2024, sales: 20 },
    ];
    // 2023 + 2024 = 4047 is not a fact about anything.
    expect(insightFacts(["y", "sales"], rows)).not.toContain("y: total");
  });
});

describe("the prompt that consumes them", () => {
  it("tells the model the facts are authoritative and not to divide", async () => {
    const src = await import("node:fs").then((fs) => fs.readFileSync("src/lib/biAgent.ts", "utf8"));
    const at = src.indexOf("export async function generateWidgetInsight");
    const body = src.slice(at, at + 2600);
    expect(body).toContain("computeInsightFacts(args.columns, args.rows)");
    expect(body).toMatch(/FACTS is authoritative/);
    expect(body).toMatch(/Do NOT calculate a percentage/);
    // And the facts have to actually reach the model.
    expect(body).toContain("FACTS (authoritative)");
  });
});
