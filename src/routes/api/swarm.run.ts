// Public swarm run endpoint.
//
//   POST /api/swarm/run
//   Authorization: Bearer sk_swarm_…
//   { "input": "…", "inputs": { "field": "value" },
//     "history": [{ "role": "user"|"assistant", "content": "…" }] }
//   → { "output": "…", "runId": "…" }
//
// `history` (optional) turns a swarm into a multi-turn chatbot: prior turns
// are replayed into every agent node so the swarm answers in context. The
// caller manages the transcript (append the returned output as the assistant
// turn and send it back next time) — the endpoint stays stateless.
//
// Authenticated by a per-swarm API key (SHA-256 hash looked up server-side).
// The swarm runs headlessly via the server executor as the key's owner.
import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { sha256Hex } from "@/utils/swarmDeploy.functions";
import { executeSwarmServer } from "@/utils/swarmExecute.server";
import { resolveInternalOrigin } from "@/utils/internalOrigin.server";
import { acquireSlot, envInt, rateLimited, releaseSlot } from "@/utils/rateLimit.server";

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

        // A swarm run is expensive and can hold a worker for minutes, so bound
        // both the request rate and how many may be in flight for this key.
        // Both counters are per-process — see rateLimit.server.ts.
        const bucket = `swarm-run:${key.id}`;
        if (rateLimited(bucket, envInt("SWARM_RUN_RATE_LIMIT_PER_MIN", 30))) {
          return json({ error: "Rate limit exceeded — slow down and retry." }, 429);
        }
        if (!acquireSlot(bucket, envInt("SWARM_RUN_MAX_CONCURRENT", 5))) {
          return json(
            { error: "Too many concurrent runs for this key — retry when one finishes." },
            429,
          );
        }

        try {
          let payload: { input?: unknown; inputs?: unknown; history?: unknown } = {};
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
          // Optional conversation history (chat mode). Keep only valid turns and
          // cap to the last 20 so a long transcript can't blow up token usage.
          const history: { role: "user" | "assistant"; content: string }[] = Array.isArray(
            payload.history,
          )
            ? (payload.history as unknown[])
                .filter(
                  (m): m is { role: "user" | "assistant"; content: string } =>
                    !!m &&
                    typeof m === "object" &&
                    ((m as { role?: unknown }).role === "user" ||
                      (m as { role?: unknown }).role === "assistant") &&
                    typeof (m as { content?: unknown }).content === "string",
                )
                .slice(-20)
            : [];

          const { data: swarm } = await supabaseAdmin
            .from("swarms")
            .select("id, name, nodes, edges")
            .eq("id", key.swarm_id)
            .maybeSingle();
          if (!swarm) return json({ error: "Swarm not found" }, 404);

          // Resolved from configuration only — never from the request's Host
          // header, because the executor sends an internal secret to this origin.
          const origin = resolveInternalOrigin();

          const result = await executeSwarmServer({
            swarm,
            userId: key.user_id,
            origin,
            input,
            initialState,
            history,
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
        } finally {
          // Always give the concurrency slot back, including on a thrown error.
          releaseSlot(bucket);
        }
      },
    },
  },
});
