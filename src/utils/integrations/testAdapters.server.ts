// Server-only live-test adapters for Integration Hub connectors.
//
// One adapter per connector, each making the cheapest possible authenticated
// upstream call. Shared by three callers:
//   * the Integrations page server fns (test-before-activate on save),
//   * the scheduled health pass (utils/integrations/health.server.ts), which
//     re-runs the same tests so a key revoked upstream is noticed before an
//     agent run fails on it,
//   * the gateway validator (testLlmGateway).
//
// Extracted from integrations.functions.ts — that module is bundled into
// client routes, so it dynamic-imports this one inside handlers (same pattern
// it already used for the SSRF guard).

import { safeFetch } from "@/utils/ssrfGuard.server";

export type TestResult =
  | { ok: true; detail: string }
  | { ok: false; detail: string; status?: number };

/** Providers whose integrations-table credentials we can live-test. */
export const TESTABLE_INTEGRATION_PROVIDERS = new Set([
  "openai",
  "anthropic",
  "gemini",
  "grok",
  "openrouter",
  "groq",
  "qwen",
  "vllm",
  "nvidia",
  "ollama",
]);

export function clean(v: unknown): string {
  if (typeof v !== "string") return "";
  return v
    .trim()
    .replace(/^Bearer\s+/i, "")
    .replace(/^key=/i, "")
    .replace(/^["']+|["']+$/g, "");
}

// Every test fetches a URL the USER supplied (base_url / endpoint /
// instance_url) from inside the server's network, so it goes through the SSRF
// guard — which refuses cloud-metadata / link-local targets (private networks
// like a local Ollama/vLLM/n8n are allowed by default; see ssrfGuard.server.ts).
// A bounded timeout stops a slow/hostile upstream from tying up a worker.
export const OUTBOUND_TIMEOUT_MS = 12_000;
export async function guardedFetch(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = OUTBOUND_TIMEOUT_MS,
): Promise<Response> {
  return safeFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

function normalizeAnthropicBaseUrl(v: unknown): string {
  const base = (typeof v === "string" ? v.trim() : "") || "https://api.anthropic.com/v1";
  const stripped = base.replace(/^["']+|["']+$/g, "").replace(/\/+$/, "");
  return stripped.endsWith("/v1") ? stripped : `${stripped}/v1`;
}

// Extract the most human-readable error message from an upstream HTTP
// failure body. Most LLM providers return JSON shaped as
// `{ error: { message, type, code } }` (OpenAI, Anthropic, Gemini,
// OpenRouter, Groq, xAI). Some return `{ message }` or plain text / HTML.
// We return the cleanest possible string so the user sees the EXACT
// upstream reason instead of a generic "Could not connect".
export async function extractUpstreamError(r: Response): Promise<string> {
  const raw = await r.text().catch(() => "");
  if (!raw) return `HTTP ${r.status} ${r.statusText || ""}`.trim();
  try {
    const j = JSON.parse(raw) as {
      error?: { message?: string; type?: string; code?: string | number } | string;
      message?: string;
      detail?: string;
    };
    if (typeof j.error === "string" && j.error.trim()) return j.error.trim();
    if (j.error && typeof j.error === "object") {
      const parts = [j.error.type, j.error.code, j.error.message]
        .filter((p) => p !== undefined && p !== null && String(p).length > 0)
        .map(String);
      if (parts.length) return parts.join(" — ");
    }
    if (typeof j.message === "string" && j.message.trim()) return j.message.trim();
    if (typeof j.detail === "string" && j.detail.trim()) return j.detail.trim();
  } catch {
    // Not JSON — fall through.
  }
  // Strip HTML tags so error pages don't dump markup at the user.
  const stripped = raw
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return stripped.slice(0, 500) || `HTTP ${r.status}`;
}

function fmtFail(provider: string, r: Response, msg: string): TestResult {
  return { ok: false, status: r.status, detail: `${provider} ${r.status}: ${msg}` };
}

async function testOpenAI(cfg: Record<string, string>): Promise<TestResult> {
  const key = clean(cfg.api_key);
  if (!key) return { ok: false, detail: "API key is required" };
  const baseUrl = (cfg.base_url || "https://api.openai.com/v1").replace(/\/+$/, "");
  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
  if (cfg.organization_id) headers["OpenAI-Organization"] = cfg.organization_id;
  const r = await guardedFetch(`${baseUrl}/models`, { method: "GET", headers });
  if (r.ok) return { ok: true, detail: "Authenticated against OpenAI /v1/models" };
  return fmtFail("OpenAI", r, await extractUpstreamError(r));
}

async function testAnthropic(cfg: Record<string, string>): Promise<TestResult> {
  const key = clean(cfg.api_key);
  if (!key) return { ok: false, detail: "API key is required" };
  const baseUrl = normalizeAnthropicBaseUrl(cfg.base_url);
  const version = cfg.anthropic_version || "2023-06-01";
  // /models requires the same auth and is the cheapest authed call.
  const url = `${baseUrl}/models`;
  let r: Response;
  try {
    r = await guardedFetch(url, {
      method: "GET",
      headers: { "x-api-key": key, "anthropic-version": version },
    });
  } catch (e) {
    const msg = (e as Error)?.message || String(e);
    return { ok: false, detail: `Network error reaching ${url}: ${msg}` };
  }
  if (r.ok) return { ok: true, detail: `Authenticated against Anthropic ${url}` };
  const upstream = await extractUpstreamError(r);
  const detail = upstream && upstream.trim().length > 0 ? upstream : `(no body returned)`;
  return { ok: false, status: r.status, detail: `Anthropic ${r.status} at ${url}: ${detail}` };
}

async function testGemini(cfg: Record<string, string>): Promise<TestResult> {
  const key = clean(cfg.api_key);
  if (!key) return { ok: false, detail: "API key is required" };
  const r = await guardedFetch(
    `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1`,
    {
      method: "GET",
      headers: { "x-goog-api-key": key },
    },
  );
  if (r.ok) return { ok: true, detail: "Authenticated against Google AI Studio" };
  return fmtFail("Gemini", r, await extractUpstreamError(r));
}

async function testGrok(cfg: Record<string, string>): Promise<TestResult> {
  const key = clean(cfg.api_key);
  if (!key) return { ok: false, detail: "API key is required" };
  const baseUrl = (cfg.base_url || "https://api.x.ai/v1").replace(/\/+$/, "");
  const r = await guardedFetch(`${baseUrl}/models`, {
    method: "GET",
    headers: { Authorization: `Bearer ${key}` },
  });
  if (r.ok) return { ok: true, detail: "Authenticated against xAI /v1/models" };
  return fmtFail("Grok", r, await extractUpstreamError(r));
}

async function testOllama(cfg: Record<string, string>): Promise<TestResult> {
  const endpoint = (cfg.endpoint || "").replace(/\/+$/, "");
  if (!endpoint) return { ok: false, detail: "Server URL is required" };
  try {
    // /api/tags returns 200 + list of available models; works without auth.
    const r = await guardedFetch(`${endpoint}/api/tags`, { method: "GET" });
    if (r.ok) {
      const j = (await r.json().catch(() => null)) as { models?: unknown[] } | null;
      const count = Array.isArray(j?.models) ? j!.models!.length : 0;
      return { ok: true, detail: `Reached Ollama (${count} models available)` };
    }
    return fmtFail("Ollama", r, await extractUpstreamError(r));
  } catch (e) {
    return { ok: false, detail: `Could not reach ${endpoint}: ${(e as Error).message}` };
  }
}

async function testOpenRouter(cfg: Record<string, string>): Promise<TestResult> {
  const key = clean(cfg.api_key);
  if (!key) return { ok: false, detail: "API key is required" };
  const baseUrl = (cfg.base_url || "https://openrouter.ai/api/v1").replace(/\/+$/, "");
  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
  if (cfg.http_referer) headers["HTTP-Referer"] = cfg.http_referer;
  if (cfg.app_title) headers["X-Title"] = cfg.app_title;
  // /auth/key returns the key's metadata (limit, usage, label) and requires
  // auth — perfect cheap probe. Falls back to /models on 404.
  const url = `${baseUrl}/auth/key`;
  let r: Response;
  try {
    r = await guardedFetch(url, { method: "GET", headers });
  } catch (e) {
    return { ok: false, detail: `Network error reaching ${url}: ${(e as Error).message}` };
  }
  if (r.status === 404) {
    const fallbackUrl = `${baseUrl}/models`;
    try {
      r = await guardedFetch(fallbackUrl, { method: "GET", headers });
    } catch (e) {
      return {
        ok: false,
        detail: `Network error reaching ${fallbackUrl}: ${(e as Error).message}`,
      };
    }
    if (r.ok) return { ok: true, detail: `Authenticated against OpenRouter ${fallbackUrl}` };
  }
  if (r.ok) {
    const j = (await r.json().catch(() => null)) as {
      data?: { label?: string; usage?: number; limit?: number | null };
    } | null;
    const label = j?.data?.label ? ` (${j.data.label})` : "";
    const usage = typeof j?.data?.usage === "number" ? ` — used $${j.data.usage.toFixed(4)}` : "";
    return { ok: true, detail: `Authenticated with OpenRouter${label}${usage}` };
  }
  const upstream = await extractUpstreamError(r);
  const detail = upstream && upstream.trim().length > 0 ? upstream : "(no body returned)";
  return { ok: false, status: r.status, detail: `OpenRouter ${r.status} at ${url}: ${detail}` };
}

async function testGroq(cfg: Record<string, string>): Promise<TestResult> {
  const key = clean(cfg.api_key);
  if (!key) return { ok: false, detail: "API key is required" };
  const baseUrl = (cfg.base_url || "https://api.groq.com/openai/v1").replace(/\/+$/, "");
  // GET /models is the cheapest authed call on Groq's OpenAI-compat surface.
  const r = await guardedFetch(`${baseUrl}/models`, {
    method: "GET",
    headers: { Authorization: `Bearer ${key}` },
  });
  if (r.ok) {
    const j = (await r.json().catch(() => null)) as { data?: unknown[] } | null;
    const count = Array.isArray(j?.data) ? j!.data!.length : 0;
    return { ok: true, detail: `Authenticated against Groq (${count} models available)` };
  }
  return fmtFail("Groq", r, await extractUpstreamError(r));
}

async function testQwen(cfg: Record<string, string>): Promise<TestResult> {
  const key = clean(cfg.api_key);
  if (!key) return { ok: false, detail: "API key is required" };
  // Default to DashScope International (singapore). Mainland users can
  // override with https://dashscope.aliyuncs.com/compatible-mode/v1
  const baseUrl = (
    cfg.base_url || "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"
  ).replace(/\/+$/, "");
  const url = `${baseUrl}/models`;
  let r: Response;
  try {
    r = await guardedFetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${key}` },
    });
  } catch (e) {
    return { ok: false, detail: `Network error reaching ${url}: ${(e as Error).message}` };
  }
  if (r.ok) {
    const j = (await r.json().catch(() => null)) as { data?: unknown[] } | null;
    const count = Array.isArray(j?.data) ? j!.data!.length : 0;
    return {
      ok: true,
      detail: `Authenticated against Qwen DashScope (${count} models available)`,
    };
  }
  return fmtFail("Qwen", r, await extractUpstreamError(r));
}

async function testVLLM(cfg: Record<string, string>): Promise<TestResult> {
  // vLLM exposes /v1/models on its OpenAI-compatible server. Auth is optional
  // (vLLM only requires it when the operator launched with --api-key).
  const rawBase = (cfg.base_url || "").trim().replace(/\/+$/, "");
  if (!rawBase)
    return { ok: false, detail: "Server URL is required (e.g. http://my-vllm:8000/v1)" };
  if (!/^https?:\/\//i.test(rawBase)) {
    return { ok: false, detail: "URL must start with http:// or https://" };
  }
  const baseUrl = rawBase.endsWith("/v1") ? rawBase : `${rawBase}/v1`;
  const url = `${baseUrl}/models`;
  const headers: Record<string, string> = { Accept: "application/json" };
  const key = clean(cfg.api_key);
  if (key) headers.Authorization = `Bearer ${key}`;
  let r: Response;
  try {
    r = await guardedFetch(url, { method: "GET", headers });
  } catch (e) {
    return { ok: false, detail: `Network error reaching ${url}: ${(e as Error).message}` };
  }
  if (!r.ok) return fmtFail("vLLM", r, await extractUpstreamError(r));
  const j = (await r.json().catch(() => null)) as { data?: { id?: string }[] } | null;
  const models = Array.isArray(j?.data)
    ? (j!.data!.map((m) => m.id).filter(Boolean) as string[])
    : [];
  // If the operator pinned a served-model-name, surface a warning if the
  // first model id from the server doesn't match — but still mark as ok.
  const expected = clean(cfg.served_model_name);
  if (expected && models.length > 0 && !models.includes(expected)) {
    return {
      ok: true,
      detail: `Reached vLLM (${models.length} model(s) served: ${models.slice(0, 3).join(", ")}). Note: served-model-name "${expected}" not in the list — the agent will use whatever it sends.`,
    };
  }
  return {
    ok: true,
    detail: `Reached vLLM (${models.length} model(s): ${models.slice(0, 3).join(", ") || "—"})`,
  };
}

async function testNvidia(cfg: Record<string, string>): Promise<TestResult> {
  // NVIDIA NIM exposes an OpenAI-compatible /v1/models endpoint at
  // https://integrate.api.nvidia.com/v1. Keys are issued at build.nvidia.com
  // and look like `nvapi-...`. GET /v1/models is the cheapest authed probe.
  const key = clean(cfg.api_key);
  if (!key) return { ok: false, detail: "API key is required (get one at build.nvidia.com)" };
  const baseUrl = (cfg.base_url || "https://integrate.api.nvidia.com/v1").replace(/\/+$/, "");
  const url = `${baseUrl}/models`;
  let r: Response;
  try {
    r = await guardedFetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    });
  } catch (e) {
    return { ok: false, detail: `Network error reaching ${url}: ${(e as Error).message}` };
  }
  if (r.ok) {
    const j = (await r.json().catch(() => null)) as { data?: unknown[] } | null;
    const count = Array.isArray(j?.data) ? j!.data!.length : 0;
    return { ok: true, detail: `Authenticated against NVIDIA NIM (${count} models available)` };
  }
  return fmtFail("NVIDIA", r, await extractUpstreamError(r));
}

/** Dispatch a live credential test for an LLM-provider integration. */
export async function runProviderTest(
  provider: string,
  cfg: Record<string, string>,
): Promise<TestResult> {
  switch (provider) {
    case "openai":
      return testOpenAI(cfg);
    case "anthropic":
      return testAnthropic(cfg);
    case "gemini":
      return testGemini(cfg);
    case "grok":
      return testGrok(cfg);
    case "ollama":
      return testOllama(cfg);
    case "openrouter":
      return testOpenRouter(cfg);
    case "groq":
      return testGroq(cfg);
    case "qwen":
      return testQwen(cfg);
    case "vllm":
      return testVLLM(cfg);
    case "nvidia":
      return testNvidia(cfg);
    default:
      return { ok: false, detail: `Unsupported provider: ${provider}` };
  }
}

/** Live-test an n8n instance by hitting GET /api/v1/workflows. */
export async function testN8nCore(cfg: {
  instance_url: string;
  webhook_token?: string;
  auth_type?: string;
}): Promise<TestResult & { workflowCount?: number }> {
  const base = clean(cfg.instance_url).replace(/\/+$/, "");
  if (!base) return { ok: false, detail: "Instance URL is required" };
  if (!/^https?:\/\//i.test(base)) {
    return { ok: false, detail: "URL must start with http:// or https://" };
  }
  const url = `${base}/api/v1/workflows?limit=1`;
  const headers: Record<string, string> = { Accept: "application/json" };
  const token = clean(cfg.webhook_token);
  if (cfg.auth_type === "header" && token) {
    headers["X-N8N-API-KEY"] = token;
  } else if (cfg.auth_type === "basic" && token) {
    headers["Authorization"] = `Basic ${btoa(token)}`;
  }
  try {
    const r = await guardedFetch(url, { method: "GET", headers });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      return {
        ok: false,
        status: r.status,
        detail: `n8n ${r.status}: ${txt.slice(0, 200) || "Check the URL and auth token"}`,
      };
    }
    const j = (await r.json().catch(() => null)) as {
      data?: unknown[];
      nextCursor?: string;
    } | null;
    const count = Array.isArray(j?.data) ? j!.data!.length : 0;
    const more = j?.nextCursor ? "+" : "";
    return {
      ok: true,
      detail: `Reached n8n at ${base} (${count}${more} workflow${count === 1 ? "" : "s"} visible)`,
      workflowCount: count,
    };
  } catch (e) {
    return { ok: false, detail: `Could not reach ${base}: ${(e as Error).message}` };
  }
}

/** Live-test a Firecrawl key with a cheap 1-result search. Fixed host — no SSRF surface. */
export async function testFirecrawlCore(apiKey: string): Promise<TestResult> {
  const key = clean(apiKey);
  if (!key) return { ok: false, detail: "API key is required" };
  try {
    const r = await fetch("https://api.firecrawl.dev/v2/search", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: "agentswarms connection test", limit: 1 }),
      signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
    });
    if (r.status === 401 || r.status === 402 || r.status === 403) {
      const t = await r.text().catch(() => "");
      return {
        ok: false,
        status: r.status,
        detail:
          r.status === 402
            ? `Firecrawl key valid but out of credits: ${t.slice(0, 160)}`
            : "Firecrawl rejected the API key (unauthorized). Check the key.",
      };
    }
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      return { ok: false, status: r.status, detail: `Firecrawl ${r.status}: ${t.slice(0, 200)}` };
    }
    return {
      ok: true,
      detail: "Firecrawl key is valid — web_search and web_browse are ready.",
    };
  } catch (e) {
    return { ok: false, detail: `Could not reach Firecrawl: ${(e as Error).message}` };
  }
}

/**
 * Live-test an LLM gateway (LiteLLM / Portkey / Helicone / custom) via the
 * OpenAI-compat GET /models probe, with the same base URL + bearer key the
 * chat path will use — so a pass here means real traffic will authenticate.
 *
 * 404/405 on /models is tolerated (ok with a caveat): some passthrough
 * gateways only implement /chat/completions, and blocking those setups would
 * be a false negative. Auth failures and unreachable hosts are hard failures.
 */
export async function testGatewayCore(cfg: {
  base_url: string;
  api_key: string;
  provider?: string;
}): Promise<TestResult> {
  const base = clean(cfg.base_url).replace(/\/+$/, "");
  if (!base) return { ok: false, detail: "Gateway base URL is required" };
  if (!/^https?:\/\//i.test(base)) {
    return { ok: false, detail: "URL must start with http:// or https://" };
  }
  const key = clean(cfg.api_key);
  if (!key) return { ok: false, detail: "Gateway API key is required" };
  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    Accept: "application/json",
  };
  // Portkey also reads its own header; sending both is harmless elsewhere
  // but only added when the user picked Portkey to avoid confusing gateways
  // that reject unknown auth headers.
  if (cfg.provider === "portkey") headers["x-portkey-api-key"] = key;
  const url = `${base}/models`;
  let r: Response;
  try {
    r = await guardedFetch(url, { method: "GET", headers });
  } catch (e) {
    return { ok: false, detail: `Network error reaching ${url}: ${(e as Error).message}` };
  }
  if (r.ok) {
    const j = (await r.json().catch(() => null)) as { data?: unknown[] } | null;
    const count = Array.isArray(j?.data) ? j!.data!.length : 0;
    return {
      ok: true,
      detail: `Gateway authenticated at ${url}${count ? ` (${count} models routed)` : ""}`,
    };
  }
  if (r.status === 404 || r.status === 405) {
    return {
      ok: true,
      detail: `Gateway reachable at ${base} (HTTP ${r.status} on /models — this gateway doesn't list models; chat completions should still work)`,
    };
  }
  if (r.status === 401 || r.status === 403) {
    return fmtFail("Gateway", r, await extractUpstreamError(r));
  }
  return fmtFail("Gateway", r, await extractUpstreamError(r));
}
