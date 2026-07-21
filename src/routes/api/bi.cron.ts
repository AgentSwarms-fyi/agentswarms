// POST /api/bi/cron — trigger scheduled BI dashboard refreshes.
//
// Called (a) by signed-in clients on app load, which both starts the
// in-process 60s scheduler and runs a catch-up pass, and (b) by external
// cron services on serverless hosts. Auth: a valid Supabase access token
// (any signed-in user) OR the BI_CRON_TOKEN env value. Processing is
// idempotent (only due schedules run) and internally throttled.
import { createFileRoute } from "@tanstack/react-router";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { ensureScheduler, processDueSchedules } from "@/utils/bi/refresh.server";

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function handle(request: Request) {
  ensureScheduler();
  const auth = request.headers.get("Authorization") ?? "";
  const bearer = auth.replace(/^Bearer\s+/i, "").trim();
  const cronToken = process.env.BI_CRON_TOKEN;
  let allowed = Boolean(cronToken && bearer && bearer === cronToken);
  if (!allowed && bearer) {
    const { data } = await supabaseAdmin.auth.getUser(bearer);
    allowed = Boolean(data.user);
  }
  if (!allowed) return json({ error: "Unauthorized" }, 401);
  try {
    const ran = await processDueSchedules(bearer === cronToken);
    return json({ ok: true, processed: ran });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
}

export const Route = createFileRoute("/api/bi/cron")({
  server: {
    handlers: {
      POST: ({ request }) => handle(request),
      GET: ({ request }) => handle(request),
    },
  },
});
