// Server functions for the vector store: what it is, whether it is reachable,
// and rebuilding it from Postgres.
//
// Rebuilding is the answer to every way an external store can drift from the
// database, and there are several — a Qdrant that lost its volume, a store
// switched on after a knowledge base was already indexed, a delete that
// happened while it was unreachable. Rather than a reconciliation protocol
// nobody can reason about, there is one idempotent operation: forget these
// knowledge bases, then write every chunk they have back.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { auditEvent } from "@/utils/audit.server";
import { requireSuperadmin } from "@/utils/iam.server";
import { selectedStoreKind, vectorStore, vectorStoreIsExternal } from "./store.server";
import { VECTOR_DIMS, type VectorPoint, type VectorStoreInfo } from "./types";

/** Rows read from `kb_chunks` per page while re-indexing. */
const REINDEX_PAGE = 250;

export type VectorStoreStatus = {
  /** What VECTOR_STORE asked for. */
  selected: string;
  /** Whether that store keeps vectors outside Postgres. */
  external: boolean;
  dims: number;
  info: VectorStoreInfo;
  /** Chunks in Postgres — the number a healthy external store should match. */
  chunksInDatabase: number;
};

export const vectorStoreStatus = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ access_token: z.string().min(1) }).parse(input))
  .handler(async ({ data }): Promise<{ ok: false; error: string } | VectorStoreStatus> => {
    const guard = await requireSuperadmin(data.access_token);
    if (!guard.ok) return guard;

    const kind = selectedStoreKind();
    const store = vectorStore(supabaseAdmin);
    const [info, counted] = await Promise.all([
      store.info(),
      supabaseAdmin.from("kb_chunks").select("id", { count: "exact", head: true }),
    ]);
    return {
      selected: kind,
      external: vectorStoreIsExternal(kind),
      dims: VECTOR_DIMS,
      info,
      chunksInDatabase: counted.count ?? 0,
    };
  });

/**
 * Rebuild the external index from `kb_chunks`.
 *
 * Superadmin, and service-role on purpose: this reads every chunk in the
 * knowledge bases named, which is exactly the thing an ordinary caller must
 * not be able to do. There is nothing to rebuild on pgvector — the vector is
 * the row — so that path returns immediately and says so rather than
 * pretending to work.
 */
export const vectorStoreReindex = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        /** Empty means every knowledge base. */
        knowledgeBaseIds: z.array(z.string().uuid()).max(200).optional(),
      })
      .parse(input),
  )
  .handler(
    async ({
      data,
    }): Promise<
      { ok: false; error: string } | { ok: true; indexed: number; skipped: boolean; kind: string }
    > => {
      const guard = await requireSuperadmin(data.access_token);
      if (!guard.ok) return guard;

      const kind = selectedStoreKind();
      if (!vectorStoreIsExternal(kind)) {
        return { ok: true, indexed: 0, skipped: true, kind };
      }
      const store = vectorStore(supabaseAdmin);

      // Which knowledge bases, resolved up front so the delete and the write
      // cover exactly the same set.
      let kbIds = data.knowledgeBaseIds ?? [];
      if (kbIds.length === 0) {
        const { data: kbs, error } = await supabaseAdmin.from("knowledge_bases").select("id");
        if (error) throw new Error(error.message);
        kbIds = (kbs ?? []).map((k) => k.id);
      }
      if (kbIds.length === 0) return { ok: true, indexed: 0, skipped: false, kind };

      // Forget first. A chunk deleted while the store was unreachable has no
      // row to re-write it, so writing without clearing would leave it there
      // for ever — and an id that hydrates to nothing is dropped at query
      // time, which hides the drift rather than fixing it.
      await store.deleteByKnowledgeBases(kbIds);

      let indexed = 0;
      for (const kbId of kbIds) {
        for (let from = 0; ; from += REINDEX_PAGE) {
          const { data: rows, error } = await supabaseAdmin
            .from("kb_chunks")
            .select("id, document_id, knowledge_base_id, embedding")
            .eq("knowledge_base_id", kbId)
            .order("id", { ascending: true })
            .range(from, from + REINDEX_PAGE - 1);
          if (error) throw new Error(error.message);
          const page = (rows ?? []) as unknown as {
            id: string;
            document_id: string;
            knowledge_base_id: string;
            embedding: string | number[] | null;
          }[];
          if (page.length === 0) break;

          const points: VectorPoint[] = [];
          for (const r of page) {
            const vec = parseEmbedding(r.embedding);
            // A chunk with no embedding is one that was never indexed — it is
            // keyword-only today and re-embedding is the fix, not this.
            if (!vec) continue;
            points.push({
              id: r.id,
              embedding: vec,
              knowledgeBaseId: r.knowledge_base_id,
              documentId: r.document_id,
            });
          }
          await store.upsert(points);
          indexed += points.length;
          if (page.length < REINDEX_PAGE) break;
        }
      }

      auditEvent({
        userId: guard.userId,
        actorEmail: guard.email,
        action: "vector_store.reindex",
        resourceType: "vector_store",
        resourceName: kind,
        detail: { knowledge_bases: kbIds.length, vectors: indexed },
      });
      return { ok: true, indexed, skipped: false, kind };
    },
  );

/**
 * Which store this deployment searches, for anybody who may open a knowledge
 * base — not just an operator.
 *
 * Deliberately thinner than `vectorStoreStatus`: no endpoint, no counts, no
 * reachability. Somebody configuring a collection's chunking needs to know
 * WHERE its vectors are searched, because it changes nothing they can set and
 * everything about who to ask; they do not need the address of the store or
 * how many vectors it holds, and neither belongs in a page any KB owner can
 * open.
 */
export const vectorStoreBrief = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({}).parse(input ?? {}))
  .handler(async (): Promise<{ kind: string; external: boolean; dims: number }> => {
    const kind = selectedStoreKind();
    return { kind, external: vectorStoreIsExternal(kind), dims: VECTOR_DIMS };
  });

/**
 * Drop vectors for documents or knowledge bases that are being deleted.
 *
 * Called by the delete paths BEFORE they remove the rows, which is the order
 * that keeps this authorisable: once the row is gone there is nothing left to
 * check ownership against. If the row delete then fails, the cost is a
 * knowledge base that retrieves by keyword until somebody re-indexes — an
 * outcome that is visible and repairable, unlike a vector nobody can attribute.
 */
export const forgetVectors = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        documentIds: z.array(z.string().uuid()).max(2000).optional(),
        knowledgeBaseIds: z.array(z.string().uuid()).max(200).optional(),
        /** A connected source, whose documents go with it. */
        sourceIds: z.array(z.string().uuid()).max(200).optional(),
      })
      .refine(
        (v) =>
          (v.documentIds?.length ?? 0) +
            (v.knowledgeBaseIds?.length ?? 0) +
            (v.sourceIds?.length ?? 0) >
          0,
        { message: "documentIds, knowledgeBaseIds or sourceIds is required" },
      )
      .parse(input),
  )
  .handler(async ({ data, context }): Promise<{ ok: true; forgot: number }> => {
    const { supabase } = context;
    if (!vectorStoreIsExternal(selectedStoreKind())) return { ok: true, forgot: 0 };
    const store = vectorStore(supabase);
    let forgot = 0;

    // Read back under the CALLER'S client: an id they cannot see comes back
    // empty and is never passed to the store.
    if (data.knowledgeBaseIds?.length) {
      const { data: kbs } = await supabase
        .from("knowledge_bases")
        .select("id")
        .in("id", data.knowledgeBaseIds);
      const ids = (kbs ?? []).map((k) => k.id);
      if (ids.length > 0) {
        await store.deleteByKnowledgeBases(ids);
        forgot += ids.length;
      }
    }
    const docIds = new Set(data.documentIds ?? []);
    if (data.sourceIds?.length) {
      // Resolved here rather than in the browser: the caller would otherwise
      // have to list the documents itself, and a source with a thousand of
      // them would send a thousand ids back to be checked again.
      const { data: fromSources } = await supabase
        .from("knowledge_documents")
        .select("id")
        .in("source_id", data.sourceIds);
      for (const d of fromSources ?? []) docIds.add(d.id);
    }
    if (docIds.size > 0) {
      const { data: docs } = await supabase
        .from("knowledge_documents")
        .select("id")
        .in("id", [...docIds]);
      const ids = (docs ?? []).map((d) => d.id);
      if (ids.length > 0) {
        await store.deleteByDocuments(ids);
        forgot += ids.length;
      }
    }
    return { ok: true, forgot };
  });

/**
 * pgvector hands a `vector` column back as its text form, `[0.1,0.2,…]`.
 *
 * Parsed rather than trusted: a column that came back as something else is a
 * chunk to skip, not a crash in the middle of a re-index that has already
 * written half a collection.
 */
export function parseEmbedding(raw: string | number[] | null): number[] | null {
  if (Array.isArray(raw)) return raw.length === VECTOR_DIMS ? raw : null;
  if (typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== VECTOR_DIMS) return null;
    return parsed.every((n) => typeof n === "number" && Number.isFinite(n))
      ? (parsed as number[])
      : null;
  } catch {
    return null;
  }
}
