// The default store: pgvector, in the same Postgres as everything else.
//
// This is not a fallback. For most deployments it is the right answer — the
// vectors are backed up with the rows they belong to, a knowledge base cannot
// half-exist because two systems disagree, and the ACL is the row-level
// security already protecting `kb_chunks` rather than a filter somebody has to
// remember to pass.
//
// `upsert` and the deletes are no-ops here, and deliberately so: the vector IS
// a column on the chunk row, so it arrives when the row is inserted and leaves
// when the row is deleted. Writing that as an empty method rather than as a
// branch at every call site is the whole point of the seam — the caller says
// what happened and the store decides whether it has anything to do.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import type { VectorMatch, VectorStore, VectorStoreInfo } from "./types";

type Client = SupabaseClient<Database>;

export function pgvectorStore(sb: Client): VectorStore {
  return {
    kind: "pgvector",

    async search({ embedding, knowledgeBaseIds, limit }): Promise<VectorMatch[]> {
      if (knowledgeBaseIds.length === 0 || limit <= 0) return [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (sb as any).rpc("match_kb_chunk_ids", {
        // Postgres wants the literal form; a JS array arrives as JSON and is
        // rejected by the vector type.
        query_embedding: `[${embedding.join(",")}]`,
        kb_ids: knowledgeBaseIds,
        match_count: limit,
      });
      if (error) throw new Error(error.message);
      return ((data ?? []) as { id: string; similarity: number | null }[]).map((r) => ({
        id: r.id,
        score: r.similarity ?? 0,
      }));
    },

    // The vector is a column on the row: inserting the row stores it, deleting
    // the row forgets it. There is nothing else to do.
    async upsert() {},
    async deleteByDocuments() {},
    async deleteByKnowledgeBases() {},

    async info(): Promise<VectorStoreInfo> {
      try {
        const { count, error } = await sb
          .from("kb_chunks")
          .select("id", { count: "exact", head: true });
        if (error) throw new Error(error.message);
        return {
          kind: "pgvector",
          endpoint: null,
          ok: true,
          points: count ?? undefined,
          // Whatever the database itself is doing. Saying "1" here would claim
          // a single copy of data that may well be on a replicated volume or a
          // Postgres cluster, which is not this code's business to assert.
        };
      } catch (e) {
        return {
          kind: "pgvector",
          endpoint: null,
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    },
  };
}
