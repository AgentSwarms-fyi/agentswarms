// TanStack server functions for embedding KB documents into the kb_chunks
// vector store. Called by client-side insertion sites to embed freshly
// uploaded docs, and to back-fill embeddings for pre-existing KBs.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { embedAndStoreDocuments, type EmbedDocInput } from "./embedding.server";
import { resolveOpenAICompatTransport } from "@/utils/providers/credentials.server";
import type { ProviderId } from "@/utils/providers/types";

/** Resolve where embeddings run: the operator's OpenAI key (built-in) or the
 * caller's own integration (OpenAI-compatible /embeddings endpoint). */
async function resolveEmbedTarget(
  userId: string,
  provider?: string,
): Promise<{ apiKey: string; endpoint?: string; allowCustomModel: boolean } | null> {
  if (!provider || provider === "openai_builtin") {
    const key = process.env.OPENAI_API_KEY;
    return key ? { apiKey: key, allowCustomModel: false } : null;
  }
  const t = await resolveOpenAICompatTransport({ userId, provider: provider as ProviderId });
  if (!t || (!t.apiKey && provider !== "ollama")) return null;
  return {
    apiKey: t.apiKey ?? "",
    endpoint: t.endpointUrl.replace(/\/chat\/completions\/?$/, "/embeddings"),
    allowCustomModel: true,
  };
}

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
    const target = await resolveEmbedTarget(userId, data.provider);
    if (!target) {
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
      openaiKey: target.apiKey,
      endpoint: target.endpoint,
      allowCustomModel: target.allowCustomModel,
      defaults: data.model ? { model: data.model } : undefined,
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
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const target = await resolveEmbedTarget(userId, data.provider);
    if (!target) {
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
      openaiKey: target.apiKey,
      endpoint: target.endpoint,
      allowCustomModel: target.allowCustomModel,
      defaults: data.model ? { model: data.model } : undefined,
      userId,
    });
    return { ...result, skipped: false as const };
  });

/** Whether the operator's built-in OpenAI embedding key is configured —
 * lets the RAG settings UI label "Built-in" honestly. */
export const kbEmbedStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async () => ({ builtinConfigured: Boolean(process.env.OPENAI_API_KEY) }));
