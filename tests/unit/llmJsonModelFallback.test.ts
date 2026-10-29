// The JSON model call (BI, Ask over an ontology, the analyst, generators)
// runs on the caller's model when it can, and on the instance default when it
// can't — including when the provider answers that it does not know the
// model, which no availability check can see in advance. That failure gets
// one more try, on the default, and the trace says it fell back and from what.
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  answers: [] as { status: number; body: unknown }[],
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: { default_model: "openrouter/anthropic/claude-sonnet-4" },
            error: null,
          }),
        }),
      }),
    }),
  },
}));
vi.mock("@/utils/budgetGuard.server", () => ({ budgetRefusal: async () => null }));
vi.mock("@/utils/providers/credentials.server", () => ({
  resolveOpenAICompatTransport: async () => ({
    endpointUrl: "https://openrouter.ai/api/v1/chat/completions",
    apiKey: "test-key",
  }),
  loadCredentialRowShared: async () => null,
}));
vi.mock("@/utils/iam.server", () => ({
  getEffectiveModelRules: async () => null,
  isModelAllowed: () => true,
}));
vi.mock("@/utils/ssrfGuard.server", () => ({
  providerFetch: vi.fn(async () => {
    const a = state.answers.shift() ?? {
      status: 200,
      body: { choices: [{ message: { content: '{"answer":42}' } }] },
    };
    return new Response(JSON.stringify(a.body), {
      status: a.status,
      headers: { "content-type": "application/json" },
    });
  }),
}));
vi.mock("@/utils/observability/recordGatewayUsage.server", () => ({
  recordGatewayCall: vi.fn(async () => undefined),
  extractUsage: () => null,
}));
vi.mock("@/utils/observability/providerCost", () => ({ usageReportingBody: () => ({}) }));

import { llmJsonServer } from "@/utils/bi/llmJson.server";
import { recordGatewayCall } from "@/utils/observability/recordGatewayUsage.server";
import { forgetDefaultModel } from "@/utils/providers/defaultModel.server";
import { providerFetch } from "@/utils/ssrfGuard.server";

const call = (model?: string) =>
  llmJsonServer({
    userId: "u1",
    iamClient: {} as never,
    userPrompt: "Plan a dashboard.",
    ...(model ? { model } : {}),
    surface: "BI",
  });

const sentModels = () =>
  vi
    .mocked(providerFetch)
    .mock.calls.map((c) => JSON.parse(String((c[1] as RequestInit).body)).model as string);

beforeEach(() => {
  state.answers = [];
  forgetDefaultModel();
  vi.mocked(providerFetch).mockClear();
  vi.mocked(recordGatewayCall).mockClear();
});

describe("the JSON model call", () => {
  it("runs on the caller's model when it can", async () => {
    const res = await call("openai/gpt-5");
    expect(res).toMatchObject({ ok: true, model: "openai/gpt-5" });
    expect(res.ok && res.fellBack).toBeUndefined();
    expect(sentModels()).toEqual(["openai/gpt-5"]);
  });

  it("runs on the instance default when the caller names none", async () => {
    const res = await call();
    expect(res).toMatchObject({ ok: true, model: "anthropic/claude-sonnet-4" });
    expect(sentModels()).toEqual(["anthropic/claude-sonnet-4"]);
  });

  it("retries once on the default when the provider does not know the model", async () => {
    state.answers = [
      { status: 404, body: { error: { message: "No endpoints found for openai/gpt-9." } } },
    ];
    const res = await call("openai/gpt-9");
    expect(sentModels()).toEqual(["openai/gpt-9", "anthropic/claude-sonnet-4"]);
    expect(res).toMatchObject({
      ok: true,
      result: { answer: 42 },
      model: "anthropic/claude-sonnet-4",
      fellBack: { from: "openrouter/openai/gpt-9", reason: expect.stringMatching(/does not know/) },
    });
    // The answering call's trace says it fell back, and from what.
    const traces = vi.mocked(recordGatewayCall).mock.calls.map((c) => c[0]);
    expect(traces.at(-1)).toMatchObject({
      status: "success",
      modelFallback: { from: "openrouter/openai/gpt-9" },
    });
  });

  it("does not retry other failures, or a default the provider does not know", async () => {
    state.answers = [{ status: 429, body: { error: { message: "rate limited" } } }];
    expect(await call("openai/gpt-5")).toMatchObject({ ok: false, status: 429 });
    expect(sentModels()).toEqual(["openai/gpt-5"]);

    vi.mocked(providerFetch).mockClear();
    state.answers = [
      {
        status: 404,
        body: { error: { message: "No endpoints found for anthropic/claude-sonnet-4." } },
      },
    ];
    expect(await call()).toMatchObject({ ok: false });
    expect(sentModels()).toEqual(["anthropic/claude-sonnet-4"]);
  });
});
