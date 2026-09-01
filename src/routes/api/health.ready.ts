// GET/HEAD /api/health/ready — readiness probe.
//
// Distinct from /api/health (liveness). Liveness answers "is the process
// alive?"; readiness answers "can it actually serve requests right now?" —
// principally, can it reach its database. A pod that is up but cannot reach
// Postgres should be pulled from the load-balancer rotation, not sent traffic.
//
//   200 { status: "ready",     checks: { db: true } }
//   503 { status: "not_ready", checks: { db: false }, error?: string }
//
// No auth (infra probe). The DB check is a tiny head-count with a hard timeout,
// so a hung database makes the probe fail FAST (503) rather than hang the
// health check itself — which would otherwise look like a liveness failure.
import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { appRole } from "@/utils/appRole";

const HEADERS = { "Content-Type": "application/json", "Cache-Control": "no-store" };
const DB_TIMEOUT_MS = 3000;

// An analytics node answers "no" here ON PURPOSE, so a load balancer stops
// sending it interactive traffic while /api/health keeps reporting it alive and
// the orchestrator leaves it running. That is the whole of APP_ROLE=analytics:
// readiness routes traffic, liveness decides restarts, and the two disagreeing
// is precisely how you hold a node out of the request path without needing a
// feature from your load balancer. See src/utils/appRole.ts.
function analyticsNotReady(): Response {
  return new Response(
    JSON.stringify({
      status: "not_ready",
      role: "analytics",
      reason: "APP_ROLE=analytics — this node is held out of the interactive pool by design",
    }),
    { status: 503, headers: HEADERS },
  );
}

async function dbReachable(): Promise<{ ok: boolean; error?: string }> {
  try {
    const probe = supabaseAdmin
      .from("iam_settings")
      .select("id", { head: true, count: "exact" })
      .then(({ error }) => ({ ok: !error, error: error?.message }));
    const timeout = new Promise<{ ok: boolean; error?: string }>((resolve) =>
      setTimeout(
        () => resolve({ ok: false, error: `db check exceeded ${DB_TIMEOUT_MS}ms` }),
        DB_TIMEOUT_MS,
      ),
    );
    return await Promise.race([probe, timeout]);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export const Route = createFileRoute("/api/health/ready")({
  server: {
    handlers: {
      GET: async () => {
        // Checked before the database round trip: the answer cannot change, so
        // probing Postgres every few seconds from a node nobody routes to is
        // pure load on the one component that is already the fleet's ceiling.
        if (appRole() === "analytics") return analyticsNotReady();
        const db = await dbReachable();
        const body = db.ok
          ? { status: "ready", checks: { db: true } }
          : { status: "not_ready", checks: { db: false }, error: db.error };
        return new Response(JSON.stringify(body), { status: db.ok ? 200 : 503, headers: HEADERS });
      },
      HEAD: async () => {
        if (appRole() === "analytics") {
          return new Response(null, { status: 503, headers: { "Cache-Control": "no-store" } });
        }
        const db = await dbReachable();
        return new Response(null, {
          status: db.ok ? 200 : 503,
          headers: { "Cache-Control": "no-store" },
        });
      },
    },
  },
});
