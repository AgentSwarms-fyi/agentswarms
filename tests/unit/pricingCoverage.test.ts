// What a call costs, and what happens when the app does not know.
//
// Every estimator returns 0 for a model it has no price for, and 0 is
// indistinguishable from "cheap" by the time it reaches a report or a budget.
// getBudgetDecision sums cost_usd, so calls on an unpriced model never
// accumulate: the monthly total stays under the limit for ever and the hard cap
// never fires.
//
// That was not hypothetical. The model pickers offered 24 ids with no price,
// openai/gpt-4o-mini — the DEFAULT for embedded agents — among them. Measured
// at 2,000 calls of 3k in / 800 out, gpt-4o reported $0.00 against a real
// $31.00, and claude-3.5-sonnet $0.00 against $42.00.
import { readFileSync, readdirSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  estimateEmbeddingCost,
  estimateImageCost,
  estimateTextCost,
  hasKnownPrice,
  isImageModel,
  TEXT_COST_TABLE,
} from "@/utils/observability/pricing";

describe("a price the app does know", () => {
  it("scales with tokens on both sides", () => {
    const m = "openai/gpt-4o";
    const one = estimateTextCost(m, 1000, 1000);
    expect(one).toBeGreaterThan(0);
    expect(estimateTextCost(m, 2000, 2000)).toBeCloseTo(one * 2, 10);
  });

  it("charges input and output at different rates", () => {
    // Collapsing them into one rate is a silent 4x error on output-heavy work.
    expect(estimateTextCost("openai/gpt-4o", 1000, 0)).not.toBeCloseTo(
      estimateTextCost("openai/gpt-4o", 0, 1000),
      10,
    );
  });

  it("costs nothing for zero tokens", () => {
    expect(estimateTextCost("openai/gpt-4o", 0, 0)).toBe(0);
  });
});

describe("the same model under either spelling", () => {
  // Gateway ids are vendor/model; a direct provider call uses the bare id, and
  // EMBED_COST_TABLE is keyed that way. The knowledge page names the prefixed
  // form, so the SAME embedding run priced at zero or not depending on which
  // caller reached it.
  it("prices an embedding model with or without the vendor prefix", () => {
    const bare = estimateEmbeddingCost("text-embedding-3-small", 1_000_000);
    const prefixed = estimateEmbeddingCost("openai/text-embedding-3-small", 1_000_000);
    expect(bare).toBeGreaterThan(0);
    expect(prefixed).toBe(bare);
  });

  it("does not let the fallback match an unrelated model", () => {
    // Splitting on "/" must not turn a wrong vendor into a right price.
    expect(estimateTextCost("someone/not-a-real-model", 1000, 1000)).toBe(0);
    expect(hasKnownPrice("someone/not-a-real-model", "text")).toBe(false);
  });
});

describe("a price the app does NOT know is announced, not assumed", () => {
  it("reports no known price rather than a cost of zero", () => {
    expect(hasKnownPrice("brand-new/model-nobody-priced", "text")).toBe(false);
    expect(estimateTextCost("brand-new/model-nobody-priced", 5000, 5000)).toBe(0);
  });

  it("answers for every kind, since each has its own table", () => {
    for (const kind of ["text", "embedding", "image"] as const) {
      expect(hasKnownPrice("brand-new/model-nobody-priced", kind), kind).toBe(false);
    }
    expect(hasKnownPrice("openai/gpt-4o", "text")).toBe(true);
    expect(hasKnownPrice("text-embedding-3-small", "embedding")).toBe(true);
    expect(hasKnownPrice("google/gemini-2.5-flash-image", "image")).toBe(true);
  });

  it("is wired into the trace, so the gap is recorded", () => {
    // Knowing is worthless if nothing writes it down: a spend figure has to be
    // able to say it is incomplete.
    //
    // The recorder asks the RESOLVER now rather than calling hasKnownPrice
    // directly — one question, one answer, so the cost and the "was it priced"
    // flag can never come from two different lookups that disagree. This
    // assertion caught that change, which is what it is for.
    const rec = readFileSync("src/utils/observability/recordGatewayUsage.server.ts", "utf8");
    expect(rec).toContain("priceCall(");
    expect(rec).toContain("pricing_missing");
    expect(rec, "the flag is derived from a second lookup").toContain("if (!priced.priced)");
  });
});

describe("every model the app offers has a price", () => {
  // THE DRIFT GUARD. A model picker and a price table are edited by different
  // concerns, and the picker is the one that grows. This is what turns "we
  // forgot to price it" from a silent budget hole into a failing test.
  function walk(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(p, out);
      else if (/\.tsx?$/.test(e.name)) out.push(p);
    }
    return out;
  }

  const VENDORS =
    "google|openai|anthropic|meta-llama|mistralai|deepseek|x-ai|qwen|Qwen|groq|cohere";

  const offered = new Map<string, string>();
  for (const f of walk("src")) {
    if (f.includes("observability/pricing.ts")) continue;
    for (const m of readFileSync(f, "utf8").matchAll(
      new RegExp(`"((?:${VENDORS})\\/[A-Za-z0-9][\\w.-]*)"`, "g"),
    )) {
      if (!offered.has(m[1])) offered.set(m[1], f);
    }
  }

  it("found the model ids to check", () => {
    // Guards the guard: a regex that stops matching would pass vacuously.
    expect(offered.size).toBeGreaterThan(20);
    expect([...offered.keys()]).toContain("openai/gpt-4o");
  });

  it("has a price for each one", () => {
    const unpriced = [...offered.entries()]
      .filter(([id]) => !["text", "embedding", "image"].some((k) => hasKnownPrice(id, k as never)))
      .map(([id, f]) => `${id} (${f})`);
    expect(
      unpriced,
      `these are selectable and cost $0, so budgets ignore them:\n  ${unpriced.join("\n  ")}`,
    ).toEqual([]);
  });

  it("treats every image model as an image, so it is not priced as text", () => {
    // An image model missing from IMAGE_COST_TABLE falls through to the text
    // estimator with zero output tokens — which is zero again, by a second
    // route.
    for (const id of [...offered.keys()].filter((i) => /image/.test(i))) {
      expect(isImageModel(id), `${id} is not recognised as an image model`).toBe(true);
      expect(estimateImageCost(id, 1), id).toBeGreaterThan(0);
    }
  });

  it("prices nothing at zero or negative", () => {
    for (const [id, p] of Object.entries(TEXT_COST_TABLE)) {
      expect(p.in, `${id} input`).toBeGreaterThan(0);
      expect(p.out, `${id} output`).toBeGreaterThan(0);
    }
  });
});
