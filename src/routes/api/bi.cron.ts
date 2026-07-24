// POST/GET /api/bi/cron — run one pass of all scheduled work.
//
// Drives BI refreshes + data alerts, prep flows, catalog crawls, audit purge,
// scheduled swarm runs, and notebook-kernel reaping. Called (a) by signed-in
// clients on app load (which also starts the in-process 60s scheduler and runs
// a catch-up pass) and (b) by external cron services — the required path on
// serverless and the recommended path for autoscaled multi-instance
// deployments. Auth: a valid Supabase access token (any signed-in user) OR the
// BI_CRON_TOKEN env value.
//
// A cross-instance lease inside runCronPass() guarantees only one pass runs at
// a time across the whole fleet, so this is safe to call from every instance
// and from an external cron simultaneously — extra callers just get
// `skipped: true`.
import { createFileRoute } from "@tanstack/react-router";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { ensureScheduler, runCronPass } from "@/utils/bi/refresh.server";

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
    // No origin is passed: self-call origins are resolved from configuration
    // inside the scheduler (see internalOrigin.server), never from this
    // request's Host header, which a caller controls.
    const result = await runCronPass({ force: bearer === cronToken });
    return json({ ok: true, skipped: !result.ran, ...result });
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
