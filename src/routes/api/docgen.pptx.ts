// POST /api/docgen/pptx
// Optional server-side PowerPoint renderer. Forwards a FILLED plan (charts
// already materialised client-side, diagrams pre-rendered to SVG) to the
// self-hosted python-pptx doc-gen service (DOCGEN_SERVICE_URL), which produces
// NATIVE editable charts/tables/text. With `verify`, the service also returns
// the slides as images, a vision model reviews them as the user (the chat's
// model, else the instance default; see deckReview.server.ts), and the deck is
// rendered again with the fixes. Returns { pptx_base64, thumb, notes }.
//
// When no service can be reached (e.g. Cloudflare Workers, or the container
// isn't running) this returns 501 { error: "not_configured" } and the browser
// falls back to the in-app pptxgenjs generator — so nothing breaks by default.
//
// Auth: Bearer token (any signed-in user).
import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import { resolveDocgenBaseUrl, docgenAuthHeaders } from "@/utils/docgenService.server";
import { callerFailure, callerFailureStatus } from "@/utils/callerLookup.server";
import { withNulSafeFetch } from "@/integrations/supabase/nulSafeFetch";
import { applyDeckFixes, reviewNote } from "@/lib/docGen/deckReview";
import type { PptxPlan } from "@/lib/docGen/types";
import { reviewDeck, slideImages } from "@/utils/deckReview.server";

/** One LibreOffice render of a deck, slide images included when asked for. */
const RENDER_TIMEOUT_MS = 90_000;

type Rendered = { pptx_base64: string; thumb?: string | null; images?: unknown };

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

export const Route = createFileRoute("/api/docgen/pptx")({
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
          withNulSafeFetch({ global: { headers: { Authorization: `Bearer ${token}` } } }),
        );
        const {
          data: { user },
          error: authError,
        } = await userClient.auth.getUser();
        if (!user) {
          return json(
            { error: callerFailure(authError, "Unauthorized") },
            callerFailureStatus(authError),
          );
        }

        const body = (await request.json().catch(() => ({}))) as {
          plan?: unknown;
          verify?: boolean;
          model?: unknown;
        };
        const plan = body.plan as PptxPlan | undefined;
        if (!plan || typeof plan !== "object" || !Array.isArray(plan.slides)) {
          return json({ error: "plan required" }, 400);
        }

        // One render; with `images`, the slides come back as PNGs too.
        const render = async (images: boolean) => {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), RENDER_TIMEOUT_MS);
          try {
            const resp = await fetch(`${serviceUrl}/render`, {
              method: "POST",
              headers: { "Content-Type": "application/json", ...docgenAuthHeaders() },
              body: JSON.stringify({ plan, images }),
              signal: ctrl.signal,
            });
            const text = await resp.text();
            if (!resp.ok) throw new Error(text.slice(0, 500) || `doc-gen replied ${resp.status}`);
            return JSON.parse(text) as Rendered;
          } catch (e) {
            throw new Error((e as Error).name === "AbortError" ? "timeout" : (e as Error).message);
          } finally {
            clearTimeout(timer);
          }
        };

        let out: Rendered;
        try {
          out = await render(!!body.verify);
        } catch (e) {
          return json({ error: "render_failed", detail: (e as Error).message }, 502);
        }
        const notes: string[] = [];
        if (body.verify) {
          // The review is best-effort: whatever it says, the deck ships.
          const slides = slideImages(out.images);
          const review = await reviewDeck({
            userId: user.id,
            choice: typeof body.model === "string" ? body.model.slice(0, 200) : null,
            title: String(plan.title ?? ""),
            images: slides.images,
            total: slides.total,
          });
          if (!review.ok) {
            notes.push(`The slide review did not run: ${review.error}`);
          } else {
            const changed = applyDeckFixes(plan, review.fixes);
            notes.push(
              reviewNote(review.model, review.fixes, changed, {
                reviewed: slides.images.length,
                total: slides.total,
              }),
            );
            if (changed) {
              try {
                out = await render(false);
              } catch (e) {
                notes.push(
                  `The reviewed deck could not be rendered (${(e as Error).message}); this is the first render.`,
                );
              }
            }
          }
        }
        return json({ pptx_base64: out.pptx_base64, thumb: out.thumb ?? null, notes });
      },
    },
  },
});
