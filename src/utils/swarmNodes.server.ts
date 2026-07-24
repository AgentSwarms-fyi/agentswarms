// Server-only cores for the deterministic swarm nodes (HTTP + Tool). Kept in a
// dedicated .server.ts so client-reachable modules (swarmNodes.functions.ts,
// which the browser runtime imports for its RPC stubs) never pull in the
// service-role client or secrets resolver at the top level.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";
import { resolveSecretRefs } from "@/utils/secrets.server";
import { safeFetch } from "@/utils/ssrfGuard.server";
import type { AgentToolContext } from "@/utils/tools/registry.server";

// RLS-scoped client (publishable key + the caller's JWT), matching the one the
// chat route builds for its tool context.
export function userScopedClient(authToken: string): SupabaseClient<Database> | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return null;
  return createClient<Database>(url, key, {
    auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${authToken}` } },
  });
}

// ── HTTP node core ────────────────────────────────────────────────────────
export type HttpNodeParams = {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  headers?: { key: string; value: string }[];
  body?: string;
  timeout_ms?: number;
};

export async function runHttpNodeCore(
  userId: string,
  p: HttpNodeParams,
): Promise<{ ok: false; error: string } | { ok: true; status: number; body: string }> {
  let url: string;
  const headers: Record<string, string> = {};
  let body: string | undefined;
  try {
    url = await resolveSecretRefs(userId, p.url);
    for (const h of p.headers ?? []) {
      if (!h.key.trim()) continue;
      headers[h.key.trim()] = await resolveSecretRefs(userId, h.value);
    }
    body = p.body ? await resolveSecretRefs(userId, p.body) : undefined;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Secret resolution failed" };
  }
  if (!/^https?:\/\//i.test(url)) {
    return { ok: false, error: "URL must start with http:// or https://" };
  }
  const controller = AbortSignal.timeout(p.timeout_ms ?? 30_000);
  try {
    // safeFetch always blocks cloud-metadata / link-local targets and
    // re-validates every redirect hop. Private/internal targets are allowed by
    // default; set BLOCK_PRIVATE_NETWORK_FETCH=true to refuse those too.
    const res = await safeFetch(url, {
      method: p.method,
      headers,
      body: p.method === "GET" || p.method === "DELETE" ? undefined : body,
      signal: controller,
    });
    const text = await res.text();
    return { ok: true, status: res.status, body: text.slice(0, 200_000) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Request failed" };
  }
}

// ── Tool node core ────────────────────────────────────────────────────────
export const TOOL_NODE_IDS = [
  "sql_query",
  "kb_search",
  "web_search",
  "web_browse",
  "calculator",
  "datetime",
  "weather",
  "mcp_call_tool",
] as const;

// Tools that read user data through RLS — cannot run in a headless run without
// the owner's JWT.
export const RLS_TOOL_IDS = new Set<string>(["sql_query", "kb_search", "kb_graph_search"]);

export type ToolNodeParams = {
  tool_id: (typeof TOOL_NODE_IDS)[number];
  args: Record<string, string>;
  knowledge_base_id?: string | null;
  sql_tables?: string[];
  mcp_servers?: string[];
  web_config?: { provider?: string; api_key?: string };
};

export async function runToolNodeCore(
  ctx: AgentToolContext,
  p: ToolNodeParams,
): Promise<{ ok: false; error: string } | { ok: true; result: string }> {
  const a = p.args;
  try {
    const reg = await import("@/utils/tools/registry.server");
    const sql = await import("@/utils/tools/sql.server");
    let result: string;
    switch (p.tool_id) {
      case "sql_query": {
        const allow = p.sql_tables && p.sql_tables.length > 0 ? new Set(p.sql_tables) : null;
        result = await sql.runSqlQuery(ctx, { sql: a.sql ?? "" }, allow);
        break;
      }
      case "kb_search":
        result = await reg.runKbSearch(
          ctx,
          { query: a.query ?? "", top_k: a.top_k ? Number(a.top_k) : undefined },
          p.knowledge_base_id ? [p.knowledge_base_id] : undefined,
        );
        break;
      case "web_search":
        result = await reg.runWebSearch(
          ctx,
          { query: a.query ?? "", limit: a.limit ? Number(a.limit) : undefined },
          p.web_config,
        );
        break;
      case "web_browse":
        result = await reg.runWebBrowse(ctx, { url: a.url ?? "" }, p.web_config);
        break;
      case "calculator":
        result = await reg.runCalculator(ctx, { expression: a.expression ?? "" });
        break;
      case "datetime":
        result = await reg.runDatetime(ctx, { timezone: a.timezone });
        break;
      case "weather":
        result = await reg.runWeather(ctx, {
          location: a.location,
          latitude: a.latitude ? Number(a.latitude) : undefined,
          longitude: a.longitude ? Number(a.longitude) : undefined,
        });
        break;
      case "mcp_call_tool": {
        let args: Record<string, unknown> = {};
        if (a.arguments) {
          try {
            args = JSON.parse(a.arguments);
          } catch {
            return { ok: false, error: "MCP `arguments` must be valid JSON" };
          }
        }
        result = await reg.runMcpCallTool(
          ctx,
          { server_name: a.server_name ?? "", tool_name: a.tool_name ?? "", arguments: args },
          p.mcp_servers,
        );
        break;
      }
      default:
        return { ok: false, error: `Unsupported tool: ${p.tool_id}` };
    }
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Tool execution failed" };
  }
}
