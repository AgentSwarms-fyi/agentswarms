// Where a price comes from, and what happens when nothing knows one.
//
// The old lookup ignored the provider. execution_traces has always recorded
// llm_provider, and the table was keyed by model alone, so claude-3.5-sonnet
// cost the same on Bedrock, on Anthropic direct, and through OpenRouter's
// margin — three different numbers in reality.
//
// The chain is: operator override → synced catalog → bundled table →
// self-hosted zero → null. Each layer knows more about THIS deployment than
// the one after it, and null is a real answer that the caller records, because
// a price of 0 and an unknown price are the same figure in a budget and must
// not be the same signal.
import { afterEach, describe, expect, it } from "vitest";

import {
  priceCall,
  resolvePrice,
  setPriceCatalog,
  setPriceOverrides,
} from "@/utils/observability/priceResolver";

afterEach(() => {
  setPriceOverrides({});
  setPriceCatalog({});
});

describe("the provider is part of the question", () => {
  it("prices the same model differently per provider", () => {
    setPriceCatalog({
      "bedrock:claude-3.5-sonnet": { in: 0.003, out: 0.015 },
      "openrouter:claude-3.5-sonnet": { in: 0.0033, out: 0.0165 },
    });
    const onBedrock = resolvePrice({
      provider: "bedrock",
      model: "claude-3.5-sonnet",
      kind: "text",
    });
    const onRouter = resolvePrice({
      provider: "openrouter",
      model: "claude-3.5-sonnet",
      kind: "text",
    });
    expect(onBedrock?.in).toBe(0.003);
    expect(onRouter?.in).toBe(0.0033);
  });

  it("falls back to a provider-agnostic price when there is no specific one", () => {
    // The bundled tables are keyed by model alone, so this is how every
    // existing entry keeps working.
    const p = resolvePrice({ provider: "bedrock", model: "openai/gpt-4o", kind: "text" });
    expect(p?.source).toBe("bundled");
    expect(p?.in).toBeGreaterThan(0);
  });

  it("does not let one provider's rate leak to another", () => {
    setPriceCatalog({ "bedrock:some-model": { in: 9, out: 9 } });
    expect(resolvePrice({ provider: "groq", model: "some-model", kind: "text" })).toBeNull();
  });

  it("prefers the provider-qualified rate over a vendor-less one", () => {
    // Candidate ORDER is load-bearing, and a mutation that tried the bare tail
    // first survived every other test here. The tail exists for one narrow
    // case — EMBED_COST_TABLE is keyed `text-embedding-3-small` while callers
    // name `openai/text-embedding-3-small` — and it must stay the LAST resort,
    // or a generic entry silently overrides the rate for a specific backend.
    setPriceCatalog({
      "bedrock:claude-3.5-sonnet": { in: 0.003, out: 0.015 },
      "claude-3.5-sonnet": { in: 0.0099, out: 0.0099 },
    });
    const p = resolvePrice({
      provider: "bedrock",
      model: "anthropic/claude-3.5-sonnet",
      kind: "text",
    });
    expect(p?.in).toBe(0.003);
  });

  it("prefers the provider rate when the full model id is also priced", () => {
    // The realistic shape of that ordering: a gateway charges a margin over
    // the model's own list price, and the catalog holds BOTH. Whichever is
    // tried first wins, so the provider-qualified key has to come first. The
    // previous case could not tell the two orders apart, because the full id
    // was absent from the catalog and both orders fell through to the same
    // entry.
    setPriceCatalog({
      "openrouter:openai/gpt-4o": { in: 0.0033, out: 0.0132 },
      "openai/gpt-4o": { in: 0.0025, out: 0.01 },
    });
    expect(resolvePrice({ provider: "openrouter", model: "openai/gpt-4o", kind: "text" })?.in).toBe(
      0.0033,
    );
    // …and a direct call to the vendor still gets the vendor's own price.
    expect(resolvePrice({ provider: "openai", model: "openai/gpt-4o", kind: "text" })?.in).toBe(
      0.0025,
    );
  });
});

describe("the layers rank in order of what they know about this deployment", () => {
  it("an override beats the catalog and the bundled table", () => {
    // Committed-use and EA rates are not list price, and no public source can
    // know yours — so nothing may outrank an override.
    setPriceCatalog({ "openai:gpt-4o": { in: 0.0025, out: 0.01 } });
    setPriceOverrides({ "openai:gpt-4o": { in: 0.001, out: 0.004 } });
    const p = resolvePrice({ provider: "openai", model: "gpt-4o", kind: "text" });
    expect(p).toEqual({ in: 0.001, out: 0.004, source: "override" });
  });

  it("the catalog beats the bundled table", () => {
    setPriceCatalog({ "openai/gpt-4o": { in: 0.9, out: 0.9 } });
    const p = resolvePrice({ provider: "openai", model: "openai/gpt-4o", kind: "text" });
    expect(p?.source).toBe("catalog");
    expect(p?.in).toBe(0.9);
  });

  it("the bundled table answers when nothing has been synced", () => {
    const p = resolvePrice({ provider: "openrouter", model: "openai/gpt-4o", kind: "text" });
    expect(p?.source).toBe("bundled");
  });

  it("reports which layer answered, so a figure can be traced", () => {
    setPriceOverrides({ "openai:x": { in: 1, out: 1 } });
    expect(resolvePrice({ provider: "openai", model: "x", kind: "text" })?.source).toBe("override");
  });
});

describe("self-hosted is a known zero, not an unknown one", () => {
  it("prices Ollama and vLLM at zero and says so", () => {
    for (const provider of ["ollama", "vllm"]) {
      const p = resolvePrice({ provider, model: "llama3.1:8b", kind: "text" });
      expect(p, provider).toEqual({ in: 0, out: 0, source: "self-hosted" });
    }
  });

  it("counts as priced, so no gap is reported for it", () => {
    // Conflating "runs on your own hardware" with "we could not find a price"
    // would either bury real gaps or flood the traces with false ones.
    const r = priceCall({
      provider: "ollama",
      model: "llama3.1:8b",
      kind: "text",
      tokensIn: 10_000,
      tokensOut: 10_000,
    });
    expect(r).toEqual({ costUsd: 0, priced: true, source: "self-hosted" });
  });

  it("still lets an operator price a self-hosted gateway", () => {
    // vLLM behind a metered proxy is not free, and the override must win —
    // which is why the self-hosted default is checked LAST.
    setPriceOverrides({ "vllm:mixtral": { in: 0.0002, out: 0.0002 } });
    const p = resolvePrice({ provider: "vllm", model: "mixtral", kind: "text" });
    expect(p).toEqual({ in: 0.0002, out: 0.0002, source: "override" });
  });
});

describe("an unknown price is null, never zero", () => {
  it("returns null rather than a free-looking price", () => {
    expect(
      resolvePrice({ provider: "groq", model: "nobody-priced-this", kind: "text" }),
    ).toBeNull();
  });

  it("reports priced:false so the caller can mark the trace", () => {
    const r = priceCall({
      provider: "groq",
      model: "nobody-priced-this",
      kind: "text",
      tokensIn: 1_000_000,
      tokensOut: 1_000_000,
    });
    expect(r.priced).toBe(false);
    expect(r.costUsd).toBe(0);
    expect(r.source).toBeNull();
  });

  it("is wired into the trace record", () => {
    // Knowing is worthless if nothing writes it down.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const rec = require("node:fs").readFileSync(
      "src/utils/observability/recordGatewayUsage.server.ts",
      "utf8",
    ) as string;
    expect(rec).toContain("priceCall(");
    expect(rec).toContain("if (!priced.priced) requestPayload.pricing_missing = true;");
    // The RESOLVED provider, passed as a shorthand property. Matching merely
    // `provider` here let a mutation to `provider: undefined` through — which
    // is the whole bug this work exists to fix, reintroduced and undetected.
    expect(rec, "the provider is not passed to the pricer").toMatch(
      /priceCall\(\{\s*\n\s*provider,\s*\n/,
    );
    // …and the same value goes onto the trace row, so the recorded provider
    // and the priced provider can never disagree.
    expect(rec).toContain("llm_provider: provider,");
  });

  it("handles an empty or missing model id without inventing a price", () => {
    for (const model of ["", "   "]) {
      expect(resolvePrice({ provider: "openai", model, kind: "text" })).toBeNull();
    }
  });
});

describe("the arithmetic", () => {
  it("charges input and output at their own rates", () => {
    setPriceCatalog({ "openai:m": { in: 0.001, out: 0.01 } });
    const r = priceCall({
      provider: "openai",
      model: "m",
      kind: "text",
      tokensIn: 1000,
      tokensOut: 1000,
    });
    expect(r.costUsd).toBeCloseTo(0.011, 10);
  });

  it("bills images per image, not per token", () => {
    setPriceCatalog({ "gemini:img": { in: 0.04, out: 0 } });
    const r = priceCall({
      provider: "gemini",
      model: "img",
      kind: "image",
      tokensIn: 0,
      tokensOut: 0,
      imageCount: 3,
    });
    expect(r.costUsd).toBeCloseTo(0.12, 10);
  });

  it("treats a missing image count as one image", () => {
    setPriceCatalog({ "gemini:img": { in: 0.04, out: 0 } });
    expect(
      priceCall({ provider: "gemini", model: "img", kind: "image", tokensIn: 0, tokensOut: 0 })
        .costUsd,
    ).toBeCloseTo(0.04, 10);
  });

  it("never returns a negative cost from bad token counts", () => {
    setPriceCatalog({ "openai:m": { in: 0.001, out: 0.01 } });
    const r = priceCall({
      provider: "openai",
      model: "m",
      kind: "text",
      tokensIn: -500,
      tokensOut: -500,
    });
    expect(r.costUsd).toBe(0);
  });

  it("matches ids case-insensitively, since they arrive in both", () => {
    setPriceCatalog({ "openai:gpt-4o": { in: 0.0025, out: 0.01 } });
    expect(resolvePrice({ provider: "OpenAI", model: "GPT-4o", kind: "text" })?.in).toBe(0.0025);
  });
});
