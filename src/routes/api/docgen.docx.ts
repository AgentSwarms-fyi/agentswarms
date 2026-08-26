// POST /api/docgen/docx
// Optional server-side Word renderer. Forwards a DocxPlan to the self-hosted
// python-docx doc-gen service (DOCGEN_SERVICE_URL), which produces a multi-page
// document with a cover, an updatable table of contents, and fixed-width
// bordered/shaded tables. Returns { docx_base64, thumb }.
//
// When no service can be reached (e.g. Cloudflare Workers, or the container
// isn't running) this returns 501 { error: "not_configured" } and the browser
// falls back to the in-app `docx` generator — so nothing breaks by default.
//
// Auth: Bearer token (any signed-in user).
import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import { resolveDocgenBaseUrl, docgenAuthHeaders } from "@/utils/docgenService.server";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

export const Route = createFileRoute("/api/docgen/docx")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { headers: corsHeaders }),
      POST: async ({ request }) => {
        // Probes for the service rather than trusting configuration, so the
        // right hostname for the run mode isn't something to get wrong.
        const serviceUrl = await resolveDocgenBaseUrl();
        if (!serviceUrl) return json({ error: "not_configured" }, 501);

        const auth = request.headers.get("authorization") || "";
        const token = auth.replace(/^Bearer\s+/i, "");
        if (!token) return json({ error: "Unauthorized" }, 401);
        // SERVER url first. VITE_SUPABASE_URL is the browser's copy, inlined at
        // build time, and the two differ whenever the app runs in a container
        // beside a self-hosted Supabase: the browser reaches it on localhost,
        // the container cannot. Reading the browser copy here made getUser()
        // fail with ECONNREFUSED, which this route reported as "Unauthorized".
        const userClient = createClient(
          (process.env.SUPABASE_URL || import.meta.env.VITE_SUPABASE_URL)!,
          import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY!,
          { global: { headers: { Authorization: `Bearer ${token}` } } },
        );
        const {
          data: { user },
        } = await userClient.auth.getUser();
        if (!user) return json({ error: "Unauthorized" }, 401);

        const body = (await request.json().catch(() => ({}))) as { plan?: unknown };
        if (!body.plan) return json({ error: "plan required" }, 400);

        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 60_000);
        try {
          const resp = await fetch(`${serviceUrl}/render/docx`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...docgenAuthHeaders(),
            },
            body: JSON.stringify({ plan: body.plan }),
            signal: ctrl.signal,
          });
          const text = await resp.text();
          if (!resp.ok) {
            return json({ error: "render_failed", detail: text.slice(0, 500) }, 502);
          }
          return new Response(text, {
            status: 200,
            headers: { "Content-Type": "application/json", ...corsHeaders },
          });
        } catch (e) {
          const msg = (e as Error).name === "AbortError" ? "timeout" : (e as Error).message;
          return json({ error: "render_failed", detail: msg }, 502);
        } finally {
          clearTimeout(timer);
        }
      },
    },
  },
});
