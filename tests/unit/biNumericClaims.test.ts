// Checking the numbers an AI wrote against the numbers the data produced.
//
// Handing the insight card computed facts stopped it inventing 48% / 39% / 19%
// — but only made it less likely. Nothing checked. This is the check, and the
// case it has to get right is the real card, verbatim, against the real rows.
//
// The design problem is rounding. The prompt asks the model to round for
// readability ($1.2M, 3.4k), so a check that demands exact equality fails on
// every well-written sentence, and one with a fixed fuzz either waves through
// a wrong figure or rejects a right one depending on magnitude. The tolerance
// therefore comes from the PRECISION THE WRITER CHOSE: "$1.0M" claims only
// that the value rounds to 1.0M, so anything within ±50,000 satisfies it,
// while "410,379.26" claims two decimals and gets ±0.005.
import { describe, expect, it } from "vitest";

import { computeInsightFacts } from "@/lib/biInsightFacts";
import { extractClaims, unsupportedFigures, verifyClaims } from "@/lib/biNumericClaims";

/** The widget that produced the finding: "Sales by Region", as it really was. */
const COLUMNS = ["region", "total_sales"];
const ROWS = [
  { region: "EMEA", total_sales: 1042800 },
  { region: "AMER", total_sales: 837900 },
  { region: "APJ", total_sales: 415500 },
  { region: "—", total_sales: 1001.86 },
];
const FACTS = computeInsightFacts(COLUMNS, ROWS);

const verify = (prose: string) => verifyClaims(prose, FACTS, ROWS);

describe("the card that started this", () => {
  // Verbatim from the dashboard, before the fix.
  const BEFORE =
    "EMEA leads with total sales of $1.0M, accounting for 48% of overall sales. " +
    "AMER follows with $837k, representing 39% of total sales. " +
    "APJ has the lowest sales at $415k, making up 19% of the total.";

  it("flags all three invented shares", () => {
    const bad = unsupportedFigures(verify(BEFORE));
    // The three percentages are the finding: the real shares are 45.4 / 36.5 /
    // 18.1. Note 19% vs 18.1% is only 0.9 out — a full-unit tolerance would
    // wave it through, which is why the window is HALF the last place written.
    expect(bad).toContain("48%");
    expect(bad).toContain("39%");
    expect(bad).toContain("19%");
  });

  it("also flags $837k, because 837,900 rounds to $838k", () => {
    // Worth stating rather than tuning away. The model truncated instead of
    // rounding, and "$837k" is a claim that the value rounds to 837,000. It
    // does not. Loosening the window to admit this is exactly what would let
    // 19% through, so the check pushes the writer to the precision it should
    // have used — and the card the product now produces writes "$837.9k".
    expect(unsupportedFigures(verify(BEFORE))).toContain("$837k");
    expect(unsupportedFigures(verify("AMER follows with $837.9k."))).toEqual([]);
    expect(unsupportedFigures(verify("AMER follows with $838k."))).toEqual([]);
  });

  it("accepts the same sentence once the shares are right", () => {
    // Verbatim from the dashboard, after the fix.
    const AFTER =
      "Total sales across all regions amount to $2.3M. " +
      "EMEA leads with $1.0M in sales, representing 45.4% of total sales. " +
      "AMER follows with $837.9k, accounting for 36.5% of total sales. " +
      "APJ has significantly lower sales at $415.5k, making up only 18.1% of total sales.";
    expect(unsupportedFigures(verify(AFTER))).toEqual([]);
  });

  it("matches each figure to the fact that produced it", () => {
    const v = verify("EMEA leads with $1.0M, representing 45.4% of total sales.");
    expect(v[0].matched).toEqual({ kind: "row", label: "total_sales" });
    expect(v[1].matched).toEqual({ kind: "share", label: "EMEA" });
  });
});

describe("tolerance comes from the precision written", () => {
  it("accepts a figure rounded the way the prompt asks for", () => {
    // 1,042,800 written as "$1.0M" — inside the ±50,000 that "1.0M" claims.
    expect(unsupportedFigures(verify("EMEA is $1.0M."))).toEqual([]);
    // The grand total 2,297,201.86 written as "$2.3M".
    expect(unsupportedFigures(verify("Sales total $2.3M."))).toEqual([]);
  });

  it("rejects a figure that rounding cannot reach", () => {
    // No value rounds to 1.4M; the nearest is 1,042,800.
    expect(unsupportedFigures(verify("EMEA is $1.4M."))).toEqual(["$1.4M"]);
  });

  it("holds a precise figure to its precision", () => {
    expect(unsupportedFigures(verify("APJ is 415,500."))).toEqual([]);
    // One cent out, claimed to the cent.
    expect(unsupportedFigures(verify("APJ is 415,500.01."))).toEqual(["415,500.01"]);
  });

  it("derives the window rather than fixing it", () => {
    const [coarse] = extractClaims("$1.0M");
    const [fine] = extractClaims("410,379.26");
    expect(coarse.tolerance).toBe(50_000);
    expect(fine.tolerance).toBeCloseTo(0.005, 6);
  });
});

describe("a magnitude letter has to be attached to its number", () => {
  // Found by driving the real product, not by reading the code. An insight
  // card on "Monthly Units Sold Trend" wrote "…January 2023 and March 2024
  // both recording the minimum of 159 units", and the check flagged a figure
  // in it. The extractor had read the "b" of "both" as a BILLION suffix, so
  // "2024 b" became 2.024e9 — which also stopped it looking like a year, so
  // the year guard never fired and a correct sentence was sent back for
  // rewriting.
  const SENTENCE =
    "some months like January 2023 and March 2024 both recording the minimum of 159 units";

  it("reads the years as years, not as billions", () => {
    expect(extractClaims(SENTENCE).map((c) => c.raw)).toEqual(["159"]);
  });

  it("leaves any number followed by a k/m/b/t word alone", () => {
    // The same trap, in the phrases a BI card actually writes.
    for (const phrase of ["300 basis points", "12 bottles", "7 key accounts", "40 million"]) {
      const claims = extractClaims(phrase);
      expect(claims, phrase).toHaveLength(1);
    }
    expect(extractClaims("300 basis points")[0].value).toBe(300);
    expect(extractClaims("12 bottles")[0].value).toBe(12);
    expect(extractClaims("7 key accounts")[0].value).toBe(7);
  });

  it("still reads an attached letter as a magnitude", () => {
    expect(extractClaims("$1.2M")[0].value).toBe(1_200_000);
    expect(extractClaims("3.4k rows")[0].value).toBe(3_400);
    expect(extractClaims("$837.9k,")[0].value).toBe(837_900);
  });

  it("reads a spelled-out magnitude, which cannot be misread", () => {
    expect(extractClaims("$2.3 million")[0].value).toBe(2_300_000);
    expect(extractClaims("1.5 billion units")[0].value).toBe(1_500_000_000);
    // …but not a word that merely starts that way.
    expect(extractClaims("4 millionaires")[0].value).toBe(4);
  });
});

describe("what it refuses to flag", () => {
  it("leaves years alone", () => {
    // Flagging "2024" in "revenue in 2024" would train everyone to ignore it.
    expect(extractClaims("Revenue grew through 2024 and 2025.")).toEqual([]);
    expect(unsupportedFigures(verify("Revenue in 2023 was strong."))).toEqual([]);
  });

  it("accepts the row count, which a card legitimately states", () => {
    expect(unsupportedFigures(verify("Across 4 regions, sales rose."))).toEqual([]);
  });

  it("accepts a computed total, min, max and mean", () => {
    const totals = verify("Total 2,297,201.86, high 1,042,800, low 1,001.86.");
    expect(totals.every((c) => c.matched)).toBe(true);
    expect(totals[0].matched?.kind).toBe("total");
  });

  it("says nothing about prose with no figures at all", () => {
    expect(verify("Regional performance varies considerably.")).toEqual([]);
  });
});

describe("percentages are checked against shares, not row values", () => {
  it("catches a share that is merely plausible", () => {
    // 40% is not any region's share; the real ones are 45.4 / 36.5 / 18.1 / 0.0.
    expect(unsupportedFigures(verify("EMEA is 40% of sales."))).toEqual(["40%"]);
  });

  it("still accepts a percentage the data itself contains", () => {
    // A margin column of percentages is a legitimate source for "18%".
    const rows = [
      { region: "AMER", margin_pct: 18.2 },
      { region: "EMEA", margin_pct: 21.4 },
    ];
    const facts = computeInsightFacts(["region", "margin_pct"], rows);
    const v = verifyClaims("AMER runs at 18.2% margin.", facts, rows);
    expect(unsupportedFigures(v)).toEqual([]);
  });
});

describe("where the check is actually spent", () => {
  // A verifier nothing calls verifies nothing. Mutation testing has caught
  // this exact shape twice in this codebase already — a budget nothing sent,
  // and a schema fetch an `if (false)` could disable — so the call site is
  // pinned, not just the function.
  it("runs inside the insight card, with a retry and a disclosure", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("src/lib/biAgent.ts", "utf8");
    const at = src.indexOf("export async function generateWidgetInsight");
    // To the next top-level function, not a fixed byte count — a magic window
    // silently stops covering the end of the function as the function grows,
    // which is how this assertion went red on an unrelated edit.
    const end = src.indexOf("export async function runBiTurn", at);
    expect(end).toBeGreaterThan(at);
    const body = src.slice(at, end);

    expect(body).toContain("unsupportedFigures(verifyClaims(text, measured, args.rows))");
    // The RESULT has to be used, not merely computed. Mutation-checked:
    // replacing `let bad = check(insight)` with an empty list left the helper
    // defined, the assertion above green, and nothing checked at all.
    expect(body).toMatch(/let bad = check\(insight\)/);
    expect(body).toMatch(/if \(bad\.length > 0\)/);
    // A truncated result must not hand the checker shares to accept, or a
    // "100%" written against one row of a LIMIT 1 query verifies happily.
    expect(body).toMatch(/rowLimit != null \? \{ \.\.\.measured0, shares: \[\] \}/);
    // One retry, and it must NAME the figures — "try again" produces the same
    // number in a new sentence.
    expect(body).toMatch(/must not appear in the card: \$\{bad\.join/);
    // The retry only wins if it is actually better.
    expect(body).toMatch(/if \(retryBad\.length < bad\.length\)/);
    // And what survives both is disclosed rather than quietly shipped.
    expect(body).toContain("Could not be checked against this visual's data");
  });
});

describe("the shape of the verdict", () => {
  it("reports each figure once, in the order written, with its offset", () => {
    const v = verify("EMEA $1.0M then AMER $837.9k.");
    expect(v.map((c) => c.raw)).toEqual(["$1.0M", "$837.9k"]);
    expect(v[0].at).toBeLessThan(v[1].at);
    expect("EMEA $1.0M then AMER $837.9k.".slice(v[1].at)).toMatch(/^\$837\.9k/);
  });

  it("does not repeat the same unsupported figure twice", () => {
    expect(unsupportedFigures(verify("It was 48%. Yes, 48%."))).toEqual(["48%"]);
  });

  it("works with no facts at all, against the rows alone", () => {
    const v = verifyClaims("EMEA is 1,042,800.", null, ROWS);
    expect(unsupportedFigures(v)).toEqual([]);
    expect(verifyClaims("EMEA is 999.", null, ROWS)[0].matched).toBeNull();
  });
});
