// Public notebook run endpoint — a notebook published as an API.
//
//   POST /api/notebook/run
//   Authorization: Bearer nbk_…
//   { "inputs": { … }, "async": false }
//   → 200 { "result": …, "runId": "…" }        (sync — waits for the run)
//   → 202 { "accepted": true, "runId": "…" }   (async — poll with the runId)
//
// The batch runner already executes a notebook headlessly with governance and
// the sandbox hardening intact; this reaches that same path from outside, so a
// notebook becomes callable by your own systems without being reimplemented as
// a service.
//
// Keys are matched by hash — the plaintext is never stored — and every run is
// attributed to the key that started it.
import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { startSession, getSession } from "@/utils/notebookRuntime/service.server";
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

/** Wall-clock ceiling for a synchronous run before we hand back a runId. */
const SYNC_WAIT_MS = 110_000;
const POLL_MS = 1000;

export const Route = createFileRoute("/api/notebook/run")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: corsHeaders }),
      POST: async ({ request }) => {
        const auth = request.headers.get("authorization") || "";
        const raw = auth.replace(/^Bearer\s+/i, "").trim();
        if (!raw) return json({ error: "Missing API key" }, 401);

        // Resolve by hash: a stolen database row cannot be replayed as a key.
        const { data: key } = await supabaseAdmin
          .from("notebook_api_keys")
          .select(
            "id, user_id, notebook_id, entrypoint, is_active, expires_at, revoked_at, use_count",
          )
          .eq("key_hash", await hashNotebookApiKey(raw))
          .maybeSingle();

        if (!key || !key.is_active || key.revoked_at) {
          return json({ error: "Invalid or disabled API key" }, 401);
        }
        if (key.expires_at && new Date(key.expires_at).getTime() < Date.now()) {
          return json({ error: "API key has expired" }, 401);
        }

        let body: { inputs?: Record<string, unknown>; async?: boolean } = {};
        try {
          body = (await request.json()) as typeof body;
        } catch {
          /* an empty body is a valid no-input run */
        }

        // Usage tracking is best-effort: it must never fail the run. The count
        // is read-modify-write, so two simultaneous calls on one key can lose an
        // increment — it is an activity indicator, not a billing meter.
        void supabaseAdmin
          .from("notebook_api_keys")
          .update({
            use_count: (key.use_count ?? 0) + 1,
            last_used_at: new Date().toISOString(),
            last_used_ip:
              request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
              request.headers.get("x-real-ip") ||
              null,
          })
          .eq("id", key.id)
          .then(() => {});

        let session;
        try {
          const started = await startSession({
            userId: key.user_id,
            notebookId: key.notebook_id,
            kind: "batch",
            entrypoint: key.entrypoint || null,
            inputs: body.inputs ?? {},
          });
          session = started.session;
        } catch (e) {
          return json({ error: (e as Error).message || "Could not start the notebook" }, 503);
        }

        // Attribute the run to this key so a published notebook's history is
        // as traceable as an interactive one.
        void supabaseAdmin
          .from("notebook_runtime_sessions")
          .update({ api_key_id: key.id })
          .eq("id", session.id)
          .then(() => {});

        if (body.async) {
          return json({ accepted: true, runId: session.id }, 202);
        }

        // Synchronous: poll the session until the batch runner posts its result.
        const deadline = Date.now() + SYNC_WAIT_MS;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, POLL_MS));
          const row = await getSession(key.user_id, session.id);
          if (!row) break;
          if (row.status === "succeeded") {
            return json({ result: row.result ?? null, runId: session.id });
          }
          if (row.status === "error") {
            return json({ error: row.error || "Notebook run failed", runId: session.id }, 502);
          }
        }
        // Still running: hand back the id rather than holding the connection
        // open indefinitely. The caller polls /api/notebook/run/status.
        return json(
          {
            accepted: true,
            runId: session.id,
            note: "Still running — poll /api/notebook/run/status with this runId.",
          },
          202,
        );
      },
    },
  },
});
