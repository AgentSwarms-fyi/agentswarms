// TanStack server functions for embedding KB documents into the kb_chunks
// vector store. Called by client-side insertion sites to embed freshly
// uploaded docs, and to back-fill embeddings for pre-existing KBs.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { embedAndStoreDocuments, type EmbedDocInput } from "./embedding.server";
import { resolveEmbedTarget } from "./embedTarget.server";

export const embedKbDocuments = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        documentIds: z.array(z.string().uuid()).min(1).max(200),
        provider: z.string().optional(),
        model: z.string().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const target = await resolveEmbedTarget(userId, {
      provider: data.provider,
      model: data.model,
    });
    if (!target) {
      return {
        documentsProcessed: 0,
        chunksInserted: 0,
        warnings: [] as string[],
        skipped: true,
        reason: "no_api_key" as const,
      };
    }

    const { data: docs, error } = await supabase
      .from("knowledge_documents")
      .select("id, knowledge_base_id, user_id, is_sample, content, metadata")
      .in("id", data.documentIds)
      .eq("user_id", userId);
    if (error) throw new Error(error.message);
    if (!docs || docs.length === 0)
      return { documentsProcessed: 0, chunksInserted: 0, warnings: [] as string[] };

    const result = await embedAndStoreDocuments({
      sb: supabase,
      docs: docs as EmbedDocInput[],
      openaiKey: target.apiKey,
      endpoint: target.endpoint,
      allowCustomModel: target.allowCustomModel,
      // The resolved target already carries the provider's default model, so a
      // caller that names neither still embeds with something coherent.
      defaults: { model: target.model },
      stampProvider: target.provider,
      userId,
    });
    return { ...result, skipped: false as const };
  });

export const backfillKbEmbeddings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        knowledgeBaseId: z.string().uuid(),
        limit: z.number().int().min(1).max(100).optional(),
        provider: z.string().optional(),
        model: z.string().optional(),
        /** Re-index documents that already have chunks, not just the pending ones. */
        force: z.boolean().optional(),
        /** Chunk settings to stamp on each document before rebuilding its rows. */
        chunkSettings: z
          .object({
            mode: z.enum(["flat", "parent_child", "qa"]).optional(),
            strategy: z.string().optional(),
            chunkSize: z.number().int().min(64).max(8192).optional(),
            chunkOverlap: z.number().int().min(0).max(1024).optional(),
            parentSize: z.number().int().min(128).max(4096).optional(),
          })
          .optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const target = await resolveEmbedTarget(userId, {
      provider: data.provider,
      model: data.model,
    });
    if (!target) {
      return {
        documentsProcessed: 0,
        chunksInserted: 0,
        warnings: [] as string[],
        skipped: true,
        reason: "no_api_key" as const,
      };
    }

    const { data: docs, error } = await supabase
      .from("knowledge_documents")
      .select("id, knowledge_base_id, user_id, is_sample, content, metadata")
      .eq("knowledge_base_id", data.knowledgeBaseId)
      .eq("user_id", userId)
      .limit(data.limit ?? 50);
    if (error) throw new Error(error.message);
    if (!docs || docs.length === 0)
      return { documentsProcessed: 0, chunksInserted: 0, warnings: [] as string[] };

    // Normally this is a BACKFILL: documents that already have chunks are left
    // alone. `force` turns it into a re-index, which is what changing the
    // chunking mode requires — parent-child and Q&A rebuild the rows entirely,
    // so without this the new setting would apply only to documents added
    // afterwards and an existing knowledge base could never be upgraded.
    let pending = docs;
    if (!data.force) {
      const ids = docs.map((d) => d.id);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: existing } = await (supabase.from("kb_chunks" as any) as any)
        .select("document_id")
        .in("document_id", ids);
      const have = new Set<string>(
        ((existing ?? []) as { document_id: string }[]).map((r) => r.document_id),
      );
      pending = docs.filter((d) => !have.has(d.id));
    }
    if (pending.length === 0)
      return { documentsProcessed: 0, chunksInserted: 0, warnings: [] as string[] };

    // Persist the requested chunk settings onto each document BEFORE embedding.
    // embedAndStoreDocuments reads the mode from the document's own metadata,
    // and that metadata is also what tells a later reader how these chunks were
    // built — leaving it stale would make the row describe a shape it no longer
    // has.
    if (data.chunkSettings) {
      const cs = data.chunkSettings;
      pending = pending.map((d) => ({
        ...d,
        metadata: {
          ...((d.metadata ?? {}) as Record<string, unknown>),
          ...(cs.mode ? { chunk_mode: cs.mode } : {}),
          ...(cs.strategy ? { chunk_strategy: cs.strategy } : {}),
          ...(typeof cs.chunkSize === "number" ? { chunk_size: cs.chunkSize } : {}),
          ...(typeof cs.chunkOverlap === "number" ? { chunk_overlap: cs.chunkOverlap } : {}),
          ...(typeof cs.parentSize === "number" ? { parent_chunk_size: cs.parentSize } : {}),
        },
      }));
      for (const d of pending) {
        await supabase
          .from("knowledge_documents")
          .update({ metadata: d.metadata as never })
          .eq("id", d.id);
      }
    }

    const result = await embedAndStoreDocuments({
      sb: supabase,
      docs: pending as EmbedDocInput[],
      openaiKey: target.apiKey,
      endpoint: target.endpoint,
      allowCustomModel: target.allowCustomModel,
      // The resolved target already carries the provider's default model, so a
      // caller that names neither still embeds with something coherent.
      defaults: { model: target.model },
      stampProvider: target.provider,
      userId,
    });
    return { ...result, skipped: false as const };
  });

/** Whether the operator's built-in OpenAI embedding key is configured —
 * lets the RAG settings UI label "Built-in" honestly. */
export const kbEmbedStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async () => ({
    builtinConfigured: Boolean(process.env.OPENAI_API_KEY),
    openrouterAvailable: Boolean(process.env.OPENROUTER_API_KEY),
  }));
