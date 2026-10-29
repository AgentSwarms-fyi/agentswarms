// Which model a call runs on (providers/defaultModel.server).
//
// The rule, as the platform's owner put it: the default model is set in the
// admin settings, not in .env. A model chosen in a section (chat, swarm, BI,
// ontology, anywhere) overrides it; when nothing is chosen, or the chosen
// model is not available, the call falls back to the default.
//
// "Not available" is decided per person: an unknown provider, a provider not
// connected for them (no key of their own, none shared, no instance key), or
// their IAM model rules. The default is held to the same test — one that
// can't run for this person is an error that says why, never a silent third
// model.
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = {
  adminDefault: null as string | null,
  readFails: false,
  rules: null as { provider: string; model_pattern: string }[] | null,
  connected: new Set<string>(["openrouter"]),
};

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () =>
            state.readFails
              ? { data: null, error: { message: 'column "default_model" does not exist' } }
              : { data: { default_model: state.adminDefault }, error: null },
        }),
      }),
    }),
  },
}));
vi.mock("@/utils/iam.server", () => ({
  getEffectiveModelRules: async () => state.rules,
}));
vi.mock("@/utils/providers/credentials.server", () => ({
  resolveOpenAICompatTransport: async ({ provider }: { provider: string }) =>
    state.connected.has(provider)
      ? { endpointUrl: `https://${provider}.test/v1/chat/completions`, apiKey: "k" }
      : null,
  loadCredentialRowShared: async () => null,
}));

const m = await import("@/utils/providers/defaultModel.server");

beforeEach(() => {
  state.adminDefault = "openrouter/anthropic/claude-sonnet-4";
  state.readFails = false;
  state.rules = null;
  state.connected = new Set(["openrouter"]);
  m.forgetDefaultModel();
});

describe("the default", () => {
  it("is the administrator's, read from the settings — not from the environment", async () => {
    vi.stubEnv("OPENROUTER_DEFAULT_MODEL", "openai/gpt-4o-mini");
    const d = await m.instanceDefaultModel();
    expect(d).toMatchObject({
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4",
      source: "admin",
    });
    vi.unstubAllEnvs();
  });

  it("is the built-in one until an administrator sets it", async () => {
    state.adminDefault = null;
    expect(await m.instanceDefaultModel()).toMatchObject({
      spec: m.BUILTIN_DEFAULT_MODEL,
      source: "built-in",
    });
  });

  it("is the built-in one on a database without the column yet, rather than an error", async () => {
    state.readFails = true;
    expect((await m.instanceDefaultModel()).source).toBe("built-in");
  });
});

describe("a section's own model comes first", () => {
  it("runs on it when this person can use it", async () => {
    const c = await m.chooseModel("u1", { provider: "openrouter", model: "openai/gpt-5" });
    expect(c).toMatchObject({
      ok: true,
      spec: "openrouter/openai/gpt-5",
      source: "requested",
      fellBack: null,
    });
  });

  it("reads a model with no provider as an OpenRouter id, as it always was", async () => {
    // "openai/gpt-4o-mini" is OpenRouter's name for it, not the OpenAI provider.
    const c = await m.chooseModel("u1", { model: "openai/gpt-4o-mini" });
    expect(c).toMatchObject({ ok: true, provider: "openrouter", model: "openai/gpt-4o-mini" });
  });
});

describe("no choice, or one that can't run, falls back to the default", () => {
  it("nothing chosen", async () => {
    const c = await m.chooseModel("u1", null);
    expect(c).toMatchObject({
      ok: true,
      spec: "openrouter/anthropic/claude-sonnet-4",
      source: "default",
      fellBack: null,
    });
  });

  it("a provider named without a model is no choice", async () => {
    const c = await m.chooseModel("u1", { provider: "openrouter", model: "" });
    expect(c).toMatchObject({ ok: true, source: "default", fellBack: null });
  });

  it("a provider not connected for this person", async () => {
    const c = await m.chooseModel("u1", { provider: "anthropic", model: "claude-opus-4" });
    expect(c).toMatchObject({ ok: true, source: "default" });
    expect(c.ok && c.fellBack).toEqual({
      from: "anthropic/claude-opus-4",
      reason: expect.stringMatching(/anthropic is not connected/),
    });
  });

  it("a model this person's IAM rules don't allow", async () => {
    state.rules = [{ provider: "openrouter", model_pattern: "anthropic/*" }];
    const c = await m.chooseModel("u1", { provider: "openrouter", model: "openai/gpt-5" });
    expect(c).toMatchObject({ ok: true, spec: "openrouter/anthropic/claude-sonnet-4" });
    expect(c.ok && c.fellBack?.reason).toMatch(/not allowed for this account/);
  });

  it("a provider that doesn't exist", async () => {
    const c = await m.chooseModel("u1", { provider: "nosuch", model: "x" });
    expect(c).toMatchObject({ ok: true, source: "default" });
    expect(c.ok && c.fellBack?.reason).toMatch(/is not a provider/);
  });
});

describe("a default that can't run either is an error that says why and where", () => {
  it("names the choice, the default, both reasons and the admin page", async () => {
    state.connected = new Set();
    const c = await m.chooseModel("u1", { provider: "openai", model: "gpt-5" });
    expect(c.ok).toBe(false);
    if (c.ok) return;
    expect(c.status).toBe(400);
    expect(c.error).toMatch(/^openai\/gpt-5 can't be used: openai is not connected/);
    expect(c.error).toMatch(
      /The default model, openrouter\/anthropic\/claude-sonnet-4, can't be used either/,
    );
    expect(c.error).toMatch(/Admin → Developer runtime → AI services → Default model/);
  });

  it("answers 403 when the default is what the rules forbid", async () => {
    state.rules = [{ provider: "openrouter", model_pattern: "openai/*" }];
    const c = await m.chooseModel("u1", null);
    expect(c).toMatchObject({ ok: false, status: 403 });
  });
});

describe("a model the provider does not know", () => {
  it("is recognised from the provider's answer, so the call can retry on the default", () => {
    for (const [status, text] of [
      [404, '{"error":{"message":"No endpoints found for openai/gpt-9."}}'],
      [400, '{"error":{"message":"openai/gpt-9 is not a valid model ID"}}'],
      [404, '{"error":{"code":"model_not_found","message":"The model `gpt-9` does not exist"}}'],
      [400, "Invalid model: claude-9"],
    ] as const)
      expect(m.isUnknownModelError(status, text), text).toBe(true);
  });

  it("is not confused with other failures", () => {
    expect(m.isUnknownModelError(429, "model is rate limited")).toBe(false);
    expect(m.isUnknownModelError(500, "model not found")).toBe(false);
    expect(m.isUnknownModelError(400, "messages must not be empty")).toBe(false);
  });
});

describe("a spec", () => {
  it("is provider/model, with the provider one the platform knows", () => {
    expect(m.parseModelSpec("openrouter/google/gemini-2.5-flash")).toEqual({
      provider: "openrouter",
      model: "google/gemini-2.5-flash",
    });
    expect(m.parseModelSpec("anthropic/claude-sonnet-4")).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4",
    });
    expect(m.parseModelSpec("gemini")).toBeNull();
    expect(m.parseModelSpec("nosuch/model")).toBeNull();
    expect(m.parseModelSpec(null)).toBeNull();
  });
});

describe("a fallback an internal caller already made", () => {
  // AI in SQL, document reading and the Sheets assistant resolve their model
  // before calling /api/chat; the chat route then sees only the default, so
  // they hand over what they fell back from for the trace.
  it("is read from the request body when it has the shape, capped", () => {
    expect(
      m.fallbackFromCaller({ from: "openrouter/openai/gpt-9", reason: "not connected" }),
    ).toEqual({
      from: "openrouter/openai/gpt-9",
      reason: "not connected",
    });
    const long = m.fallbackFromCaller({ from: "x".repeat(900), reason: "y".repeat(900) });
    expect([long?.from.length, long?.reason.length]).toEqual([200, 500]);
  });

  it("is nothing otherwise", () => {
    for (const v of [
      null,
      undefined,
      "gpt-9",
      { from: "", reason: "r" },
      { from: "a" },
      { from: 1, reason: "r" },
    ])
      expect(m.fallbackFromCaller(v)).toBeNull();
  });

  it("is honoured from internal callers only, and each one passes it on", () => {
    const chat = readFileSync("src/routes/api/chat.ts", "utf8");
    expect(chat).toContain(
      "chosen.fellBack ?? (isInternalRun ? fallbackFromCaller(body.modelFallback) : null)",
    );
    expect(readFileSync("src/utils/internalChat.server.ts", "utf8")).toContain(
      "...(args.modelFallback ? { modelFallback: args.modelFallback } : {})",
    );
    const sql = readFileSync("src/utils/aiSql/run.server.ts", "utf8");
    expect(sql).toMatch(
      /modelFallback:\s*eff\.fellBack \?\? \(miss\.model === session\.defaultModel \? session\.defaultFallback : null\)/,
    );
    expect(readFileSync("src/utils/documents/vision.server.ts", "utf8")).toContain(
      "modelFallback: fellBack,",
    );
    expect(
      readFileSync("src/utils/sheetsAssist.functions.ts", "utf8").match(
        /modelFallback: m\.fellBack,/g,
      ),
    ).toHaveLength(2);
  });
});
