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

export const DEFAULT_EMBED_MODEL = "text-embedding-3-small";
export const SUPPORTED_EMBED_MODELS = new Set<string>([
  "text-embedding-3-small",
  "text-embedding-3-large",
]);
const EMBED_DIMS = 1536; // must match kb_chunks.embedding vector(1536)
const CHARS_PER_TOKEN = 4;
const DEFAULT_CHUNK_TOKENS = 256; // ~1024 chars
const DEFAULT_OVERLAP_TOKENS = 40; // ~160 chars
const EMBED_BATCH = 96;
const INSERT_BATCH = 64;

export type ChunkStrategy = "fixed" | "sentence" | "paragraph" | "semantic" | "recursive";

export type ChunkOptions = {
  strategy?: ChunkStrategy;
  chunkSize?: number; // tokens
  chunkOverlap?: number; // tokens
};

function resolveCharBudget(opts: ChunkOptions): { target: number; overlap: number } {
  const tokens = Math.max(64, Math.min(opts.chunkSize ?? DEFAULT_CHUNK_TOKENS, 2048));
  // Clamp overlap to <=50% of chunk size so prevTail can't dominate the next chunk.
  const overlapCap = Math.floor(tokens / 2);
  const overlapTokens = Math.max(
    0,
    Math.min(opts.chunkOverlap ?? DEFAULT_OVERLAP_TOKENS, overlapCap),
  );
  return { target: tokens * CHARS_PER_TOKEN, overlap: overlapTokens * CHARS_PER_TOKEN };
}

function splitFixed(text: string, target: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += target) out.push(text.slice(i, i + target));
  return out;
}

function splitBySentences(text: string, target: number): string[] {
  const sentences = text.split(/(?<=[.!?])\s+/);
  const chunks: string[] = [];
  let buf = "";
  for (const s of sentences) {
    if (s.length > target) {
      if (buf) {
        chunks.push(buf.trim());
        buf = "";
      }
      chunks.push(...splitFixed(s, target));
      continue;
    }
    if ((buf + " " + s).length > target) {
      chunks.push(buf.trim());
      buf = s;
    } else buf = buf ? buf + " " + s : s;
  }
  if (buf.trim()) chunks.push(buf.trim());
  return chunks;
}

function splitByParagraphs(text: string, target: number): string[] {
  const paragraphs = text.split(/\n{2,}/);
  const chunks: string[] = [];
  let buf = "";
  for (const p of paragraphs) {
    if (p.length > target) {
      if (buf) {
        chunks.push(buf.trim());
        buf = "";
      }
      chunks.push(...splitBySentences(p, target));
      continue;
    }
    if ((buf + "\n\n" + p).length > target) {
      chunks.push(buf.trim());
      buf = p;
    } else buf = buf ? buf + "\n\n" + p : p;
  }
  if (buf.trim()) chunks.push(buf.trim());
  return chunks;
}

// Recursive: paragraphs → sentences → fixed, falling through when a unit
// still exceeds the budget. "Semantic" is approximated as recursive here
// (true semantic chunking requires extra embedding calls per boundary,
// which is not worth the cost for this stack — recursive gives most of
// the benefit at zero extra cost).
function splitRecursive(text: string, target: number): string[] {
  return splitByParagraphs(text, target);
}

export function chunkText(raw: string, opts: ChunkOptions = {}): string[] {
  const cleaned = (raw || "").replace(/\r\n/g, "\n").trim();
  if (!cleaned) return [];
  const { target, overlap } = resolveCharBudget(opts);
  if (cleaned.length <= target) return [cleaned];

  const strategy: ChunkStrategy = opts.strategy ?? "recursive";
  let chunks: string[];
  switch (strategy) {
    case "fixed":
      chunks = splitFixed(cleaned, target);
      break;
    case "sentence":
      chunks = splitBySentences(cleaned, target);
      break;
    case "paragraph":
      chunks = splitByParagraphs(cleaned, target);
      break;
    case "semantic":
    case "recursive":
    default:
      chunks = splitRecursive(cleaned, target);
      break;
  }

  if (overlap > 0 && chunks.length > 1) {
    for (let i = 1; i < chunks.length; i++) {
      const prevTail = chunks[i - 1].slice(-overlap);
      chunks[i] = `${prevTail} ${chunks[i]}`;
    }
  }
  return chunks.filter((c) => c.trim().length > 0);
}

export async function embedTexts(
  texts: string[],
  openaiKey: string,
  model: string = DEFAULT_EMBED_MODEL,
  opts?: { userId?: string | null; surface?: string },
): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (!openaiKey) throw new Error("OPENAI_API_KEY is not configured");
  const useModel = SUPPORTED_EMBED_MODELS.has(model) ? model : DEFAULT_EMBED_MODEL;

  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const batch = texts.slice(i, i + EMBED_BATCH);
    const tStart = Date.now();
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${openaiKey}`,
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
          `embedding dimension mismatch for ${useModel}: expected ${EMBED_DIMS}, got ${d.embedding?.length ?? "n/a"}`,
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
} {
  const m = (meta ?? {}) as Record<string, unknown>;
  const rawModel = typeof m.embedding_model === "string" ? (m.embedding_model as string) : "";
  const model = SUPPORTED_EMBED_MODELS.has(rawModel) ? rawModel : DEFAULT_EMBED_MODEL;
  const strategy =
    typeof m.chunk_strategy === "string" ? (m.chunk_strategy as ChunkStrategy) : undefined;
  const chunkSize = typeof m.chunk_size === "number" ? (m.chunk_size as number) : undefined;
  const chunkOverlap =
    typeof m.chunk_overlap === "number" ? (m.chunk_overlap as number) : undefined;
  return { model, chunk: { strategy, chunkSize, chunkOverlap } };
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
}): Promise<{ documentsProcessed: number; chunksInserted: number }> {
  const { sb, docs, openaiKey } = opts;
  if (docs.length === 0) return { documentsProcessed: 0, chunksInserted: 0 };

  type Row = {
    document_id: string;
    knowledge_base_id: string;
    user_id: string | null;
    is_sample: boolean;
    chunk_index: number;
    content: string;
    token_estimate: number;
    _model: string;
  };
  const rows: Row[] = [];
  const docIdsToReplace: string[] = [];

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
    const chunks = chunkText(text, chunkOpts);
    chunks.forEach((c, idx) => {
      rows.push({
        document_id: d.id,
        knowledge_base_id: d.knowledge_base_id,
        user_id: d.user_id,
        is_sample: !!d.is_sample,
        chunk_index: idx,
        content: c,
        token_estimate: Math.ceil(c.length / CHARS_PER_TOKEN),
        _model: model,
      });
    });
  }

  if (docIdsToReplace.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (sb.from("kb_chunks" as any) as any).delete().in("document_id", docIdsToReplace);
  }
  if (rows.length === 0) return { documentsProcessed: docs.length, chunksInserted: 0 };

  // Group rows by embedding model so each model is embedded in its own batch.
  const byModel = new Map<string, number[]>();
  rows.forEach((r, i) => {
    const arr = byModel.get(r._model) ?? [];
    arr.push(i);
    byModel.set(r._model, arr);
  });

  const embeddings: number[][] = new Array(rows.length);
  for (const [model, indices] of byModel) {
    const inputs = indices.map((i) => rows[i].content);
    const vectors = await embedTexts(inputs, openaiKey, model, {
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
    const { _model: _drop, ...rest } = r;
    void _drop;
    return { ...rest, embedding: `[${embeddings[i].join(",")}]` };
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

  return { documentsProcessed: docs.length, chunksInserted: rows.length };
}
