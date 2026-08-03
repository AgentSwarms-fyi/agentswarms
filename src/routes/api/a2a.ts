// Server-side proxy for the A2A (Agent-to-Agent) protocol.
//
// Two actions:
//   - discover: GET <endpoint>/.well-known/agent-card.json, validates shape
//   - invoke:   POST JSON-RPC message/send (or message/stream) to the remote
//               A2A server, optionally forwarding the user-supplied auth header.
//
// Why a proxy:
//   1) Browser CORS — most A2A servers don't set permissive CORS headers.
//   2) SSRF protection — we block requests to private/internal hostnames.
//   3) Centralised auth — only signed-in users may invoke.

import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import type { AgentCard, A2AMessage, Task } from "@/lib/a2aClient";
import { assertPublicUrl, safeFetch } from "@/utils/ssrfGuard.server";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const REQUEST_TIMEOUT_MS = 60_000;

function jsonResponse(body: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders, ...extraHeaders },
  });
}

async function getUserId(request: Request): Promise<string | null> {
  const auth = request.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  const token = auth.slice(7);
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return null;
  const sb = createClient<Database>(url, key, {
    auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
  });
  const { data } = await sb.auth.getClaims(token);
  return data?.claims?.sub ?? null;
}

// ───────────────────── SSRF guard ─────────────────────
// Delegated to utils/ssrfGuard.server. This file used to carry its own
// hostname check, and the copy had fallen behind the original in ways that
// mattered:
//
//   * NO DNS RESOLUTION. It matched on the literal hostname, so a name whose
//     A record points at 169.254.169.254 sailed through — and this endpoint
//     RETURNS the upstream body to the caller, making that a read of cloud
//     instance metadata, which hands out the host's IAM credentials.
//   * NO REDIRECT VALIDATION. All three fetches followed redirects by default,
//     so a public URL could 302 into the same place.
//   * ::ffff:a9fe:a9fe — the compressed IPv4-mapped spelling of
//     169.254.169.254 — was not recognised. The canonical guard documents this
//     exact case as a bug it already found and fixed; the copy never got it.
//   * Missing the unspecified address (::) and CGNAT (100.64.0.0/10).
//
// blockPrivate: true keeps THIS route's stricter policy. The shared guard
// permits ordinary private networks by default because self-hosted model
// servers and in-cluster MCP live there; a proxy that returns the response to
// a browser is a different proposition, and refusing them here is what the
// inline version did.
const A2A_FETCH = { blockPrivate: true, maxRedirects: 3 } as const;

async function validateRemoteUrl(
  rawUrl: string,
): Promise<{ ok: true; url: URL } | { ok: false; error: string }> {
  const r = await assertPublicUrl(rawUrl, { blockPrivate: true });
  return r.ok ? r : { ok: false, error: r.error };
}

// ───────────────────── Discovery ─────────────────────
function looksLikeAgentCard(x: unknown): x is AgentCard {
  if (!x || typeof x !== "object") return false;
  const c = x as Record<string, unknown>;
  // Required by both legacy and current A2A spec: name + url + skills[].
  // version/capabilities are sometimes omitted by minimal servers — accept anyway.
  return typeof c.name === "string" && typeof c.url === "string" && Array.isArray(c.skills);
}

async function handleDiscover(payload: { endpoint?: string }): Promise<Response> {
  if (!payload.endpoint) return jsonResponse({ error: "endpoint is required" }, 400);
  const v = await validateRemoteUrl(payload.endpoint);
  if (!v.ok) return jsonResponse({ error: v.error }, 400);

  // The card may live at one of several well-known paths. The current A2A spec
  // uses /.well-known/agent-card.json, but many deployed servers (and the
  // a2aprotocol.ai validator) still use /.well-known/agent.json.
  // If the user pasted an exact card URL, try that exact URL first, then its
  // sibling filename in the same directory, then fall back to base/root paths.
  const candidates: string[] = [];
  const base = v.url;
  const baseHref = base.href.replace(/[?#].*$/, "").replace(/\/$/, "");
  const wellKnownNames = ["agent-card.json", "agent.json"];
  const pushCandidate = (candidate: string) => {
    if (candidate && !candidates.includes(candidate)) candidates.push(candidate);
  };
  const exactCardMatch = base.pathname.match(/^(.*\/\.well-known\/)(agent(?:-card)?\.json)$/i);

  // 1) If the user pasted the full card URL, hit it directly first and then
  // try the sibling filename in the same directory.
  if (exactCardMatch) {
    pushCandidate(base.href);
    const siblingName = exactCardMatch[2] === "agent-card.json" ? "agent.json" : "agent-card.json";
    pushCandidate(new URL(`${exactCardMatch[1]}${siblingName}`, base.origin).href);
  }

  // 2) If the pasted URL was not an exact card URL, treat it as the agent base.
  if (!exactCardMatch) {
    for (const name of wellKnownNames) {
      pushCandidate(`${baseHref}/.well-known/${name}`);
    }
  }

  // 3) Fall back to the host root /.well-known/<name>.
  for (const name of wellKnownNames) {
    pushCandidate(`${base.origin}/.well-known/${name}`);
  }

  let lastError = "Agent card not found";
  for (const candidate of candidates) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10_000);
    try {
      const r = await safeFetch(candidate, {
        ...A2A_FETCH,
        method: "GET",
        headers: { Accept: "application/json" },
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (!r.ok) {
        lastError = `Agent card fetch failed at ${candidate} (${r.status})`;
        continue;
      }
      const json = await r.json().catch(() => null);
      if (!looksLikeAgentCard(json)) {
        lastError = `Response from ${candidate} is not a valid Agent Card (missing required fields)`;
        continue;
      }
      return jsonResponse({ card: json });
    } catch (e) {
      clearTimeout(t);
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  return jsonResponse({ error: `${lastError}. Tried: ${candidates.join(", ")}` }, 502);
}

// ───────────────────── Invocation ─────────────────────
interface InvokePayload {
  endpoint?: string;
  message?: A2AMessage;
  skillId?: string;
  remoteAuthHeader?: string;
  stream?: boolean;
}

async function resolveRpcUrl(
  rawEndpoint: string,
): Promise<{ ok: true; url: URL } | { ok: false; error: string }> {
  const v = await validateRemoteUrl(rawEndpoint);
  if (!v.ok) return v;

  // If the user pasted the agent-card URL itself, fetch it and use its `url`
  // field as the JSON-RPC endpoint (per A2A spec). Otherwise use the URL as-is.
  const isCardUrl = /\/\.well-known\/agent(?:-card)?\.json$/i.test(v.url.pathname);
  if (!isCardUrl) return { ok: true, url: v.url };

  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10_000);
    const r = await safeFetch(v.url.href, {
      ...A2A_FETCH,
      headers: { Accept: "application/json" },
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!r.ok) return { ok: false, error: `Could not re-fetch agent card (${r.status})` };
    const card = (await r.json().catch(() => null)) as AgentCard | null;
    if (!card?.url || typeof card.url !== "string") {
      return { ok: false, error: "Agent card is missing a 'url' field for the RPC endpoint" };
    }
    const v2 = await validateRemoteUrl(card.url);
    if (!v2.ok) return v2;
    return { ok: true, url: v2.url };
  } catch (e) {
    return {
      ok: false,
      error: `Failed to resolve RPC URL: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

async function handleInvoke(payload: InvokePayload): Promise<Response> {
  if (!payload.endpoint) return jsonResponse({ error: "endpoint is required" }, 400);
  if (!payload.message || !Array.isArray(payload.message.parts)) {
    return jsonResponse({ error: "message with parts[] is required" }, 400);
  }
  const resolved = await resolveRpcUrl(payload.endpoint);
  if (!resolved.ok) return jsonResponse({ error: resolved.error }, 400);
  const v = { ok: true as const, url: resolved.url };

  const method = payload.stream ? "message/stream" : "message/send";
  const rpcBody = {
    jsonrpc: "2.0" as const,
    id: `rpc_${Date.now()}`,
    method,
    params: {
      message: payload.message,
      ...(payload.skillId ? { metadata: { skillId: payload.skillId } } : {}),
    },
  };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: payload.stream ? "text/event-stream" : "application/json",
  };
  if (payload.remoteAuthHeader) {
    // Trust the user's input — they entered this for their own remote agent.
    headers.Authorization =
      payload.remoteAuthHeader.startsWith("Bearer ") ||
      payload.remoteAuthHeader.startsWith("Basic ")
        ? payload.remoteAuthHeader
        : `Bearer ${payload.remoteAuthHeader}`;
  }

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);

  let upstream: Response;
  try {
    upstream = await safeFetch(v.url.href, {
      ...A2A_FETCH,
      method: "POST",
      headers,
      body: JSON.stringify(rpcBody),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timeout);
    return jsonResponse(
      { error: `Failed to reach remote agent: ${e instanceof Error ? e.message : String(e)}` },
      502,
    );
  }

  if (!upstream.ok) {
    clearTimeout(timeout);
    const txt = await upstream.text().catch(() => "");
    return jsonResponse(
      { error: `Remote agent returned ${upstream.status}: ${txt.slice(0, 400)}` },
      502,
    );
  }

  // Streaming: pipe SSE through to the browser unchanged. The /lib/a2aClient
  // parser knows how to handle JSON-RPC framed events.
  if (payload.stream) {
    if (!upstream.body) {
      clearTimeout(timeout);
      return jsonResponse({ error: "Upstream stream had no body" }, 502);
    }
    return new Response(upstream.body, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        ...corsHeaders,
      },
    });
  }

  // Non-streaming: parse JSON-RPC envelope and forward the result. The A2A
  // spec allows the result to be either a Task object OR a direct Message
  // object (some agents like the Hello World sample reply with a Message).
  // We pass it through and let the client decode either shape.
  const j = (await upstream.json().catch(() => null)) as {
    result?: Task | A2AMessage;
    error?: { message?: string; code?: number };
  } | null;
  clearTimeout(timeout);
  if (!j) return jsonResponse({ error: "Upstream returned non-JSON response" }, 502);
  if (j.error) {
    return jsonResponse({ error: j.error.message || `Remote JSON-RPC error ${j.error.code}` }, 502);
  }
  if (!j.result) return jsonResponse({ error: "Upstream returned no result" }, 502);
  // Detect Message vs Task by shape (kind="message" or has parts[] but no status).
  const r = j.result as { kind?: string; status?: unknown; parts?: unknown };
  const isMessage = r.kind === "message" || (Array.isArray(r.parts) && !r.status);
  if (isMessage) {
    return jsonResponse({ message: j.result });
  }
  return jsonResponse({ task: j.result });
}

// ───────────────────── Route ─────────────────────
export const Route = createFileRoute("/api/a2a")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: corsHeaders }),

      POST: async ({ request }) => {
        const userId = await getUserId(request);
        if (!userId) return jsonResponse({ error: "Unauthorized" }, 401);

        const url = new URL(request.url);
        const action = url.searchParams.get("action");
        let payload: Record<string, unknown> = {};
        try {
          payload = (await request.json()) as Record<string, unknown>;
        } catch {
          return jsonResponse({ error: "Invalid JSON body" }, 400);
        }

        if (action === "discover") {
          return handleDiscover(payload as { endpoint?: string });
        }
        if (action === "invoke") {
          return handleInvoke(payload as InvokePayload);
        }
        return jsonResponse({ error: "Unknown action. Use ?action=discover|invoke" }, 400);
      },
    },
  },
});
