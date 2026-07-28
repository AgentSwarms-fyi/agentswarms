// Poll a published notebook run started with { "async": true } (or one that
// outran the synchronous wait).
//
//   POST /api/notebook/run/status
//   Authorization: Bearer nbk_…
//   { "runId": "…" }
//   → 200 { status, result?, error? }
//
// The key is scoped to one notebook, so a run started by a different key — or
// belonging to another user — is simply not found rather than reported as
// forbidden, which would confirm the id exists.
import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { hashNotebookApiKey } from "@/utils/notebookApiKeys";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

export const Route = createFileRoute("/api/notebook/run/status")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: corsHeaders }),
      POST: async ({ request }) => {
        const auth = request.headers.get("authorization") || "";
        const raw = auth.replace(/^Bearer\s+/i, "").trim();
        if (!raw) return json({ error: "Missing API key" }, 401);

        const { data: key } = await supabaseAdmin
          .from("notebook_api_keys")
          .select("id, user_id, notebook_id, is_active, expires_at, revoked_at")
          .eq("key_hash", await hashNotebookApiKey(raw))
          .maybeSingle();
        if (!key || !key.is_active || key.revoked_at) {
          return json({ error: "Invalid or disabled API key" }, 401);
        }
        if (key.expires_at && new Date(key.expires_at).getTime() < Date.now()) {
          return json({ error: "API key has expired" }, 401);
        }

        let body: { runId?: string } = {};
        try {
          body = (await request.json()) as typeof body;
        } catch {
          return json({ error: "Invalid JSON body" }, 400);
        }
        const runId = typeof body.runId === "string" ? body.runId.trim() : "";
        if (!runId) return json({ error: "runId is required" }, 400);

        const { data: row } = await supabaseAdmin
          .from("notebook_runtime_sessions")
          .select("id, status, result, error, api_key_id, user_id")
          .eq("id", runId)
          .eq("user_id", key.user_id)
          .eq("api_key_id", key.id)
          .maybeSingle();
        if (!row) return json({ error: "Run not found" }, 404);

        if (row.status === "succeeded") return json({ status: "succeeded", result: row.result });
        if (row.status === "error") {
          return json({ status: "error", error: row.error || "Notebook run failed" });
        }
        return json({ status: row.status });
      },
    },
  },
});
