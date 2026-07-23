// Reaper for notebook runtime sessions — stops idle interactive kernels and
// anything past its hard expiry, freeing cluster capacity. Idempotent.
//
// Auth mirrors /api/bi/cron: the NOTEBOOK_CRON_TOKEN (or BI_CRON_TOKEN) env
// value, OR any signed-in user (so app clients can trigger a best-effort sweep).
// Point an external scheduler at this endpoint (e.g. every 5 min) in production.
import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { reapSessions } from "@/utils/notebookRuntime/service.server";

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function handle(request: Request): Promise<Response> {
  const auth = request.headers.get("Authorization") ?? "";
  const bearer = auth.replace(/^Bearer\s+/i, "").trim();
  const cronToken = process.env.NOTEBOOK_CRON_TOKEN || process.env.BI_CRON_TOKEN;
  let allowed = Boolean(cronToken && bearer && bearer === cronToken);
  if (!allowed && bearer) {
    const { data } = await supabaseAdmin.auth.getUser(bearer);
    allowed = Boolean(data.user);
  }
  if (!allowed) return json({ error: "Unauthorized" }, 401);
  try {
    const reaped = await reapSessions();
    return json({ ok: true, reaped });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
}

export const Route = createFileRoute("/api/notebook/runtime/reap")({
  server: {
    handlers: {
      POST: ({ request }) => handle(request),
      GET: ({ request }) => handle(request),
    },
  },
});
