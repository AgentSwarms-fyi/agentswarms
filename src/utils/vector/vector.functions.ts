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
import { resolveRetrievalSettings } from "@/lib/kbRag";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { auditEvent } from "@/utils/audit.server";
import { requireSuperadmin } from "@/utils/iam.server";
import {
  externalIndex,
  externalStoreConfigured,
  selectedStoreKind,
  storeFor,
  storeKindByKnowledgeBase,
  storeKindForChoice,
  vectorStore,
  vectorStoreIsExternal,
} from "./store.server";
import { indexReport, repairKnowledgeBase } from "./sync.server";
import { parseEmbedding, VECTOR_DIMS, type VectorPoint, type VectorStoreInfo } from "./types";

/** Rows read from `kb_chunks` per page while re-indexing. */
const REINDEX_PAGE = 250;

export type VectorStoreStatus = {
  /** What VECTOR_STORE asked for. */
  selected: string;
  /** Whether that store keeps vectors outside Postgres. */
  external: boolean;
  dims: number;
  info: VectorStoreInfo;
  /** Chunks in Postgres, embedded or not. */
  chunksInDatabase: number;
  /**
   * Where the external index stands against Postgres, per knowledge base on
   * it (sync.server.ts). Null when this deployment has no external index.
   * `expected` counts only the chunks that belong there — embedded ones in a
   * collection that searches the index — which is the honest comparison:
   * every chunk in the database never was.
   */
  index: {
    knowledgeBases: number;
    inStep: number;
    expected: number;
    held: number;
    outOfStep: {
      knowledgeBaseId: string;
      name: string | null;
      expected: number;
      held: number;
      error?: string;
    }[];
    repairing: number;
    lastSweepAt: string | null;
    error?: string;
  } | null;
};

export const vectorStoreStatus = createServerFn({ method: "POST" })
  .validator((input: unknown) => z.object({ access_token: z.string().min(1) }).parse(input))
  .handler(async ({ data }): Promise<{ ok: false; error: string } | VectorStoreStatus> => {
    const guard = await requireSuperadmin(data.access_token);
    if (!guard.ok) return guard;

    const kind = selectedStoreKind();
    const store = vectorStore(supabaseAdmin);
    const [info, counted, index] = await Promise.all([
      store.info(),
      supabaseAdmin.from("kb_chunks").select("id", { count: "exact", head: true }),
      readIndexReport(),
    ]);
    return {
      selected: kind,
      external: vectorStoreIsExternal(kind),
      dims: VECTOR_DIMS,
      info,
      chunksInDatabase: counted.count ?? 0,
      index,
    };
  });

async function readIndexReport(): Promise<VectorStoreStatus["index"]> {
  try {
    const report = await indexReport();
    if (!report) return null;
    const shown = report.outOfStep.slice(0, 20);
    // Names, because an id is not something an operator can act on. This is
    // the superadmin's page; the service-role read is what it already uses.
    const names = new Map<string, string>();
    if (shown.length > 0) {
      const { data: kbs } = await supabaseAdmin
        .from("knowledge_bases")
        .select("id, name")
        .in(
          "id",
          shown.map((v) => v.knowledgeBaseId),
        );
      for (const k of (kbs ?? []) as { id: string; name: string | null }[]) {
        if (k.name) names.set(k.id, k.name);
      }
    }
    return {
      knowledgeBases: report.knowledgeBases,
      inStep: report.inStep,
      expected: report.expected,
      held: report.held,
      outOfStep: shown.map((v) => ({
        knowledgeBaseId: v.knowledgeBaseId,
        name: names.get(v.knowledgeBaseId) ?? null,
        expected: v.expected,
        held: v.held,
        ...(v.error ? { error: v.error } : {}),
      })),
      repairing: report.repairing,
      lastSweepAt: report.lastSweep?.at ?? null,
    };
  } catch (e) {
    return {
      knowledgeBases: 0,
      inStep: 0,
      expected: 0,
      held: 0,
      outOfStep: [],
      repairing: 0,
      lastSweepAt: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

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
  .validator((input: unknown) =>
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

      // Which knowledge bases, resolved up front so the delete and the write
      // cover exactly the same set.
      let kbIds = data.knowledgeBaseIds ?? [];
      if (kbIds.length === 0) {
        const { data: kbs, error } = await supabaseAdmin.from("knowledge_bases").select("id");
        if (error) throw new Error(error.message);
        kbIds = (kbs ?? []).map((k) => k.id);
      }
      if (kbIds.length === 0) return { ok: true, indexed: 0, skipped: false, kind };

      // Only the collections that keep vectors outside Postgres, which is not
      // the same question as what this instance defaults to: a collection can
      // choose the external index on an instance whose default is Postgres,
      // and it is exactly that collection a rebuild has to reach.
      const kinds = await storeKindByKnowledgeBase(supabaseAdmin, kbIds);
      const external = kbIds.filter((id) => vectorStoreIsExternal(kinds.get(id) ?? kind));
      if (external.length === 0) return { ok: true, indexed: 0, skipped: true, kind };
      kbIds = external;
      const index = externalIndex();
      if (!index) return { ok: true, indexed: 0, skipped: true, kind };

      // Every vector written again, and every point Postgres no longer has
      // removed by id (R417). It used to forget the knowledge bases first,
      // which removed the stale points too — a chunk deleted while the store
      // was unreachable has no row to rewrite it — but left them empty, and
      // searched as empty, until the copy caught up.
      let indexed = 0;
      for (const id of kbIds) {
        indexed += (await repairKnowledgeBase(index, id, { rewrite: true })).copied;
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
 * Copy the embeddings already in `kb_chunks` into a vector store.
 *
 * Reading from Postgres rather than re-embedding is the whole point: the
 * vectors exist, they cost money once, and moving a collection between
 * indexes must not charge for them again.
 *
 * `sb` decides what is visible. Passed the caller's client it copies only
 * what that caller may read; passed the admin client it copies everything.
 */
async function copyChunksToStore(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  knowledgeBaseIds: string[],
  store: { upsert: (points: VectorPoint[]) => Promise<void> },
): Promise<number> {
  let indexed = 0;
  for (const kbId of knowledgeBaseIds) {
    for (let from = 0; ; from += REINDEX_PAGE) {
      const { data: rows, error } = await sb
        .from("kb_chunks")
        .select("id, document_id, knowledge_base_id, embedding")
        .eq("knowledge_base_id", kbId)
        .order("id", { ascending: true })
        .range(from, from + REINDEX_PAGE - 1);
      if (error) throw new Error(error.message);
      const page = (rows ?? []) as {
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
  return indexed;
}

/**
 * Save a collection's retrieval settings, and move its vectors if the index
 * it searches has changed.
 *
 * The move is why this is a server function rather than an update from the
 * browser. Changing the index is not a preference that takes effect on the
 * next query: the embeddings sit in whichever store they were written to, so
 * a collection pointed at an index it was never written to matches nothing —
 * no error, no empty-state, just an agent that stops citing it.
 *
 * The order is deliberate. Copy, then save, then clear the old index. A
 * failure part-way leaves vectors in two stores, which costs disk and answers
 * correctly; the other order leaves a collection pointing at an empty one.
 */
export const saveKbRetrievalSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) =>
    z
      .object({
        knowledgeBaseId: z.string().uuid(),
        mode: z.enum(["semantic", "hybrid", "keyword"]),
        semanticWeight: z.number().min(0).max(1),
        vectorStore: z.enum(["default", "pgvector", "qdrant"]),
      })
      .parse(input),
  )
  .handler(
    async ({
      data,
      context,
    }): Promise<
      | { ok: false; error: string }
      | { ok: true; moved: number; movedTo: string | null; cleared: string | null }
    > => {
      const { supabase } = context;
      // Read back under the CALLER'S client: a collection they cannot see comes
      // back empty, and nothing below ever runs on an id they do not own.
      const { data: kb } = await supabase
        .from("knowledge_bases")
        .select("id, retrieval_settings")
        .eq("id", data.knowledgeBaseId)
        .maybeSingle();
      if (!kb) return { ok: false, error: "Knowledge base not found" };

      const before = storeKindForChoice(
        resolveRetrievalSettings(kb.retrieval_settings).vectorStore,
      );
      const after = storeKindForChoice(data.vectorStore);

      let moved = 0;
      let movedTo: string | null = null;
      if (after !== before && vectorStoreIsExternal(after)) {
        moved = await copyChunksToStore(supabase, [kb.id], storeFor(after, supabase));
        movedTo = after;
      }

      const { error } = await supabase
        .from("knowledge_bases")
        .update({
          retrieval_settings: {
            mode: data.mode,
            semantic_weight: data.semanticWeight,
            vector_store: data.vectorStore,
          },
        })
        .eq("id", kb.id);
      if (error) return { ok: false, error: error.message };

      // Only now, and only the store this collection has actually left. A
      // failure here is a copy nobody searches: wasted space, not a wrong
      // answer, so it is reported and not thrown.
      let cleared: string | null = null;
      if (after !== before && vectorStoreIsExternal(before)) {
        try {
          await storeFor(before, supabase).deleteByKnowledgeBases([kb.id]);
          cleared = before;
        } catch (e) {
          console.warn(
            "[vector] switched store but the old index was not cleared:",
            e instanceof Error ? e.message : e,
          );
        }
      }

      if (after !== before) {
        auditEvent({
          userId: context.userId,
          actorEmail: (context.claims as { email?: string }).email ?? null,
          action: "vector_store.knowledge_base_changed",
          resourceType: "knowledge_base",
          resourceId: kb.id,
          detail: { from: before, to: after, vectors: moved },
        });
      }
      return { ok: true, moved, movedTo, cleared };
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
  .validator((input: unknown) => z.object({}).parse(input ?? {}))
  .handler(
    async (): Promise<{
      kind: string;
      external: boolean;
      dims: number;
      externalAvailable: boolean;
    }> => {
      const kind = selectedStoreKind();
      return {
        kind,
        external: vectorStoreIsExternal(kind),
        dims: VECTOR_DIMS,
        // Whether a collection CAN be pointed at the external store, which is
        // a different question from whether this instance defaults to it. A
        // choice the deployment cannot honour has to be visible where it is
        // made, not discovered later in a server log.
        externalAvailable: externalStoreConfigured(),
      };
    },
  );

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
  .validator((input: unknown) =>
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
    // Asked of the deployment, not of the collection. A collection can have
    // chosen the external index while the instance defaults to Postgres, and
    // one switched AWAY from it still has vectors there. Deleting an id the
    // store does not hold is a no-op, so clearing unconditionally is both
    // cheaper than resolving each collection and the only version that cannot
    // strand a vector whose row is gone.
    if (!externalStoreConfigured()) return { ok: true, forgot: 0 };
    const store = storeFor("qdrant", supabase);
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

// In types.ts since R417, where the index sync reads it too; re-exported
// here because this is where callers have always found it.
export { parseEmbedding };
