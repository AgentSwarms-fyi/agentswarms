// Server functions backing the deterministic (non-LLM) swarm nodes:
//   - executeHttpNode: performs an outbound HTTP request. Flow-state templating
//     ({{var}}) is already applied client-side; here we resolve {{secret:NAME}}
//     references server-side (values never reach the browser) and run the fetch.
//   - executeToolNode: runs ONE built-in tool deterministically (no LLM turn),
//     reusing the same server-side tool runners the chat tool-loop uses.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { resolveSecretRefs } from "@/utils/secrets.server";
import type { AgentToolContext } from "@/utils/tools/registry.server";

async function userFromToken(accessToken: string | undefined): Promise<string | null> {
  if (!accessToken) return null;
  const { data, error } = await supabaseAdmin.auth.getUser(accessToken);
  if (error || !data.user) return null;
  return data.user.id;
}

// RLS-scoped client (publishable key + the caller's JWT), matching the one the
// chat route builds for its tool context.
function userScopedClient(authToken: string): SupabaseClient<Database> | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return null;
  return createClient<Database>(url, key, {
    auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${authToken}` } },
  });
}

// ── HTTP node ───────────────────────────────────────────────────────────────

export const executeHttpNode = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
        url: z.string().min(1),
        headers: z
          .array(z.object({ key: z.string(), value: z.string() }))
          .max(40)
          .optional(),
        body: z.string().max(200_000).optional(),
        timeout_ms: z.number().int().min(1000).max(120_000).optional(),
      })
      .parse(input),
  )
  .handler(
    async ({
      data,
    }): Promise<{ ok: false; error: string } | { ok: true; status: number; body: string }> => {
      const userId = await userFromToken(data.access_token);
      if (!userId) return { ok: false, error: "Invalid session" };

      // Resolve {{secret:NAME}} references (access-checked) in url/headers/body.
      let url: string;
      const headers: Record<string, string> = {};
      let body: string | undefined;
      try {
        url = await resolveSecretRefs(userId, data.url);
        for (const h of data.headers ?? []) {
          if (!h.key.trim()) continue;
          headers[h.key.trim()] = await resolveSecretRefs(userId, h.value);
        }
        body = data.body ? await resolveSecretRefs(userId, data.body) : undefined;
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : "Secret resolution failed" };
      }

      if (!/^https?:\/\//i.test(url)) {
        return { ok: false, error: "URL must start with http:// or https://" };
      }

      const controller = AbortSignal.timeout(data.timeout_ms ?? 30_000);
      try {
        const res = await fetch(url, {
          method: data.method,
          headers,
          body: data.method === "GET" || data.method === "DELETE" ? undefined : body,
          signal: controller,
        });
        const text = await res.text();
        // Cap the returned body so a huge response can't blow up the run.
        return { ok: true, status: res.status, body: text.slice(0, 200_000) };
      } catch (e) {
        return {
          ok: false,
          error: e instanceof Error ? e.message : "Request failed",
        };
      }
    },
  );

// ── Tool node ─────────────────────────────────────────────────────────────

const TOOL_IDS = [
  "sql_query",
  "kb_search",
  "web_search",
  "web_browse",
  "calculator",
  "datetime",
  "weather",
  "mcp_call_tool",
] as const;

export const executeToolNode = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        tool_id: z.enum(TOOL_IDS),
        args: z.record(z.string(), z.string()).default({}),
        knowledge_base_id: z.string().uuid().nullish(),
        sql_tables: z.array(z.string()).optional(),
        mcp_servers: z.array(z.string()).optional(),
        web_config: z.object({ provider: z.string(), api_key: z.string() }).partial().optional(),
      })
      .parse(input),
  )
  .handler(
    async ({ data }): Promise<{ ok: false; error: string } | { ok: true; result: string }> => {
      const userId = await userFromToken(data.access_token);
      if (!userId) return { ok: false, error: "Invalid session" };
      const sb = userScopedClient(data.access_token);
      if (!sb) return { ok: false, error: "Server is missing Supabase configuration" };

      const ctx: AgentToolContext = { userId, authToken: data.access_token, sb };
      const a = data.args;

      try {
        const reg = await import("@/utils/tools/registry.server");
        const sql = await import("@/utils/tools/sql.server");
        let result: string;
        switch (data.tool_id) {
          case "sql_query": {
            const allow =
              data.sql_tables && data.sql_tables.length > 0 ? new Set(data.sql_tables) : null;
            result = await sql.runSqlQuery(ctx, { sql: a.sql ?? "" }, allow);
            break;
          }
          case "kb_search":
            result = await reg.runKbSearch(
              ctx,
              { query: a.query ?? "", top_k: a.top_k ? Number(a.top_k) : undefined },
              data.knowledge_base_id ? [data.knowledge_base_id] : undefined,
            );
            break;
          case "web_search":
            result = await reg.runWebSearch(
              ctx,
              { query: a.query ?? "", limit: a.limit ? Number(a.limit) : undefined },
              data.web_config,
            );
            break;
          case "web_browse":
            result = await reg.runWebBrowse(ctx, { url: a.url ?? "" }, data.web_config);
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
              data.mcp_servers,
            );
            break;
          }
          default:
            return { ok: false, error: `Unsupported tool: ${data.tool_id}` };
        }
        return { ok: true, result };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : "Tool execution failed" };
      }
    },
  );
