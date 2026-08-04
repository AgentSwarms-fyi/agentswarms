// The narrative under the chart was doing its own arithmetic, and getting it
// wrong.
//
// Measured through the real summarizeResult. Given five products it wrote:
//
//   "Total revenue across all products is approximately $1.4M ...
//    Alpha has the highest unit sales at 1.2k"
//
// The true total was $704,186 — it reported DOUBLE — and the top product by
// units was Gamma (1,544), not Alpha (1,237). Both stated flatly, in prose,
// beneath a chart that was correct.
//
// It could hardly have done better: it was handed a TEN-ROW SAMPLE plus a
// total row count and told to "lead with the headline number", so any total it
// gave was invented or extrapolated from a prefix — the snapshot-cap bug again,
// in words instead of bars.
//
// describeResultFacts does that arithmetic in code. These tests cover it
// without a model call; the phrasing on top is a model's job and is not
// pinned here.
import { describe, expect, it } from "vitest";

import { describeResultFacts } from "@/lib/biAgent";

const result = (columns: string[], rows: Record<string, unknown>[], capped = false) =>
  ({ columns, rows, row_count: rows.length, capped }) as never;

const PRODUCTS = [
  { product: "Alpha", units: 1237, revenue: 184291.37 },
  { product: "Beta", units: 892, revenue: 133478.52 },
  { product: "Gamma", units: 1544, revenue: 97210.08 },
  { product: "Delta", units: 611, revenue: 212663.19 },
  { product: "Epsil", units: 1098, revenue: 76542.64 },
];

describe("the totals the narrative is allowed to cite", () => {
  const facts = describeResultFacts(result(["product", "units", "revenue"], PRODUCTS));

  it("sums exactly, to the cent", () => {
    // 704185.80 — the figure the model reported as $1.4M.
    expect(facts).toContain("total=704185.80");
    expect(facts).toContain("total=5382");
  });

  it("names the row holding each maximum", () => {
    // Gamma, not Alpha. The superlative is resolved in code precisely because
    // eyeballing a sample is how it went wrong.
    expect(facts).toMatch(/units:.*max=1544 \(Gamma\)/);
    expect(facts).toMatch(/revenue:.*max=212663\.19 \(Delta\)/);
  });

  it("names the row holding each minimum too", () => {
    expect(facts).toMatch(/units:.*min=611 \(Delta\)/);
    expect(facts).toMatch(/revenue:.*min=76542\.64 \(Epsil\)/);
  });

  it("does not treat the label column as a measure", () => {
    expect(facts).not.toMatch(/^product:/m);
  });
});

describe("it refuses to call a truncated set a total", () => {
  it("says so, and says how to phrase it", () => {
    // A capped result summed and presented as "the total" is the same lie the
    // snapshot cap tells with a bar chart.
    const facts = describeResultFacts(result(["product", "revenue"], PRODUCTS, true));
    expect(facts).toContain("TRUNCATED");
    expect(facts).toMatch(/of the rows shown/i);
    expect(facts, "a capped result must not be described as complete").not.toMatch(
      /computed over all/,
    );
  });

  it("calls an uncapped result complete", () => {
    const facts = describeResultFacts(result(["product", "revenue"], PRODUCTS));
    expect(facts).toMatch(/computed over all 5 rows/);
    expect(facts).not.toContain("TRUNCATED");
  });
});

describe("shapes that must not produce a bogus fact", () => {
  it("returns nothing for an empty result", () => {
    expect(describeResultFacts(result(["a", "b"], []))).toBe("");
  });

  it("returns nothing when no column is numeric", () => {
    expect(
      describeResultFacts(result(["city", "country"], [{ city: "Paris", country: "FR" }])),
    ).toBe("");
  });

  it("ignores nulls rather than counting them as zero", () => {
    // Averaging or summing a null as 0 silently understates every figure.
    const facts = describeResultFacts(
      result(
        ["k", "v"],
        [
          { k: "a", v: 10 },
          { k: "b", v: null },
          { k: "c", v: 5 },
        ],
      ),
    );
    expect(facts).toContain("total=15");
    expect(facts).toMatch(/min=5 \(c\)/);
  });

  it("survives a result with no label column", () => {
    const facts = describeResultFacts(result(["v"], [{ v: 3 }, { v: 9 }]));
    expect(facts).toContain("total=12");
    expect(facts).toContain("max=9");
  });
});

describe("the prompt actually forbids the model doing its own sums", () => {
  it("tells it to use the computed facts and not the sample", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/lib/biAgent.ts", "utf8");
    // To the NEXT top-level declaration, not the first "\n}" — the function
    // contains nested braces (the systemPrompt ternary), so a first-brace
    // slice cut the body off above the call it was looking for.
    const fn = src.slice(src.indexOf("export async function summarizeResult"));
    const nextDecl = fn.indexOf("\n// ──", 1);
    const body = fn.slice(0, nextDecl > 0 ? nextDecl : 4000);
    expect(body).toContain("describeResultFacts");
    expect(body, "the model is not told where totals come from").toMatch(/Use the COMPUTED FACTS/);
    expect(body, "the model is not warned off the sample").toMatch(/do NOT add up the sample/i);

    // AND the facts must actually be INTERPOLATED into the prompt. Computing
    // them and keeping the instruction while dropping `${facts}` from the
    // template leaves every assertion above green and sends the model the same
    // bare sample it was inventing totals from — caught by mutation, which is
    // the only way a gap like this shows up.
    expect(body, "COMPUTED FACTS is never sent to the model").toMatch(
      /userPrompt:[\s\S]*\$\{facts\}/,
    );
  });
});
