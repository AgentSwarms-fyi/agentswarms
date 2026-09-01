// TanStack server functions for embedding KB documents into the kb_chunks
// vector store. Called by client-side insertion sites to embed freshly
// uploaded docs, and to back-fill embeddings for pre-existing KBs.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { embedAndStoreDocuments, type EmbedDocInput } from "./embedding.server";
import { resolveEmbedTarget } from "./embedTarget.server";

/**
 * A caller may index a document they own, or a SAMPLE document.
 *
 * Both selects here used `.eq("user_id", userId)`, and every shipped sample
 * document has `user_id = NULL` — a comparison NULL never satisfies. So a
 * back-fill on a sample collection selected zero rows and returned
 * `{ documentsProcessed: 0 }`, which the UI reported as "All documents are
 * already indexed." Indexing a sample was not merely un-done; it could not be
 * done, which is why kb_chunks held zero rows across all 17 shipped
 * collections and 49 documents.
 */
const OWNED_OR_SAMPLE = (userId: string) => `user_id.eq.${userId},is_sample.eq.true`;

/**
 * Which client writes the chunks.
 *
 * kb_chunks' INSERT policy is `auth.uid() = user_id AND is_sample = false AND
 * the knowledge base is yours` — so a client can never write into the shared
 * sample index, deliberately: on a multi-user instance that would let anyone
 * put arbitrary text in front of every other user's retrieval, which is a
 * prompt-injection channel, not a feature.
 *
 * The fix is not to relax the policy. The server function already controls the
 * content — it reads it out of the sample document itself — so the sample
 * branch writes with the service role and the policy stays shut to clients.
 * Same shape as the headless-run trace writes.
 */
const writerFor = (docs: { is_sample?: boolean | null }[], userClient: typeof supabaseAdmin) =>
  docs.some((d) => d.is_sample) ? supabaseAdmin : userClient;

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
      .or(OWNED_OR_SAMPLE(userId));
    if (error) throw new Error(error.message);
    if (!docs || docs.length === 0)
      return { documentsProcessed: 0, chunksInserted: 0, warnings: [] as string[] };

    const result = await embedAndStoreDocuments({
      sb: writerFor(docs, supabase),
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
      .or(OWNED_OR_SAMPLE(userId))
      .limit(data.limit ?? 50);
    if (error) throw new Error(error.message);
    if (!docs || docs.length === 0)
      return { documentsProcessed: 0, chunksInserted: 0, warnings: [] as string[] };

    // Everything below writes: the chunk probe, the metadata stamp, and the
    // chunk rows themselves. A sample collection needs the service role for
    // all three, for the reason on writerFor.
    const writer = writerFor(docs, supabase);

    // Normally this is a BACKFILL: documents that already have chunks are left
    // alone. `force` turns it into a re-index, which is what changing the
    // chunking mode requires — parent-child and Q&A rebuild the rows entirely,
    // so without this the new setting would apply only to documents added
    // afterwards and an existing knowledge base could never be upgraded.
    let pending = docs;
    if (!data.force) {
      const ids = docs.map((d) => d.id);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: existing } = await (writer.from("kb_chunks" as any) as any)
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
        await writer
          .from("knowledge_documents")
          .update({ metadata: d.metadata as never })
          .eq("id", d.id);
      }
    }

    const result = await embedAndStoreDocuments({
      sb: writer,
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

/**
 * What the RAG settings UI needs to label its provider list honestly.
 *
 * `openrouterAvailable` covers the case the dialog could not otherwise see: the
 * operator set OPENROUTER_API_KEY, so OpenRouter works for this user without
 * them connecting anything, even though they own no integration row.
 *
 * `anyProviderResolvable` asks the real resolver rather than inspecting the
 * environment, so the answer is whatever ingest would actually do. It is the
 * difference between "vector search is on" and "your documents are being saved
 * with keyword search only", which a user otherwise discovers by noticing bad
 * retrieval.
 */
export const kbEmbedStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => ({
    openrouterAvailable: Boolean(process.env.OPENROUTER_API_KEY),
    anyProviderResolvable: Boolean(await resolveEmbedTarget(context.userId)),
  }));

/**
 * Ask a provider, for real, whether it can embed into this store.
 *
 * THE GAP THIS FILLS. `kb_chunks.embedding` is `vector(1536)` and embedTexts
 * hard-rejects any other width, so "this provider has an embeddings API" is not
 * the same as "this provider works here". Several models the picker offers are
 * natively 768, 1024 or 4096 and only fit if they honour the OpenAI
 * `dimensions` parameter — which some do and some silently ignore. Which is
 * which cannot be known from a model id, and a hardcoded list rots: two
 * nvidia/* entries in this repo turned out to 404 on the live endpoint.
 *
 * So the answer is measured instead of predicted. One short string, one call,
 * and the reader learns before their documents are saved rather than after,
 * when the alternative is noticing that retrieval has quietly been keyword-only.
 */
export const kbEmbedProbe = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        provider: z.string().max(64).optional().nullable(),
        model: z.string().max(200).optional().nullable(),
      })
      .parse(input ?? {}),
  )
  .handler(
    async ({
      data,
      context,
    }): Promise<{
      ok: boolean;
      provider?: string;
      model?: string;
      dims?: number;
      message?: string;
    }> => {
      const { userId } = context;
      const target = await resolveEmbedTarget(userId, {
        provider: data.provider,
        model: data.model,
      });
      if (!target) {
        return {
          ok: false,
          message:
            "That provider is not connected, or has no credentials saved. Connect it under Integrations first.",
        };
      }
      const { embedTexts } = await import("./embedding.server");
      try {
        const [vector] = await embedTexts(["probe"], target.apiKey, target.model, {
          endpoint: target.endpoint,
          allowCustomModel: target.allowCustomModel,
          userId,
          surface: "kb_embed_probe",
        });
        return {
          ok: true,
          provider: target.provider,
          model: target.model,
          dims: vector?.length,
        };
      } catch (e) {
        // Provider errors quote the request back. Strip the key before this
        // reaches a browser — the same class of leak the lakehouse had.
        let message = (e as Error).message;
        if (target.apiKey && target.apiKey.length >= 6) {
          message = message.split(target.apiKey).join("[redacted]");
        }
        return { ok: false, provider: target.provider, model: target.model, message };
      }
    },
  );
