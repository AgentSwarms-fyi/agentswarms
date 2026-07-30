// Server-only helpers for provider credentials. Never import this from client code.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { decryptJson } from "./crypto.server";
import { bedrockChatStream } from "./adapters/bedrock.server";
import { vertexChatStream } from "./adapters/vertex.server";
import { anthropicChatStream } from "./adapters/anthropic.server";
import { azureOpenAIChatStream } from "./adapters/azure.server";
import { ociChatStream } from "./adapters/oci.server";
import { qwenChatStream } from "./adapters/qwen.server";
import { grokChatStream } from "./adapters/grok.server";
import { geminiChatStream } from "./adapters/gemini.server";
import { openAICompatChatStream } from "./adapters/openai-compat.server";
import { vllmChatStream } from "./adapters/vllm.server";
import type {
  AnthropicCreds,
  AzureConfig,
  AzureCreds,
  BedrockConfig,
  BedrockCreds,
  GrokConfig,
  GrokCreds,
  OCIConfig,
  OCICreds,
  ProviderId,
  QwenConfig,
  QwenCreds,
  VLLMConfig,
  VLLMCreds,
  VertexConfig,
  VertexCreds,
} from "./types";

// Providers whose credentials live in the legacy `integrations` table
// (plaintext `config`) instead of the encrypted `provider_credentials` table.
// Qwen lives in BOTH: when saved through the Integrations page it goes here
// (plaintext, OpenAI-compatible). When saved through the Agents page it goes
// through the encrypted provider_credentials table. The chat route checks
// the legacy table first, so the Integrations card takes precedence.
import { resolveIntegrationConfig } from "./integrationConfig.server";

const LEGACY_PROVIDERS = new Set<ProviderId>([
  "grok",
  "openai",
  "gemini",
  "ollama",
  "openrouter",
  "groq",
  "anthropic",
  "qwen",
  "vllm",
  "nvidia",
]);

async function loadLegacyConfig(userId: string, provider: ProviderId) {
  // Users can end up with duplicate rows for the same provider (e.g. one
  // inactive + one active after re-saving). `.maybeSingle()` blows up in that
  // case with "JSON object requested, multiple (or no) rows returned", so we
  // fetch all matches and prefer the most recently updated active row.
  const { data, error } = await supabaseAdmin
    .from("integrations")
    .select("config, is_active, updated_at")
    .eq("user_id", userId)
    .eq("provider", provider)
    .eq("type", "llm_provider")
    .order("is_active", { ascending: false })
    .order("updated_at", { ascending: false });
  if (error) throw new Error(error.message);
  if (!data || data.length === 0) return null;
  const row = data[0];

  // Decrypt the at-rest-encrypted api_key (api_key_enc) and resolve any
  // {{secret:NAME}} references inside provider configs, per-user at use time.
  const cfg = (row.config ?? {}) as Record<string, unknown>;
  return { ...row, config: await resolveIntegrationConfig(userId, "llm_provider", cfg) };
}

// Optional override applied when an agent has tools.routeThroughGateway = true
// AND the user has an active LLM Gateway integration. We swap the upstream
// URL + key so all traffic goes through LiteLLM/Portkey/Helicone/etc.
export type GatewayOverride = { baseUrl: string; apiKey: string; provider?: string };

/**
 * Resolve the user's active LLM Gateway integration into a usable override.
 *
 * Two routing modes, matching the Integrations UI:
 *  - per-agent opt-in (`tools.routeThroughGateway`): callers that know the
 *    agent pass the resulting override explicitly (the chat route does this);
 *  - `config.route_all === true`: EVERY LLM surface routes through the
 *    gateway. `resolveOpenAICompatTransport` consults this itself, so BI,
 *    embeds, skill generation, notebooks, model listings and embeddings are
 *    covered without each call site knowing about gateways.
 *
 * With `requireRouteAll`, returns null unless route_all is set. Lookup
 * failures return null (routing, not egress enforcement — a DB blip must not
 * take every provider down), but are logged.
 */
export async function resolveUserGatewayOverride(
  userId: string,
  opts: { requireRouteAll?: boolean } = {},
): Promise<GatewayOverride | null> {
  try {
    const { data: gw } = await supabaseAdmin
      .from("integrations")
      .select("config, is_active")
      .eq("user_id", userId)
      .eq("type", "llm_gateway")
      .eq("is_active", true)
      .maybeSingle();
    if (!gw?.is_active || !gw.config) return null;
    const cfg = (await resolveIntegrationConfig(
      userId,
      "llm_gateway",
      gw.config as Record<string, unknown>,
    )) as { base_url?: string; api_key?: string; provider?: string; route_all?: unknown };
    if (opts.requireRouteAll && cfg.route_all !== true) return null;
    if (!cfg.base_url || !cfg.api_key) return null;
    return {
      baseUrl: cfg.base_url.replace(/\/+$/, ""),
      apiKey: cfg.api_key,
      provider: cfg.provider,
    };
  } catch (e) {
    console.warn("[gateway] override lookup failed:", (e as Error).message);
    return null;
  }
}

// ── Org-shared credentials (IAM grants) ────────────────────────────────────
// A superadmin can grant another user's LLM credential to a user or group
// (resource_type 'integration' for the integrations table, 'provider_credential'
// for the encrypted signed-request store). Grantees can USE the credential —
// these fallbacks run strictly AFTER the caller's own key misses — but can
// never read it: RLS on both tables is untouched, and decryption (including
// {{secret:NAME}} refs) happens against the OWNER, server-side only.

async function grantedIdsFor(
  userId: string,
  type: "integration" | "provider_credential",
): Promise<Set<string>> {
  try {
    const { resolveGrantedResourceIds } = await import("@/utils/iam.server");
    return await resolveGrantedResourceIds(supabaseAdmin, userId, type);
  } catch (e) {
    console.warn("[shared-creds] grant lookup failed:", (e as Error).message);
    return new Set();
  }
}

/** A credential from the integrations table granted to this user via IAM. */
async function loadGrantedLegacyConfig(userId: string, provider: ProviderId) {
  const ids = await grantedIdsFor(userId, "integration");
  if (ids.size === 0) return null;
  const { data } = await supabaseAdmin
    .from("integrations")
    .select("config, is_active, updated_at, user_id")
    .in("id", [...ids])
    .eq("type", "llm_provider")
    .eq("provider", provider)
    .eq("is_active", true)
    .order("updated_at", { ascending: false });
  const row = data?.[0];
  if (!row) return null;
  // Decrypt with the OWNER's identity — their ciphertext, their secret refs.
  return {
    ...row,
    config: await resolveIntegrationConfig(
      row.user_id,
      "llm_provider",
      (row.config ?? {}) as Record<string, unknown>,
    ),
  };
}

/** Own encrypted credential first, then one granted via IAM. */
export async function loadCredentialRowShared(userId: string, provider: ProviderId) {
  const own = await loadCredentialRow(userId, provider).catch(() => null);
  if (own) return own;
  const ids = await grantedIdsFor(userId, "provider_credential");
  if (ids.size === 0) return null;
  const { data } = await supabaseAdmin
    .from("provider_credentials")
    .select("credentials, config, default_model")
    .in("id", [...ids])
    .eq("provider", provider)
    .limit(1);
  return data?.[0] ?? null;
}

// Server-wide default: when a user hasn't connected their own OpenRouter key,
// fall back to a single operator-configured OPENROUTER_API_KEY so the app
// works zero-config out of the box (mirrors what `lovable_ai` used to do,
// minus any per-user caps — self-hosters own their own key + budget).
const ENV_OPENROUTER_BASE_URL = (
  process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1"
).replace(/\/+$/, "");

function getEnvOpenRouterKey(): string | null {
  const key = process.env.OPENROUTER_API_KEY;
  return key && key.trim() ? key.trim() : null;
}

// Subset of providers that speak vanilla OpenAI Chat Completions and therefore
// support the same server-side tool-calling loop the Lovable AI gateway uses.
// Anything outside this set goes through its bespoke adapter and tools are
// not (yet) wired up — those providers will silently fall back to plain
// streaming without tools.
const OPENAI_COMPAT_PROVIDERS = new Set<ProviderId>([
  "openai",
  "gemini",
  "grok",
  "groq",
  "openrouter",
  "ollama",
  "qwen",
  "vllm",
  "nvidia",
]);

export type OpenAICompatTransport = {
  endpointUrl: string; // full URL to /chat/completions
  apiKey: string; // bearer token (may be empty for local Ollama)
  extraHeaders?: Record<string, string>;
  organizationId?: string;
};

// Resolve the OpenAI-compatible /chat/completions URL + key for a given user
// + provider. Returns null when the provider isn't OpenAI-compatible or the
// user hasn't configured credentials. Used by the chat route to run the
// shared tool loop against external providers.
export async function resolveOpenAICompatTransport(args: {
  userId: string;
  provider: ProviderId;
  gateway?: GatewayOverride;
}): Promise<OpenAICompatTransport | null> {
  const { userId, provider } = args;
  if (!OPENAI_COMPAT_PROVIDERS.has(provider)) return null;

  // Gateway resolution: an explicit override from the caller (per-agent
  // opt-in) wins; otherwise honor the user's "route all LLM traffic" gateway
  // setting here, at the one chokepoint every OpenAI-compat surface shares.
  const gateway =
    args.gateway ?? (await resolveUserGatewayOverride(userId, { requireRouteAll: true }));

  // Gateway override short-circuits per-provider creds — every gateway we
  // support (LiteLLM/Portkey/Helicone) speaks OpenAI Chat Completions.
  if (gateway?.baseUrl && gateway?.apiKey) {
    return {
      endpointUrl: `${gateway.baseUrl.replace(/\/+$/, "")}/chat/completions`,
      apiKey: gateway.apiKey,
    };
  }

  let row = await loadLegacyConfig(userId, provider);
  // Own key first; an IAM-granted credential second; env fallback last.
  if (!row || !row.is_active) {
    row = await loadGrantedLegacyConfig(userId, provider);
  }
  if (!row || !row.is_active) {
    // No user-saved OpenRouter key — fall back to the operator's shared
    // OPENROUTER_API_KEY (if configured) so OpenRouter can act as the
    // app-wide zero-config default provider. BYOK always wins when present.
    if (provider === "openrouter") {
      const envKey = getEnvOpenRouterKey();
      if (envKey) {
        return { endpointUrl: `${ENV_OPENROUTER_BASE_URL}/chat/completions`, apiKey: envKey };
      }
    }
    return null;
  }
  const cfg = (row.config || {}) as Record<string, unknown>;
  const cleanKey = (typeof cfg.api_key === "string" ? cfg.api_key : "")
    .trim()
    .replace(/^Bearer\s+/i, "")
    .replace(/^key=/i, "")
    .replace(/^["']+|["']+$/g, "");

  const baseUrlOverride = typeof cfg.base_url === "string" && cfg.base_url ? cfg.base_url : "";

  switch (provider) {
    case "openai": {
      const baseUrl = baseUrlOverride || "https://api.openai.com/v1";
      return {
        endpointUrl: `${baseUrl.replace(/\/+$/, "")}/chat/completions`,
        apiKey: cleanKey,
        organizationId: typeof cfg.organization_id === "string" ? cfg.organization_id : undefined,
      };
    }
    case "gemini": {
      // Google publishes an OpenAI-compatible endpoint for Gemini at this URL.
      // Tool calling works the same way — function declarations come back as
      // standard `tool_calls` on the assistant message.
      const baseUrl = baseUrlOverride || "https://generativelanguage.googleapis.com/v1beta/openai";
      return {
        endpointUrl: `${baseUrl.replace(/\/+$/, "")}/chat/completions`,
        apiKey: cleanKey,
      };
    }
    case "grok": {
      const baseUrl = baseUrlOverride || "https://api.x.ai/v1";
      return {
        endpointUrl: `${baseUrl.replace(/\/+$/, "")}/chat/completions`,
        apiKey: cleanKey,
      };
    }
    case "groq": {
      const baseUrl = baseUrlOverride || "https://api.groq.com/openai/v1";
      return {
        endpointUrl: `${baseUrl.replace(/\/+$/, "")}/chat/completions`,
        apiKey: cleanKey,
      };
    }
    case "openrouter": {
      const baseUrl = baseUrlOverride || "https://openrouter.ai/api/v1";
      const extraHeaders: Record<string, string> = {};
      if (typeof cfg.http_referer === "string" && cfg.http_referer.trim()) {
        extraHeaders["HTTP-Referer"] = cfg.http_referer.trim();
      }
      if (typeof cfg.app_title === "string" && cfg.app_title.trim()) {
        extraHeaders["X-Title"] = cfg.app_title.trim();
      }
      return {
        endpointUrl: `${baseUrl.replace(/\/+$/, "")}/chat/completions`,
        apiKey: cleanKey,
        extraHeaders,
      };
    }
    case "ollama": {
      const endpoint =
        typeof cfg.endpoint === "string" && cfg.endpoint
          ? cfg.endpoint.replace(/\/+$/, "")
          : "http://localhost:11434";
      const baseUrl = endpoint.endsWith("/v1") ? endpoint : `${endpoint}/v1`;
      return {
        endpointUrl: `${baseUrl.replace(/\/+$/, "")}/chat/completions`,
        apiKey: cleanKey,
      };
    }
    case "qwen": {
      // Alibaba DashScope OpenAI-compatible endpoint. International default;
      // mainland China users override base_url to dashscope.aliyuncs.com/...
      const baseUrl = baseUrlOverride || "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
      return {
        endpointUrl: `${baseUrl.replace(/\/+$/, "")}/chat/completions`,
        apiKey: cleanKey,
      };
    }
    case "vllm": {
      // Self-hosted vLLM. base_url MUST be supplied (no public default). If
      // the operator configured a served-model-name, it overrides whatever
      // model id the agent passes (vLLM only knows that one alias).
      const baseUrl = baseUrlOverride;
      if (!baseUrl) return null;
      const normalized = baseUrl.replace(/\/+$/, "");
      const withV1 = normalized.endsWith("/v1") ? normalized : `${normalized}/v1`;
      return {
        endpointUrl: `${withV1}/chat/completions`,
        apiKey: cleanKey,
      };
    }
    case "nvidia": {
      // NVIDIA NIM (build.nvidia.com) — OpenAI-compatible endpoint with a
      // generous free tier for NVIDIA Developer Program members. Keys look
      // like `nvapi-...`. Default endpoint: integrate.api.nvidia.com.
      const baseUrl = baseUrlOverride || "https://integrate.api.nvidia.com/v1";
      return {
        endpointUrl: `${baseUrl.replace(/\/+$/, "")}/chat/completions`,
        apiKey: cleanKey,
      };
    }
    default:
      return null;
  }
}

async function streamLegacyProvider(args: {
  userId: string;
  provider: ProviderId;
  modelId: string;
  systemPrompt?: string;
  messages: { role: "system" | "user" | "assistant"; content: string }[];
  temperature?: number;
  maxTokens?: number;
  gateway?: GatewayOverride;
}): Promise<Response> {
  const { userId, provider, modelId, systemPrompt, messages, temperature, maxTokens, gateway } =
    args;
  let row = await loadLegacyConfig(userId, provider);
  // Own key first; an IAM-granted credential second; env fallback last.
  if (!row || !row.is_active) {
    row = await loadGrantedLegacyConfig(userId, provider);
  }
  if (!row || !row.is_active) {
    if (provider === "openrouter") {
      const envKey = getEnvOpenRouterKey();
      if (envKey) {
        return openAICompatChatStream({
          baseUrl: ENV_OPENROUTER_BASE_URL,
          apiKey: envKey,
          modelId,
          systemPrompt,
          messages,
          temperature,
          maxTokens,
          providerLabel: "OpenRouter (default)",
        });
      }
    }
    throw new Error(`No ${provider} credentials configured. Add them in Integrations.`);
  }
  const cfg = (row.config || {}) as Record<string, unknown>;
  const apiKey = typeof cfg.api_key === "string" ? cfg.api_key : "";
  const cleanApiKey = apiKey
    .trim()
    .replace(/^Bearer\s+/i, "")
    .replace(/^key=/i, "")
    .replace(/^["']+|["']+$/g, "");

  switch (provider) {
    case "grok": {
      if (!cleanApiKey && !gateway)
        throw new Error("Grok API key is missing in your Integrations entry.");
      const baseUrl =
        gateway?.baseUrl ||
        (typeof cfg.base_url === "string" && cfg.base_url ? cfg.base_url : undefined);
      const useKey = gateway?.apiKey || cleanApiKey;
      return grokChatStream({
        creds: { apiKey: useKey } as GrokCreds,
        config: { baseUrl } as GrokConfig,
        modelId,
        systemPrompt,
        messages,
        temperature,
        maxTokens,
      });
    }
    case "openai": {
      if (!cleanApiKey && !gateway)
        throw new Error("OpenAI API key is missing in your Integrations entry.");
      const baseUrl =
        gateway?.baseUrl ||
        (typeof cfg.base_url === "string" && cfg.base_url
          ? cfg.base_url
          : "https://api.openai.com/v1");
      const useKey = gateway?.apiKey || cleanApiKey;
      const organizationId = gateway
        ? undefined
        : typeof cfg.organization_id === "string"
          ? cfg.organization_id
          : undefined;
      return openAICompatChatStream({
        baseUrl,
        apiKey: useKey,
        modelId,
        systemPrompt,
        messages,
        temperature,
        maxTokens,
        organizationId,
        providerLabel: gateway ? `OpenAI via Gateway` : "OpenAI",
      });
    }
    case "gemini": {
      // Gemini's native API is not OpenAI-compatible. If a gateway is in use,
      // fall back to the OpenAI-compat path against the gateway URL — that's
      // the standard pattern (LiteLLM/Portkey expose Gemini under /v1/chat/completions).
      if (gateway) {
        return openAICompatChatStream({
          baseUrl: gateway.baseUrl,
          apiKey: gateway.apiKey,
          modelId,
          systemPrompt,
          messages,
          temperature,
          maxTokens,
          providerLabel: "Gemini via Gateway",
        });
      }
      if (!cleanApiKey) throw new Error("Gemini API key is missing in your Integrations entry.");
      return geminiChatStream({
        apiKey: cleanApiKey,
        modelId,
        systemPrompt,
        messages,
        temperature,
        maxTokens,
      });
    }
    case "ollama": {
      const baseUrl =
        gateway?.baseUrl ||
        (() => {
          const endpoint =
            typeof cfg.endpoint === "string" && cfg.endpoint
              ? cfg.endpoint.replace(/\/+$/, "")
              : "http://localhost:11434";
          return endpoint.endsWith("/v1") ? endpoint : `${endpoint}/v1`;
        })();
      const model = modelId || (typeof cfg.model_name === "string" ? cfg.model_name : "llama3.1");
      return openAICompatChatStream({
        baseUrl,
        apiKey: gateway?.apiKey,
        modelId: model,
        systemPrompt,
        messages,
        temperature,
        maxTokens,
        providerLabel: gateway ? "Ollama via Gateway" : "Ollama",
      });
    }
    case "openrouter": {
      // OpenRouter is OpenAI-compatible. We forward the optional HTTP-Referer
      // and X-Title headers — these are required by OpenRouter for some free
      // models and are used for app attribution in their analytics dashboard.
      if (!cleanApiKey && !gateway) {
        throw new Error("OpenRouter API key is missing in your Integrations entry.");
      }
      const baseUrl =
        gateway?.baseUrl ||
        (typeof cfg.base_url === "string" && cfg.base_url
          ? cfg.base_url
          : "https://openrouter.ai/api/v1");
      const useKey = gateway?.apiKey || cleanApiKey;
      const extraHeaders: Record<string, string> = {};
      if (typeof cfg.http_referer === "string" && cfg.http_referer.trim()) {
        extraHeaders["HTTP-Referer"] = cfg.http_referer.trim();
      }
      if (typeof cfg.app_title === "string" && cfg.app_title.trim()) {
        extraHeaders["X-Title"] = cfg.app_title.trim();
      }
      return openAICompatChatStream({
        baseUrl,
        apiKey: useKey,
        modelId,
        systemPrompt,
        messages,
        temperature,
        maxTokens,
        providerLabel: gateway ? "OpenRouter via Gateway" : "OpenRouter",
        extraHeaders,
      });
    }
    case "groq": {
      // Groq exposes an OpenAI-compatible /openai/v1/chat/completions endpoint
      // backed by their LPU inference hardware. Streaming SSE works identically
      // to OpenAI, so we route through the shared adapter.
      if (!cleanApiKey && !gateway) {
        throw new Error("Groq API key is missing in your Integrations entry.");
      }
      const baseUrl =
        gateway?.baseUrl ||
        (typeof cfg.base_url === "string" && cfg.base_url
          ? cfg.base_url
          : "https://api.groq.com/openai/v1");
      const useKey = gateway?.apiKey || cleanApiKey;
      return openAICompatChatStream({
        baseUrl,
        apiKey: useKey,
        modelId,
        systemPrompt,
        messages,
        temperature,
        maxTokens,
        providerLabel: gateway ? "Groq via Gateway" : "Groq",
      });
    }
    case "anthropic": {
      // Anthropic creds saved via the Integrations page live in the legacy
      // plaintext `integrations` table (alongside openai/openrouter/grok).
      // Route through the dedicated adapter, honoring optional base_url and
      // anthropic_version overrides. Gateway (LiteLLM/Portkey) is handled
      // separately via OpenAI-compat.
      if (gateway) {
        return openAICompatChatStream({
          baseUrl: gateway.baseUrl,
          apiKey: gateway.apiKey,
          modelId,
          systemPrompt,
          messages,
          temperature,
          maxTokens,
          providerLabel: "Anthropic via Gateway",
        });
      }
      if (!cleanApiKey) {
        throw new Error("Anthropic API key is missing in your Integrations entry.");
      }
      const baseUrl = typeof cfg.base_url === "string" && cfg.base_url ? cfg.base_url : undefined;
      const anthropicVersion =
        typeof cfg.anthropic_version === "string" && cfg.anthropic_version
          ? cfg.anthropic_version
          : undefined;
      return anthropicChatStream({
        creds: { apiKey: cleanApiKey },
        modelId,
        systemPrompt,
        messages,
        temperature,
        maxTokens,
        baseUrl,
        anthropicVersion,
      });
    }
    case "qwen": {
      // Qwen via DashScope OpenAI-compatible endpoint. Saved through the
      // Integrations page as plaintext `api_key` + optional `base_url`.
      if (!cleanApiKey && !gateway) {
        throw new Error("Qwen API key is missing in your Integrations entry.");
      }
      const useKey = gateway?.apiKey || cleanApiKey;
      const baseUrl =
        gateway?.baseUrl ||
        (typeof cfg.base_url === "string" && cfg.base_url ? cfg.base_url : undefined);
      return qwenChatStream({
        creds: { apiKey: useKey } as QwenCreds,
        config: { baseUrl } as QwenConfig,
        modelId,
        systemPrompt,
        messages,
        temperature,
        maxTokens,
      });
    }
    case "vllm": {
      // vLLM is self-hosted; base_url is required. servedModelName overrides
      // the agent's chosen model id when the operator launched vLLM with a
      // specific alias (the only model id vLLM will accept).
      const baseUrl = (typeof cfg.base_url === "string" && cfg.base_url ? cfg.base_url : "").trim();
      if (!baseUrl) {
        throw new Error("vLLM base URL is missing in your Integrations entry.");
      }
      const servedModelName =
        typeof cfg.served_model_name === "string"
          ? cfg.served_model_name.trim() || undefined
          : undefined;
      return vllmChatStream({
        creds: { apiKey: cleanApiKey || undefined } as VLLMCreds,
        config: { baseUrl, servedModelName } as VLLMConfig,
        modelId,
        systemPrompt,
        messages,
        temperature,
        maxTokens,
      });
    }
    case "nvidia": {
      // NVIDIA NIM exposes an OpenAI-compatible /chat/completions endpoint at
      // integrate.api.nvidia.com. Streams SSE identically to OpenAI, so we
      // route through the shared adapter. Keys are issued at build.nvidia.com
      // with a generous free tier for the NVIDIA Developer Program.
      if (!cleanApiKey && !gateway) {
        throw new Error(
          "NVIDIA NIM API key is missing in your Integrations entry. Get one at build.nvidia.com.",
        );
      }
      const baseUrl =
        gateway?.baseUrl ||
        (typeof cfg.base_url === "string" && cfg.base_url
          ? cfg.base_url
          : "https://integrate.api.nvidia.com/v1");
      const useKey = gateway?.apiKey || cleanApiKey;
      return openAICompatChatStream({
        baseUrl,
        apiKey: useKey,
        modelId,
        systemPrompt,
        messages,
        temperature,
        maxTokens,
        providerLabel: gateway ? "NVIDIA via Gateway" : "NVIDIA NIM",
      });
    }
    default:
      throw new Error(`Legacy provider not implemented: ${provider}`);
  }
}

export async function loadCredentialRow(userId: string, provider: ProviderId) {
  const { data, error } = await supabaseAdmin
    .from("provider_credentials")
    .select("credentials, config, default_model")
    .eq("user_id", userId)
    .eq("provider", provider)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

/**
 * The user's configured default model for a provider — checks the newer
 * provider_credentials store first, then the legacy integrations config
 * (where OpenAI-compatible providers connected via /integrations live).
 */
export async function getProviderDefaultModel(
  userId: string,
  provider: ProviderId,
): Promise<string | null> {
  const cred = await loadCredentialRowShared(userId, provider).catch(() => null);
  if (cred?.default_model) return cred.default_model;
  let legacy = await loadLegacyConfig(userId, provider).catch(() => null);
  if (!legacy?.is_active) legacy = await loadGrantedLegacyConfig(userId, provider);
  const cfg = (legacy?.config ?? {}) as Record<string, unknown>;
  if (typeof cfg.default_model === "string" && cfg.default_model) return cfg.default_model;
  if (typeof cfg.model === "string" && cfg.model) return cfg.model;
  return null;
}

export async function streamWithProvider(args: {
  userId: string;
  provider: ProviderId;
  modelId: string;
  systemPrompt?: string;
  messages: { role: "system" | "user" | "assistant"; content: string }[];
  temperature?: number;
  maxTokens?: number;
  gateway?: GatewayOverride;
}): Promise<Response> {
  const { userId, provider, modelId, systemPrompt, messages, temperature, maxTokens, gateway } =
    args;

  // Legacy providers (grok, openai, gemini, ollama) store creds in the
  // older `integrations` table as plaintext config. Route them through
  // a dedicated dispatcher so the chat route works for every provider
  // listed in the Integrations page.
  if (LEGACY_PROVIDERS.has(provider)) {
    return streamLegacyProvider({
      userId,
      provider,
      modelId,
      systemPrompt,
      messages,
      temperature,
      maxTokens,
      gateway,
    });
  }

  // Anthropic uses encrypted creds but supports a custom base URL — route
  // through the gateway via OpenAI-compat (which is how LiteLLM/Portkey
  // proxy Anthropic models). Bedrock/Vertex/Azure/OCI use signed/IAM auth
  // that can't be transparently proxied with a base URL swap, so the
  // gateway flag is silently ignored for those.
  if (gateway && provider === "anthropic") {
    return openAICompatChatStream({
      baseUrl: gateway.baseUrl,
      apiKey: gateway.apiKey,
      modelId,
      systemPrompt,
      messages,
      temperature,
      maxTokens,
      providerLabel: "Anthropic via Gateway",
    });
  }

  // Own encrypted credential first, then one shared with this user via IAM.
  const row = await loadCredentialRowShared(userId, provider);
  if (!row)
    throw new Error(`No ${provider} credentials configured. Add them in Provider Integrations.`);
  const decrypted = await decryptJson<Record<string, unknown>>(
    (row.credentials as any).ciphertext,
    (row.credentials as any).iv,
  );
  const config = row.config as Record<string, unknown>;

  switch (provider) {
    case "bedrock":
      return bedrockChatStream({
        creds: decrypted as BedrockCreds,
        config: config as BedrockConfig,
        modelId,
        systemPrompt,
        messages,
        temperature,
        maxTokens,
      });
    case "vertex":
      return vertexChatStream({
        creds: decrypted as VertexCreds,
        config: config as VertexConfig,
        modelId,
        systemPrompt,
        messages,
        temperature,
        maxTokens,
      });
    case "anthropic":
      return anthropicChatStream({
        creds: decrypted as AnthropicCreds,
        modelId,
        systemPrompt,
        messages,
        temperature,
        maxTokens,
      });
    case "azure_openai":
      return azureOpenAIChatStream({
        creds: decrypted as AzureCreds,
        config: config as AzureConfig,
        modelId,
        systemPrompt,
        messages,
        temperature,
        maxTokens,
      });
    case "oci_genai":
      return ociChatStream({
        creds: decrypted as OCICreds,
        config: config as OCIConfig,
        modelId,
        systemPrompt,
        messages,
        temperature,
        maxTokens,
      });
    case "qwen":
      return qwenChatStream({
        creds: decrypted as QwenCreds,
        config: config as QwenConfig,
        modelId,
        systemPrompt,
        messages,
        temperature,
        maxTokens,
      });
    // Note: "grok" is handled earlier (legacy integrations table), not here.
    default:
      throw new Error(`Unsupported provider: ${provider}`);
  }
}
