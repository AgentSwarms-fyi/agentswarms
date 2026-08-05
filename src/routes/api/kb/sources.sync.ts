// POST /api/kb/sources/sync — run one connector source's sync right now.
//
// Same engine the scheduler runs (syncKbSource), so the manual button and the
// cron pass cannot disagree about what a sync does or what counts as success.

import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { syncKbSource } from "@/utils/kb/sync.server";

const Body = z.object({ source_id: z.string().uuid() });

export const Route = createFileRoute("/api/kb/sources/sync")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = request.headers.get("Authorization") || "";
        const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
        if (!token) return Response.json({ error: "Not signed in" }, { status: 401 });

        let body: z.infer<typeof Body>;
        try {
          body = Body.parse(await request.json());
        } catch (err) {
          return Response.json(
            { error: err instanceof Error ? err.message : "Invalid request body" },
            { status: 400 },
          );
        }

        const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
        const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
        if (!supabaseUrl || !serviceKey) {
          return Response.json({ error: "Backend misconfigured" }, { status: 500 });
        }
        const userClient = createClient(supabaseUrl, process.env.SUPABASE_PUBLISHABLE_KEY || "", {
          global: { headers: { Authorization: `Bearer ${token}` } },
        });
        const { data: userRes } = await userClient.auth.getUser();
        if (!userRes?.user) return Response.json({ error: "Not signed in" }, { status: 401 });

        const admin = createClient(supabaseUrl, serviceKey);
        const { data: source } = await admin
          .from("kb_sources")
          .select("id, user_id, knowledge_base_id, kind, label, config, credentials, access_scope")
          .eq("id", body.source_id)
          .maybeSingle();
        if (!source || source.user_id !== userRes.user.id) {
          return Response.json({ error: "Source not found" }, { status: 404 });
        }

        const outcome = await syncKbSource(admin, source);
        const status = outcome.status === "ok" ? 200 : outcome.status === "error" ? 502 : 207;
        return Response.json(
          { ok: outcome.ok, status: outcome.status, error: outcome.error, stats: outcome.stats },
          { status },
        );
      },
    },
  },
});
