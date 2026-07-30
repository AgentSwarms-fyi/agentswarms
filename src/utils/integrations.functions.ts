// Server functions for the Integrations page: live credential validation and
// the encrypted save path.
//
// IMPORTANT: this file is bundled into client routes — the actual test
// adapters (which pull in the SSRF guard / node:dns) live in
// utils/integrations/testAdapters.server.ts and are dynamic-imported inside
// handlers only, so they never reach the browser bundle.

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

const FirecrawlTestSchema = z.object({
  access_token: z.string().min(1).max(10000),
  api_key: z.string().min(1).max(2000),
});

const GatewayTestSchema = z.object({
  access_token: z.string().min(1).max(10000),
  base_url: z.string().min(1).max(500),
  // Blank means "test with the previously-saved (encrypted) key".
  api_key: z.string().max(2000).default(""),
  provider: z.string().max(60).default("litellm"),
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

/**
 * Per-user rate limit shared by every connection-test endpoint. The tests
 * fetch user-supplied URLs from inside the server's network (SSRF-guarded,
 * but still an oracle), so an authed user must not get an unthrottled probe
 * loop. In-process sliding window — per instance, like every other limit in
 * the OSS build. Returns a TestResult to surface, or null to proceed.
 */
export async function integrationTestGate(userId: string): Promise<TestResult | null> {
  const { rateLimited, envInt } = await import("./rateLimit.server");
  if (rateLimited(`integration-test:${userId}`, envInt("INTEGRATION_TEST_PER_MINUTE", 10))) {
    return {
      ok: false,
      detail: "Too many connection tests in the last minute — wait a moment and try again.",
    };
  }
  return null;
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
    const limited = await integrationTestGate(auth.userId);
    if (limited) return limited;
    // Server-side log so we can see exactly which provider was tested and
    // what came back. Visible in dev-server.log + worker logs.
    console.log(
      `[testIntegrationKey] user=${auth.userId} provider=${data.provider} keys=${Object.keys(data.config).join(",")}`,
    );
    try {
      const { runProviderTest } = await import("./integrations/testAdapters.server");
      const result = await runProviderTest(data.provider, data.config);
      console.log(
        `[testIntegrationKey] provider=${data.provider} ok=${result.ok} detail=${result.detail.slice(0, 200)}`,
      );
      return result;
    } catch (e) {
      // Surface the full error including name so the user sees something
      // actionable instead of a blank "Could not connect" message.
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
    const limited = await integrationTestGate(auth.userId);
    if (limited) return limited;
    const { testN8nCore } = await import("./integrations/testAdapters.server");
    return testN8nCore({
      instance_url: data.instance_url,
      webhook_token: data.webhook_token,
      auth_type: data.auth_type,
    });
  });

// Live-test a Firecrawl API key with a cheap 1-result search so the user knows
// the key works before we mark the connector active.
export const testFirecrawlKey = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => FirecrawlTestSchema.parse(input))
  .handler(async ({ data }): Promise<TestResult> => {
    const auth = await validateAccessToken(data.access_token);
    if (!auth.ok) return { ok: false, detail: auth.detail };
    const limited = await integrationTestGate(auth.userId);
    if (limited) return limited;
    const { testFirecrawlCore } = await import("./integrations/testAdapters.server");
    return testFirecrawlCore(data.api_key);
  });

// Live-test an LLM gateway with the same base URL + key the chat path will
// use. The gateway was the only connector saved without a real roundtrip —
// backwards, given that a misconfigured gateway can take EVERY routed LLM
// call down at once. A blank api_key tests against the saved encrypted key.
export const testLlmGateway = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => GatewayTestSchema.parse(input))
  .handler(async ({ data }): Promise<TestResult> => {
    const auth = await validateAccessToken(data.access_token);
    if (!auth.ok) return { ok: false, detail: auth.detail };
    const limited = await integrationTestGate(auth.userId);
    if (limited) return limited;
    let apiKey = data.api_key.trim();
    if (!apiKey) {
      // Fall back to the stored (encrypted) key so users can re-validate
      // without re-typing it.
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { resolveIntegrationConfig } = await import("./providers/integrationConfig.server");
      const { data: row } = await supabaseAdmin
        .from("integrations")
        .select("config")
        .eq("user_id", auth.userId)
        .eq("type", "llm_gateway")
        .maybeSingle();
      if (row?.config) {
        const cfg = (await resolveIntegrationConfig(
          auth.userId,
          "llm_gateway",
          row.config as Record<string, unknown>,
        )) as { api_key?: string };
        apiKey = (cfg.api_key ?? "").trim();
      }
      if (!apiKey) return { ok: false, detail: "No gateway API key entered or saved yet." };
    }
    const { testGatewayCore } = await import("./integrations/testAdapters.server");
    return testGatewayCore({
      base_url: data.base_url,
      api_key: apiKey,
      provider: data.provider,
    });
  });

// Live-test a notification channel by posting a visible test message to the
// webhook — the same payload builder real sends use.
const NotificationTestSchema = z.object({
  access_token: z.string().min(1).max(10000),
  provider: z.enum(["slack", "teams", "discord", "webhook"]),
  webhook_url: z.string().max(1000).default(""),
});

export const testNotificationChannel = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => NotificationTestSchema.parse(input))
  .handler(async ({ data }): Promise<TestResult> => {
    const auth = await validateAccessToken(data.access_token);
    if (!auth.ok) return { ok: false, detail: auth.detail };
    const limited = await integrationTestGate(auth.userId);
    if (limited) return limited;
    let url = data.webhook_url.trim();
    if (!url) {
      // Blank = re-validate the saved (encrypted) webhook URL.
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { resolveIntegrationConfig } = await import("./providers/integrationConfig.server");
      const { data: row } = await supabaseAdmin
        .from("integrations")
        .select("config")
        .eq("user_id", auth.userId)
        .eq("type", "notification")
        .eq("provider", data.provider)
        .maybeSingle();
      if (row?.config) {
        const cfg = (await resolveIntegrationConfig(
          auth.userId,
          "notification",
          row.config as Record<string, unknown>,
        )) as { webhook_url?: string };
        url = (cfg.webhook_url ?? "").trim();
      }
      if (!url) return { ok: false, detail: "No webhook URL entered or saved yet." };
    }
    const { testNotificationCore } = await import("./integrations/testAdapters.server");
    return testNotificationCore(data.provider, url);
  });

// LLM credentials shared WITH the signed-in user via IAM grants. Names and
// owner emails only — the grantee can use a shared key (resolution happens
// server-side at call time) but can never read it.
export const listSharedProviders = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ access_token: z.string().min(1).max(10000) }).parse(input),
  )
  .handler(
    async ({
      data,
    }): Promise<
      { ok: true; shared: { provider: string; owner_email: string | null }[] } | { ok: false }
    > => {
      const auth = await validateAccessToken(data.access_token);
      if (!auth.ok) return { ok: false };
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { resolveGrantedResourceIds } = await import("./iam.server");
      const [integIds, credIds] = await Promise.all([
        resolveGrantedResourceIds(supabaseAdmin, auth.userId, "integration"),
        resolveGrantedResourceIds(supabaseAdmin, auth.userId, "provider_credential"),
      ]);
      const shared: { provider: string; owner: string }[] = [];
      if (integIds.size > 0) {
        const { data: rows } = await supabaseAdmin
          .from("integrations")
          .select("provider, user_id")
          .in("id", [...integIds])
          .eq("type", "llm_provider")
          .eq("is_active", true);
        for (const r of rows ?? [])
          if (r.provider && r.user_id !== auth.userId)
            shared.push({ provider: r.provider, owner: r.user_id });
      }
      if (credIds.size > 0) {
        const { data: rows } = await supabaseAdmin
          .from("provider_credentials")
          .select("provider, user_id")
          .in("id", [...credIds]);
        for (const r of rows ?? [])
          if (r.user_id !== auth.userId)
            // The UI uses "vertex_ai" where the API uses "vertex".
            shared.push({
              provider: r.provider === "vertex" ? "vertex_ai" : r.provider,
              owner: r.user_id,
            });
      }
      // Resolve owner emails (few distinct owners; bounded lookups).
      const owners = [...new Set(shared.map((s) => s.owner))].slice(0, 20);
      const emailById = new Map<string, string | null>();
      await Promise.all(
        owners.map(async (id) => {
          try {
            const { data: u } = await supabaseAdmin.auth.admin.getUserById(id);
            emailById.set(id, u.user?.email ?? null);
          } catch {
            emailById.set(id, null);
          }
        }),
      );
      return {
        ok: true,
        shared: shared.map((s) => ({
          provider: s.provider,
          owner_email: emailById.get(s.owner) ?? null,
        })),
      };
    },
  );

// Save an integration row with any secret config field (api_key /
// webhook_token) encrypted at rest. The browser used to write integrations
// directly in plaintext; it now posts here. Leaving a secret field blank on an
// update keeps the previously-stored (encrypted) value, so users can edit
// non-secret fields without re-typing keys.
const SaveIntegrationSchema = z.object({
  access_token: z.string().min(1).max(10000),
  id: z.string().uuid().optional(),
  type: z.string().min(1).max(60),
  provider: z.string().max(60).default(""),
  name: z.string().max(120).default(""),
  config: z.record(z.string(), z.any()).default({}),
  is_active: z.boolean().default(true),
});

/** Types that must have at most one row per user (per provider for llm_provider). */
const SINGLETON_TYPES = new Set(["llm_gateway", "n8n", "firecrawl"]);

/**
 * Non-secret facts about a save, for the audit trail. URLs are where traffic
 * goes (audit-worthy); key VALUES never appear — only whether one was rotated.
 */
function auditDetailFor(
  type: string,
  config: Record<string, unknown>,
  secretFields: string[],
): Record<string, unknown> {
  const detail: Record<string, unknown> = {};
  for (const k of ["base_url", "instance_url", "endpoint", "provider", "auth_type"]) {
    const v = config[k];
    if (typeof v === "string" && v) detail[k] = v.slice(0, 300);
  }
  detail.secret_rotated = secretFields.some((f) => {
    const v = config[f];
    return typeof v === "string" && v.length > 0;
  });
  return detail;
}

/**
 * Core of saveIntegration, after authentication. Exported as a plain function
 * so the save/upsert/audit logic is directly testable; only ever call it with
 * a userId your caller has verified.
 */
export async function saveIntegrationForUser(
  userId: string,
  data: Omit<z.infer<typeof SaveIntegrationSchema>, "access_token">,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { encryptIntegrationConfig, preserveBlankSecrets, integrationSecretFields } =
    await import("./providers/integrationConfig.server");
  const { auditEvent } = await import("./audit.server");

  // Resolve the row this save targets. When the client passes no id (or a
  // stale one), fall back to the singleton lookup by (type[, provider]) —
  // this is what makes "blank secret keeps the saved key" work on every
  // path and what prevents duplicate rows from ever being created (the
  // partial unique indexes are the backstop, not the mechanism).
  let targetId: string | null = null;
  let existingConfig: Record<string, unknown> | null = null;
  if (data.id) {
    const { data: ex } = await supabaseAdmin
      .from("integrations")
      .select("id, config")
      .eq("id", data.id)
      .eq("user_id", userId)
      .maybeSingle();
    if (ex) {
      targetId = ex.id;
      existingConfig = (ex.config ?? null) as Record<string, unknown> | null;
    }
  }
  if (!targetId && (SINGLETON_TYPES.has(data.type) || data.type === "llm_provider")) {
    let q = supabaseAdmin
      .from("integrations")
      .select("id, config")
      .eq("user_id", userId)
      .eq("type", data.type);
    if (data.type === "llm_provider") q = q.eq("provider", data.provider);
    const { data: rows } = await q
      .order("is_active", { ascending: false })
      .order("updated_at", { ascending: false })
      .limit(1);
    if (rows && rows.length > 0) {
      targetId = rows[0].id;
      existingConfig = (rows[0].config ?? null) as Record<string, unknown> | null;
    }
  }

  // Detect a rotated secret BEFORE encryption moves it out of the field.
  const detail = auditDetailFor(
    data.type,
    data.config as Record<string, unknown>,
    integrationSecretFields(data.type),
  );

  let cfg = await encryptIntegrationConfig(data.type, data.config as Record<string, unknown>);
  cfg = preserveBlankSecrets(data.type, cfg, existingConfig);

  const row = {
    config: cfg,
    is_active: data.is_active,
    name: data.name,
    provider: data.provider,
    type: data.type,
  };

  let savedId = targetId;
  if (targetId) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabaseAdmin.from("integrations") as any)
      .update(row)
      .eq("id", targetId)
      .eq("user_id", userId);
    if (error) return { ok: false, error: error.message };
  } else {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ins = await (supabaseAdmin.from("integrations") as any)
      .insert({ user_id: userId, ...row })
      .select("id")
      .single();
    if (ins.error) {
      // Unique-violation race (two concurrent saves): the other writer won
      // the insert — retry once as an update of that row.
      if (ins.error.code === "23505") {
        let rq = supabaseAdmin
          .from("integrations")
          .select("id")
          .eq("user_id", userId)
          .eq("type", data.type);
        if (data.type === "llm_provider") rq = rq.eq("provider", data.provider);
        const { data: winner } = await rq.limit(1).maybeSingle();
        if (winner) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const { error: updErr } = await (supabaseAdmin.from("integrations") as any)
            .update(row)
            .eq("id", winner.id)
            .eq("user_id", userId);
          if (updErr) return { ok: false, error: updErr.message };
          savedId = winner.id;
        } else {
          return { ok: false, error: ins.error.message };
        }
      } else {
        return { ok: false, error: ins.error.message };
      }
    } else {
      savedId = ins.data.id as string;
    }
  }

  // Service-role writes skip the client-write DB trigger by design, so
  // this path MUST self-audit — connecting a provider key or repointing
  // the gateway URL (where prompts get sent) has to leave a trail.
  auditEvent({
    userId,
    action: targetId ? "integration.update" : "integration.create",
    resourceType: "integration",
    resourceId: savedId ?? undefined,
    resourceName: data.name || data.type,
    detail: { type: data.type, is_active: data.is_active, ...detail },
  });
  return { ok: true, id: savedId! };
}

export const saveIntegration = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => SaveIntegrationSchema.parse(input))
  .handler(async ({ data }): Promise<{ ok: true; id: string } | { ok: false; error: string }> => {
    const auth = await validateAccessToken(data.access_token);
    if (!auth.ok) return { ok: false, error: auth.detail };
    return saveIntegrationForUser(auth.userId, data);
  });

// Post-turn notification to an agent's n8n webhook. Called from server-side
// handlers after an assistant reply so workflows can log, route, or react to
// the conversation.
//
// Delivery semantics: the payload carries prompt + response, so the receiver
// should be able to VERIFY it actually came from this server — when the
// operator sets WEBHOOK_SIGNING_SECRET, every delivery is HMAC-signed
// (X-AgentSwarms-Signature: v1=hex(hmac_sha256(secret, "<ts>.<body>")),
// X-AgentSwarms-Timestamp: <ms epoch>). One retry on network error / 5xx with
// a short backoff; 4xx never retries (the receiver rejected it). The whole
// call stays inside the request lifetime, so the budget is deliberately tight.
export async function notifyN8nWebhook(opts: {
  webhookUrl: string;
  authHeader?: string | null;
  payload: Record<string, unknown>;
  timeoutMs?: number;
}): Promise<{ ok: boolean; status?: number; detail?: string }> {
  const url = (opts.webhookUrl || "").trim();
  if (!url) return { ok: false, detail: "No webhook URL" };
  const body = JSON.stringify(opts.payload);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.authHeader) headers["Authorization"] = opts.authHeader;
  const secret = (process.env.WEBHOOK_SIGNING_SECRET ?? "").trim();
  if (secret) {
    const { createHmac } = await import("node:crypto");
    const ts = Date.now().toString();
    headers["X-AgentSwarms-Timestamp"] = ts;
    headers["X-AgentSwarms-Signature"] =
      "v1=" + createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
  }
  // SSRF-guarded (the webhook URL is user-authored) with its own short budget.
  const { guardedFetch } = await import("./integrations/testAdapters.server");
  let lastDetail = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 500));
    try {
      const r = await guardedFetch(url, { method: "POST", headers, body }, opts.timeoutMs ?? 5000);
      if (r.ok || r.status < 500) return { ok: r.ok, status: r.status };
      lastDetail = `HTTP ${r.status}`;
    } catch (e) {
      lastDetail = (e as Error).message;
    }
  }
  return { ok: false, detail: lastDetail };
}
