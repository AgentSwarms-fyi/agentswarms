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

import { insightFacts } from "@/lib/biInsightFacts";

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
    expect(body).toContain("insightFacts(args.columns, args.rows)");
    expect(body).toMatch(/FACTS is authoritative/);
    expect(body).toMatch(/Do NOT calculate a percentage/);
    // And the facts have to actually reach the model.
    expect(body).toContain("FACTS (authoritative)");
  });
});
