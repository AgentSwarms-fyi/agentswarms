// List tables + columns for one of the caller's warehouse connections
// (information_schema-based, uniform shape across providers).
import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { listWarehouseTables } from "@/utils/warehouse/drivers.server";
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

export const Route = createFileRoute("/api/warehouse/schema")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = request.headers.get("authorization");
        const token = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
        const sb = token ? getServerSupabase(token) : null;
        if (!token || !sb) return json(401, { error: "Sign in to browse warehouses" });
        const { data: claims } = await sb.auth.getClaims(token);
        const userId = claims?.claims?.sub;
        if (!userId) return json(401, { error: "Invalid session" });

        let body: { connection_id?: string };
        try {
          body = await request.json();
        } catch {
          return json(400, { error: "Invalid JSON body" });
        }
        if (!body.connection_id) return json(400, { error: "connection_id is required" });

        try {
          const conn = await loadWarehouseConnection(
            sb,
            { connectionId: body.connection_id },
            userId,
          );
          const tables = await listWarehouseTables(conn.config);
          return json(200, { tables, connection: conn.name, provider: conn.provider });
        } catch (e) {
          return json(400, {
            error: "schema_failed",
            message: e instanceof Error ? e.message : "Failed to list tables",
          });
        }
      },
    },
  },
});
