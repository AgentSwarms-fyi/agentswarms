// Makes an agent from an agent template for the signed-in caller: the agent,
// its knowledge base and documents, and any example approval. Used by
// "Use" on an agent in the template gallery (R530), through the Agents page.
// What it makes, and why every lookup names the caller, is in
// src/utils/templates/provision.server.ts.
//
// Same caller flow as /api/chat: the client sends the user's Supabase access
// token in the Authorization header, and the client built from it is the
// caller's own, so RLS scopes every write.

import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { callerFailure, callerFailureStatus } from "@/utils/callerLookup.server";
import { withNulSafeFetch } from "@/integrations/supabase/nulSafeFetch";
import { provisionAgentTemplate } from "@/utils/templates/provision.server";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });

function getUserSupabase(authToken: string) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return null;
  return createClient<Database>(
    url,
    key,
    withNulSafeFetch({
      auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${authToken}` } },
    }),
  );
}

export const Route = createFileRoute("/api/templates/provision")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: corsHeaders }),

      POST: async ({ request }) => {
        try {
          const auth = request.headers.get("authorization");
          if (!auth?.startsWith("Bearer ")) {
            return json(401, { error: "Authentication required" });
          }
          const token = auth.slice(7);
          const sb = getUserSupabase(token);
          if (!sb) return json(500, { error: "Server is not configured" });

          const { data: claimsData, error: claimsErr } = await sb.auth.getClaims(token);
          if (claimsErr || !claimsData?.claims?.sub) {
            return json(callerFailureStatus(claimsErr), {
              error: callerFailure(claimsErr, "Invalid auth token"),
            });
          }

          const body = (await request.json().catch(() => ({}))) as { templateId?: unknown };
          if (typeof body.templateId !== "string" || !body.templateId) {
            return json(400, { error: "templateId is required" });
          }

          const res = await provisionAgentTemplate(sb, claimsData.claims.sub, body.templateId);
          if (!res.ok) return json(res.status, { error: res.error });
          const { ok: _ok, ...out } = res;
          return json(200, out);
        } catch (e) {
          console.error("provision route error:", e);
          return json(500, { error: e instanceof Error ? e.message : "Unknown error" });
        }
      },
    },
  },
});
