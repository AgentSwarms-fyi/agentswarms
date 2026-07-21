// Hybrid RAG retrieval used by both the auto-RAG path in chat.ts and the
// explicit kb_search tool. Combines vector search (kb_chunks via pgvector)
// with a keyword fallback over any documents that haven't been embedded yet
// — so existing knowledge bases, agents, and swarms keep returning results
// while embeddings are being back-filled.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { embedTexts } from "./embedding.server";

export type Citation = {
  index: number;
  documentId: string;
  documentName: string;
  knowledgeBaseId: string;
  knowledgeBaseName: string;
  snippet: string;
};

const STOP = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "if",
  "of",
  "to",
  "in",
  "on",
  "for",
  "with",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "this",
  "that",
  "these",
  "those",
  "it",
  "as",
  "at",
  "by",
  "from",
  "what",
  "how",
  "why",
  "when",
  "who",
  "which",
  "do",
  "does",
  "did",
  "i",
  "you",
  "we",
  "they",
  "he",
  "she",
  "me",
  "us",
  "them",
  "my",
  "your",
  "our",
  "their",
  "can",
  "will",
  "would",
  "should",
  "could",
]);

const SNIPPET_RADIUS = 280;
const SNIPPET_MAX = 560;

function trimSnippet(s: string): string {
  return s.replace(/\s+/g, " ").trim().slice(0, SNIPPET_MAX);
}

export async function retrieveCitationsServer(opts: {
  sb: SupabaseClient<Database>;
  agentId?: string | null;
  query: string;
  topK?: number;
  extraKbIds?: string[];
  userId?: string | null;
  /** Explicit re-ranker (swarm nodes) — agent tools config fills when absent. */
  reranker?: { provider: string; model: string };
}): Promise<Citation[]> {
  const { sb } = opts;
  const topK = Math.max(1, Math.min(opts.topK ?? 5, 8));
  // Optional re-ranker (from the agent's tools.reranker) — when set we
  // over-fetch candidates and let the model reorder them.
  let reranker: { provider: string; model: string } | null = opts.reranker ?? null;

  // 1) Resolve KB ids — agent's own + any extras passed by the caller.
  const agentKbIds: string[] = [];
  if (opts.agentId) {
    const { data: agent } = await sb
      .from("agents")
      .select("knowledge_base_id, tools")
      .eq("id", opts.agentId)
      .maybeSingle();
    if (agent) {
      const tools = (agent.tools ?? {}) as {
        knowledgeBaseIds?: unknown;
        reranker?: { provider?: string; model?: string };
      };
      if (!reranker && tools.reranker?.provider && tools.reranker.model) {
        reranker = { provider: tools.reranker.provider, model: tools.reranker.model };
      }
      const fromTools = Array.isArray(tools.knowledgeBaseIds)
        ? (tools.knowledgeBaseIds as unknown[]).filter((x): x is string => typeof x === "string")
        : [];
      if (agent.knowledge_base_id) agentKbIds.push(agent.knowledge_base_id);
      agentKbIds.push(...fromTools);
    }
  }
  const kbIds = Array.from(new Set([...agentKbIds, ...(opts.extraKbIds ?? [])]));
  if (kbIds.length === 0) return [];

  // 2) Vector search via pgvector — best-effort. The query must be embedded
  // with the same model/provider the documents were embedded with, so read
  // the embed config stamped on the KB's documents and resolve the caller's
  // integration when it isn't the built-in OpenAI key.
  let vectorCits: Citation[] = [];
  let embedKey = process.env.OPENAI_API_KEY ?? "";
  let embedEndpoint: string | undefined;
  let embedModel: string | undefined;
  let allowCustomModel = false;
  try {
    const { data: metaDocs } = await sb
      .from("knowledge_documents")
      .select("metadata")
      .in("knowledge_base_id", kbIds)
      .limit(20);
    const meta = (metaDocs ?? [])
      .map((r) => r.metadata as { embedding_provider?: string; embedding_model?: string } | null)
      .find((m) => m?.embedding_model);
    if (meta?.embedding_model) embedModel = meta.embedding_model;
    if (meta?.embedding_provider && meta.embedding_provider !== "openai_builtin" && opts.userId) {
      const { resolveOpenAICompatTransport } = await import("@/utils/providers/credentials.server");
      const t = await resolveOpenAICompatTransport({
        userId: opts.userId,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        provider: meta.embedding_provider as any,
      });
      if (t && (t.apiKey || meta.embedding_provider === "ollama")) {
        embedKey = t.apiKey ?? "";
        embedEndpoint = t.endpointUrl.replace(/\/chat\/completions\/?$/, "/embeddings");
        allowCustomModel = true;
      }
    }
  } catch {
    /* fall back to the built-in key */
  }
  if (embedKey || embedEndpoint) {
    try {
      const [queryEmbedding] = await embedTexts([opts.query], embedKey, embedModel, {
        userId: opts.userId ?? null,
        surface: "KB: Query Embedding",
        endpoint: embedEndpoint,
        allowCustomModel,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: matches, error: matchErr } = await (sb as any).rpc("match_kb_chunks", {
        query_embedding: `[${queryEmbedding.join(",")}]`,
        kb_ids: kbIds,
        match_count: reranker ? Math.min(topK * 3, 20) : topK,
      });
      if (matchErr) throw new Error(matchErr.message);
      const rows = (matches ?? []) as Array<{
        document_id: string;
        knowledge_base_id: string;
        chunk_index: number;
        content: string;
        similarity: number;
      }>;
      if (rows.length > 0) {
        const docIds = Array.from(new Set(rows.map((r) => r.document_id)));
        const [{ data: kbs }, { data: docs }] = await Promise.all([
          sb.from("knowledge_bases").select("id, name").in("id", kbIds),
          sb.from("knowledge_documents").select("id, name").in("id", docIds),
        ]);
        const kbMap = new Map((kbs ?? []).map((k) => [k.id, k.name]));
        const docMap = new Map((docs ?? []).map((d) => [d.id, d.name]));
        vectorCits = rows.map((m, i) => ({
          index: i + 1,
          documentId: m.document_id,
          documentName: docMap.get(m.document_id) ?? "Document",
          knowledgeBaseId: m.knowledge_base_id,
          knowledgeBaseName: kbMap.get(m.knowledge_base_id) ?? "Knowledge Base",
          snippet: trimSnippet(m.content),
        }));
      }
    } catch (err) {
      console.warn("[kb.server] vector search failed, falling back to keyword scan:", err);
    }
  }

  // 3) Keyword fallback over docs that haven't been embedded yet (sample KBs,
  //    legacy data) — so retrieval stays alive while back-fill runs.
  let keywordCits: Citation[] = [];
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: chunkedRows } = await (sb.from("kb_chunks" as any) as any)
      .select("document_id")
      .in("knowledge_base_id", kbIds);
    const embedded = new Set<string>(
      ((chunkedRows ?? []) as { document_id: string }[]).map((c) => c.document_id),
    );

    // Paginate so we don't silently lose docs 501+ on un-embedded KBs.
    // Supabase JS caps a single response at 1000 rows; we page in 1000-row
    // batches up to KEYWORD_SCAN_CAP. Beyond that we log + proceed with what
    // we have — at that scale the right fix is to back-fill embeddings, not
    // brute-force scan more rows.
    const KEYWORD_SCAN_CAP = 5000;
    const KEYWORD_PAGE = 1000;
    type DocRow = { id: string; name: string; content: string | null; knowledge_base_id: string };
    const allDocs: DocRow[] = [];
    for (let offset = 0; offset < KEYWORD_SCAN_CAP; offset += KEYWORD_PAGE) {
      const { data: page } = await sb
        .from("knowledge_documents")
        .select("id, name, content, knowledge_base_id")
        .in("knowledge_base_id", kbIds)
        .range(offset, offset + KEYWORD_PAGE - 1);
      if (!page || page.length === 0) break;
      allDocs.push(...page);
      if (page.length < KEYWORD_PAGE) break;
    }
    if (allDocs.length >= KEYWORD_SCAN_CAP) {
      console.warn(
        `[kb.server] keyword scan hit ${KEYWORD_SCAN_CAP}-doc cap; back-fill embeddings to ensure full coverage`,
      );
    }
    const pending = allDocs.filter((d) => !embedded.has(d.id));
    if (pending.length > 0) {
      const terms = Array.from(
        new Set(
          opts.query
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, " ")
            .split(/\s+/)
            .filter((t) => t.length >= 3 && !STOP.has(t)),
        ),
      );
      if (terms.length > 0) {
        const { data: kbs } = await sb.from("knowledge_bases").select("id, name").in("id", kbIds);
        const kbMap = new Map((kbs ?? []).map((k) => [k.id, k.name]));

        type Scored = { doc: (typeof pending)[number]; score: number; snippet: string };
        const scored: Scored[] = [];
        for (const doc of pending) {
          const content = (doc.content || "").trim();
          if (!content) continue;
          const lower = content.toLowerCase();
          let score = 0;
          let bestPos = -1;
          let bestLocalHits = 0;
          for (const term of terms) {
            let from = 0;
            let count = 0;
            while (from < lower.length) {
              const idx = lower.indexOf(term, from);
              if (idx === -1) break;
              count += 1;
              const ws = Math.max(0, idx - SNIPPET_RADIUS);
              const we = Math.min(lower.length, idx + SNIPPET_RADIUS);
              let localHits = 0;
              for (const t of terms) {
                const found = lower.indexOf(t, ws);
                if (found !== -1 && found < we) localHits += 1;
              }
              if (localHits > bestLocalHits) {
                bestLocalHits = localHits;
                bestPos = idx;
              }
              from = idx + term.length;
            }
            score += Math.min(count, 5);
          }
          if (score === 0) continue;
          const center = bestPos >= 0 ? bestPos : 0;
          const start = Math.max(0, center - SNIPPET_RADIUS);
          const end = Math.min(content.length, center + SNIPPET_RADIUS);
          const snippet =
            (start > 0 ? "…" : "") +
            content.slice(start, end).replace(/\s+/g, " ").trim() +
            (end < content.length ? "…" : "");
          scored.push({ doc, score, snippet });
        }
        scored.sort((a, b) => b.score - a.score);
        keywordCits = scored.slice(0, reranker ? Math.min(topK * 3, 20) : topK).map((s, i) => ({
          index: i + 1,
          documentId: s.doc.id,
          documentName: s.doc.name,
          knowledgeBaseId: s.doc.knowledge_base_id,
          knowledgeBaseName: kbMap.get(s.doc.knowledge_base_id) ?? "Knowledge Base",
          snippet: trimSnippet(s.snippet),
        }));
      }
    }
  } catch (err) {
    console.warn("[kb.server] keyword fallback failed:", err);
  }

  // 4) Merge — vector first (semantic priority), then keyword. Dedupe by doc.
  const seen = new Set<string>();
  const merged: Citation[] = [];
  const mergeCap = reranker ? Math.min(topK * 3, 20) : topK;
  for (const c of [...vectorCits, ...keywordCits]) {
    if (seen.has(c.documentId)) continue;
    seen.add(c.documentId);
    merged.push({ ...c, index: merged.length + 1 });
    if (merged.length >= mergeCap) break;
  }

  // 5) Optional re-rank: a cross-encoder scores query/snippet pairs and
  // reorders the over-fetched pool; any failure falls back to the original
  // similarity order so retrieval never breaks.
  if (reranker && merged.length > 1 && opts.userId) {
    const ranked = await rerankCandidates({
      userId: opts.userId,
      reranker,
      query: opts.query,
      candidates: merged,
      topK,
    });
    if (ranked) return ranked;
  }
  return merged.slice(0, topK).map((c, i) => ({ ...c, index: i + 1 }));
}

/** Cohere/Jina-style POST {base}/rerank — supported by NVIDIA NIM, vLLM,
 * and OpenRouter's rerank models. Returns null on any failure. */
async function rerankCandidates(opts: {
  userId: string;
  reranker: { provider: string; model: string };
  query: string;
  candidates: Citation[];
  topK: number;
}): Promise<Citation[] | null> {
  try {
    const { resolveOpenAICompatTransport } = await import("@/utils/providers/credentials.server");
    const t = await resolveOpenAICompatTransport({
      userId: opts.userId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      provider: opts.reranker.provider as any,
    });
    if (!t || (!t.apiKey && opts.reranker.provider !== "ollama")) return null;
    const endpoint = t.endpointUrl.replace(/\/chat\/completions\/?$/, "/rerank");
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20_000);
    const res = await fetch(endpoint, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "Content-Type": "application/json",
        ...(t.apiKey ? { Authorization: `Bearer ${t.apiKey}` } : {}),
        ...(t.extraHeaders ?? {}),
      },
      body: JSON.stringify({
        model: opts.reranker.model,
        query: opts.query,
        documents: opts.candidates.map((c) => c.snippet),
        top_n: opts.topK,
      }),
    }).finally(() => clearTimeout(timer));
    if (!res.ok) {
      console.warn(`[kb.server] rerank ${res.status} — keeping similarity order`);
      return null;
    }
    const json = (await res.json()) as {
      results?: { index: number; relevance_score?: number; score?: number }[];
      data?: { index: number; relevance_score?: number; score?: number }[];
    };
    const items = json.results ?? json.data;
    if (!Array.isArray(items) || items.length === 0) return null;
    const ordered = [...items]
      .sort((a, b) => (b.relevance_score ?? b.score ?? 0) - (a.relevance_score ?? a.score ?? 0))
      .map((r) => opts.candidates[r.index])
      .filter((c): c is Citation => Boolean(c))
      .slice(0, opts.topK);
    if (ordered.length === 0) return null;
    return ordered.map((c, i) => ({ ...c, index: i + 1 }));
  } catch (e) {
    console.warn("[kb.server] rerank failed — keeping similarity order:", (e as Error).message);
    return null;
  }
}
