// POST /api/etl/ingest — streamed-row intake for one pipeline.
//
//   Authorization: Bearer etl_…            (the pipeline's trigger token)
//   { "pipeline_id": "…", "rows": [{…}, …] }   — or a single object as "row"
//   → 202 { "accepted": N }
//
// Rows land in etl_ingest_events and wait for the pipeline's next run; an
// "ingest" source node drains them in id order with the same at-least-once
// cursor shape CDC uses. This is micro-batch streaming: push whenever events
// happen, load on the pipeline's schedule (or fire /api/etl/run right after
// pushing for near-real-time).
import { createHash, timingSafeEqual } from "node:crypto";

import { createFileRoute } from "@tanstack/react-router";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { envInt, rateLimitedGlobal } from "@/utils/rateLimit.server";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

function hashMatches(presented: string, storedHash: string): boolean {
  const a = Buffer.from(createHash("sha256").update(presented).digest("hex"));
  const b = Buffer.from(storedHash);
  return a.length === b.length && timingSafeEqual(a, b);
}

const MAX_ROWS_PER_REQUEST = 1000;
const MAX_BODY_BYTES = 1_000_000;
/** Backlog ceiling per pipeline — refuse rather than grow without bound. */
const MAX_BACKLOG = 500_000;

export const Route = createFileRoute("/api/etl/ingest")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = request.headers.get("authorization") ?? "";
        const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
        if (!token.startsWith("etl_")) return json({ error: "Unauthorized" }, 401);

        const raw = await request.text();
        if (raw.length > MAX_BODY_BYTES) return json({ error: "Body too large (1MB cap)" }, 413);
        let body: { pipeline_id?: string; rows?: unknown; row?: unknown };
        try {
          body = JSON.parse(raw);
        } catch {
          return json({ error: "Invalid JSON body" }, 400);
        }
        if (!body.pipeline_id) return json({ error: "pipeline_id is required" }, 400);

        const rows = Array.isArray(body.rows)
          ? body.rows
          : body.row && typeof body.row === "object"
            ? [body.row]
            : null;
        if (!rows || rows.length === 0) {
          return json({ error: "rows (array) or row (object) is required" }, 400);
        }
        if (rows.length > MAX_ROWS_PER_REQUEST) {
          return json({ error: `At most ${MAX_ROWS_PER_REQUEST} rows per request` }, 413);
        }
        if (rows.some((r) => !r || typeof r !== "object" || Array.isArray(r))) {
          return json({ error: "Every row must be a JSON object" }, 400);
        }

        const { data: pipeline } = await supabaseAdmin
          .from("etl_pipelines")
          .select("id, user_id, trigger_token_hash")
          .eq("id", body.pipeline_id)
          .maybeSingle();
        // Same single 404 as /api/etl/run — nothing to learn from the shape.
        if (
          !pipeline ||
          !pipeline.trigger_token_hash ||
          !hashMatches(token, pipeline.trigger_token_hash)
        ) {
          return json({ error: "Not found" }, 404);
        }

        if (await rateLimitedGlobal("etl-ingest", envInt("ETL_INGEST_PER_MIN", 600))) {
          return json({ error: "Rate limit exceeded, try again shortly" }, 429);
        }

        const { count } = await supabaseAdmin
          .from("etl_ingest_events")
          .select("id", { count: "exact", head: true })
          .eq("pipeline_id", pipeline.id);
        if ((count ?? 0) + rows.length > MAX_BACKLOG) {
          return json({ error: "Ingest backlog full — run the pipeline to drain it" }, 429);
        }

        const { error } = await supabaseAdmin.from("etl_ingest_events").insert(
          rows.map((r) => ({
            pipeline_id: pipeline.id,
            user_id: pipeline.user_id,
            payload: r as never,
          })),
        );
        if (error) return json({ error: "Could not store rows" }, 500);
        return json({ accepted: rows.length }, 202);
      },
    },
  },
});
