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

const HEADERS = { "Content-Type": "application/json", "Cache-Control": "no-store" };
const DB_TIMEOUT_MS = 3000;

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
        const db = await dbReachable();
        const body = db.ok
          ? { status: "ready", checks: { db: true } }
          : { status: "not_ready", checks: { db: false }, error: db.error };
        return new Response(JSON.stringify(body), { status: db.ok ? 200 : 503, headers: HEADERS });
      },
      HEAD: async () => {
        const db = await dbReachable();
        return new Response(null, {
          status: db.ok ? 200 : 503,
          headers: { "Cache-Control": "no-store" },
        });
      },
    },
  },
});
