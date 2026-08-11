// Execute a read-only SQL query against one of the caller's object-store
// sources (S3, R2, MinIO, Spaces, B2, GCS-over-S3).
//
// An API ROUTE rather than a server function, for the same reason
// /api/warehouse/query is one: the result rows have an arbitrary shape and the
// server-function serializer validates against a concrete type. Both query
// paths therefore look the same to the client.
//
// The user's SQL runs in the SANDBOXED local engine over rows fetched from the
// bucket — never in the engine that can reach s3://. See
// utils/catalog/objectStoreQuery.server for why that split is not optional.
import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";
import { auditEvent } from "@/utils/audit.server";
import { runObjectStoreQuery } from "@/utils/catalog/objectStoreQuery.server";

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

export const Route = createFileRoute("/api/objectstore/query")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = request.headers.get("authorization") ?? "";
        const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
        if (!token) return json(401, { error: "Missing authorization" });

        const sb = getServerSupabase(token);
        if (!sb) return json(500, { error: "Server is missing Supabase configuration" });
        const { data: auth_, error: authErr } = await sb.auth.getUser(token);
        if (authErr || !auth_.user) return json(401, { error: "Unauthorized" });

        let body: { source_id?: string; sql?: string; max_rows?: number };
        try {
          body = await request.json();
        } catch {
          return json(400, { error: "Invalid JSON body" });
        }
        const sourceId = String(body.source_id ?? "");
        const sql = String(body.sql ?? "");
        if (!sourceId || !sql.trim()) return json(400, { error: "source_id and sql are required" });

        try {
          const res = await runObjectStoreQuery({
            userId: auth_.user.id,
            sourceId,
            sql,
            maxRows: body.max_rows,
          });
          // Audited like every other query path — a refused one below too, so
          // an attempted write against a bucket appears in the log.
          auditEvent({
            userId: auth_.user.id,
            action: "data.objectstore_query",
            resourceType: "catalog_source",
            resourceId: sourceId,
            detail: {
              sql: sql.slice(0, 2000),
              rows: res.rows.length,
              truncated: res.truncated,
              ms: res.duration_ms,
            },
          });
          return json(200, res);
        } catch (e) {
          const message = e instanceof Error ? e.message : "Query failed";
          auditEvent({
            userId: auth_.user.id,
            action: "data.objectstore_query_refused",
            resourceType: "catalog_source",
            resourceId: sourceId,
            detail: { sql: sql.slice(0, 2000), error: message.slice(0, 500) },
          });
          return json(400, { error: message });
        }
      },
    },
  },
});
