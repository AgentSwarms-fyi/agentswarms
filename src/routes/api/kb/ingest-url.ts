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
import { resolveEmbedArgs } from "@/utils/tools/embedTarget.server";
import { reconcileSourceDocuments, type IncomingDoc } from "@/utils/kb/reconcileDocs.server";

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

        // No Firecrawl key is no longer fatal: the built-in fetcher reads
        // server-rendered pages, which is most documentation. Without this,
        // "add a URL to a knowledge base" was unavailable entirely to anyone
        // who had not signed up for a third-party service.
        const firecrawlKey = process.env.FIRECRAWL_API_KEY;

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
          if (!firecrawlKey) {
            const { nativeScrape } = await import("@/utils/nativeScrape.server");
            const r = await nativeScrape(body.url);
            markdown = r.markdown;
            if (r.title) title = r.title;
            if (r.thin) {
              // Saving the empty shell of a JavaScript-rendered page would put
              // a document in the knowledge base that answers nothing, so fail
              // with the reason instead.
              throw new Error(
                "The page returned almost no text with the built-in fetcher — it is most likely rendered by JavaScript. Connect Firecrawl to ingest pages like this.",
              );
            }
          } else {
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
          }
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
              error: firecrawlKey
                ? "Firecrawl returned no extractable text for this URL."
                : "The built-in fetcher found no extractable text at this URL.",
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

        // Reconcile rather than delete-and-reinsert: a re-scrape of the same
        // URL must update the same document row, so its id — and the
        // acl_principals keyed to it — survive, and identical text is not
        // re-embedded.
        const { stats, toEmbed } = await reconcileSourceDocuments(admin, {
          sourceId: sourceId!,
          knowledgeBaseId: body.knowledge_base_id,
          userId: user.id,
          incoming: [
            {
              externalId: body.url,
              name: title,
              content: markdown,
              metadata: { source: "url", url: body.url, ingested_at: new Date().toISOString() },
            },
          ],
        });
        // Nothing to embed AND nothing recorded as unchanged means the write
        // did not happen at all.
        const insertedDoc = toEmbed[0] ?? null;
        if (!insertedDoc && stats.unchanged === 0) {
          await admin
            .from("kb_sources")
            .update({ status: "error", error: "document write failed" })
            .eq("id", sourceId)
            .eq("user_id", user.id);
          return Response.json({ error: "document write failed" }, { status: 500 });
        }

        // Embed + index into kb_chunks. If embedding fails the source is
        // marked `embedding_failed` (not `ok`) so the UI / re-sync can surface
        // it — otherwise users think ingest worked and chat silently falls
        // back to keyword search.
        let chunksInserted = 0;
        let embedError: string | null = null;
        // Resolve the provider rather than reaching for OPENAI_API_KEY, so
        // this honours the OpenRouter-first preference like every other path.
        const embed = insertedDoc ? await resolveEmbedArgs(user.id) : null;
        if (embed && insertedDoc) {
          try {
            const r = await embedAndStoreDocuments({
              sb: admin,
              docs: [insertedDoc],
              ...embed,
              userId: user.id,
              surface: "KB: Ingest URL",
            });
            chunksInserted = r.chunksInserted;
          } catch (err) {
            embedError = err instanceof Error ? err.message : String(err);
            console.warn("[ingest-url] embedding failed:", err);
          }
        } else if (insertedDoc) {
          embedError = "No embedding provider is connected";
        }
        // insertedDoc === null means the page is byte-identical to last time:
        // nothing to embed, and the existing chunks still describe it.

        await admin
          .from("kb_sources")
          .update({
            status: embedError ? "embedding_failed" : "ok",
            last_synced_at: new Date().toISOString(),
            error: embedError,
            last_sync_stats: stats,
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
