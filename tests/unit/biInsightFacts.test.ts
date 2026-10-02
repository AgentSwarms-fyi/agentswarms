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
import fs from "node:fs";

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
    // Bounded by the next top-level export, not by a byte count. A fixed
    // window silently starts asserting about a DIFFERENT function's text as
    // the one under test grows — this slice was 2600 characters and a few
    // lines of comment pushed the last assertion out of it.
    const next = src.indexOf("\nexport ", at + 1);
    const body = src.slice(at, next > at ? next : undefined);
    expect(body).toContain("computeInsightFacts(args.columns, args.rows)");
    expect(body).toMatch(/FACTS is authoritative/);
    expect(body).toMatch(/Do NOT calculate a percentage/);
    // And the facts have to actually reach the model.
    expect(body).toContain("FACTS (authoritative)");
  });
});

describe("a snapshot that is a prefix, which the SQL cannot tell you about", () => {
  // The other PARTIAL case is the query capping ITSELF with a trailing LIMIT,
  // and reading the SQL finds it. This one is the snapshot hitting the row cap
  // while the query had more to give: the SQL asked for everything, so nothing
  // in it says the tail is missing. On a warehouse table that is the normal
  // case, not an exotic one.
  const cols = ["region", "total_sales"];
  const rows = [
    { region: "AMER", total_sales: 60 },
    { region: "EMEA", total_sales: 40 },
  ];

  it("says the rows beyond the cap are missing", () => {
    const out = insightFacts(cols, rows, "SELECT region, SUM(x) FROM t GROUP BY region", 2);
    expect(out).toContain("PARTIAL");
    expect(out).toContain("this snapshot holds 2 row(s)");
  });

  it("withholds the shares, which would be shares of a prefix", () => {
    // 60 and 40 really do sum to 100 of the rows present. Stating that as
    // "60% / 40%" is the sentence this exists to prevent, because the rows that
    // would move it were never fetched.
    const out = insightFacts(cols, rows, "SELECT region, SUM(x) FROM t GROUP BY region", 2);
    expect(out).not.toContain("SHARE OF");
    expect(out).not.toContain("sum to 100%");
  });

  it("forbids the superlatives a prefix cannot support", () => {
    // "AMER is the largest region" is unknowable from the first page of a
    // result ordered or not — the largest may be in the part that was dropped.
    const out = insightFacts(cols, rows, undefined, 2);
    expect(out).toMatch(/largest or smallest/);
    expect(out).toMatch(/category is absent/);
  });

  it("still states the totals, which are true of the rows it has", () => {
    const out = insightFacts(cols, rows, undefined, 2);
    expect(out).toContain("total=100");
    expect(out).toContain("ROWS: 2");
  });

  it("leaves a complete result exactly as it was", () => {
    const out = insightFacts(cols, rows, "SELECT region, SUM(x) FROM t GROUP BY region");
    expect(out).not.toContain("PARTIAL");
    expect(out).toContain("SHARE OF");
  });

  it("prefers the query's own LIMIT when both are true", () => {
    // A LIMIT 1 query whose snapshot also hit the cap is still best described
    // by the limit the author wrote — and either way the shares are gone.
    const out = insightFacts(cols, rows, "SELECT region, SUM(x) FROM t LIMIT 1", 2);
    expect(out).toContain("ends with LIMIT 1");
    expect(out).not.toContain("this snapshot holds");
    expect(out).not.toContain("SHARE OF");
  });

  it("is actually wired from the widget to the card", () => {
    // The card takes rows from a widget snapshot, and only the widget knows
    // whether that snapshot is whole. Source-anchored because no unit test of
    // the digest can see an argument that was never passed.
    const agent = fs.readFileSync("src/lib/biAgent.ts", "utf8");
    expect(agent).toContain("const cappedAt = args.truncated ? args.rows.length : null;");
    expect(agent).toContain("const partial = rowLimit != null || cappedAt != null;");
    // Shares must go for EITHER reason, not just the LIMIT one.
    expect(agent).toContain(
      "const measured = measured0 && partial ? { ...measured0, shares: [] } : measured0;",
    );
    // Computing the reason is not the same as handing it over. Dropping the
    // third argument still removes the shares, so nothing else here would
    // notice — the caveat would simply stop being written.
    expect(agent).toContain("formatInsightFacts(measured, rowLimit, cappedAt)");
    const route = fs.readFileSync("src/routes/_authenticated/bi_.$dashboardId.tsx", "utf8");
    expect(route).toContain("truncated: w.truncated,");
  });
});
