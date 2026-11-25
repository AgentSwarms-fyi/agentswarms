// A call the provider refused cost nothing, and its trace must say so.
//
// With OpenAI credits exhausted, a chat turn failed with "OpenAI error [429]:
// insufficient_quota", yet its execution_traces row read 15 tokens in and
// $0.000037: the chars/4 estimate of a prompt nobody ran, priced from the
// table. budget_spend() adds up cost_usd from every row, errors included, so
// that was spend toward the user's cap that the provider never charged. The
// swarm step for the same call read 0 tokens and $0.00.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { traceUsage, type TraceUsageInput } from "@/utils/observability/traceUsage";
import { approxTokens, estimateImageCost } from "@/utils/observability/pricing";
import { priceCall } from "@/utils/observability/priceResolver";

const PROMPT = "One line about Isaac Newton. Please keep it short."; // ~13 tokens
const base: TraceUsageInput = {
  provider: "openai",
  model: "gpt-4o",
  isImage: false,
  promptTokensApprox: approxTokens(PROMPT),
  assistantText: "",
};
const tablePrice = (tokensIn: number, tokensOut: number, model = "gpt-4o") =>
  priceCall({ provider: "openai", model, kind: "text", tokensIn, tokensOut }).costUsd;

describe("a turn the provider refused", () => {
  it("records zero tokens and zero cost, not an estimate of the prompt", () => {
    const refused = traceUsage({ ...base, notBilled: true });
    expect(refused).toEqual({
      tokensIn: 0,
      tokensOut: 0,
      tokensEstimated: false,
      providerCost: null,
      costUsd: 0,
    });
  });

  it("is exactly the case that used to be charged", () => {
    // The same turn without the flag: what the row recorded before the fix.
    const before = traceUsage(base);
    expect(before.tokensIn).toBe(base.promptTokensApprox);
    expect(before.tokensIn).toBeGreaterThan(0);
    expect(before.costUsd).toBeGreaterThan(0);
    expect(before.costUsd).toBe(tablePrice(before.tokensIn, 0));
  });

  it("an image call the gateway refused costs nothing either", () => {
    const img = { ...base, model: "dall-e-3", isImage: true };
    expect(traceUsage(img).costUsd).toBe(estimateImageCost("dall-e-3", 1));
    expect(traceUsage({ ...img, notBilled: true }).costUsd).toBe(0);
  });
});

describe("every turn that was billed records what it did before", () => {
  it("no usage reported: the chars/4 estimate, priced from the table, marked estimated", () => {
    const answer = "Isaac Newton described gravity and the laws of motion.";
    const u = traceUsage({ ...base, assistantText: answer });
    expect(u.tokensIn).toBe(base.promptTokensApprox);
    expect(u.tokensOut).toBe(approxTokens(answer));
    expect(u.tokensEstimated).toBe(true);
    expect(u.providerCost).toBeNull();
    expect(u.costUsd).toBe(tablePrice(u.tokensIn, u.tokensOut));
  });

  it("usage reported: the provider's figures, not marked estimated", () => {
    const u = traceUsage({
      ...base,
      assistantText: "x",
      upstreamTokensIn: 120,
      upstreamTokensOut: 40,
    });
    expect([u.tokensIn, u.tokensOut, u.tokensEstimated]).toEqual([120, 40, false]);
    expect(u.costUsd).toBe(tablePrice(120, 40));
  });

  it("a provider-reported cost wins, including a measured zero", () => {
    const paid = traceUsage({
      ...base,
      upstreamTokensIn: 10,
      upstreamTokensOut: 5,
      upstreamCostUsd: 0.0123,
    });
    expect([paid.providerCost, paid.costUsd]).toEqual([0.0123, 0.0123]);
    const free = traceUsage({
      ...base,
      upstreamTokensIn: 10,
      upstreamTokensOut: 5,
      upstreamCostUsd: 0,
    });
    expect([free.providerCost, free.costUsd]).toEqual([0, 0]);
  });

  it("a replayed final answer stays zero (its tool round's row is billed)", () => {
    const u = traceUsage({
      ...base,
      assistantText: "answer",
      replayedFinal: true,
      upstreamCostUsd: 0.5,
    });
    expect(u).toEqual({
      tokensIn: 0,
      tokensOut: 0,
      tokensEstimated: false,
      providerCost: null,
      costUsd: 0,
    });
  });
});

describe("the chat route uses the rule, and says which failures were not billed", () => {
  const CHAT = readFileSync("src/routes/api/chat.ts", "utf8");
  const recordTrace = CHAT.slice(
    CHAT.indexOf("async function recordTrace("),
    CHAT.indexOf("const latencyMs = Date.now() - trace.startedAt;"),
  );

  it("recordTrace takes its tokens and cost from traceUsage, passing notBilled through", () => {
    expect(recordTrace).toContain("notBilled?: boolean;");
    expect(recordTrace).toMatch(/= traceUsage\(\{[\s\S]*notBilled: opts\.notBilled,[\s\S]*\}\);/);
    // The old inline formula is gone, so there is one rule, not two.
    expect(recordTrace).not.toContain("trace.promptTokensApprox)");
  });

  it("a provider error before any answer is recorded as not billed", () => {
    const providerCatch = CHAT.slice(
      CHAT.indexOf('const message = err instanceof Error ? err.message : "Provider error";'),
    );
    expect(providerCatch.slice(0, 900)).toMatch(
      /await recordTrace\(\{\s*trace,\s*status: "error",\s*errorMessage: message,\s*assistantText: "",\s*notBilled: true,\s*\}\);/,
    );
  });

  it("an input guardrail's refusal, before any model call, is recorded as not billed", () => {
    expect(CHAT).toMatch(
      /errorMessage: `Guardrail: \$\{decision\.reason\}`,\s*assistantText: "",[\s\S]{0,120}notBilled: true,/,
    );
  });

  it("an upstream that answered but sent nothing is NOT marked: it may have billed", () => {
    expect(CHAT).toContain(
      'void recordTrace({ trace, status: "error", errorMessage: "Empty upstream", assistantText: "" });',
    );
  });

  it("a not-billed row says so, and is never flagged as a pricing gap to reprice", () => {
    expect(CHAT).toContain("if (opts.notBilled) safePayload.not_billed = true;");
    expect(CHAT).toMatch(
      /!opts\.replayedFinal &&\s*!opts\.notBilled &&\s*!isImg &&\s*costUnpriced\(/,
    );
  });
});
