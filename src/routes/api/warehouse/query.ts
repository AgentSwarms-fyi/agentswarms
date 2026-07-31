// Execute a read-only SQL query against one of the caller's warehouse
// connections. Used by the Data & SQL page, the BI panel, and the
// warehouse agent tools.
import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { executeWarehouseQuery, MAX_WAREHOUSE_ROWS } from "@/utils/warehouse/drivers.server";
import { auditEvent } from "@/utils/audit.server";
import { extractTableRefs } from "@/lib/sqlRefs";
import { loadWarehouseConnection } from "@/utils/warehouse/connections.server";

function getServerSupabase(authToken: string) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return null;
  return createClient<Database>(url, key, {
    auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${authToken}` } },
  });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const Route = createFileRoute("/api/warehouse/query")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = request.headers.get("authorization");
        const token = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
        const sb = token ? getServerSupabase(token) : null;
        if (!token || !sb) return json(401, { error: "Sign in to query warehouses" });
        const { data: claims } = await sb.auth.getClaims(token);
        const userId = claims?.claims?.sub;
        if (!userId) return json(401, { error: "Invalid session" });

        let body: { connection_id?: string; sql?: string; max_rows?: number };
        try {
          body = await request.json();
        } catch {
          return json(400, { error: "Invalid JSON body" });
        }
        if (!body.connection_id || !body.sql) {
          return json(400, { error: "connection_id and sql are required" });
        }

        try {
          const conn = await loadWarehouseConnection(
            sb,
            { connectionId: body.connection_id },
            userId,
          );
          const result = await executeWarehouseQuery(
            conn.config,
            body.sql,
            typeof body.max_rows === "number" ? body.max_rows : undefined,
            { userId },
          );
          auditEvent({
            userId,
            action: "warehouse.query",
            resourceType: "warehouse",
            resourceName: conn.name,
            detail: {
              provider: conn.provider,
              tables: extractTableRefs(body.sql).slice(0, 12),
              rows: result.row_count,
              duration_ms: result.duration_ms,
              sql: body.sql.slice(0, 200),
            },
          });
          return json(200, { ...result, connection: conn.name, provider: conn.provider });
        } catch (e) {
          return json(400, {
            error: "query_failed",
            message: e instanceof Error ? e.message : "Query failed",
          });
        }
      },
    },
  },
});
