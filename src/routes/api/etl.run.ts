// POST /api/etl/run — external trigger for one pipeline.
//
//   Authorization: Bearer etl_…
//   { "pipeline_id": "…" }
//   → 202 { "accepted": true, "run_id": "…" }
//
// The token is per-pipeline and matched by SHA-256 hash (plaintext shown once
// at mint, never stored). This is how a swarm http node, an n8n workflow or an
// external system starts a load without holding a user session — the swarm
// side of "talks to the ecosystem" is exactly this endpoint.
import { createHash, timingSafeEqual } from "node:crypto";

import { createFileRoute } from "@tanstack/react-router";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { envInt, rateLimitedGlobal } from "@/utils/rateLimit.server";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/** Constant-time hash comparison; both sides are fixed-length hex. */
function hashMatches(presented: string, storedHash: string): boolean {
  const a = Buffer.from(createHash("sha256").update(presented).digest("hex"));
  const b = Buffer.from(storedHash);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const Route = createFileRoute("/api/etl/run")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = request.headers.get("authorization") ?? "";
        const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
        if (!token.startsWith("etl_")) return json({ error: "Unauthorized" }, 401);

        let body: { pipeline_id?: string; params?: Record<string, unknown> };
        try {
          body = await request.json();
        } catch {
          return json({ error: "Invalid JSON body" }, 400);
        }
        if (!body.pipeline_id) return json({ error: "pipeline_id is required" }, 400);
        const params =
          body.params && typeof body.params === "object" && !Array.isArray(body.params)
            ? body.params
            : undefined;

        const { data: pipeline } = await supabaseAdmin
          .from("etl_pipelines")
          .select("*")
          .eq("id", body.pipeline_id)
          .maybeSingle();
        // One 404 for "no such pipeline", "no token minted" and "wrong token":
        // distinguishing them would tell a token guesser which ids exist.
        if (
          !pipeline ||
          !pipeline.trigger_token_hash ||
          !hashMatches(token, pipeline.trigger_token_hash)
        ) {
          return json({ error: "Not found" }, 404);
        }
        if (!pipeline.is_active) return json({ error: "Pipeline is disabled" }, 409);

        // Global limiter: the ceiling is a documented number, so it must hold
        // across every app instance, not per process.
        if (await rateLimitedGlobal(`etlrun:${pipeline.id}`, envInt("ETL_TRIGGER_PER_MIN", 6))) {
          return json({ error: "rate_limited", message: "Too many trigger requests." }, 429);
        }

        const { startEtlRun } = await import("@/utils/etl/service.server");
        const res = await startEtlRun(pipeline, "trigger", params);
        if (!res.ok) return json({ error: res.error }, 409);
        return json({ accepted: true, run_id: res.runId }, 202);
      },
    },
  },
});
