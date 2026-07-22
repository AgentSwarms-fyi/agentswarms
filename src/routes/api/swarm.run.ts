// Public swarm run endpoint.
//
//   POST /api/swarm/run
//   Authorization: Bearer sk_swarm_…
//   { "input": "…", "inputs": { "field": "value" } }
//   → { "output": "…", "runId": "…" }
//
// Authenticated by a per-swarm API key (SHA-256 hash looked up server-side).
// The swarm runs headlessly via the server executor as the key's owner.
import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { sha256Hex } from "@/utils/swarmDeploy.functions";
import { executeSwarmServer } from "@/utils/swarmExecute.server";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  });

export const Route = createFileRoute("/api/swarm/run")({
  server: {
    handlers: {
      OPTIONS: () => new Response(null, { status: 204, headers: cors }),
      POST: async ({ request }) => {
        const auth = request.headers.get("authorization");
        const rawKey = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : "";
        if (!rawKey) return json({ error: "Missing API key" }, 401);

        const keyHash = await sha256Hex(rawKey);
        const { data: key } = await supabaseAdmin
          .from("swarm_api_keys")
          .select("id, user_id, swarm_id, is_active, reject_approvals")
          .eq("key_hash", keyHash)
          .maybeSingle();
        if (!key || !key.is_active) return json({ error: "Invalid or disabled API key" }, 401);

        let payload: { input?: unknown; inputs?: unknown } = {};
        try {
          payload = (await request.json()) as typeof payload;
        } catch {
          /* empty body ok */
        }
        const input = typeof payload.input === "string" ? payload.input : "";
        const initialState: Record<string, string> = {};
        if (payload.inputs && typeof payload.inputs === "object") {
          for (const [k, v] of Object.entries(payload.inputs as Record<string, unknown>)) {
            initialState[k] = typeof v === "string" ? v : JSON.stringify(v);
          }
        }

        const { data: swarm } = await supabaseAdmin
          .from("swarms")
          .select("id, name, nodes, edges")
          .eq("id", key.swarm_id)
          .maybeSingle();
        if (!swarm) return json({ error: "Swarm not found" }, 404);

        const origin = process.env.PUBLIC_APP_URL || new URL(request.url).origin;

        const result = await executeSwarmServer({
          swarm,
          userId: key.user_id,
          origin,
          input,
          initialState,
          rejectApprovals: key.reject_approvals,
          source: "api",
        });

        // Best-effort last-used stamp.
        void supabaseAdmin
          .from("swarm_api_keys")
          .update({ last_used_at: new Date().toISOString() })
          .eq("id", key.id)
          .then(undefined, () => undefined);

        if (result.status === "error") {
          return json({ error: result.error, runId: result.runId }, 400);
        }
        return json({ output: result.output, runId: result.runId });
      },
    },
  },
});
