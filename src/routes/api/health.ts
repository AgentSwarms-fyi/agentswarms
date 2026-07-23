// GET/HEAD /api/health — lightweight liveness probe for load balancers,
// container orchestrators, and uptime monitors.
//
// No auth, no database work: it just confirms the SSR server process is up and
// serving. A hung or crashed process won't respond at all, which is exactly
// what an LB health check detects. Keep it cheap — probes hit it frequently.
import { createFileRoute } from "@tanstack/react-router";

const HEADERS = { "Content-Type": "application/json", "Cache-Control": "no-store" };

function ok(): Response {
  return new Response(
    JSON.stringify({ status: "ok", service: "agentswarms", time: new Date().toISOString() }),
    { status: 200, headers: HEADERS },
  );
}

export const Route = createFileRoute("/api/health")({
  server: {
    handlers: {
      GET: () => ok(),
      HEAD: () => new Response(null, { status: 200, headers: { "Cache-Control": "no-store" } }),
    },
  },
});
