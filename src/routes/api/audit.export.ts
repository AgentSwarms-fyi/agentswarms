// GET /api/audit/export — NDJSON export of the compliance trail.
//
//   GET /api/audit/export?stream=audit&since=2026-01-01&until=2026-02-01
//   Authorization: Bearer <superadmin access token>
//   → one JSON object per line (application/x-ndjson)
//
// Why this exists: audit rows are purged on a retention timer, and enterprises
// need the trail in their own SIEM (Splunk / Sentinel / Chronicle) rather than
// only inside this app. NDJSON streams line-by-line, so a nightly cron can pipe
// it straight to a log shipper or object store without buffering the whole set.
//
// Scalability: rows are fetched in pages and pushed into a ReadableStream as
// they arrive, so memory stays flat regardless of range size. The client sees
// data immediately instead of waiting for the full query.
//
// Superadmin only — this returns every user's activity.
import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireSuperadmin } from "@/utils/iam.server";

const PAGE = 1000;

/** Exportable streams. `traces` is the LLM-call log; `runs` is swarm runs. */
const STREAMS = {
  audit: { table: "audit_events", ts: "created_at" },
  traces: { table: "execution_traces", ts: "created_at" },
  runs: { table: "swarm_runs", ts: "started_at" },
} as const;
type StreamName = keyof typeof STREAMS;

function err(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const Route = createFileRoute("/api/audit/export")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const auth = request.headers.get("authorization");
        const token = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : "";
        if (!token) return err("Missing bearer token", 401);
        const guard = await requireSuperadmin(token);
        if (!guard.ok) return err(guard.error, 403);

        const url = new URL(request.url);
        const name = (url.searchParams.get("stream") ?? "audit") as StreamName;
        const spec = STREAMS[name];
        if (!spec) {
          return err(`Unknown stream "${name}". Expected: ${Object.keys(STREAMS).join(", ")}`, 400);
        }
        // Both bounds optional; invalid dates are rejected rather than silently
        // widening the export to everything.
        const since = url.searchParams.get("since");
        const until = url.searchParams.get("until");
        for (const [label, v] of [
          ["since", since],
          ["until", until],
        ] as const) {
          if (v && Number.isNaN(Date.parse(v))) return err(`Invalid ${label} date: ${v}`, 400);
        }

        const encoder = new TextEncoder();
        // Cursor lives in the closure rather than on the stream source: `this`
        // inside an underlying-source method is easy to get wrong and needs a
        // cast to carry state.
        let from = 0;
        const stream = new ReadableStream<Uint8Array>({
          async pull(controller) {
            // One page per pull keeps backpressure honest: we only read from the
            // database as fast as the consumer drains the response.
            let q = supabaseAdmin
              .from(spec.table)
              .select("*")
              .order(spec.ts, { ascending: true })
              // `id` breaks the tie. Two events can share a timestamp to the
              // microsecond, and offset paging over a non-unique order is not a
              // sequence: the planner may return one of them at the end of page
              // one and again at the start of page two, and the other never. In
              // an export that is a row which did not happen beside a row that
              // happened twice, in the file someone reaches for precisely
              // because they need to know which.
              .order("id", { ascending: true })
              .range(from, from + PAGE - 1);
            if (since) q = q.gte(spec.ts, new Date(since).toISOString());
            if (until) q = q.lt(spec.ts, new Date(until).toISOString());

            const { data, error } = await q;
            if (error) {
              // Mid-stream failure: emit a final error line so the consumer can
              // tell a truncated export from a complete one.
              controller.enqueue(
                encoder.encode(JSON.stringify({ _export_error: error.message }) + "\n"),
              );
              controller.close();
              return;
            }
            if (!data || data.length === 0) {
              controller.close();
              return;
            }
            controller.enqueue(
              encoder.encode(data.map((r) => JSON.stringify(r)).join("\n") + "\n"),
            );
            from += data.length;
            // There is deliberately no close-on-a-short-page here, and the
            // expression is described rather than quoted: a test asserts it
            // is gone, and a comment carrying it would satisfy that
            // assertion forever.
            //
            // This file is careful everywhere else: a mid-stream failure emits
            // `{"_export_error": …}` as a final line "so the consumer can tell a
            // truncated export from a complete one". The short-page close was
            // the one path that ended the stream WITHOUT emitting it — and it
            // fires whenever the server hands back less than it was asked for,
            // which is the operator's `db-max-rows` and not ours. A project
            // tuned below PAGE would have closed after one page, silently, and
            // produced a file indistinguishable from the whole trail.
            //
            // A short page proves nothing; an empty one proves the end, and the
            // branch above already handles it. The cost is one extra request per
            // export, against an export that is already one request per page.
          },
        });

        return new Response(stream, {
          headers: {
            "Content-Type": "application/x-ndjson; charset=utf-8",
            "Cache-Control": "no-store",
            "Content-Disposition": `attachment; filename="${name}-export.ndjson"`,
          },
        });
      },
    },
  },
});
