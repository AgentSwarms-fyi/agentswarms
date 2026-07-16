// POST /api/kb/ingest-url
//
// Server route that ingests a single URL into a Knowledge Base via Firecrawl.
// Steps:
//   1. Verify the caller is logged in (Bearer JWT against Supabase).
//   2. Verify they own the target knowledge_base_id.
//   3. Upsert a row in `kb_sources` (kind=url) so the source is tracked.
//   4. Call Firecrawl `/v2/scrape` for markdown.
//   5. Replace any existing knowledge_documents rows tied to this source_id
//      with one fresh row containing the scraped markdown.
//   6. Update kb_sources.status / last_synced_at / error.
//
// Real, not mock: hits the live Firecrawl API with FIRECRAWL_API_KEY from the
// project secrets. If the secret is missing, returns a clear 412 so the UI
// can prompt the user to connect Firecrawl in Connectors.

import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { embedAndStoreDocuments } from "@/utils/tools/embedding.server";

const Body = z.object({
  knowledge_base_id: z.string().uuid(),
  source_id: z.string().uuid().optional(), // present on re-sync
  url: z.string().url(),
  label: z.string().optional(),
});

const FIRECRAWL_BASE = "https://api.firecrawl.dev/v2";

export const Route = createFileRoute("/api/kb/ingest-url")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = request.headers.get("Authorization") || "";
        const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
        if (!token) {
          return Response.json({ error: "Not signed in" }, { status: 401 });
        }

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

        // User-scoped client (validates the JWT) for the auth check.
        const userClient = createClient(supabaseUrl, process.env.SUPABASE_PUBLISHABLE_KEY || "", {
          global: { headers: { Authorization: `Bearer ${token}` } },
        });
        const { data: userRes } = await userClient.auth.getUser();
        const user = userRes?.user;
        if (!user) {
          return Response.json({ error: "Not signed in" }, { status: 401 });
        }

        // Service-role client for the actual writes (we already verified ownership).
        const admin = createClient(supabaseUrl, serviceKey);

        // Verify ownership of the KB.
        const { data: kb } = await admin
          .from("knowledge_bases")
          .select("id, user_id")
          .eq("id", body.knowledge_base_id)
          .maybeSingle();
        if (!kb || kb.user_id !== user.id) {
          return Response.json({ error: "Knowledge base not found" }, { status: 404 });
        }

        const firecrawlKey = process.env.FIRECRAWL_API_KEY;
        if (!firecrawlKey) {
          return Response.json(
            {
              error:
                "Firecrawl is not connected. Open Connectors and link Firecrawl, then try again.",
              code: "FIRECRAWL_NOT_CONNECTED",
            },
            { status: 412 },
          );
        }

        // Upsert source row (insert if no source_id, otherwise update existing).
        let sourceId = body.source_id;
        if (!sourceId) {
          const { data: created, error: srcErr } = await admin
            .from("kb_sources")
            .insert({
              knowledge_base_id: body.knowledge_base_id,
              user_id: user.id,
              kind: "url",
              label: body.label || body.url,
              config: { url: body.url },
              status: "syncing",
            })
            .select("id")
            .single();
          if (srcErr || !created) {
            return Response.json(
              { error: srcErr?.message || "Could not record source" },
              { status: 500 },
            );
          }
          sourceId = created.id;
        } else {
          await admin
            .from("kb_sources")
            .update({ status: "syncing", error: null })
            .eq("id", sourceId)
            .eq("user_id", user.id);
        }

        // Call Firecrawl scrape (markdown).
        let markdown = "";
        let title = body.label || body.url;
        try {
          const res = await fetch(`${FIRECRAWL_BASE}/scrape`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${firecrawlKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              url: body.url,
              formats: ["markdown"],
              onlyMainContent: true,
            }),
          });
          if (!res.ok) {
            const txt = await res.text().catch(() => "");
            throw new Error(`Firecrawl ${res.status}: ${txt.slice(0, 300)}`);
          }
          const json = (await res.json()) as {
            data?: { markdown?: string; metadata?: { title?: string } };
            markdown?: string;
            metadata?: { title?: string };
          };
          markdown = json.data?.markdown || json.markdown || "";
          const metaTitle = json.data?.metadata?.title || json.metadata?.title;
          if (metaTitle) title = metaTitle;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await admin
            .from("kb_sources")
            .update({ status: "error", error: msg })
            .eq("id", sourceId)
            .eq("user_id", user.id);
          return Response.json({ error: msg, source_id: sourceId }, { status: 502 });
        }

        if (!markdown.trim()) {
          await admin
            .from("kb_sources")
            .update({
              status: "error",
              error: "Firecrawl returned no extractable text for this URL.",
            })
            .eq("id", sourceId)
            .eq("user_id", user.id);
          return Response.json(
            {
              error: "No extractable text on that page.",
              source_id: sourceId,
            },
            { status: 422 },
          );
        }

        // Replace any prior docs from this source.
        await admin.from("knowledge_documents").delete().eq("source_id", sourceId);
        const { data: insertedDoc, error: insErr } = await admin
          .from("knowledge_documents")
          .insert({
            knowledge_base_id: body.knowledge_base_id,
            user_id: user.id,
            source_id: sourceId,
            name: title,
            content: markdown,
            metadata: { source: "url", url: body.url, ingested_at: new Date().toISOString() },
          })
          .select("id, knowledge_base_id, user_id, is_sample, content")
          .single();
        if (insErr || !insertedDoc) {
          await admin
            .from("kb_sources")
            .update({ status: "error", error: insErr?.message || "insert failed" })
            .eq("id", sourceId)
            .eq("user_id", user.id);
          return Response.json({ error: insErr?.message || "insert failed" }, { status: 500 });
        }

        // Embed + index into kb_chunks. If embedding fails the source is
        // marked `embedding_failed` (not `ok`) so the UI / re-sync can surface
        // it — otherwise users think ingest worked and chat silently falls
        // back to keyword search.
        let chunksInserted = 0;
        let embedError: string | null = null;
        const openaiKey = process.env.OPENAI_API_KEY;
        if (openaiKey) {
          try {
            const r = await embedAndStoreDocuments({
              sb: admin,
              docs: [insertedDoc],
              openaiKey,
              userId: user.id,
              surface: "KB: Ingest URL",
            });
            chunksInserted = r.chunksInserted;
          } catch (err) {
            embedError = err instanceof Error ? err.message : String(err);
            console.warn("[ingest-url] embedding failed:", err);
          }
        } else {
          embedError = "OPENAI_API_KEY not configured";
        }

        await admin
          .from("kb_sources")
          .update({
            status: embedError ? "embedding_failed" : "ok",
            last_synced_at: new Date().toISOString(),
            error: embedError,
          })
          .eq("id", sourceId)
          .eq("user_id", user.id);

        return Response.json({
          ok: true,
          source_id: sourceId,
          documents: 1,
          chars: markdown.length,
          chunks: chunksInserted,
          embedding_error: embedError,
        });
      },
    },
  },
});
