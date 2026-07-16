// TanStack server functions for embedding KB documents into the kb_chunks
// vector store. Called by client-side insertion sites to embed freshly
// uploaded docs, and to back-fill embeddings for pre-existing KBs.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { embedAndStoreDocuments, type EmbedDocInput } from "./embedding.server";

export const embedKbDocuments = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        documentIds: z.array(z.string().uuid()).min(1).max(200),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) {
      return {
        documentsProcessed: 0,
        chunksInserted: 0,
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
    if (!docs || docs.length === 0) return { documentsProcessed: 0, chunksInserted: 0 };

    const result = await embedAndStoreDocuments({
      sb: supabase,
      docs: docs as EmbedDocInput[],
      openaiKey,
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
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) {
      return {
        documentsProcessed: 0,
        chunksInserted: 0,
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
    if (!docs || docs.length === 0) return { documentsProcessed: 0, chunksInserted: 0 };

    // Skip docs that already have chunks.
    const ids = docs.map((d) => d.id);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: existing } = await (supabase.from("kb_chunks" as any) as any)
      .select("document_id")
      .in("document_id", ids);
    const have = new Set<string>(
      ((existing ?? []) as { document_id: string }[]).map((r) => r.document_id),
    );
    const pending = docs.filter((d) => !have.has(d.id));
    if (pending.length === 0) return { documentsProcessed: 0, chunksInserted: 0 };

    const result = await embedAndStoreDocuments({
      sb: supabase,
      docs: pending as EmbedDocInput[],
      openaiKey,
    });
    return { ...result, skipped: false as const };
  });
