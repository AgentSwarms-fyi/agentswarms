// Batch-job result callback. A headless batch kernel POSTs its outcome here
// using its session token (never a user JWT or provider key). We map the token
// to the exact session it belongs to and persist the result — the client polls
// /api/notebook/runtime (action:status) to read it.
import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { verifySessionToken } from "@/utils/notebookRuntime/token.server";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const Route = createFileRoute("/api/notebook/runtime/result")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = request.headers.get("authorization");
        const token = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
        const claims = await verifySessionToken(token);
        if (!claims) return json(401, { error: "Invalid or expired session token" });

        let body: { status?: string; result?: unknown; logs?: string; error?: string };
        try {
          body = await request.json();
        } catch {
          return json(400, { error: "Invalid JSON body" });
        }

        const status = body.status === "error" ? "error" : "succeeded";
        // Scope the write to exactly the token's session + user.
        const { error } = await supabaseAdmin
          .from("notebook_runtime_sessions")
          .update({
            status,
            result: (body.result ?? null) as never,
            logs: typeof body.logs === "string" ? body.logs.slice(0, 200_000) : null,
            error: typeof body.error === "string" ? body.error.slice(0, 4000) : null,
            stopped_at: new Date().toISOString(),
          })
          .eq("id", claims.sid)
          .eq("user_id", claims.sub)
          .eq("kind", "batch");
        if (error) return json(500, { error: error.message });
        return json(200, { ok: true });
      },
    },
  },
});
