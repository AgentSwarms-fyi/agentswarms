// Embedding + chunking helpers for vector-based RAG over Knowledge Bases.
//
// - chunkText: strategy-aware splitter. Honours per-document RAG settings
//   (strategy, chunk size in tokens, overlap in tokens) saved by the RAG
//   Settings dialog. ~4 chars/token is used to translate token budgets to
//   character budgets so we don't have to ship a tokenizer to the worker.
// - embedTexts: batched call to OpenAI's /v1/embeddings endpoint. Always
//   requests `dimensions: 1536` (Matryoshka truncation, supported by both
//   text-embedding-3-* models) so every vector lands in the same 1536-dim
//   space and is comparable to vectors already in kb_chunks.
// - embedAndStoreDocuments: chunks one or more documents using each doc's
//   own RAG settings, embeds every chunk with the requested model, replaces
//   any existing kb_chunks rows for those documents, then inserts the fresh
//   rows.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import {
  CHARS_PER_TOKEN,
  chunkText,
  type ChunkOptions,
  type ChunkStrategy,
} from "@/lib/kbChunking";

// Re-exported for server callers that already import them from here.
export { chunkText };
export type { ChunkOptions, ChunkStrategy };
import { chunkParentChild, isChunkMode, type ChunkMode, DEFAULT_PARENT_TOKENS } from "@/lib/kbRag";
import { generateQaPairs } from "./kbQa.server";
import { getOpenRouterApiKey } from "@/utils/providers/openrouterDefault.server";

export const DEFAULT_EMBED_MODEL = "text-embedding-3-small";
export const SUPPORTED_EMBED_MODELS = new Set<string>([
  "text-embedding-3-small",
  "text-embedding-3-large",
]);
const EMBED_DIMS = 1536; // must match kb_chunks.embedding vector(1536)
const EMBED_BATCH = 96;
const INSERT_BATCH = 64;

export async function embedTexts(
  texts: string[],
  openaiKey: string,
  model: string = DEFAULT_EMBED_MODEL,
  opts?: {
    userId?: string | null;
    surface?: string;
    /** OpenAI-compatible /embeddings endpoint (integration BYOK). */
    endpoint?: string;
    /** Skip the built-in model allow-list (custom integration models). */
    allowCustomModel?: boolean;
  },
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const endpoint = opts?.endpoint ?? "https://api.openai.com/v1/embeddings";
  if (!openaiKey && !opts?.endpoint) throw new Error("OPENAI_API_KEY is not configured");
  const useModel = opts?.allowCustomModel
    ? model
    : SUPPORTED_EMBED_MODELS.has(model)
      ? model
      : DEFAULT_EMBED_MODEL;

  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const batch = texts.slice(i, i + EMBED_BATCH);
    const tStart = Date.now();
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(openaiKey ? { Authorization: `Bearer ${openaiKey}` } : {}),
      },
      body: JSON.stringify({
        model: useModel,
        input: batch,
        dimensions: EMBED_DIMS,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      if (opts?.userId) {
        const { recordGatewayCall } =
          await import("@/utils/observability/recordGatewayUsage.server");
        await recordGatewayCall({
          userId: opts.userId,
          surface: opts.surface || "KB: Embedding",
          model: useModel,
          kind: "embedding",
          provider: "openai",
          promptText: batch.join("\n"),
          latencyMs: Date.now() - tStart,
          status: "error",
          errorMessage: `${res.status}: ${body.slice(0, 200)}`,
        });
      }
      throw new Error(`embeddings ${res.status}: ${body.slice(0, 300)}`);
    }
    const json = (await res.json()) as {
      data: { embedding: number[]; index: number }[];
      usage?: { prompt_tokens?: number; total_tokens?: number };
    };
    if (opts?.userId) {
      const tokensIn =
        Number(json.usage?.prompt_tokens ?? json.usage?.total_tokens ?? 0) ||
        Math.ceil(batch.join(" ").length / 4);
      const { recordGatewayCall } = await import("@/utils/observability/recordGatewayUsage.server");
      await recordGatewayCall({
        userId: opts.userId,
        surface: opts.surface || "KB: Embedding",
        model: useModel,
        kind: "embedding",
        provider: "openai",
        tokensIn,
        tokensOut: 0,
        latencyMs: Date.now() - tStart,
      });
    }
    const sorted = [...json.data].sort((a, b) => a.index - b.index);
    for (const d of sorted) {
      // Hard-validate the dimension before it reaches Postgres. Some models /
      // gateway paths ignore the `dimensions` hint and return the model's
      // native size (e.g. 768 for Gemini, 3072 for text-embedding-3-large),
      // which would crash the vector(1536) insert or corrupt the index.
      if (!Array.isArray(d.embedding) || d.embedding.length !== EMBED_DIMS) {
        throw new Error(
          `"${useModel}" returned ${d.embedding?.length ?? "no"}-dimensional vectors, but the ` +
            `store is fixed at ${EMBED_DIMS}. Either the model ignores the "dimensions" ` +
            `parameter or it has no ${EMBED_DIMS}-d output — pick a model that does ` +
            `(the OpenAI text-embedding-3-* models truncate to any size), or the ` +
            `kb_chunks.embedding column has to be migrated to this model's width.`,
        );
      }
      out.push(d.embedding);
    }
  }
  return out;
}

export type EmbedDocInput = {
  id: string;
  knowledge_base_id: string;
  user_id: string | null;
  is_sample?: boolean | null;
  content: string | null;
  // Per-document RAG settings written by the Knowledge UI / AddSourceDialog.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  metadata?: Record<string, any> | null;
};

function readDocSettings(meta: Record<string, unknown> | null | undefined): {
  model: string;
  chunk: ChunkOptions;
  mode: ChunkMode;
  parentSize: number;
} {
  const m = (meta ?? {}) as Record<string, unknown>;
  const rawModel = typeof m.embedding_model === "string" ? (m.embedding_model as string) : "";
  const model = SUPPORTED_EMBED_MODELS.has(rawModel) ? rawModel : DEFAULT_EMBED_MODEL;
  const strategy =
    typeof m.chunk_strategy === "string" ? (m.chunk_strategy as ChunkStrategy) : undefined;
  const chunkSize = typeof m.chunk_size === "number" ? (m.chunk_size as number) : undefined;
  const chunkOverlap =
    typeof m.chunk_overlap === "number" ? (m.chunk_overlap as number) : undefined;
  const mode: ChunkMode = isChunkMode(m.chunk_mode) ? m.chunk_mode : "flat";
  const parentSize =
    typeof m.parent_chunk_size === "number"
      ? (m.parent_chunk_size as number)
      : DEFAULT_PARENT_TOKENS;
  return { model, chunk: { strategy, chunkSize, chunkOverlap }, mode, parentSize };
}

export async function embedAndStoreDocuments(opts: {
  sb: SupabaseClient<Database>;
  docs: EmbedDocInput[];
  openaiKey: string;
  // Optional override (used by ingest routes that don't have per-doc metadata yet).
  defaults?: { model?: string; chunk?: ChunkOptions };
  // Attribute embedding gateway calls to this user in execution_traces.
  userId?: string | null;
  surface?: string;
  /** OpenAI-compatible /embeddings endpoint + custom-model flag (BYOK). */
  endpoint?: string;
  allowCustomModel?: boolean;
  /**
   * Provider id to record on each document alongside the model.
   *
   * Retrieval reads this back to embed the query the same way. Without it, a
   * document embedded by one provider could be searched with another's vectors
   * — which does not error, it just returns confidently wrong matches.
   */
  stampProvider?: string;
}): Promise<{
  documentsProcessed: number;
  chunksInserted: number;
  /** Non-fatal problems the caller should surface (e.g. Q&A generation). */
  warnings: string[];
}> {
  const { sb, docs, openaiKey } = opts;
  if (docs.length === 0) return { documentsProcessed: 0, chunksInserted: 0, warnings: [] };

  type Row = {
    document_id: string;
    knowledge_base_id: string;
    user_id: string | null;
    is_sample: boolean;
    chunk_index: number;
    content: string;
    token_estimate: number;
    chunk_kind: "text" | "qa";
    question: string | null;
    _model: string;
    /**
     * What actually gets embedded. Equal to `content` for flat and
     * parent-child, but the QUESTION for Q&A rows — that difference is the
     * entire point of Q&A mode, so it is a field rather than a branch at the
     * embedding call.
     */
    _embedText: string;
    /** Index into `parents` below; resolved to a real id after insert. */
    _parentSlot: number | null;
  };
  type ParentRow = {
    document_id: string;
    knowledge_base_id: string;
    user_id: string | null;
    is_sample: boolean;
    parent_index: number;
    content: string;
  };
  const rows: Row[] = [];
  const parents: ParentRow[] = [];
  const docIdsToReplace: string[] = [];
  /** Per-document notes surfaced to the caller (e.g. Q&A generation failures). */
  const warnings: string[] = [];

  for (const d of docs) {
    const text = (d.content || "").trim();
    // Always queue the doc for chunk replacement — even when content is now
    // empty (e.g. URL re-sync returned nothing). Otherwise stale chunks from
    // the previous version would survive forever as ghost rows.
    docIdsToReplace.push(d.id);
    if (!text) continue;
    const perDoc = readDocSettings(d.metadata);
    const model = perDoc.model || opts.defaults?.model || DEFAULT_EMBED_MODEL;
    const chunkOpts: ChunkOptions = {
      strategy: perDoc.chunk.strategy ?? opts.defaults?.chunk?.strategy,
      chunkSize: perDoc.chunk.chunkSize ?? opts.defaults?.chunk?.chunkSize,
      chunkOverlap: perDoc.chunk.chunkOverlap ?? opts.defaults?.chunk?.chunkOverlap,
    };
    const base = {
      document_id: d.id,
      knowledge_base_id: d.knowledge_base_id,
      user_id: d.user_id,
      is_sample: !!d.is_sample,
      _model: model,
    };
    // chunk_index is the row's identity for the upsert, so it has to keep
    // counting across parents rather than restarting inside each one.
    let idx = 0;
    const pushRow = (
      content: string,
      embedText: string,
      parentSlot: number | null,
      kind: "text" | "qa",
      question: string | null,
    ) => {
      rows.push({
        ...base,
        chunk_index: idx++,
        content,
        token_estimate: Math.ceil(content.length / CHARS_PER_TOKEN),
        chunk_kind: kind,
        question,
        _embedText: embedText,
        _parentSlot: parentSlot,
      });
    };

    if (perDoc.mode === "parent_child") {
      const pcs = chunkParentChild(text, {
        strategy: chunkOpts.strategy,
        parentTokens: perDoc.parentSize,
        childTokens: chunkOpts.chunkSize,
        childOverlap: chunkOpts.chunkOverlap,
      });
      for (const pc of pcs) {
        const slot = parents.length;
        parents.push({
          document_id: d.id,
          knowledge_base_id: d.knowledge_base_id,
          user_id: d.user_id,
          is_sample: !!d.is_sample,
          parent_index: slot,
          content: pc.parent,
        });
        // The CHILD is embedded; the parent is what retrieval will hand back.
        for (const child of pc.children) pushRow(child, child, slot, "text", null);
      }
    } else if (perDoc.mode === "qa") {
      const key = getOpenRouterApiKey();
      // Passages are chunked first so each generation call sees a bounded,
      // coherent piece of text rather than a whole document.
      const passages = chunkText(text, { ...chunkOpts, chunkOverlap: 0 });
      let pairCount = 0;
      for (const passage of passages) {
        const res = await generateQaPairs(passage, key ?? "");
        if (!res.ok) {
          // Reported, never downgraded. Silently writing flat chunks would
          // leave a knowledge base that disagrees with its own settings, and
          // the only symptom would be worse answers months later.
          warnings.push(`${d.id}: ${res.error}`);
          break;
        }
        for (const pair of res.pairs) {
          pairCount += 1;
          pushRow(pair.answer, pair.question, null, "qa", pair.question);
        }
      }
      if (pairCount === 0 && warnings.length === 0) {
        warnings.push(`${d.id}: Q&A generation produced no pairs`);
      }
    } else {
      const chunks = chunkText(text, chunkOpts);
      for (const c of chunks) pushRow(c, c, null, "text", null);
    }
  }

  if (docIdsToReplace.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (sb.from("kb_chunks" as any) as any).delete().in("document_id", docIdsToReplace);
    // Parents second. Doing it first would cascade-delete the chunks we are
    // about to replace anyway — harmless today, but it would also delete the
    // NEW chunks if this ever moved below the insert.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (sb.from("kb_chunk_parents" as any) as any).delete().in("document_id", docIdsToReplace);
  }
  if (rows.length === 0) {
    return { documentsProcessed: docs.length, chunksInserted: 0, warnings };
  }

  // Parents are inserted before their children so each child can carry a real
  // parent_id. A child whose parent insert failed would retrieve as if it were
  // flat, which is the silent-degradation case this whole module avoids.
  const parentIdBySlot = new Map<number, string>();
  if (parents.length > 0) {
    for (let i = 0; i < parents.length; i += INSERT_BATCH) {
      const slice = parents.slice(i, i + INSERT_BATCH);
      const { data, error } = await (
        sb.from("kb_chunk_parents" as never) as unknown as {
          insert: (rows: unknown[]) => {
            select: (cols: string) => Promise<{
              data: Array<{ id: string; parent_index: number }> | null;
              error: { message: string } | null;
            }>;
          };
        }
      )
        .insert(slice)
        .select("id, parent_index");
      if (error) throw new Error(`kb_chunk_parents insert failed: ${error.message}`);
      for (const r of data ?? []) parentIdBySlot.set(r.parent_index, r.id);
    }
  }

  // Group rows by embedding model so each model is embedded in its own batch.
  const byModel = new Map<string, number[]>();
  rows.forEach((r, i) => {
    const arr = byModel.get(r._model) ?? [];
    arr.push(i);
    byModel.set(r._model, arr);
  });

  const embeddings: number[][] = new Array(rows.length);
  for (const [model, indices] of byModel) {
    // _embedText, not content: in Q&A mode the vector must represent the
    // QUESTION even though the row stores the answer.
    const inputs = indices.map((i) => rows[i]._embedText);
    const vectors = await embedTexts(inputs, openaiKey, model, {
      endpoint: opts.endpoint,
      allowCustomModel: opts.allowCustomModel,
      userId: opts.userId ?? null,
      surface: opts.surface,
    });
    if (vectors.length !== inputs.length) {
      throw new Error(`embeddings mismatch for ${model}: ${vectors.length} vs ${inputs.length}`);
    }
    indices.forEach((idx, j) => {
      embeddings[idx] = vectors[j];
    });
  }

  const toInsert = rows.map((r, i) => {
    const { _model: _drop, _embedText: _drop2, _parentSlot, ...rest } = r;
    void _drop;
    void _drop2;
    return {
      ...rest,
      parent_id: _parentSlot === null ? null : (parentIdBySlot.get(_parentSlot) ?? null),
      embedding: `[${embeddings[i].join(",")}]`,
    };
  });

  // Upsert against the kb_chunks_doc_chunk_unique constraint so partial
  // failures + retries are safe. Plain insert here would orphan batches 1..N-1
  // when batch N crashes (e.g. network blip, rate limit), and a subsequent
  // re-embed would then trip the UNIQUE constraint instead of overwriting.
  for (let i = 0; i < toInsert.length; i += INSERT_BATCH) {
    const slice = toInsert.slice(i, i + INSERT_BATCH);
    const { error } = await (
      sb.from("kb_chunks" as never) as unknown as {
        upsert: (
          rows: unknown[],
          opts: { onConflict: string },
        ) => Promise<{ error: { message: string } | null }>;
      }
    ).upsert(slice, { onConflict: "document_id,chunk_index" });
    if (error) throw new Error(error.message);
  }

  // Stamp what was actually used, per document. Retrieval reads this to embed
  // the query in the same space; previously it was only written by the upload
  // UI, so anything embedded by another path (auto-embed, back-fill, re-sync)
  // left retrieval guessing.
  if (opts.stampProvider) {
    const modelByDoc = new Map<string, string>();
    for (const r of rows)
      if (!modelByDoc.has(r.document_id)) modelByDoc.set(r.document_id, r._model);
    for (const d of docs) {
      const model = modelByDoc.get(d.id);
      if (!model) continue;
      const meta = { ...(d.metadata ?? {}) } as Record<string, unknown>;
      if (meta.embedding_provider === opts.stampProvider && meta.embedding_model === model)
        continue;
      meta.embedding_provider = opts.stampProvider;
      meta.embedding_model = model;
      const { error } = await sb
        .from("knowledge_documents")
        .update({ metadata: meta as never })
        .eq("id", d.id);
      // Non-fatal: the chunks are already stored, and a missing stamp degrades
      // retrieval rather than losing data.
      if (error) console.warn("[embedding] could not stamp embed config:", error.message);
    }
  }

  return { documentsProcessed: docs.length, chunksInserted: rows.length, warnings };
}
