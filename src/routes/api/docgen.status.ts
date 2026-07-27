// GET /api/docgen/status — is the optional server-side renderer usable?
//
// Deep mode falls back to the in-browser builder whenever the doc-gen service
// is missing, which produces a file identical to Fast mode. Without this probe
// the only signal was a toast after the fact, so "Deep" looked broken rather
// than unconfigured. The composer calls this on mount and disables Deep with
// the reason when it isn't available.
import { createFileRoute } from "@tanstack/react-router";
import { resolveDocgenBaseUrl, docgenAuthHeaders } from "@/utils/docgenService.server";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

export type DocgenStatus = {
  available: boolean;
  /** Why Deep mode can't run, for the tooltip. Null when available. */
  reason: string | null;
  /** Formats the service advertises (pptx/docx/xlsx) when reachable. */
  formats?: string[];
  /** True when the PowerPoint render-verify vision loop is also configured. */
  verify?: boolean;
};

// The probe hits the service on every call but the response is tiny and the
// composer only asks once per mount; a stale cache would be worse than the
// round-trip, since operators start the container mid-session.
export const Route = createFileRoute("/api/docgen/status")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { headers: corsHeaders }),
      GET: async () => {
        // Falls back to probing the well-known hostnames when the env var is
        // unset, so the common setups work without configuration at all.
        const serviceUrl = await resolveDocgenBaseUrl();
        if (!serviceUrl) {
          return json({
            available: false,
            reason:
              "No doc-gen service found. Start it with `docker compose --profile docgen up -d`, or set DOCGEN_SERVICE_URL if it runs elsewhere.",
          } satisfies DocgenStatus);
        }
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 4000);
        try {
          const resp = await fetch(`${serviceUrl}/health`, {
            headers: docgenAuthHeaders(),
            signal: ctrl.signal,
          });
          if (!resp.ok) {
            return json({
              available: false,
              reason: `The doc-gen service replied ${resp.status}. Check the container logs.`,
            } satisfies DocgenStatus);
          }
          const h = (await resp.json()) as {
            ok?: boolean;
            formats?: string[];
            verify_available?: boolean;
          };
          return json({
            available: h.ok !== false,
            reason: null,
            formats: h.formats,
            verify: h.verify_available,
          } satisfies DocgenStatus);
        } catch (e) {
          const msg = (e as Error).name === "AbortError" ? "timed out" : (e as Error).message;
          return json({
            available: false,
            reason: `Could not reach the doc-gen service at ${serviceUrl} (${msg}).`,
          } satisfies DocgenStatus);
        } finally {
          clearTimeout(timer);
        }
      },
    },
  },
});
