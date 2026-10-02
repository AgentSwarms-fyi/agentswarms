// The AI gateway: an OpenAI-compatible endpoint in front of agents and
// models. What is pinned here is the grammar of the `model` field, the key
// format, the allow-list and fallback logic (each mutation-checked with a
// negative case), the SSE adaptation into OpenAI chunks, and the wiring that
// makes a gateway turn governed like any other: the chat route honouring a
// key's cost scope only on the internal channel, the migration extending
// spend attribution and budgets to gateway keys, and the docs.
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  GATEWAY_KEY_PREFIX,
  GATEWAY_KEY_SCOPES,
  fallbackCandidates,
  generateGatewayKey,
  gatewayKeyPrefix,
  hashGatewayKey,
  isRetryableFailure,
  looksLikeGatewayKey,
  messageText,
  modelAllowedByKey,
  modelMatches,
  openAiError,
  parseGatewayModel,
  splitConversation,
} from "@/utils/gateway/keys";

const REPO = path.resolve(__dirname, "../..");
const rd = (p: string) => readFileSync(path.join(REPO, p), "utf8");
const PROVIDERS = ["openrouter", "openai", "anthropic", "ollama"] as const;

describe("gateway keys", () => {
  it("are recognisable, hashed, and never stored whole", async () => {
    const k = generateGatewayKey();
    expect(k.startsWith(GATEWAY_KEY_PREFIX)).toBe(true);
    expect(k).toHaveLength(GATEWAY_KEY_PREFIX.length + 32);
    expect(looksLikeGatewayKey(k)).toBe(true);
    expect(looksLikeGatewayKey("mlk_" + k.slice(4))).toBe(false);
    expect(looksLikeGatewayKey("gw_short")).toBe(false);
    expect(gatewayKeyPrefix(k)).toBe(k.slice(0, 9));
    const h = await hashGatewayKey(k);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain(k.slice(4));
    expect(await hashGatewayKey(k)).toBe(h);
    expect([...GATEWAY_KEY_SCOPES]).toEqual(["agents", "models", "metrics"]);
  });
});

describe("the model field names an agent or a provider model, or nothing", () => {
  it("parses agent:<ref> and <provider>/<model>, and refuses the rest", () => {
    expect(parseGatewayModel("agent:Support triage", PROVIDERS)).toEqual({
      kind: "agent",
      ref: "Support triage",
    });
    expect(parseGatewayModel("AGENT:2316d0f3-b01f-4acf-8608-6efc12686b02", PROVIDERS)).toEqual({
      kind: "agent",
      ref: "2316d0f3-b01f-4acf-8608-6efc12686b02",
    });
    expect(parseGatewayModel("openrouter/openai/gpt-4o-mini", PROVIDERS)).toEqual({
      kind: "model",
      provider: "openrouter",
      model: "openai/gpt-4o-mini",
    });
    expect(parseGatewayModel("Anthropic/claude-sonnet-4", PROVIDERS)).toEqual({
      kind: "model",
      provider: "anthropic",
      model: "claude-sonnet-4",
    });
    // A bare model id would have to guess a provider; a typo'd provider must not run a default.
    expect(parseGatewayModel("gpt-4o-mini", PROVIDERS)).toBeNull();
    expect(parseGatewayModel("openia/gpt-4o-mini", PROVIDERS)).toBeNull();
    expect(parseGatewayModel("agent:", PROVIDERS)).toBeNull();
    expect(parseGatewayModel("openrouter/", PROVIDERS)).toBeNull();
    expect(parseGatewayModel(42, PROVIDERS)).toBeNull();
  });

  it("matches allow-list patterns with * and case-insensitively, and an empty list allows all", () => {
    expect(modelMatches("openrouter/*", "openrouter", "openai/gpt-4o-mini")).toBe(true);
    expect(modelMatches("anthropic/claude-*", "anthropic", "claude-sonnet-4")).toBe(true);
    expect(modelMatches("anthropic/claude-*", "openrouter", "anthropic/claude-sonnet-4")).toBe(
      false,
    );
    expect(modelMatches("OpenAI/GPT-4o", "openai", "gpt-4o")).toBe(true);
    expect(modelMatches("openai/gpt-4o", "openai", "gpt-4o-mini")).toBe(false);
    expect(modelMatches("openai/gpt.4o", "openai", "gptX4o")).toBe(false); // dots are literal
    expect(modelAllowedByKey([], "openai", "gpt-4o")).toBe(true);
    expect(modelAllowedByKey(["  "], "openai", "gpt-4o")).toBe(true);
    expect(modelAllowedByKey(["openrouter/*"], "openai", "gpt-4o")).toBe(false);
    expect(modelAllowedByKey(["openrouter/*", "openai/gpt-4o"], "openai", "gpt-4o")).toBe(true);
  });
});

describe("the fallback chain", () => {
  it("tries the key's chain, then the instance's, each entry once, never the primary, dropping typos", () => {
    const primary = { provider: "openrouter", model: "openai/gpt-4o" };
    const out = fallbackCandidates(
      primary,
      [
        ["openrouter/openai/gpt-4o-mini", "typo-provider/x", "OpenRouter/openai/gpt-4o", ""],
        ["openrouter/openai/gpt-4o-mini", "anthropic/claude-sonnet-4", "agent:not-a-model"],
      ],
      PROVIDERS,
    );
    expect(out).toEqual([
      { provider: "openrouter", model: "openai/gpt-4o-mini" },
      { provider: "anthropic", model: "claude-sonnet-4" },
    ]);
    expect(fallbackCandidates(primary, [[], []], PROVIDERS)).toEqual([]);
  });

  it("retries provider failures and never the caller's own mistakes", () => {
    for (const s of [402, 408, 425, 429, 500, 502, 503, 504])
      expect(isRetryableFailure(s)).toBe(true);
    for (const s of [400, 401, 403, 404, 409, 422, 499, 505])
      expect(isRetryableFailure(s)).toBe(false);
  });
});

describe("the OpenAI conversation shape", () => {
  it("flattens text parts, folds system and developer messages into the instruction, drops tool results", () => {
    expect(messageText("hi")).toBe("hi");
    expect(
      messageText([
        { type: "text", text: "a" },
        { type: "image_url" },
        { type: "text", text: "b" },
      ]),
    ).toBe("a\nb");
    expect(messageText(null)).toBe("");
    const { system, turns } = splitConversation([
      { role: "system", content: "Be brief." },
      { role: "developer", content: [{ type: "text", text: "Answer in French." }] },
      { role: "user", content: "Hello" },
      { role: "tool", content: "ignored" },
      { role: "assistant", content: "Bonjour" },
      { role: "user", content: [{ type: "text", text: "How are you?" }] },
    ]);
    expect(system).toBe("Be brief.\n\nAnswer in French.");
    expect(turns).toEqual([
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Bonjour" },
      { role: "user", content: "How are you?" },
    ]);
  });

  it("errors carry the type OpenAI clients switch on", () => {
    expect(openAiError("no", "invalid_api_key")).toEqual({
      error: { message: "no", type: "authentication_error", code: "invalid_api_key", param: null },
    });
    expect(openAiError("x", "insufficient_quota").error.type).toBe("insufficient_quota");
    expect(openAiError("x", "rate_limit_exceeded").error.type).toBe("rate_limit_error");
    expect(openAiError("x", "model_not_found", "model").error.param).toBe("model");
  });
});

describe("the platform's stream becomes OpenAI chunks", () => {
  const upstream = (frames: string) =>
    new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(frames));
        c.close();
      },
    });
  const FRAMES = [
    "event: citations",
    'data: {"citations":[{"index":1,"documentName":"policy.pdf"}]}',
    "",
    'data: {"choices":[{"delta":{"content":"Hel"}}]}',
    "",
    ": keep-alive",
    'data: {"choices":[{"delta":{"content":"lo"}}]}',
    "",
    "event: tool",
    'data: {"name":"kb_search","status":"ok"}',
    "",
    "event: cost",
    'data: {"model":"openai/gpt-4o-mini","costUsd":0.0001,"tokensIn":12,"tokensOut":3}',
    "",
    "data: [DONE]",
    "",
  ].join("\n");

  it("streams deltas with the role on the first, then a stop chunk with usage and the extras, then [DONE]", async () => {
    const { adaptUpstreamSse } = await import("@/utils/gateway/api.server");
    let summary: { text: string } | null = null;
    const out = adaptUpstreamSse(
      upstream(FRAMES),
      {
        id: "chatcmpl-1",
        model: "agent:x",
        created: 1,
        includeUsage: true,
        traceId: "t1",
        fallbackFrom: null,
      },
      (s) => {
        summary = s;
      },
    );
    const text = await new Response(out).text();
    const chunks = text
      .split("\n\n")
      .filter((l) => l.startsWith("data: ") && !l.includes("[DONE]"))
      .map((l) => JSON.parse(l.slice(6)));
    expect(chunks).toHaveLength(3);
    expect(chunks[0].object).toBe("chat.completion.chunk");
    expect(chunks[0].choices[0].delta).toEqual({ role: "assistant", content: "Hel" });
    expect(chunks[1].choices[0].delta).toEqual({ content: "lo" });
    expect(chunks[1].choices[0].finish_reason).toBeNull();
    expect(chunks[2].choices[0].finish_reason).toBe("stop");
    expect(chunks[2].usage).toEqual({ prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 });
    expect(chunks[2].agentswarms.trace_id).toBe("t1");
    expect(chunks[2].agentswarms.citations[0].documentName).toBe("policy.pdf");
    expect(chunks[2].agentswarms.tools[0].name).toBe("kb_search");
    expect(chunks[2].agentswarms.cost_usd).toBe(0.0001);
    expect(text.trim().endsWith("data: [DONE]")).toBe(true);
    expect(summary).not.toBeNull();
    expect((summary as unknown as { text: string }).text).toBe("Hello");
  });

  it("collects the same stream into one chat.completion", async () => {
    const { collectUpstreamSse } = await import("@/utils/gateway/api.server");
    const { body, text } = await collectUpstreamSse(upstream(FRAMES), {
      id: "chatcmpl-2",
      model: "openrouter/openai/gpt-4o-mini",
      created: 1,
      includeUsage: true,
      traceId: null,
      fallbackFrom: "openrouter/openai/gpt-4o",
    });
    expect(text).toBe("Hello");
    expect(body.object).toBe("chat.completion");
    expect((body.choices as { message: { content: string } }[])[0].message.content).toBe("Hello");
    expect(body.usage).toEqual({ prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 });
    expect((body.agentswarms as { fallback_from: string }).fallback_from).toBe(
      "openrouter/openai/gpt-4o",
    );
    expect(rd("src/utils/gateway/api.server.ts")).toContain("model: served,");
  });

  it("an agent turn carries the agent's prompt, tools and knowledge; a bare model carries no tools", async () => {
    const { buildInternalChatBody } = await import("@/utils/gateway/api.server");
    const agent = {
      id: "a1",
      name: "Support",
      system_prompt: "You help.",
      llm_provider: "openrouter",
      llm_model: "openai/gpt-4o-mini",
      temperature: 0.2,
      max_tokens: 2048,
      knowledge_base_id: "kb1",
      tools: { builtInTools: { kb_search: true, web_search: true } },
      is_active: true,
    };
    const msgs = [
      { role: "system" as const, content: "Answer in French." },
      { role: "user" as const, content: "Hi" },
    ];
    const a = buildInternalChatBody({
      ownerId: "u1",
      costScope: { type: "gateway_key", id: "k1" },
      target: { kind: "agent", agent },
      candidate: { provider: "anthropic", model: "claude-sonnet-4" },
      messages: msgs,
    });
    expect(a.internalUserId).toBe("u1");
    expect(a.costScope).toEqual({ type: "gateway_key", id: "k1" });
    expect(a.agentId).toBe("a1");
    expect(a.agentName).toBe("Support");
    expect(a.provider).toBe("anthropic"); // the candidate, not the agent's own, so a fallback changes only the model
    expect(a.systemPrompt).toBe("You help.\n\nAnswer in French.");
    expect(a.temperature).toBe(0.2);
    expect(a.maxTokens).toBe(2048);
    expect(a.knowledgeBaseIds).toEqual(["kb1"]);
    expect(a.enabledTools).toEqual(expect.arrayContaining(["kb_search", "web_search"]));
    // Found live: the swarm-node mapping has no ML tools, so an agent whose
    // whole point is ml_predict answered with nothing. The gateway maps the
    // agent's toggles the way agent chat does.
    const ml = buildInternalChatBody({
      ownerId: "u1",
      costScope: { type: "gateway_key", id: "k1" },
      target: {
        kind: "agent",
        agent: { ...agent, tools: { builtInTools: { ml_predict: true, metric_query: true } } },
      },
      candidate: { provider: "openrouter", model: "x" },
      messages: msgs,
    });
    expect(ml.enabledTools).toEqual(["metric_query", "ml_predict"]);
    expect(a.messages).toEqual([{ role: "user", content: "Hi" }]);
    expect(a.memoryOverrides).toEqual({
      stm_enabled: false,
      ltm_enabled: false,
      ltm_scope: "none",
    });
    const m = buildInternalChatBody({
      ownerId: "u1",
      costScope: { type: "gateway_key", id: "k1" },
      target: { kind: "model", provider: "openai", model: "gpt-4o" },
      candidate: { provider: "openai", model: "gpt-4o" },
      messages: msgs,
      temperature: 0.9,
    });
    expect(m.enabledTools).toEqual([]);
    // A channel turn passes no scope, and the body then carries none at all
    // rather than a null the chat route would have to interpret.
    const channel = buildInternalChatBody({
      ownerId: "u1",
      target: { kind: "agent", agent },
      candidate: { provider: "openrouter", model: "x" },
      messages: [{ role: "user" as const, content: "Hi" }],
    });
    expect("costScope" in channel).toBe(false);
    expect(m.agentId).toBeUndefined();
    expect(m.systemPrompt).toBe("Answer in French.");
    expect(m.temperature).toBe(0.9);
  });
});

describe("a gateway turn is governed like any other", () => {
  it("the chat route honours a key's cost scope and agent name only on the internal channel, and writes the scope to the trace", () => {
    const chat = rd("src/routes/api/chat.ts");
    expect(chat).toContain('costScope?: { type: "gateway_key"; id: string };');
    expect(chat).toContain("agentName?: string;");
    expect(chat).toContain('isInternalRun && typeof body.agentName === "string"');
    expect(chat.replace(/\s+/g, " ")).toContain(
      'isInternalRun && body.costScope?.type === "gateway_key" && typeof body.costScope.id === "string" ? { type: "gateway_key", id: body.costScope.id } : undefined',
    );
    expect(chat).toContain("cost_scope_type: trace.costScope?.type ?? null,");
    expect(chat).toContain("cost_scope_id: trace.costScope?.id ?? null,");
  });

  it("spend attribution and budgets know the gateway key, and the table is audited by trigger", () => {
    const sql = rd("supabase/migrations/20260861000000_ai_gateway.sql");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS public.gateway_keys");
    expect(sql).toContain(
      "CHECK (scopes <@ ARRAY['agents', 'models']::text[] AND cardinality(scopes) >= 1)",
    );
    expect(sql).toContain("EXECUTE FUNCTION public.audit_row_change('gateway_key')");
    expect(sql).toContain(
      "CHECK (cost_scope_type IS NULL OR cost_scope_type IN ('embed_key', 'swarm_api_key', 'gateway_key'))",
    );
    expect(sql).toContain(
      "CHECK (scope_type IN ('group', 'embed_key', 'swarm_api_key', 'gateway_key'))",
    );
    expect((sql.match(/scope_type = 'gateway_key'/g) ?? []).length).toBe(3); // read, write USING, write WITH CHECK
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS gateway_rate_limit_per_min integer");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS gateway_fallback_models text[]");
    // Found live: the trace insert was refused because the original constraint
    // is named _valid, not _check. The corrective migration owns that name.
    const fix = rd("supabase/migrations/20260862000000_ai_gateway_trace_scope.sql");
    expect(fix).toContain("DROP CONSTRAINT IF EXISTS execution_traces_cost_scope_type_valid;");
    expect(fix).toContain("DROP CONSTRAINT IF EXISTS execution_traces_cost_scope_type_check;");
    expect(fix).toContain("ADD CONSTRAINT execution_traces_cost_scope_type_valid");
    expect(fix).toContain("IN ('embed_key', 'swarm_api_key', 'gateway_key')");
    // Found on the audit page: every call produced a gateway_key.update row,
    // because the trigger audited the usage-counter touch. Changes, not use.
    const quiet = rd("supabase/migrations/20260863000000_key_audit_changes_not_usage.sql");
    expect(quiet).toContain("AFTER INSERT OR DELETE OR UPDATE OF");
    expect(quiet.replace(/\s+/g, " ")).toContain(
      "is_active, expires_at, revoked_at ON public.gateway_keys",
    );
    expect(quiet).not.toMatch(/UPDATE OF[^;]*use_count/);
    expect(quiet).toContain("ON public.ml_api_keys");
    for (const f of [
      "src/utils/budgetGuard.server.ts",
      "src/utils/observability/recordGatewayUsage.server.ts",
    ]) {
      expect(rd(f), f).toContain('"embed_key" | "swarm_api_key" | "gateway_key"');
    }
  });

  it("the routes exist, authenticate first, and answer in the OpenAI error shape", () => {
    for (const f of ["src/routes/api/v1.chat.completions.ts", "src/routes/api/v1.models.ts"]) {
      expect(existsSync(path.join(REPO, f)), f).toBe(true);
      const src = rd(f);
      expect(src).toContain("await authenticateGatewayKey(request)");
      expect(src).toContain("gatewayFail(auth.status, auth.code, auth.error)");
    }
    expect(rd("src/routes/api/v1.chat.completions.ts")).toContain(
      'createFileRoute("/api/v1/chat/completions")',
    );
    const api = rd("src/utils/gateway/api.server.ts");
    expect(api).toContain('action: "gateway.access.denied"');
    expect(api).toContain('action: "gateway.fallback"');
    expect(api).toContain('action: "gateway.chat"');
    expect(api).toContain("x-internal-run-secret");
    expect(api).toContain('.eq("user_id", key.user_id)'); // agents resolved among the OWNER's only
  });

  it("the instance defaults are settings first, env second, then a default", () => {
    const cfg = rd("src/utils/notebookRuntime/config.server.ts");
    expect(cfg).toContain("gatewayRateLimitPerMin:");
    expect(cfg).toContain('envInt("AI_GATEWAY_RATE_LIMIT_PER_MIN")');
    expect(cfg).toContain("process.env.AI_GATEWAY_FALLBACK_MODELS");
    const admin = rd("src/utils/notebookRuntimeAdmin.functions.ts");
    expect(admin).toContain(
      "gateway_fallback_models: z.array(z.string().min(1).max(160)).max(10).optional()",
    );
    expect(rd("src/components/admin/RuntimeTab.tsx")).toContain(
      'set("gateway_rate_limit_per_min", n)',
    );
  });

  it("the docs, the README and the env example say the same thing", () => {
    for (const f of ["docs/AI_GATEWAY.md", "src/routes/docs.gateway.tsx"]) {
      const doc = rd(f).replace(/\s+/g, " ");
      expect(doc, f).toContain("/chat/completions");
      expect(doc, f).toContain("agent:<name or id>");
      expect(doc, f).toContain("gateway.fallback");
      expect(doc, f).toContain("insufficient_quota");
      expect(doc, f).toContain("AI_GATEWAY_FALLBACK_MODELS");
    }
    expect(rd("README.md")).toContain("OpenAI-compatible endpoint");
    expect(rd("README.md")).toContain("./docs/AI_GATEWAY.md");
    expect(rd(".env.example")).toContain("AI_GATEWAY_RATE_LIMIT_PER_MIN=");
    expect(rd("docs/SCALE_AND_LIMITS.md")).toContain("`AI_GATEWAY_FALLBACK_MODELS`");
    expect(rd("src/components/docs/DocsShell.tsx")).toContain('to: "/docs/gateway"');
  });
});
