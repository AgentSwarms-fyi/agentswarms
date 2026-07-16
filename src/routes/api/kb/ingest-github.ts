// POST /api/kb/ingest-github
//
// Ingests Markdown / text files from a public GitHub repo into a KB.
// Body: { knowledge_base_id, repo: "owner/name", branch?, globs?, source_id? }
//
// Real, not mock:
//   1. Resolves the default branch if `branch` not provided.
//   2. Fetches the recursive git tree.
//   3. Filters paths by user-supplied globs (defaults to *.md, *.mdx, *.txt).
//   4. Downloads each matching file's raw content.
//   5. Inserts one knowledge_documents row per file with source_id set.
//
// Auth: optional GITHUB_TOKEN env var raises rate limits; works without it
// for public repos at the standard 60 req/h unauthenticated quota.

import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { embedAndStoreDocuments } from "@/utils/tools/embedding.server";

const Body = z.object({
  knowledge_base_id: z.string().uuid(),
  source_id: z.string().uuid().optional(),
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "repo must be owner/name"),
  branch: z.string().optional(),
  globs: z.array(z.string()).optional(),
  label: z.string().optional(),
  max_files: z.number().int().min(1).max(200).optional(),
});

const DEFAULT_GLOBS = ["*.md", "*.mdx", "*.txt", "*.markdown"];
const MAX_FILES_DEFAULT = 50;
const MAX_FILE_BYTES = 1_000_000; // 1 MB per file safety cap

function ghHeaders(): Record<string, string> {
  const h: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "AgentSwarms-KB-Ingest",
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

// Tiny glob matcher: supports `*`, `**`, and literal extensions. Good enough
// for `*.md`, `docs/**/*.mdx`, etc., without pulling in micromatch.
function globToRegex(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "::DOUBLE_STAR::")
    .replace(/\*/g, "[^/]*")
    .replace(/::DOUBLE_STAR::/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

function matchesAny(path: string, globs: string[]): boolean {
  return globs.some(
    (g) => globToRegex(g).test(path) || globToRegex(g).test(path.split("/").pop() || ""),
  );
}

export const Route = createFileRoute("/api/kb/ingest-github")({
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
            { error: err instanceof Error ? err.message : "Invalid body" },
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
        const user = userRes?.user;
        if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });

        const admin = createClient(supabaseUrl, serviceKey);
        const { data: kb } = await admin
          .from("knowledge_bases")
          .select("id, user_id")
          .eq("id", body.knowledge_base_id)
          .maybeSingle();
        if (!kb || kb.user_id !== user.id) {
          return Response.json({ error: "Knowledge base not found" }, { status: 404 });
        }

        const globs = body.globs && body.globs.length > 0 ? body.globs : DEFAULT_GLOBS;
        const maxFiles = body.max_files ?? MAX_FILES_DEFAULT;

        // Upsert source row.
        let sourceId = body.source_id;
        const sourceConfig = { repo: body.repo, branch: body.branch || null, globs };
        if (!sourceId) {
          const { data: created, error: srcErr } = await admin
            .from("kb_sources")
            .insert({
              knowledge_base_id: body.knowledge_base_id,
              user_id: user.id,
              kind: "github",
              label: body.label || body.repo,
              config: sourceConfig,
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
            .update({ status: "syncing", error: null, config: sourceConfig })
            .eq("id", sourceId)
            .eq("user_id", user.id);
        }

        try {
          // Resolve branch
          let branch = body.branch;
          if (!branch) {
            const repoRes = await fetch(`https://api.github.com/repos/${body.repo}`, {
              headers: ghHeaders(),
            });
            if (!repoRes.ok) {
              throw new Error(
                `GitHub repo lookup ${repoRes.status}: ${(await repoRes.text()).slice(0, 200)}`,
              );
            }
            const repoJson = (await repoRes.json()) as { default_branch?: string };
            branch = repoJson.default_branch || "main";
          }

          // Recursive tree
          const treeRes = await fetch(
            `https://api.github.com/repos/${body.repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
            { headers: ghHeaders() },
          );
          if (!treeRes.ok) {
            throw new Error(
              `GitHub tree fetch ${treeRes.status}: ${(await treeRes.text()).slice(0, 200)}`,
            );
          }
          const treeJson = (await treeRes.json()) as {
            tree?: { path?: string; type?: string; size?: number }[];
            truncated?: boolean;
          };
          const blobs = (treeJson.tree || []).filter(
            (t) => t.type === "blob" && t.path && matchesAny(t.path, globs),
          );
          if (blobs.length === 0) {
            throw new Error(`No files in ${body.repo}@${branch} matched ${globs.join(", ")}`);
          }
          const subset = blobs.slice(0, maxFiles);

          // Fetch each file's raw content. Done sequentially to be polite to
          // the unauthenticated rate limit; for typical doc repos this is fast.
          const docs: {
            knowledge_base_id: string;
            user_id: string;
            source_id: string;
            name: string;
            content: string;
            metadata: Record<string, unknown>;
          }[] = [];
          for (const b of subset) {
            if (!b.path) continue;
            if (typeof b.size === "number" && b.size > MAX_FILE_BYTES) continue;
            const rawUrl = `https://raw.githubusercontent.com/${body.repo}/${branch}/${b.path}`;
            const fileRes = await fetch(rawUrl, { headers: ghHeaders() });
            if (!fileRes.ok) continue;
            const text = await fileRes.text();
            if (!text.trim()) continue;
            docs.push({
              knowledge_base_id: body.knowledge_base_id,
              user_id: user.id,
              source_id: sourceId!,
              name: `${body.repo}/${b.path}`,
              content: text.slice(0, 500_000), // hard cap per row
              metadata: {
                source: "github",
                repo: body.repo,
                branch,
                path: b.path,
                url: rawUrl,
                ingested_at: new Date().toISOString(),
              },
            });
          }

          if (docs.length === 0) {
            throw new Error("All matched files were empty or unfetchable.");
          }

          await admin.from("knowledge_documents").delete().eq("source_id", sourceId);
          const { data: insertedDocs, error: insErr } = await admin
            .from("knowledge_documents")
            .insert(docs)
            .select("id, knowledge_base_id, user_id, is_sample, content");
          if (insErr) throw new Error(insErr.message);

          // Embed + index. If embedding fails the source is marked
          // `embedding_failed` (not `ok`) so the UI / re-sync surfaces it
          // instead of silently falling back to keyword search.
          let chunksInserted = 0;
          let embedError: string | null = null;
          const openaiKey = process.env.OPENAI_API_KEY;
          if (openaiKey && insertedDocs && insertedDocs.length > 0) {
            try {
              const r = await embedAndStoreDocuments({
                sb: admin,
                docs: insertedDocs,
                openaiKey,
                userId: user.id,
                surface: "KB: Ingest GitHub",
              });
              chunksInserted = r.chunksInserted;
            } catch (err) {
              embedError = err instanceof Error ? err.message : String(err);
              console.warn("[ingest-github] embedding failed:", err);
            }
          } else if (!openaiKey) {
            embedError = "OPENAI_API_KEY not configured";
          }

          await admin
            .from("kb_sources")
            .update({
              status: embedError ? "embedding_failed" : "ok",
              last_synced_at: new Date().toISOString(),
              error: embedError,
              config: {
                ...sourceConfig,
                branch,
                last_file_count: docs.length,
                truncated: !!treeJson.truncated,
              },
            })
            .eq("id", sourceId)
            .eq("user_id", user.id);

          return Response.json({
            ok: true,
            source_id: sourceId,
            documents: docs.length,
            chunks: chunksInserted,
            branch,
            truncated: !!treeJson.truncated,
            embedding_error: embedError,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await admin
            .from("kb_sources")
            .update({ status: "error", error: msg })
            .eq("id", sourceId)
            .eq("user_id", user.id);
          return Response.json({ error: msg, source_id: sourceId }, { status: 502 });
        }
      },
    },
  },
});
