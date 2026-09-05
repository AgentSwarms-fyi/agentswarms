// The AI gateway's server side: authenticate a gateway key, resolve what the
// `model` field names, run the turn through the platform's own chat route
// (so IAM model rules, guardrails, tools, knowledge, traces and audit all
// apply exactly as they do everywhere else), fall back down the key's chain
// when a provider fails, and answer in the OpenAI shape the caller expects.
//
// Nothing here calls a model provider directly. The one chokepoint for that
// is /api/chat's internal channel - the same one deployed swarms, schedules
// and evals use - reached with the internal run secret and the key owner's
// id, so a gateway turn is governed as that owner, never as the caller.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { auditEvent } from "@/utils/audit.server";
import { budgetMessage, getBudgetDecision } from "@/utils/budgetGuard.server";
import { agentToNodePatch } from "@/lib/agentToSwarmNode";
import { builtInTogglesOf, enabledToolsFromToggles } from "@/utils/tools/agentToggles";
import { internalRunSecret, resolveInternalOrigin } from "@/utils/internalOrigin.server";
import { getPlatformResources } from "@/utils/notebookRuntime/config.server";
import { rateLimitedGlobal } from "@/utils/rateLimit.server";
import { clientIp, clientUserAgent } from "@/utils/requestMeta.server";
import type { ProviderId } from "@/utils/providers/types";
import {
  fallbackCandidates,
  hashGatewayKey,
  isRetryableFailure,
  looksLikeGatewayKey,
  modelAllowedByKey,
  openAiError,
  parseGatewayModel,
  splitConversation,
  type GatewayKeyScope,
  type GatewayTarget,
  type OpenAiErrorCode,
  type OpenAiMessage,
} from "@/utils/gateway/keys";

/** Every provider id the platform knows; pinned to the type so a new provider cannot be forgotten here. */
export const GATEWAY_PROVIDERS = [
  "bedrock",
  "vertex",
  "anthropic",
  "azure_openai",
  "oci_genai",
  "qwen",
  "grok",
  "openai",
  "gemini",
  "ollama",
  "openrouter",
  "groq",
  "vllm",
  "nvidia",
] as const satisfies readonly ProviderId[];
type _Exhaustive =
  Exclude<ProviderId, (typeof GATEWAY_PROVIDERS)[number]> extends never ? true : never;
const _exhaustive: _Exhaustive = true;
void _exhaustive;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type GatewayKeyRow = {
  id: string;
  user_id: string;
  name: string;
  scopes: GatewayKeyScope[];
  agent_ids: string[];
  model_allow: string[];
  fallback_models: string[];
  rate_limit_per_min: number | null;
  is_active: boolean;
  expires_at: string | null;
  revoked_at: string | null;
  use_count: number;
};

const KEY_COLUMNS =
  "id, user_id, name, scopes, agent_ids, model_allow, fallback_models, rate_limit_per_min, is_active, expires_at, revoked_at, use_count";

export type GatewayAuth =
  | { ok: true; key: GatewayKeyRow }
  | { ok: false; status: number; code: OpenAiErrorCode; error: string };

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
};

export const gatewayJson = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS, ...headers },
  });

export const gatewayFail = (
  status: number,
  code: OpenAiErrorCode,
  message: string,
  param?: string,
) => gatewayJson(openAiError(message, code, param ?? null), status);

export const gatewayOptions = () => new Response(null, { status: 204, headers: CORS });

/**
 * Authenticate `Authorization: Bearer gw_...`. Denials are audited against
 * the key's owner when the key is known - a revoked key being retried, or a
 * key used past its scope, is exactly what an owner wants to see - and rate
 * limited either way, so an unknown key cannot be guessed at speed.
 */
export async function authenticateGatewayKey(request: Request): Promise<GatewayAuth> {
  const auth = request.headers.get("authorization") || "";
  const raw = auth.replace(/^Bearer\s+/i, "").trim();
  const meta = { ip: clientIp(request), user_agent: clientUserAgent(request) };
  const deny = (
    reason: string,
    status: number,
    code: OpenAiErrorCode,
    error: string,
    key?: GatewayKeyRow | null,
  ): GatewayAuth => {
    if (key) {
      auditEvent({
        userId: key.user_id,
        action: "gateway.access.denied",
        resourceType: "gateway_key",
        resourceId: key.id,
        resourceName: key.name,
        detail: { reason, ...meta },
      });
    }
    return { ok: false, status, code, error };
  };
  if (!raw) return deny("missing", 401, "invalid_api_key", "Missing API key");
  if (!looksLikeGatewayKey(raw))
    return deny("malformed", 401, "invalid_api_key", "Invalid API key");

  const { data: key } = await supabaseAdmin
    .from("gateway_keys")
    .select(KEY_COLUMNS)
    .eq("key_hash", await hashGatewayKey(raw))
    .maybeSingle();
  if (!key) return deny("unknown", 401, "invalid_api_key", "Invalid API key");
  const row = key as GatewayKeyRow;
  if (!row.is_active || row.revoked_at) {
    return deny("revoked", 401, "invalid_api_key", "This API key has been revoked", row);
  }
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
    return deny("expired", 401, "invalid_api_key", "This API key has expired", row);
  }
  const limit = row.rate_limit_per_min ?? (await getPlatformResources()).gatewayRateLimitPerMin;
  if (await rateLimitedGlobal(`gateway:${row.id}`, limit)) {
    return deny(
      "rate_limited",
      429,
      "rate_limit_exceeded",
      `Rate limit exceeded for this key (${limit} calls a minute); retry shortly`,
      row,
    );
  }

  void supabaseAdmin
    .from("gateway_keys")
    .update({
      use_count: (row.use_count ?? 0) + 1,
      last_used_at: new Date().toISOString(),
      last_used_ip: meta.ip ?? null,
    })
    .eq("id", row.id)
    .then(() => {});

  return { ok: true, key: row };
}

export type AgentRowForGateway = {
  id: string;
  name: string;
  system_prompt: string | null;
  llm_provider: string;
  llm_model: string;
  temperature: number;
  max_tokens: number;
  knowledge_base_id: string | null;
  tools: unknown;
  is_active: boolean;
};

export type ResolvedTarget =
  | { kind: "agent"; agent: AgentRowForGateway }
  | { kind: "model"; provider: string; model: string };

/**
 * What the `model` field names, and whether this key may reach it. Agents
 * are looked up by id or by exact name among the OWNER's agents only - the
 * service-role client would otherwise happily return anyone's.
 */
export async function resolveGatewayTarget(
  key: GatewayKeyRow,
  model: unknown,
): Promise<
  | { ok: true; target: ResolvedTarget }
  | { ok: false; status: number; code: OpenAiErrorCode; error: string }
> {
  const parsed: GatewayTarget | null = parseGatewayModel(model, GATEWAY_PROVIDERS);
  if (!parsed) {
    return {
      ok: false,
      status: 404,
      code: "model_not_found",
      error:
        "Unknown model. Name a saved agent as agent:<id or name>, or a connected model as <provider>/<model> (for example openrouter/openai/gpt-4o-mini).",
    };
  }
  if (parsed.kind === "agent") {
    if (!key.scopes.includes("agents")) {
      return {
        ok: false,
        status: 403,
        code: "insufficient_scope",
        error: 'This key does not have the "agents" scope',
      };
    }
    let q = supabaseAdmin
      .from("agents")
      .select(
        "id, name, system_prompt, llm_provider, llm_model, temperature, max_tokens, knowledge_base_id, tools, is_active",
      )
      .eq("user_id", key.user_id);
    q = UUID.test(parsed.ref) ? q.eq("id", parsed.ref) : q.ilike("name", parsed.ref);
    const { data } = await q.limit(2);
    const rows = (data ?? []) as AgentRowForGateway[];
    if (rows.length === 0) {
      return {
        ok: false,
        status: 404,
        code: "model_not_found",
        error: `No agent named "${parsed.ref}"`,
      };
    }
    if (rows.length > 1) {
      return {
        ok: false,
        status: 404,
        code: "model_not_found",
        error: `More than one agent is named "${parsed.ref}"; use agent:<id>`,
      };
    }
    const agent = rows[0];
    if (!agent.is_active) {
      return {
        ok: false,
        status: 404,
        code: "model_not_found",
        error: `The agent "${agent.name}" is inactive`,
      };
    }
    if (key.agent_ids.length > 0 && !key.agent_ids.includes(agent.id)) {
      return {
        ok: false,
        status: 403,
        code: "insufficient_scope",
        error: `This key is not allowed to call the agent "${agent.name}"`,
      };
    }
    return { ok: true, target: { kind: "agent", agent } };
  }
  if (!key.scopes.includes("models")) {
    return {
      ok: false,
      status: 403,
      code: "insufficient_scope",
      error: 'This key does not have the "models" scope',
    };
  }
  if (!modelAllowedByKey(key.model_allow, parsed.provider, parsed.model)) {
    return {
      ok: false,
      status: 403,
      code: "model_not_allowed",
      error: `This key is not allowed to call ${parsed.provider}/${parsed.model}`,
    };
  }
  return { ok: true, target: { kind: "model", provider: parsed.provider, model: parsed.model } };
}

/** The models a key can name, in the shape GET /v1/models returns. */
export async function listGatewayModels(key: GatewayKeyRow): Promise<
  {
    id: string;
    object: "model";
    created: number;
    owned_by: string;
    agentswarms?: Record<string, unknown>;
  }[]
> {
  const out: {
    id: string;
    object: "model";
    created: number;
    owned_by: string;
    agentswarms?: Record<string, unknown>;
  }[] = [];
  if (key.scopes.includes("agents")) {
    let q = supabaseAdmin
      .from("agents")
      .select("id, name, description, llm_provider, llm_model, created_at")
      .eq("user_id", key.user_id)
      .eq("is_active", true)
      .order("name");
    if (key.agent_ids.length > 0) q = q.in("id", key.agent_ids);
    const { data } = await q;
    for (const a of data ?? []) {
      out.push({
        id: `agent:${a.id}`,
        object: "model",
        created: Math.floor(new Date(a.created_at).getTime() / 1000),
        owned_by: "agentswarms",
        agentswarms: {
          kind: "agent",
          name: a.name,
          alias: `agent:${a.name}`,
          description: a.description,
          model: `${a.llm_provider}/${a.llm_model}`,
        },
      });
    }
  }
  if (key.scopes.includes("models")) {
    // A connected model is any the owner's providers serve; the allow-list is
    // the only finite thing to show, so the patterns are listed as hints.
    const patterns = key.model_allow.length ? key.model_allow : ["<provider>/<model>"];
    for (const p of patterns) {
      out.push({
        id: p,
        object: "model",
        created: 0,
        owned_by: "provider",
        agentswarms: { kind: "model_pattern", providers: [...GATEWAY_PROVIDERS] },
      });
    }
  }
  return out;
}

// ── The turn itself ──────────────────────────────────────────────────────────

export type OpenAiChatRequest = {
  model?: unknown;
  messages?: unknown;
  stream?: unknown;
  temperature?: unknown;
  max_tokens?: unknown;
  max_completion_tokens?: unknown;
  stream_options?: { include_usage?: unknown } | null;
};

type Usage = { prompt_tokens: number; completion_tokens: number; total_tokens: number };

type UpstreamExtras = {
  citations?: unknown;
  sources?: unknown;
  tools?: unknown[];
  guardrail?: unknown;
  memory_used?: unknown;
  cost_usd?: number;
};

/** One SSE frame of the platform's own stream. */
async function* sseFrames(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event = "message";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      let line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line === "") {
        event = "message";
        continue;
      }
      if (line.startsWith("event: ")) {
        event = line.slice(7).trim();
        continue;
      }
      if (!line.startsWith("data: ")) continue;
      yield { event, data: line.slice(6).trim() };
    }
  }
}

/** Fold one upstream frame into the running text, usage and extras. Returns the text delta, if any. */
function foldFrame(
  frame: { event: string; data: string },
  acc: { text: string; usage: Usage | null; extras: UpstreamExtras; done: boolean },
): string | null {
  if (frame.data === "[DONE]") {
    acc.done = true;
    return null;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(frame.data);
  } catch {
    return null;
  }
  const p = (payload ?? {}) as Record<string, unknown>;
  switch (frame.event) {
    case "cost": {
      const tokensIn = Number(p.tokensIn ?? 0);
      const tokensOut = Number(p.tokensOut ?? 0);
      acc.usage = {
        prompt_tokens: tokensIn,
        completion_tokens: tokensOut,
        total_tokens: tokensIn + tokensOut,
      };
      if (typeof p.costUsd === "number") acc.extras.cost_usd = p.costUsd;
      return null;
    }
    case "citations":
      acc.extras.citations = p.citations ?? payload;
      return null;
    case "sources":
      acc.extras.sources = p.sources ?? payload;
      return null;
    case "tool":
      (acc.extras.tools ??= []).push(payload);
      return null;
    case "guardrail_rewrite":
    case "guardrail_warning":
      acc.extras.guardrail = { event: frame.event, ...p };
      return null;
    case "memory_used":
      acc.extras.memory_used = payload;
      return null;
    default: {
      const choices = p.choices as
        | { delta?: { content?: unknown }; message?: { content?: unknown } }[]
        | undefined;
      const piece = choices?.[0]?.delta?.content ?? choices?.[0]?.message?.content;
      if (typeof piece === "string" && piece.length > 0) {
        acc.text += piece;
        return piece;
      }
      return null;
    }
  }
}

export type CompletionMeta = {
  id: string;
  model: string;
  created: number;
  includeUsage: boolean;
  traceId: string | null;
  fallbackFrom: string | null;
};

/**
 * Re-emit the platform's SSE as OpenAI chat.completion.chunk frames. Text
 * deltas pass through as they arrive; the platform's own events (citations,
 * tool calls, guardrail notes, usage) are folded into the final chunk under
 * an `agentswarms` field that OpenAI clients ignore and ours can read.
 */
export function adaptUpstreamSse(
  upstream: ReadableStream<Uint8Array>,
  meta: CompletionMeta,
  onDone?: (summary: { text: string; usage: Usage | null; extras: UpstreamExtras }) => void,
): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const acc = { text: "", usage: null as Usage | null, extras: {} as UpstreamExtras, done: false };
  let sentRole = false;
  const chunk = (
    delta: Record<string, unknown>,
    finish: string | null,
    extra?: Record<string, unknown>,
  ) =>
    enc.encode(
      `data: ${JSON.stringify({
        id: meta.id,
        object: "chat.completion.chunk",
        created: meta.created,
        model: meta.model,
        choices: [{ index: 0, delta, finish_reason: finish }],
        ...(extra ?? {}),
      })}\n\n`,
    );
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const frame of sseFrames(upstream)) {
          const piece = foldFrame(frame, acc);
          if (piece === null) continue;
          const delta: Record<string, unknown> = sentRole
            ? { content: piece }
            : { role: "assistant", content: piece };
          sentRole = true;
          controller.enqueue(chunk(delta, null));
        }
        const tail: Record<string, unknown> = {
          agentswarms: {
            trace_id: meta.traceId,
            fallback_from: meta.fallbackFrom,
            ...acc.extras,
          },
        };
        if (meta.includeUsage && acc.usage) tail.usage = acc.usage;
        controller.enqueue(chunk(sentRole ? {} : { role: "assistant", content: "" }, "stop", tail));
        controller.enqueue(enc.encode("data: [DONE]\n\n"));
        onDone?.({ text: acc.text, usage: acc.usage, extras: acc.extras });
      } catch (e) {
        controller.enqueue(
          enc.encode(
            `data: ${JSON.stringify(openAiError((e as Error).message || "Stream failed", "upstream_error"))}\n\n`,
          ),
        );
        onDone?.({ text: acc.text, usage: acc.usage, extras: acc.extras });
      } finally {
        controller.close();
      }
    },
  });
}

/** Drain the platform's SSE into one OpenAI chat.completion object. */
export async function collectUpstreamSse(
  upstream: ReadableStream<Uint8Array>,
  meta: CompletionMeta,
): Promise<{
  body: Record<string, unknown>;
  text: string;
  usage: Usage | null;
  extras: UpstreamExtras;
}> {
  const acc = { text: "", usage: null as Usage | null, extras: {} as UpstreamExtras, done: false };
  for await (const frame of sseFrames(upstream)) foldFrame(frame, acc);
  const body: Record<string, unknown> = {
    id: meta.id,
    object: "chat.completion",
    created: meta.created,
    model: meta.model,
    choices: [
      { index: 0, message: { role: "assistant", content: acc.text }, finish_reason: "stop" },
    ],
    usage: acc.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    agentswarms: { trace_id: meta.traceId, fallback_from: meta.fallbackFrom, ...acc.extras },
  };
  return { body, text: acc.text, usage: acc.usage, extras: acc.extras };
}

function num(v: unknown, lo: number, hi: number): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return undefined;
  return Math.min(hi, Math.max(lo, n));
}

/** The body /api/chat's internal channel takes for one candidate model. */
export function buildInternalChatBody(args: {
  ownerId: string;
  keyId: string;
  target: ResolvedTarget;
  candidate: { provider: string; model: string };
  messages: OpenAiMessage[];
  temperature?: number;
  maxTokens?: number;
}): Record<string, unknown> {
  const { system, turns } = splitConversation(args.messages);
  const base: Record<string, unknown> = {
    internalUserId: args.ownerId,
    costScope: { type: "gateway_key", id: args.keyId },
    provider: args.candidate.provider,
    model: args.candidate.model,
    messages: turns,
    // No memory on gateway turns: the caller keeps its own conversation and
    // replays it, the way the OpenAI API works, and a key is not a person.
    memoryOverrides: { stm_enabled: false, ltm_enabled: false, ltm_scope: "none" },
  };
  if (args.target.kind === "model") {
    return {
      ...base,
      systemPrompt: system || undefined,
      temperature: args.temperature ?? 0.4,
      maxTokens: args.maxTokens ?? 8192,
      // A bare model has no tools: nothing was configured for it, and a key
      // must not be a way to run the owner's tool catalogue at large.
      enabledTools: [],
    };
  }
  const a = args.target.agent;
  const { patch } = agentToNodePatch({
    name: a.name,
    system_prompt: a.system_prompt,
    llm_provider: a.llm_provider,
    llm_model: a.llm_model,
    temperature: a.temperature,
    knowledge_base_id: a.knowledge_base_id,
    tools: a.tools,
  });
  const prompt = [patch.systemPrompt, system].filter((s) => s && s.trim()).join("\n\n");
  return {
    ...base,
    agentId: a.id,
    agentName: a.name,
    systemPrompt: prompt || undefined,
    temperature: args.temperature ?? patch.temperature ?? 0.4,
    maxTokens: args.maxTokens ?? a.max_tokens ?? 8192,
    // The agent's own toggles, through the mapping agent chat uses - not the
    // swarm-node subset, which has no ML, notification or skill tools. The
    // internal channel still caps the set to what is safe headless.
    enabledTools: enabledToolsFromToggles(builtInTogglesOf(a.tools)) ?? [],
    toolConfigs: patch.toolConfigs,
    guardrails: patch.guardrails,
    skillIds: patch.skillIds,
    knowledgeBaseIds: patch.knowledgeBaseId ? [patch.knowledgeBaseId] : undefined,
    reranker: patch.reranker ?? undefined,
  };
}

/** How /api/chat's failure reads to an OpenAI client. */
function mapUpstreamFailure(
  status: number,
  text: string,
): { status: number; code: OpenAiErrorCode; message: string } {
  let message = text.slice(0, 300);
  try {
    const j = JSON.parse(text) as { error?: unknown; message?: unknown };
    if (typeof j.message === "string") message = j.message;
    else if (typeof j.error === "string") message = j.error;
    if (j.error === "model_not_allowed") {
      return { status: 403, code: "model_not_allowed", message };
    }
  } catch {
    /* plain text */
  }
  if (status === 429)
    return {
      status: 429,
      code: "rate_limit_exceeded",
      message: message || "The provider is rate limiting this model",
    };
  if (status === 402)
    return {
      status: 502,
      code: "upstream_error",
      message: message || "The provider reports exhausted credits",
    };
  if (status === 401 || status === 403)
    return { status: 403, code: "model_not_allowed", message: message || "Not allowed" };
  if (status === 400 || status === 404)
    return { status: 400, code: "invalid_request_error", message: message || "Bad request" };
  return {
    status: 502,
    code: "upstream_error",
    message: message || `The model call failed (${status})`,
  };
}

/**
 * Run one chat completion for an authenticated key: budget, target, then the
 * candidates in turn. A fallback happens only BEFORE any token has reached
 * the caller - once a stream has started, its model answers it.
 */
export async function runGatewayCompletion(args: {
  request: Request;
  key: GatewayKeyRow;
  body: OpenAiChatRequest;
}): Promise<Response> {
  const { key, body } = args;
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return gatewayFail(
      400,
      "invalid_request_error",
      "messages must be a non-empty array",
      "messages",
    );
  }
  const messages = body.messages as OpenAiMessage[];
  const resolved = await resolveGatewayTarget(key, body.model);
  if (!resolved.ok) return gatewayFail(resolved.status, resolved.code, resolved.error, "model");
  const target = resolved.target;

  const budget = await getBudgetDecision(key.user_id, { type: "gateway_key", id: key.id });
  if (budget.over) {
    auditEvent({
      userId: key.user_id,
      action: "gateway.access.denied",
      resourceType: "gateway_key",
      resourceId: key.id,
      resourceName: key.name,
      detail: { reason: "budget", scope: budget.scope, spend: budget.spend, cap: budget.cap },
    });
    return gatewayFail(429, "insufficient_quota", budgetMessage(budget));
  }

  const secret = internalRunSecret();
  if (!secret) {
    return gatewayFail(
      500,
      "upstream_error",
      "Server is missing INTERNAL_RUN_SECRET / SUPABASE_SERVICE_ROLE_KEY",
    );
  }
  const primary =
    target.kind === "agent"
      ? { provider: target.agent.llm_provider, model: target.agent.llm_model }
      : { provider: target.provider, model: target.model };
  const instance = await getPlatformResources();
  const candidates = [
    primary,
    ...fallbackCandidates(
      primary,
      [key.fallback_models, instance.gatewayFallbackModels],
      GATEWAY_PROVIDERS,
    ),
  ];
  const stream = body.stream === true;
  const includeUsage = body.stream_options?.include_usage === true || !stream;
  const temperature = num(body.temperature, 0, 2);
  const maxTokens = num(body.max_completion_tokens ?? body.max_tokens, 1, 200_000);
  const requestedModel =
    typeof body.model === "string" ? body.model : `${primary.provider}/${primary.model}`;
  const id = `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);
  const origin = resolveInternalOrigin();

  let lastFailure: { status: number; code: OpenAiErrorCode; message: string } | null = null;
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const internal = buildInternalChatBody({
      ownerId: key.user_id,
      keyId: key.id,
      target,
      candidate,
      messages,
      temperature,
      maxTokens,
    });
    let res: Response;
    try {
      res = await fetch(`${origin}/api/chat`, {
        method: "POST",
        signal: args.request.signal,
        headers: { "Content-Type": "application/json", "x-internal-run-secret": secret },
        body: JSON.stringify(internal),
      });
    } catch (e) {
      lastFailure = {
        status: 502,
        code: "upstream_error",
        message: (e as Error).message || "The model call failed",
      };
      if (i < candidates.length - 1) {
        auditFallback(key, candidate, candidates[i + 1], "network", lastFailure.message);
        continue;
      }
      break;
    }
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      const mapped = mapUpstreamFailure(res.status, text);
      lastFailure = mapped;
      // A fallback candidate the owner's IAM rules forbid is skipped, not
      // reported: the policy is the point. The PRIMARY being forbidden is
      // the caller's answer.
      const policyOnFallback = i > 0 && mapped.code === "model_not_allowed";
      if ((isRetryableFailure(res.status) || policyOnFallback) && i < candidates.length - 1) {
        auditFallback(key, candidate, candidates[i + 1], String(res.status), mapped.message);
        continue;
      }
      break;
    }
    const served = `${candidate.provider}/${candidate.model}`;
    // `model` names what answered, as the OpenAI API does; the requested
    // model is in agentswarms.fallback_from when they differ.
    const meta: CompletionMeta = {
      id,
      model: served,
      created,
      includeUsage,
      traceId: res.headers.get("X-Trace-Id"),
      fallbackFrom: i > 0 ? `${primary.provider}/${primary.model}` : null,
    };
    const headers: Record<string, string> = {
      "X-Gateway-Model": served,
      ...(meta.traceId ? { "X-Trace-Id": meta.traceId } : {}),
      ...(i > 0 ? { "X-Gateway-Fallback": "true" } : {}),
    };
    const audit = (status: "success" | "error", usage: Usage | null) =>
      auditEvent({
        userId: key.user_id,
        action: "gateway.chat",
        resourceType: "gateway_key",
        resourceId: key.id,
        resourceName: key.name,
        decisionId: meta.traceId,
        detail: {
          target: target.kind === "agent" ? `agent:${target.agent.id}` : requestedModel,
          agent_name: target.kind === "agent" ? target.agent.name : null,
          model: served,
          fallback_from: meta.fallbackFrom,
          stream,
          status,
          tokens_in: usage?.prompt_tokens ?? null,
          tokens_out: usage?.completion_tokens ?? null,
          trace_id: meta.traceId,
        },
      });
    if (stream) {
      const out = adaptUpstreamSse(res.body, meta, (s) =>
        audit(s.text || s.usage ? "success" : "error", s.usage),
      );
      return new Response(out, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          ...CORS,
          ...headers,
        },
      });
    }
    const collected = await collectUpstreamSse(res.body, meta);
    audit(collected.text || collected.usage ? "success" : "error", collected.usage);
    return gatewayJson(collected.body, 200, headers);
  }
  const f = lastFailure ?? {
    status: 502,
    code: "upstream_error" as const,
    message: "The model call failed",
  };
  auditEvent({
    userId: key.user_id,
    action: "gateway.chat",
    resourceType: "gateway_key",
    resourceId: key.id,
    resourceName: key.name,
    detail: {
      target: target.kind === "agent" ? `agent:${target.agent.id}` : requestedModel,
      status: "error",
      error: f.message,
      candidates_tried: candidates.map((c) => `${c.provider}/${c.model}`),
    },
  });
  return gatewayFail(f.status, f.code, f.message);
}

function auditFallback(
  key: GatewayKeyRow,
  from: { provider: string; model: string },
  to: { provider: string; model: string },
  status: string,
  reason: string,
): void {
  auditEvent({
    userId: key.user_id,
    action: "gateway.fallback",
    resourceType: "gateway_key",
    resourceId: key.id,
    resourceName: key.name,
    detail: {
      from: `${from.provider}/${from.model}`,
      to: `${to.provider}/${to.model}`,
      status,
      reason: reason.slice(0, 300),
    },
  });
}
