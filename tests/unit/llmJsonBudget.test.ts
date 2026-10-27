// The BI JSON helper asks the monthly AI budget before it calls the provider.
//
// VA-2026-10-25-17. llmJsonServer is what /api/bi, the AI Analyst and embedded
// analysts call a model through. It now asks budgetRefusal() — with the call's
// cost scope, so an embed key's own cap counts — right after the model-access
// gate, and answers 402 without the provider ever being called.
import { beforeEach, describe, expect, it, vi } from "vitest";

const refusal = vi.hoisted(() => ({ text: null as string | null }));

vi.mock("@/utils/budgetGuard.server", () => ({
  budgetRefusal: vi.fn(async () => refusal.text),
}));
vi.mock("@/utils/providers/credentials.server", () => ({
  resolveOpenAICompatTransport: async () => ({
    endpointUrl: "https://openrouter.ai/api/v1/chat/completions",
    apiKey: "test-key",
  }),
  getProviderDefaultModel: async () => null,
}));
vi.mock("@/utils/iam.server", () => ({
  getEffectiveModelRules: async () => null,
  isModelAllowed: () => true,
}));
vi.mock("@/utils/ssrfGuard.server", () => ({
  providerFetch: vi.fn(
    async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: '{"answer":42}' } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  ),
}));
vi.mock("@/utils/observability/recordGatewayUsage.server", () => ({
  recordGatewayCall: vi.fn(async () => undefined),
  extractUsage: () => null,
}));
vi.mock("@/utils/observability/providerCost", () => ({ usageReportingBody: () => ({}) }));

import { budgetRefusal } from "@/utils/budgetGuard.server";
import { llmJsonServer } from "@/utils/bi/llmJson.server";
import { recordGatewayCall } from "@/utils/observability/recordGatewayUsage.server";
import { providerFetch } from "@/utils/ssrfGuard.server";

const call = () =>
  llmJsonServer({
    userId: "u1",
    iamClient: {} as never,
    userPrompt: "Plan a dashboard.",
    model: "google/gemini-2.5-flash",
    surface: "BI",
    costScope: { type: "embed_key", id: "k1" },
  });

beforeEach(() => {
  refusal.text = null;
  vi.mocked(budgetRefusal).mockClear();
  vi.mocked(providerFetch).mockClear();
  vi.mocked(recordGatewayCall).mockClear();
});

describe("llmJsonServer and the budget", () => {
  it("over the cap: 402 with the guard's sentence, and the provider is never called", async () => {
    refusal.text =
      "You have reached your monthly AI budget ($10.00). (spent $12.00 of $10.00 this month.)";
    expect(await call()).toEqual({ ok: false, status: 402, error: refusal.text });
    expect(providerFetch).not.toHaveBeenCalled();
    expect(recordGatewayCall).not.toHaveBeenCalled();
  });

  it("asks for the caller under the call's own cost scope", async () => {
    await call();
    expect(budgetRefusal).toHaveBeenCalledWith("u1", { type: "embed_key", id: "k1" });
  });

  it("within the cap, the call goes ahead", async () => {
    expect(await call()).toEqual({ ok: true, result: { answer: 42 } });
    expect(providerFetch).toHaveBeenCalledTimes(1);
  });
});
