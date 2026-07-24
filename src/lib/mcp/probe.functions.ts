// Probe an MCP server by performing the proper MCP Streamable HTTP handshake:
//   1) POST `initialize`         → capture `Mcp-Session-Id` (if any)
//   2) POST `notifications/initialized`
//   3) POST `tools/list`         → count tools
// Many spec-compliant MCP servers reject `tools/list` if you skip initialize,
// which is why the previous "one-shot" probe always returned 0 tools.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

type ProbeTool = {
  name: string;
  description?: string;
  inputSchema?: Record<string, any>;
};
type ProbeResult = {
  ok: boolean;
  toolsCount: number;
  tools: ProbeTool[];
  status: string;
  message?: string;
};

const PROTOCOL_VERSION = "2025-06-18";
const MCP_PROBE_TIMEOUT_MS = 12_000;

// The MCP endpoint is user-supplied and fetched from inside the server's
// network, so it goes through the SSRF guard (with a bounded timeout). The guard
// refuses cloud-metadata / link-local targets; ordinary private/in-cluster MCP
// addresses are allowed by default. Dynamically imported because this module is
// bundled into the client route.
async function guardedFetch(url: string, init: RequestInit): Promise<Response> {
  const { safeFetch } = await import("@/utils/ssrfGuard.server");
  return safeFetch(url, { ...init, signal: AbortSignal.timeout(MCP_PROBE_TIMEOUT_MS) });
}

function parseJsonOrSse(text: string, contentType: string): any | null {
  if (contentType.includes("text/event-stream")) {
    for (const line of text.split("\n")) {
      const m = line.match(/^data:\s*(.+)$/);
      if (!m) continue;
      try {
        const parsed = JSON.parse(m[1]);
        if (parsed && typeof parsed === "object") return parsed;
      } catch {
        /* ignore */
      }
    }
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export const probeMcpServer = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ id: z.string().uuid() }))
  .handler(async ({ data, context }): Promise<ProbeResult> => {
    const { supabase } = context;
    const { data: row, error } = await supabase
      .from("mcp_servers")
      .select("id, endpoint, auth_type, auth_token, auth_token_enc, tools_count")
      .eq("id", data.id)
      .maybeSingle();
    if (error || !row) {
      return { ok: false, toolsCount: 0, tools: [], status: "error", message: "Server not found" };
    }

    const endpoint = String(row.endpoint || "");
    const isHttp = /^https?:\/\//i.test(endpoint);
    const isSse = /^sse:\/\//i.test(endpoint);

    const probeUrl = isHttp ? endpoint : isSse ? endpoint.replace(/^sse:\/\//i, "https://") : null;

    if (!probeUrl) {
      // stdio:// (and other non-HTTP transports) run a local process and are
      // not reachable from the server, so we can't connect to them here.
      // Mark it honestly rather than showing a green "connected" for something
      // no agent can actually call.
      await supabase
        .from("mcp_servers")
        .update({ status: "error", last_ping: new Date().toISOString() })
        .eq("id", row.id);
      return {
        ok: false,
        toolsCount: row.tools_count ?? 0,
        tools: [],
        status: "error",
        message:
          "Only HTTP(S)/SSE MCP endpoints can be reached from the server. stdio servers run locally and aren't callable here.",
      };
    }

    const baseHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      // MCP Streamable HTTP spec requires the client to accept BOTH.
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": PROTOCOL_VERSION,
    };
    if (row.auth_type === "token") {
      const { resolveMcpAuthToken } = await import("./auth.server");
      const token = await resolveMcpAuthToken(row);
      if (token) baseHeaders.Authorization = `Bearer ${token}`;
    }

    const post = async (body: unknown, sessionId?: string | null) => {
      const headers = { ...baseHeaders };
      if (sessionId) headers["Mcp-Session-Id"] = sessionId;
      return guardedFetch(probeUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    };

    try {
      // 1) initialize
      const initRes = await post({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "agentswarms-probe", version: "1.0.0" },
        },
      });

      if (!initRes.ok) {
        await supabase
          .from("mcp_servers")
          .update({ status: "error", last_ping: new Date().toISOString() })
          .eq("id", row.id);
        return {
          ok: false,
          toolsCount: row.tools_count ?? 0,
          tools: [],
          status: "error",
          message: `initialize → HTTP ${initRes.status}`,
        };
      }

      const sessionId = initRes.headers.get("Mcp-Session-Id");
      // Drain initialize response (some servers require it).
      await initRes.text().catch(() => "");

      // 2) notifications/initialized — best-effort, ignore response.
      await post(
        { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
        sessionId,
      ).catch(() => null);

      // 3) tools/list
      const listRes = await post(
        { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
        sessionId,
      );

      let toolsCount = 0;
      let tools: ProbeTool[] = [];
      let listMsg: string | undefined;
      if (listRes.ok) {
        const ct = listRes.headers.get("content-type") ?? "";
        const text = await listRes.text();
        const parsed = parseJsonOrSse(text, ct);
        const arr = parsed?.result?.tools;
        if (Array.isArray(arr)) {
          toolsCount = arr.length;
          tools = arr
            .filter((t: any) => t && typeof t.name === "string")
            .map((t: any) => ({
              name: t.name as string,
              description: typeof t.description === "string" ? t.description : undefined,
              inputSchema:
                t.inputSchema && typeof t.inputSchema === "object" ? t.inputSchema : undefined,
            }));
        } else if (parsed?.error?.message) {
          listMsg = `tools/list → ${parsed.error.message}`;
        }
      } else {
        listMsg = `tools/list → HTTP ${listRes.status}`;
      }

      const status = listRes.ok ? "connected" : "error";
      await supabase
        .from("mcp_servers")
        .update({
          status,
          tools_count: toolsCount,
          tools,
          last_ping: new Date().toISOString(),
        })
        .eq("id", row.id);

      return {
        ok: listRes.ok,
        toolsCount,
        tools,
        status,
        message: listMsg,
      };
    } catch (err) {
      await supabase
        .from("mcp_servers")
        .update({ status: "error", last_ping: new Date().toISOString() })
        .eq("id", row.id);
      return {
        ok: false,
        toolsCount: row.tools_count ?? 0,
        tools: [],
        status: "error",
        message: err instanceof Error ? err.message : "Probe failed",
      };
    }
  });
