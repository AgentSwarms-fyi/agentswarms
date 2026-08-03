// Public endpoint for a server built in MCP Builder.
//
//   POST /api/mcp/s/<slug>       Streamable HTTP MCP (JSON-RPC)
//   DELETE /api/mcp/s/<slug>     terminate a session
//   GET  /api/mcp/s/<slug>       405 — no server→client SSE stream (spec-allowed)
//
// This is a hardened reverse proxy in front of user-written Python, not a thin
// pass-through. In order, every request must: resolve a slug that exists; carry
// a live `mcps_` key belonging to that app (and marked internal, if the app has
// not been exposed publicly); satisfy the key's IP allow-list and the app's
// Origin allow-list; fit under the rate and concurrency limits; and name a
// JSON-RPC method on the forward list. Only then is a sandbox started (or
// reused) and the call forwarded.
//
// Two properties worth stating explicitly:
//   * The upstream URL comes from the orchestrator's view of a container we
//     started. Nothing in the request can influence it, so there is no SSRF
//     surface here however the body is crafted.
//   * The caller's Authorization header is consumed here and never forwarded.
//     The user's server sees no credential of ours, and we accept no token we
//     did not issue — the confused-deputy shape MCP's security guidance warns
//     about does not exist.
import { createFileRoute } from "@tanstack/react-router";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { auditEvent } from "@/utils/audit.server";
import { requestOriginAllowed } from "@/utils/embedOrigin";
import { acquireSlot, envInt, rateLimitedGlobal, releaseSlot } from "@/utils/rateLimit.server";
import { hashMcpApiKey, looksLikeMcpApiKey } from "@/utils/mcpApps/keys";
import {
  FORWARDED_METHODS,
  MCP_PROTOCOL_VERSION,
  parseJsonOrSse,
  rpcError,
  toolsFromListResult,
} from "@/utils/mcpApps/protocol";
import { ensureRunning, runningEndpoint, type McpAppRow } from "@/utils/mcpApps/service.server";
import { MCP_SERVICE_PATH } from "@/utils/notebookRuntime/orchestrator";

/** Largest request body we will read. MCP arguments are small; this is a guard. */
const MAX_BODY_BYTES = 1024 * 1024;
/** Largest upstream response we will relay back. */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 60_000;

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extra },
  });
}

/**
 * CORS headers, echoing the caller's origin only when the app permits it.
 *
 * Never `*`: this endpoint is credentialed, and a wildcard would let any page
 * on the internet drive a server on behalf of whoever's key it managed to
 * scrape.
 */
function corsFor(request: Request, allowedOrigins: string[]): Record<string, string> {
  const origin = request.headers.get("origin");
  if (!origin) return {};
  if (!requestOriginAllowed(request, allowedOrigins).ok) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version",
    "Access-Control-Expose-Headers": "Mcp-Session-Id",
    Vary: "Origin",
  };
}

/** Slug is the last path segment; read it from the path, never from a header. */
function slugOf(request: Request): string {
  const parts = new URL(request.url).pathname.split("/").filter(Boolean);
  return decodeURIComponent(parts[parts.length - 1] ?? "");
}

/**
 * The caller's address, for the key's IP allow-list.
 *
 * THIS IS AN ACCESS-CONTROL INPUT, which is what makes the derivation matter.
 * utils/requestMeta.server has a clientIp() that reads the LEFT-most entry of
 * X-Forwarded-For, and its header says plainly that such values are "forensic
 * hints — never an access-control input". Its three callers obey that and use
 * it for audit stamps. This route had a private copy of the same left-most
 * logic and fed it straight to `ips.includes(...)`.
 *
 * X-Forwarded-For is APPENDED to, not overwritten. A proxy receiving
 *
 *     X-Forwarded-For: 203.0.113.10          (sent by the caller)
 *
 * forwards
 *
 *     X-Forwarded-For: 203.0.113.10, 198.51.100.66
 *
 * where the second entry is the real peer. Reading `[0]` returned the value the
 * caller chose, so anyone holding a leaked key defeated its allow-list with one
 * header — the control existed only for callers who did not try.
 *
 * Counting from the RIGHT fixes it: our own proxies appended those entries, so
 * they are the only ones we did not receive from the caller. How many to skip
 * depends on deployment, hence TRUSTED_PROXY_HOPS — 1 for the single reverse
 * proxy DEPLOYMENT.md describes, 2 behind a CDN in front of that proxy. Setting
 * it too HIGH reads an entry the caller supplied, so it is clamped to the list.
 *
 * X-Real-IP is deliberately NOT consulted. nginx overwrites it, but Caddy — the
 * proxy in our own deployment guide — does not set it at all, so a caller's own
 * X-Real-IP would arrive untouched and reopen exactly this bypass.
 *
 * No X-Forwarded-For at all means no proxy, so nothing is verifiable and this
 * returns "" — which no allow-list contains, so the request is refused.
 */
export function clientIp(request: Request): string {
  const parts = (request.headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) return "";
  const hops = Math.min(Math.max(1, envInt("TRUSTED_PROXY_HOPS", 1)), parts.length);
  return (parts[parts.length - hops] ?? "").slice(0, 64);
}

type AppRow = McpAppRow;

type KeyRow = {
  id: string;
  app_id: string;
  is_internal: boolean;
  is_active: boolean;
  expires_at: string | null;
  revoked_at: string | null;
  tool_allowlist: string[];
  ip_allowlist: string[];
  use_count: number;
};

type Authed = { app: AppRow; key: KeyRow };

/**
 * Resolve slug + key, or explain why not.
 *
 * Unknown slug and private-app-without-an-internal-key both answer 404, so
 * probing cannot distinguish "no such server" from "a server you may not see".
 */
async function authenticate(
  request: Request,
): Promise<{ ok: true; value: Authed } | { ok: false; response: Response }> {
  const slug = slugOf(request);
  if (!slug) return { ok: false, response: json({ error: "Not found" }, 404) };

  const { data: app } = await supabaseAdmin
    .from("mcp_apps")
    .select("*")
    .eq("slug", slug)
    .maybeSingle();
  if (!app) return { ok: false, response: json({ error: "Not found" }, 404) };

  const raw = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!raw || !looksLikeMcpApiKey(raw)) {
    return {
      ok: false,
      response: json({ error: "Missing or malformed API key" }, 401, {
        "WWW-Authenticate": "Bearer",
      }),
    };
  }

  const { data: key } = await supabaseAdmin
    .from("mcp_app_keys")
    .select(
      "id, app_id, is_internal, is_active, expires_at, revoked_at, tool_allowlist, ip_allowlist, use_count",
    )
    .eq("key_hash", await hashMcpApiKey(raw))
    .maybeSingle();

  // The key must belong to THIS app: otherwise a key for your own server would
  // open every other server on the instance.
  if (!key || key.app_id !== app.id || !key.is_active || key.revoked_at) {
    denied(app, request, "invalid_key");
    return { ok: false, response: json({ error: "Invalid or disabled API key" }, 401) };
  }
  if (key.expires_at && new Date(key.expires_at).getTime() < Date.now()) {
    denied(app, request, "expired_key");
    return { ok: false, response: json({ error: "API key has expired" }, 401) };
  }
  // Not exposed publicly: only the managed internal key (used by this
  // instance's own agents) gets in, and the refusal is indistinguishable from
  // "no such server".
  if (!app.is_public && !key.is_internal) {
    return { ok: false, response: json({ error: "Not found" }, 404) };
  }

  const ips = key.ip_allowlist ?? [];
  if (ips.length > 0 && !ips.includes(clientIp(request))) {
    denied(app, request, "ip_not_allowed", { key_id: key.id });
    return { ok: false, response: json({ error: "Source address not permitted" }, 403) };
  }

  const origin = requestOriginAllowed(request, app.allowed_origins ?? []);
  if (!origin.ok) {
    denied(app, request, "origin_not_allowed", { origin: origin.origin, key_id: key.id });
    return {
      ok: false,
      response: json(
        {
          error: "origin_not_allowed",
          message: `Origin ${origin.origin} is not on this server's allow-list.`,
        },
        403,
      ),
    };
  }

  return { ok: true, value: { app, key: key as KeyRow } };
}

/**
 * Audit a refused request against the OWNER's trail — this is their server
 * being probed, and last week's denials are how a leaked or brute-forced key
 * gets noticed. Unknown slugs are deliberately not audited (nothing to
 * attribute them to, and scanners would just fill the log).
 */
function denied(
  app: { id: string; user_id: string; name: string },
  request: Request,
  reason: string,
  detail: Record<string, unknown> = {},
): void {
  auditEvent({
    userId: app.user_id,
    action: "mcp_app.call_denied",
    resourceType: "mcp_app",
    resourceId: app.id,
    resourceName: app.name,
    detail: { reason, ip: clientIp(request) || null, ...detail },
  });
}

/**
 * One structured line per call, for operators shipping container logs. This is
 * the request log for an internet-facing endpoint running user code — kept as
 * a log line rather than a table because call volume is rate-limit bound, not
 * business data.
 */
function logCall(fields: Record<string, unknown>): void {
  console.log(`[mcp-endpoint] ${JSON.stringify(fields)}`);
}

/** Best-effort usage stamp; must never fail a call. */
function recordUse(key: KeyRow, request: Request): void {
  void supabaseAdmin
    .from("mcp_app_keys")
    .update({
      // Read-modify-write, so two simultaneous calls can lose an increment.
      // It is an activity indicator, not a billing meter.
      use_count: (key.use_count ?? 0) + 1,
      last_used_at: new Date().toISOString(),
      last_used_ip: clientIp(request) || null,
    })
    .eq("id", key.id)
    .then(() => {});
}

/**
 * Has the owner approved the tools this server currently advertises?
 *
 * Tool names, descriptions and schemas are instructions the calling model
 * reads, so a server that quietly changes them after being trusted is the "rug
 * pull" MCP's security guidance calls out. Redeploys that move the fingerprint
 * park the server here until a human looks at the diff.
 */
function toolsAwaitingApproval(app: AppRow): boolean {
  if (!app.tools_changed_at) return false;
  if (!app.tools_approved_at) return true;
  return new Date(app.tools_changed_at).getTime() > new Date(app.tools_approved_at).getTime();
}

async function handlePost(request: Request): Promise<Response> {
  const auth = await authenticate(request);
  if (!auth.ok) return auth.response;
  const { app, key } = auth.value;
  const cors = corsFor(request, app.allowed_origins ?? []);

  if (toolsAwaitingApproval(app)) {
    return json(
      {
        error: "tools_changed",
        message:
          "This server's tools changed since they were last approved. Its owner must review them in MCP Builder before it can be called again.",
      },
      409,
      cors,
    );
  }

  // Rate limit per key, concurrency per app: one noisy key must not be able to
  // pin every worker on a server other keys also use.
  if (await rateLimitedGlobal(`mcp:${key.id}`, envInt("MCP_RATE_LIMIT_PER_MIN", 120))) {
    return json({ error: "rate_limited", message: "Too many requests." }, 429, {
      ...cors,
      "Retry-After": "60",
    });
  }

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    return json({ error: "payload_too_large" }, 413, cors);
  }

  let body: any;
  try {
    body = JSON.parse(raw || "{}");
  } catch {
    return json(rpcError(null, -32700, "Parse error"), 400, cors);
  }
  if (Array.isArray(body)) {
    // Batching was removed in protocol revision 2025-06-18, which is the one we
    // advertise. Accepting it would mean guessing at semantics we don't declare.
    return json(rpcError(null, -32600, "JSON-RPC batching is not supported"), 400, cors);
  }

  const method = typeof body?.method === "string" ? body.method : "";
  if (!FORWARDED_METHODS.has(method)) {
    return json(
      rpcError(body?.id, -32601, `Method not permitted: ${method || "(none)"}`),
      400,
      cors,
    );
  }

  const allowed = key.tool_allowlist ?? [];
  if (method === "tools/call" && allowed.length > 0) {
    const name = String(body?.params?.name ?? "");
    if (!allowed.includes(name)) {
      return json(
        rpcError(body?.id, -32601, `Tool "${name}" is not permitted for this API key`),
        403,
        cors,
      );
    }
  }

  const slot = `mcpapp:${app.id}`;
  if (!acquireSlot(slot, envInt("MCP_MAX_CONCURRENT_PER_SERVER", 8))) {
    return json({ error: "busy", message: "This MCP server is at its concurrency limit." }, 429, {
      ...cors,
      "Retry-After": "5",
    });
  }

  try {
    const started = await ensureRunning(app);
    if (!started.ok) {
      return json({ error: started.error, message: started.message }, started.status, {
        ...cors,
        ...(started.status === 503 ? { "Retry-After": "10" } : {}),
      });
    }

    // Translate the session id both ways so the upstream one never leaves this
    // process and a session stays bound to the key that opened it.
    const presented = request.headers.get("mcp-session-id");
    const mapping = presented ? await loadSession(presented, app.id, key.id) : null;
    if (presented && !mapping) {
      return json(rpcError(body?.id, -32001, "Unknown or expired session"), 404, cors);
    }

    const upstream = await forward(
      started.endpoint,
      raw,
      mapping?.upstream_session_id ?? null,
      request.headers.get("mcp-protocol-version"),
    );
    if (!upstream.ok) {
      return json({ error: "upstream_unreachable", message: upstream.message }, 502, cors);
    }

    recordUse(key, request);

    // A fresh initialize gets a session id of OUR choosing, recorded against
    // the key so it cannot be replayed by another one.
    const headers: Record<string, string> = { ...cors };
    if (method === "initialize") {
      const id = await createSession(app.id, key.id, upstream.sessionId, started.session.id);
      if (id) headers["Mcp-Session-Id"] = id;
    } else if (mapping) {
      headers["Mcp-Session-Id"] = mapping.id;
      void touchSession(mapping.id);
    }

    // A narrowed key must not even be told about tools it cannot call —
    // otherwise the model plans around a tool that will be refused.
    if (method === "tools/list" && allowed.length > 0) {
      const parsed = parseJsonOrSse(upstream.text, upstream.contentType);
      if (parsed?.result) {
        parsed.result.tools = toolsFromListResult(parsed).filter((t) => allowed.includes(t.name));
        return json(parsed, upstream.status, headers);
      }
    }

    return new Response(upstream.text, {
      status: upstream.status,
      headers: { "Content-Type": upstream.contentType || "application/json", ...headers },
    });
  } finally {
    releaseSlot(slot);
  }
}

/** POST the caller's body upstream, with our own headers. */
async function forward(
  endpoint: string,
  bodyText: string,
  upstreamSessionId: string | null,
  protocolVersion: string | null,
): Promise<
  | { ok: true; status: number; text: string; contentType: string; sessionId: string | null }
  | { ok: false; message: string }
> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    // The spec requires clients to accept both; the sandbox may answer either.
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": protocolVersion || MCP_PROTOCOL_VERSION,
  };
  if (upstreamSessionId) headers["Mcp-Session-Id"] = upstreamSessionId;

  try {
    const res = await fetch(`${endpoint}${MCP_SERVICE_PATH}`, {
      method: "POST",
      headers,
      body: bodyText,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    const text = await res.text();
    if (text.length > MAX_RESPONSE_BYTES) {
      return { ok: false, message: "The MCP server returned an oversized response." };
    }
    return {
      ok: true,
      status: res.status,
      text,
      contentType: res.headers.get("content-type") ?? "application/json",
      sessionId: res.headers.get("mcp-session-id"),
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : "upstream request failed";
    return { ok: false, message };
  }
}

async function createSession(
  appId: string,
  keyId: string,
  upstreamSessionId: string | null,
  runtimeSessionId: string,
): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from("mcp_app_sessions")
    .insert({
      app_id: appId,
      key_id: keyId,
      upstream_session_id: upstreamSessionId,
      runtime_session_id: runtimeSessionId,
    })
    .select("id")
    .maybeSingle();
  return data?.id ?? null;
}

async function loadSession(
  id: string,
  appId: string,
  keyId: string,
): Promise<{ id: string; upstream_session_id: string | null } | null> {
  // Malformed ids would otherwise raise a uuid cast error rather than 404.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
  const { data } = await supabaseAdmin
    .from("mcp_app_sessions")
    .select("id, upstream_session_id")
    .eq("id", id)
    .eq("app_id", appId)
    .eq("key_id", keyId)
    .maybeSingle();
  return data ?? null;
}

function touchSession(id: string): void {
  void supabaseAdmin
    .from("mcp_app_sessions")
    .update({ last_seen_at: new Date().toISOString() })
    .eq("id", id)
    .then(() => {});
}

/** MCP session termination: drop our mapping and tell the sandbox too. */
async function handleDelete(request: Request): Promise<Response> {
  const auth = await authenticate(request);
  if (!auth.ok) return auth.response;
  const { app, key } = auth.value;
  const cors = corsFor(request, app.allowed_origins ?? []);

  const presented = request.headers.get("mcp-session-id");
  if (!presented) return json({ error: "Mcp-Session-Id is required" }, 400, cors);
  const mapping = await loadSession(presented, app.id, key.id);
  if (!mapping) return json({ error: "Unknown session" }, 404, cors);

  await supabaseAdmin.from("mcp_app_sessions").delete().eq("id", mapping.id);

  // Best-effort upstream termination, and only if the sandbox happens to be
  // up: our mapping is already gone, so cold-starting a container purely to
  // tell it about a session it has itself forgotten would be pure cost.
  if (mapping.upstream_session_id) {
    const endpoint = await runningEndpoint(app.id).catch(() => null);
    if (endpoint) {
      await fetch(`${endpoint}${MCP_SERVICE_PATH}`, {
        method: "DELETE",
        headers: { "Mcp-Session-Id": mapping.upstream_session_id },
        signal: AbortSignal.timeout(10_000),
      }).catch(() => {});
    }
  }
  return new Response(null, { status: 204, headers: cors });
}

export const Route = createFileRoute("/api/mcp/s/$slug")({
  server: {
    handlers: {
      OPTIONS: async ({ request }) => {
        // Pre-flight must not need a key, but it must not leak the allow-list
        // either — an origin that isn't permitted simply gets no CORS headers.
        const slug = slugOf(request);
        const { data: app } = await supabaseAdmin
          .from("mcp_apps")
          .select("allowed_origins")
          .eq("slug", slug)
          .maybeSingle();
        return new Response(null, {
          status: 204,
          headers: corsFor(request, app?.allowed_origins ?? []),
        });
      },
      POST: async ({ request }) => {
        const t0 = Date.now();
        const res = await handlePost(request);
        logCall({
          method: "POST",
          slug: slugOf(request),
          status: res.status,
          duration_ms: Date.now() - t0,
          ip: clientIp(request) || null,
        });
        return res;
      },
      DELETE: ({ request }) => handleDelete(request),
      // The spec explicitly allows a server with no server→client stream to
      // answer 405 here, and clients fall back to POST-only. Supporting it
      // would mean holding an open proxy connection per client for the life of
      // the session, which is not worth it for tool-calling.
      GET: async () =>
        json({ error: "method_not_allowed", message: "This endpoint is POST-only." }, 405, {
          Allow: "POST, DELETE, OPTIONS",
        }),
    },
  },
});
