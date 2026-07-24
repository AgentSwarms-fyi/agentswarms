// GET /api/metrics — Prometheus scrape endpoint.
//
// Exposes fleet-level operational gauges (run/trace volume, error mix, spend,
// active users) in the Prometheus text exposition format, so an enterprise can
// point Prometheus / Grafana Agent / Datadog's OpenMetrics check at it.
//
// Auth: a dedicated METRICS_TOKEN bearer. UNSET = endpoint DISABLED (404), so
// fleet metrics are never exposed unauthenticated by default. Prometheus sends
// it via `authorization: { credentials: <token> }` (bearer) in the scrape job.
//
// Cost: everything is either a bounded 24h head-count or the service-side
// admin_spend_by_user aggregate (one row per active user), and the whole
// payload is cached briefly so frequent scrapes don't hammer Postgres.
//
// These are gauges (current values), not counters — rows can be purged by
// retention, which would break a counter's monotonicity assumption. For
// request-rate/latency RED metrics you'd add an in-process registry; this is
// the DB-derived health layer.
import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const STATUSES = ["success", "error", "running"] as const;
const CACHE_TTL_MS = 15_000;
let cache: { at: number; body: string } | null = null;

/** Constant-time string compare (lengths are not secret here). */
function tokenMatches(presented: string, expected: string): boolean {
  if (presented.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++)
    diff |= presented.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

async function countSince(
  table: "execution_traces" | "swarm_runs",
  status: string,
  sinceIso: string,
) {
  const { count, error } = await supabaseAdmin
    .from(table)
    .select("id", { head: true, count: "exact" })
    .eq("status", status)
    .gte("created_at", sinceIso);
  if (error) throw error;
  return count ?? 0;
}

function line(name: string, value: number, labels?: Record<string, string>): string {
  const lbl = labels
    ? "{" +
      Object.entries(labels)
        .map(([k, v]) => `${k}="${v}"`)
        .join(",") +
      "}"
    : "";
  return `${name}${lbl} ${value}`;
}

async function buildMetrics(): Promise<string> {
  const startedAt = Date.now();
  const now = new Date();
  const since24h = new Date(now.getTime() - 86_400_000).toISOString();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();

  const out: string[] = [];
  const push = (help: string, name: string, rows: string[]) => {
    out.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, ...rows);
  };

  push("1 if the process is serving.", "agentswarms_up", [line("agentswarms_up", 1)]);

  let dbUp = 1;
  try {
    const traceRows: string[] = [];
    const runRows: string[] = [];
    for (const s of STATUSES) {
      traceRows.push(
        line(
          "agentswarms_execution_traces_24h",
          await countSince("execution_traces", s, since24h),
          {
            status: s,
          },
        ),
      );
      runRows.push(
        line("agentswarms_swarm_runs_24h", await countSince("swarm_runs", s, since24h), {
          status: s,
        }),
      );
    }
    push("LLM calls in the last 24h, by status.", "agentswarms_execution_traces_24h", traceRows);
    push("Swarm runs in the last 24h, by status.", "agentswarms_swarm_runs_24h", runRows);

    // Spend + active users from the server-side aggregate (one row per user).
    const { data: mtd, error: mtdErr } = await supabaseAdmin.rpc("admin_spend_by_user", {
      _since: monthStart,
    });
    if (mtdErr) throw mtdErr;
    const spend = (mtd ?? []).reduce((s, r) => s + Number(r.cost ?? 0), 0);
    push("Month-to-date AI spend in USD across all users.", "agentswarms_spend_usd_mtd", [
      line("agentswarms_spend_usd_mtd", Number(spend.toFixed(6))),
    ]);

    const { data: active, error: actErr } = await supabaseAdmin.rpc("admin_spend_by_user", {
      _since: since24h,
    });
    if (actErr) throw actErr;
    push("Distinct users with an LLM call in the last 24h.", "agentswarms_active_users_24h", [
      line("agentswarms_active_users_24h", (active ?? []).length),
    ]);
  } catch (e) {
    dbUp = 0;
    console.warn("[metrics] db query failed:", e instanceof Error ? e.message : String(e));
  }

  push("1 if the database was reachable for this scrape.", "agentswarms_db_up", [
    line("agentswarms_db_up", dbUp),
  ]);
  push(
    "Wall time to build this scrape response, in seconds.",
    "agentswarms_scrape_duration_seconds",
    [line("agentswarms_scrape_duration_seconds", (Date.now() - startedAt) / 1000)],
  );

  return out.join("\n") + "\n";
}

export const Route = createFileRoute("/api/metrics")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const token = process.env.METRICS_TOKEN;
        if (!token)
          return new Response("metrics endpoint is disabled (set METRICS_TOKEN)", { status: 404 });
        const auth = request.headers.get("authorization");
        const presented = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : "";
        if (!presented || !tokenMatches(presented, token)) {
          return new Response("unauthorized", { status: 401 });
        }

        if (!cache || Date.now() - cache.at > CACHE_TTL_MS) {
          cache = { at: Date.now(), body: await buildMetrics() };
        }
        return new Response(cache.body, {
          status: 200,
          headers: {
            "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
            "Cache-Control": "no-store",
          },
        });
      },
    },
  },
});
