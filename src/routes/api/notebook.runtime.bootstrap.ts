// A sandbox on the ECS backend fetches its environment here, once, with the
// nonce its task was started with (bootstrap.server.ts, R477). It has no
// other credential yet: the session token is part of what it is fetching.
import { createFileRoute } from "@tanstack/react-router";
import { NONCE_RE, redeemBootstrap } from "@/utils/notebookRuntime/bootstrap.server";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export const Route = createFileRoute("/api/notebook/runtime/bootstrap")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let body: { session_id?: unknown; nonce?: unknown };
        try {
          body = await request.json();
        } catch {
          return json(400, { error: "Invalid JSON body" });
        }
        const sid = typeof body.session_id === "string" ? body.session_id : "";
        const nonce = typeof body.nonce === "string" ? body.nonce : "";
        if (!UUID_RE.test(sid) || !NONCE_RE.test(nonce)) {
          return json(400, { error: "session_id and nonce are required" });
        }
        try {
          const env = await redeemBootstrap(sid, nonce);
          // One answer for a wrong, used or expired nonce: the caller may not
          // be the sandbox.
          if (!env) return json(404, { error: "No environment for this nonce" });
          return json(200, { env });
        } catch (e) {
          console.error(`[runtime] bootstrap for session ${sid} failed: ${(e as Error).message}`);
          return json(503, { error: "The environment could not be read; try again" });
        }
      },
    },
  },
});
