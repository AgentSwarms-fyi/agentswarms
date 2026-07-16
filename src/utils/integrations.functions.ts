// Real validation of the API keys saved on the Integrations page.
// Each adapter performs the cheapest possible upstream call (1 token, no
// stream) so we know the credentials actually work before we mark the
// row as `is_active = true`. Errors are surfaced to the UI so the user can
// fix typos / wrong endpoints before any agent tries to use the provider.

import { createClient } from "@supabase/supabase-js";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { Database } from "@/integrations/supabase/types";

// Providers we support live-testing for.
const ProviderEnum = z.enum([
  "openai",
  "anthropic",
  "gemini",
  "grok",
  "ollama",
  "openrouter",
  "groq",
  "qwen",
  "vllm",
  "nvidia",
]);

const TestSchema = z.object({
  provider: ProviderEnum,
  access_token: z.string().min(1).max(10000),
  // Allow empty strings AND undefined values from optional form fields.
  // Without this, any blank optional field (e.g. OpenRouter http_referer)
  // would make Zod reject the whole payload with no useful error reaching
  // the client — surfaced as the infamous "ok=false but no detail".
  config: z.record(z.string(), z.string().max(20000).optional()).default({}),
});

const N8nTestSchema = z.object({
  access_token: z.string().min(1).max(10000),
  instance_url: z.string().min(1).max(500),
  webhook_token: z.string().max(2000).default(""),
  auth_type: z.enum(["header", "basic", "none"]).default("header"),
});

type TestResult = { ok: true; detail: string } | { ok: false; detail: string; status?: number };

type AuthResult = { ok: true; userId: string } | { ok: false; detail: string };

async function validateAccessToken(accessToken: unknown): Promise<AuthResult> {
  const token = typeof accessToken === "string" ? accessToken.trim() : "";
  if (!token) return { ok: false, detail: "You must be signed in to test integrations" };

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) {
    return { ok: false, detail: "Server auth configuration is missing" };
  }

  const supabase = createClient<Database>(url, key, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await supabase.auth.getClaims(token);
  if (error || !data?.claims?.sub) {
    return { ok: false, detail: "Your session is invalid or expired. Please sign in again." };
  }

  return { ok: true, userId: data.claims.sub };
}

function clean(v: unknown): string {
  if (typeof v !== "string") return "";
  return v
    .trim()
    .replace(/^Bearer\s+/i, "")
    .replace(/^key=/i, "")
    .replace(/^["']+|["']+$/g, "");
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
async function extractUpstreamError(r: Response): Promise<string> {
  const raw = await r.text().catch(() => "");
  if (!raw) return `HTTP ${r.status} ${r.statusText || ""}`.trim();
  // Try JSON first.
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
  const r = await fetch(`${baseUrl}/models`, { method: "GET", headers });
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
  console.log(`[testAnthropic] GET ${url} (version=${version}, keyPrefix=${key.slice(0, 10)}…)`);
  let r: Response;
  try {
    r = await fetch(url, {
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
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=1`, {
    method: "GET",
    headers: { "x-goog-api-key": key },
  });
  if (r.ok) return { ok: true, detail: "Authenticated against Google AI Studio" };
  return fmtFail("Gemini", r, await extractUpstreamError(r));
}

async function testGrok(cfg: Record<string, string>): Promise<TestResult> {
  const key = clean(cfg.api_key);
  if (!key) return { ok: false, detail: "API key is required" };
  const baseUrl = (cfg.base_url || "https://api.x.ai/v1").replace(/\/+$/, "");
  const r = await fetch(`${baseUrl}/models`, {
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
    const r = await fetch(`${endpoint}/api/tags`, { method: "GET" });
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
  console.log(`[testOpenRouter] GET ${url} (keyPrefix=${key.slice(0, 12)}…)`);
  let r: Response;
  try {
    r = await fetch(url, { method: "GET", headers });
  } catch (e) {
    return { ok: false, detail: `Network error reaching ${url}: ${(e as Error).message}` };
  }
  if (r.status === 404) {
    const fallbackUrl = `${baseUrl}/models`;
    try {
      r = await fetch(fallbackUrl, { method: "GET", headers });
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
  const r = await fetch(`${baseUrl}/models`, {
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
  // GET /models works on the OpenAI-compatible endpoint and is the cheapest
  // authed probe — same pattern we use for OpenAI/Grok/Groq.
  const url = `${baseUrl}/models`;
  console.log(`[testQwen] GET ${url} (keyPrefix=${key.slice(0, 8)}…)`);
  let r: Response;
  try {
    r = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${key}` },
    });
  } catch (e) {
    return { ok: false, detail: `Network error reaching ${url}: ${(e as Error).message}` };
  }
  if (r.ok) {
    const j = (await r.json().catch(() => null)) as { data?: unknown[] } | null;
    const count = Array.isArray(j?.data) ? j!.data!.length : 0;
    return { ok: true, detail: `Authenticated against Qwen DashScope (${count} models available)` };
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
  console.log(`[testVLLM] GET ${url} (auth=${key ? "yes" : "no"})`);
  let r: Response;
  try {
    r = await fetch(url, { method: "GET", headers });
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
  console.log(`[testNvidia] GET ${url} (keyPrefix=${key.slice(0, 10)}…)`);
  let r: Response;
  try {
    r = await fetch(url, {
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

type ValidatedInput =
  | { __validationError: true; detail: string }
  | {
      __validationError?: undefined;
      provider: z.infer<typeof ProviderEnum>;
      access_token: string;
      config: Record<string, string>;
    };

export const testIntegrationKey = createServerFn({ method: "POST" })
  // Wrap parse in try/catch so a Zod failure returns a TestResult instead
  // of throwing — otherwise the client sees the raw error and shows the
  // infamous "Server returned ok=false but no detail".
  .inputValidator((input: unknown): ValidatedInput => {
    const parsed = TestSchema.safeParse(input);
    if (!parsed.success) {
      return {
        __validationError: true,
        detail: `Input validation failed: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
      };
    }
    // Strip empty string + undefined values so adapters get a clean config.
    const cleaned: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed.data.config)) {
      if (typeof v === "string" && v.length > 0) cleaned[k] = v;
    }
    return {
      provider: parsed.data.provider,
      access_token: parsed.data.access_token,
      config: cleaned,
    };
  })
  .handler(async ({ data }): Promise<TestResult> => {
    if (data.__validationError) {
      console.error(`[testIntegrationKey] validation failed: ${data.detail}`);
      return { ok: false, detail: data.detail };
    }
    const auth = await validateAccessToken(data.access_token);
    if (!auth.ok) return { ok: false, detail: auth.detail };
    // Server-side log so we can see exactly which provider was tested and
    // what came back. Visible in dev-server.log + worker logs.
    console.log(
      `[testIntegrationKey] user=${auth.userId} provider=${data.provider} keys=${Object.keys(data.config).join(",")}`,
    );
    try {
      let result: TestResult;
      switch (data.provider) {
        case "openai":
          result = await testOpenAI(data.config);
          break;
        case "anthropic":
          result = await testAnthropic(data.config);
          break;
        case "gemini":
          result = await testGemini(data.config);
          break;
        case "grok":
          result = await testGrok(data.config);
          break;
        case "ollama":
          result = await testOllama(data.config);
          break;
        case "openrouter":
          result = await testOpenRouter(data.config);
          break;
        case "groq":
          result = await testGroq(data.config);
          break;
        case "qwen":
          result = await testQwen(data.config);
          break;
        case "vllm":
          result = await testVLLM(data.config);
          break;
        case "nvidia":
          result = await testNvidia(data.config);
          break;
        default:
          // Should be unreachable thanks to the Zod enum, but explicit is safer
          // than returning undefined and showing the user an empty error.
          result = { ok: false, detail: `Unsupported provider: ${String(data.provider)}` };
      }
      console.log(
        `[testIntegrationKey] provider=${data.provider} ok=${result.ok} detail=${result.detail.slice(0, 200)}`,
      );
      return result;
    } catch (e) {
      // Surface the full error including name + stack head so the user sees
      // something actionable instead of a blank "Could not connect" message.
      const err = e as Error;
      const name = err?.name || "Error";
      const msg = err?.message || String(e);
      const detail = `${name}: ${msg}`;
      console.error(`[testIntegrationKey] threw for provider=${data.provider}:`, err);
      return { ok: false, detail };
    }
  });

// Live-test an n8n instance by hitting GET /api/v1/workflows. The returned
// workflow count is surfaced in the UI so the user knows the integration
// is real and what's reachable.
export const testN8nInstance = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => N8nTestSchema.parse(input))
  .handler(async ({ data }): Promise<TestResult & { workflowCount?: number }> => {
    const auth = await validateAccessToken(data.access_token);
    if (!auth.ok) return { ok: false, detail: auth.detail };
    const base = clean(data.instance_url).replace(/\/+$/, "");
    if (!base) return { ok: false, detail: "Instance URL is required" };
    if (!/^https?:\/\//i.test(base)) {
      return { ok: false, detail: "URL must start with http:// or https://" };
    }
    const url = `${base}/api/v1/workflows?limit=1`;
    const headers: Record<string, string> = { Accept: "application/json" };
    const token = clean(data.webhook_token);
    if (data.auth_type === "header" && token) {
      headers["X-N8N-API-KEY"] = token;
    } else if (data.auth_type === "basic" && token) {
      headers["Authorization"] = `Basic ${btoa(token)}`;
    }
    try {
      const r = await fetch(url, { method: "GET", headers });
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
      // The /workflows endpoint paginates — if there's a nextCursor there are more.
      // We just confirm reachability + auth here.
      const more = j?.nextCursor ? "+" : "";
      return {
        ok: true,
        detail: `Reached n8n at ${base} (${count}${more} workflow${count === 1 ? "" : "s"} visible)`,
        workflowCount: count,
      };
    } catch (e) {
      return { ok: false, detail: `Could not reach ${base}: ${(e as Error).message}` };
    }
  });

// Fire-and-forget post-turn notification to an agent's n8n webhook. Called
// from server-side handlers after an assistant reply so workflows can log,
// route, or react to the conversation.
export async function notifyN8nWebhook(opts: {
  webhookUrl: string;
  authHeader?: string | null;
  payload: Record<string, unknown>;
  timeoutMs?: number;
}): Promise<{ ok: boolean; status?: number; detail?: string }> {
  const url = (opts.webhookUrl || "").trim();
  if (!url) return { ok: false, detail: "No webhook URL" };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 5000);
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (opts.authHeader) headers["Authorization"] = opts.authHeader;
    const r = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(opts.payload),
      signal: ctrl.signal,
    });
    return { ok: r.ok, status: r.status };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  } finally {
    clearTimeout(t);
  }
}
