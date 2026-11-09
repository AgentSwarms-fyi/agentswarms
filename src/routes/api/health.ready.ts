// GET/HEAD /api/health/ready — readiness probe.
//
// Distinct from /api/health (liveness). Liveness answers "is the process
// alive?"; readiness answers "can it actually serve requests right now?" —
// principally, can it reach its database. A pod that is up but cannot reach
// Postgres should be pulled from the load-balancer rotation, not sent traffic.
//
//   200 { status: "ready",     checks: { db: true, keys: true } }
//   503 { status: "not_ready", checks: { db: false, keys: true }, error?: string }
//
// `keys` is whether the credential keyring loaded: with an external key
// provider that is the one unwrap of the data key, on the startup path and
// cached, so a node whose KMS permission is missing is held out of rotation
// (and server.mjs refuses to start it) instead of failing every credential
// read one feature at a time.
//
// No auth (infra probe). The DB check is a tiny head-count with a hard timeout,
// so a hung database makes the probe fail FAST (503) rather than hang the
// health check itself — which would otherwise look like a liveness failure.
//
// `?scope=local` leaves the database out (R463):
//
//   200 { status: "ready", scope: "local", checks: { keys: true } }
//
// It is the check a LOAD BALANCER should use when its health decides whether
// the orchestrator REPLACES the node, as ECS does with a target group. With
// the database in the check, a one-to-two-minute RDS failover failed every
// node's health at once, and ECS would replace them all — turning a database
// blip into a full outage and a cold start. Database health belongs in
// metrics and alarms. Both scopes answer 503 while the process drains.
import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { appRole } from "@/utils/appRole";
import { isDraining } from "@/utils/drain";
import { keyringReady } from "@/utils/providers/crypto.server";

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

function draining(): Response {
  return new Response(
    JSON.stringify({
      status: "not_ready",
      reason: "draining — this process received SIGTERM and is finishing its open requests",
    }),
    { status: 503, headers: HEADERS },
  );
}

/** `?scope=local`: everything but the database. */
function isLocalScope(request: Request): boolean {
  return new URL(request.url).searchParams.get("scope") === "local";
}

type Readiness = { ok: boolean; body: Record<string, unknown> };

async function readiness(local: boolean): Promise<Readiness> {
  const keys = await keyringReady();
  if (local) {
    return keys.ok
      ? { ok: true, body: { status: "ready", scope: "local", checks: { keys: true } } }
      : {
          ok: false,
          body: { status: "not_ready", scope: "local", checks: { keys: false }, error: keys.error },
        };
  }
  const db = await dbReachable();
  const ok = db.ok && keys.ok;
  return ok
    ? { ok, body: { status: "ready", checks: { db: true, keys: true } } }
    : {
        ok,
        body: {
          status: "not_ready",
          checks: { db: db.ok, keys: keys.ok },
          error: [db.ok ? null : db.error, keys.ok ? null : keys.error].filter(Boolean).join("; "),
        },
      };
}

export const Route = createFileRoute("/api/health/ready")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        // Checked before the database round trip: the answer cannot change, so
        // probing Postgres every few seconds from a node nobody routes to is
        // pure load on the one component that is already the fleet's ceiling.
        if (appRole() === "analytics") return analyticsNotReady();
        if (isDraining()) return draining();
        const r = await readiness(isLocalScope(request));
        return new Response(JSON.stringify(r.body), {
          status: r.ok ? 200 : 503,
          headers: HEADERS,
        });
      },
      HEAD: async ({ request }) => {
        const no = () =>
          new Response(null, { status: 503, headers: { "Cache-Control": "no-store" } });
        if (appRole() === "analytics" || isDraining()) return no();
        const r = await readiness(isLocalScope(request));
        return new Response(null, {
          status: r.ok ? 200 : 503,
          headers: { "Cache-Control": "no-store" },
        });
      },
    },
  },
});
