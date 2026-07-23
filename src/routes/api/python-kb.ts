// Knowledge-base retrieval for Developer-workspace notebooks. Server kernels
// call this via the injected `agentswarms.kb_search()` /
// `list_knowledge_bases()` / `kb_retriever()` helpers.
//
// The caller resolver accepts a Supabase user JWT (browser) or a
// notebook-runtime session token (server kernel) and, either way, restricts
// results to knowledge bases the user may read — own, IAM-granted, or public
// samples. An explicit id can never reach another tenant's data.
import { createFileRoute } from "@tanstack/react-router";
import { retrieveCitationsServer } from "@/utils/tools/kb.server";
import {
  listReadableKnowledgeBases,
  readableKbIds,
  resolvePythonCaller,
} from "@/utils/notebookRuntime/caller.server";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const Route = createFileRoute("/api/python-kb")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const caller = await resolvePythonCaller(request);
        if (!caller) return json(401, { error: "Sign in to use knowledge bases from a notebook" });

        let body: { action?: string; query?: string; kb_ids?: unknown; top_k?: number };
        try {
          body = await request.json();
        } catch {
          return json(400, { error: "Invalid JSON body" });
        }

        const action = (body.action || "search").toLowerCase();

        // ── list: the knowledge bases this user can read ──
        if (action === "list") {
          const { data, error } = await listReadableKnowledgeBases(caller);
          if (error) return json(500, { error });
          return json(200, {
            knowledge_bases: data.map((k) => ({ id: k.id, name: k.name, sample: !!k.is_sample })),
          });
        }

        if (action !== "search") {
          return json(400, { error: `Unknown action "${action}" — use "search" or "list".` });
        }

        // ── search: hybrid RAG over the requested (or all readable) KBs ──
        const query = typeof body.query === "string" ? body.query.trim() : "";
        if (!query) return json(400, { error: "A non-empty query string is required" });
        const topK = Math.max(1, Math.min(typeof body.top_k === "number" ? body.top_k : 5, 8));

        const requested = Array.isArray(body.kb_ids)
          ? (body.kb_ids as unknown[]).filter((x): x is string => typeof x === "string")
          : [];
        const { ids: kbIds, error: kbErr } = await readableKbIds(
          caller,
          requested.length ? requested : undefined,
        );
        if (kbErr) return json(500, { error: kbErr });
        if (kbIds.length === 0) {
          return json(200, {
            results: [],
            note:
              requested.length > 0
                ? "None of the requested knowledge bases are readable by your account."
                : "You don't have any knowledge bases yet — create one under Knowledge Base.",
          });
        }

        try {
          const citations = await retrieveCitationsServer({
            sb: caller.sb,
            query,
            extraKbIds: kbIds,
            userId: caller.userId,
            scopeUserId: caller.scopeUserId,
            topK,
          });
          return json(200, {
            results: citations.map((c) => ({
              document: c.documentName,
              knowledge_base: c.knowledgeBaseName,
              snippet: c.snippet,
            })),
          });
        } catch (e) {
          return json(502, {
            error: "retrieval_failed",
            message: e instanceof Error ? e.message : "Knowledge-base search failed",
          });
        }
      },
    },
  },
});
