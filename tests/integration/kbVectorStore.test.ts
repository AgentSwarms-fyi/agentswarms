// A collection's own vector index, against a real Postgres and a real Qdrant.
//
// The unit tests decide which store each collection SHOULD be resolved to.
// Only this can show that the resolution is what actually happened: that a
// collection set to Qdrant on an instance whose default is Postgres is written
// to Qdrant and answered by Qdrant, that the copy left behind in Postgres is
// still a working index, and that clearing one store does not touch the other.
//
// It is the pair of those facts that makes the choice safe to change: a
// collection can move either way and be searchable both before and after.
//
// RUN:
//   QDRANT_URL=http://localhost:6333 npm run test:integration
//
// with SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY set. Skips cleanly without
// either, and without a reachable Qdrant.
//
// CLEANUP: every row and every vector this file creates is namespaced to one
// run and removed in an afterAll — the chunks, the document, the collection,
// and the points in the shared Qdrant collection.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { VECTOR_DIMS, type VectorPoint } from "@/utils/vector/types";
import { storeFor, storeKindByKnowledgeBase } from "@/utils/vector/store.server";

import { admin, hasSupabase, TEST_PREFIX } from "./setup";

const RUN = Math.random().toString(36).slice(2, 7);
const QDRANT = process.env.QDRANT_URL;

/** A unit vector along one axis, so cosine similarity is exactly predictable. */
function axis(i: number): number[] {
  const v = new Array<number>(VECTOR_DIMS).fill(0);
  v[i] = 1;
  return v;
}

async function qdrantUp(): Promise<boolean> {
  if (!QDRANT) return false;
  try {
    const r = await fetch(`${QDRANT}/readyz`, { signal: AbortSignal.timeout(4_000) });
    return r.ok;
  } catch {
    return false;
  }
}

let ready = false;
/** Why the fixture was not built, so a skip is never mistaken for a pass. */
let reason = "";
let kbId = "";
let otherKbId = "";
let docId = "";
const chunkIds: string[] = [];

describe.skipIf(!hasSupabase)("a collection searched in the index it chose", () => {
  beforeAll(async () => {
    ready = await qdrantUp();
    if (!ready) {
      reason = `Qdrant at ${QDRANT ?? "(unset)"} did not answer /readyz`;
      return;
    }
    const sb = admin();

    // An existing owner, rather than a new account: these tests create rows,
    // never identities.
    // Not simply the first row: the shipped sample collections have a null
    // owner, and borrowing that would insert chunks nobody owns.
    const { data: owner, error: ownerErr } = await sb
      .from("knowledge_bases")
      .select("user_id")
      .not("user_id", "is", null)
      .limit(1)
      .maybeSingle();
    const userId = owner?.user_id;
    if (!userId) {
      ready = false;
      reason = `no existing knowledge base to borrow an owner from: ${ownerErr?.message ?? "none found"}`;
      return;
    }

    const mk = async (name: string, settings: Record<string, unknown> | null) => {
      const { data, error } = await sb
        .from("knowledge_bases")
        .insert({
          name: `${TEST_PREFIX}${name}-${RUN}`,
          user_id: userId,
          ...(settings ? { retrieval_settings: settings } : {}),
        })
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      return data.id;
    };
    // One collection that chose Qdrant, one that chose nothing.
    kbId = await mk("vecstore-chose", {
      mode: "hybrid",
      semantic_weight: 0.7,
      vector_store: "qdrant",
    });
    otherKbId = await mk("vecstore-default", null);

    const { data: doc, error: docErr } = await sb
      .from("knowledge_documents")
      .insert({
        knowledge_base_id: kbId,
        user_id: userId,
        name: `${TEST_PREFIX}doc-${RUN}.md`,
        content: "vector store routing fixture",
      })
      .select("id")
      .single();
    if (docErr) throw new Error(docErr.message);
    docId = doc.id;

    for (let i = 0; i < 3; i++) {
      const { data, error } = await sb
        .from("kb_chunks")
        .insert({
          knowledge_base_id: kbId,
          document_id: docId,
          user_id: userId,
          chunk_index: i,
          content: `fixture chunk ${i}`,
          embedding: JSON.stringify(axis(i)),
        })
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      chunkIds.push(data.id);
    }
  }, 60_000);

  afterAll(async () => {
    if (!kbId) return;
    const sb = admin();
    try {
      await storeFor("qdrant", sb).deleteByKnowledgeBases([kbId, otherKbId].filter(Boolean));
    } catch {
      /* the rows still go */
    }
    await sb.from("kb_chunks").delete().eq("knowledge_base_id", kbId);
    await sb.from("knowledge_documents").delete().eq("knowledge_base_id", kbId);
    await sb.from("knowledge_bases").delete().in("id", [kbId, otherKbId].filter(Boolean));
  }, 60_000);

  it("is running against a reachable Qdrant, or the rest of this proves nothing", () => {
    // Every test below returns early when the fixture could not be built, and
    // a test that returns early passes. That is the right behaviour on a
    // machine with no external store — and the wrong one on a machine that
    // HAS configured a store this run could not reach, where five green ticks
    // would be a lie. This separates the two.
    if (!QDRANT) return;
    expect(ready, `QDRANT_URL is ${QDRANT} but the fixture was not built: ${reason}`).toBe(true);
    expect(chunkIds).toHaveLength(3);
  });

  it("resolves each collection to the store IT chose, not the instance's", async () => {
    if (!ready) return;
    // VECTOR_STORE is not set for this run, so the instance default is
    // pgvector. This is the case every instance-wide guard got wrong.
    expect(process.env.VECTOR_STORE ?? "pgvector").toBe("pgvector");
    const kinds = await storeKindByKnowledgeBase(admin(), [kbId, otherKbId]);
    expect(kinds.get(kbId)).toBe("qdrant");
    expect(kinds.get(otherKbId)).toBe("pgvector");
  });

  it("answers from Qdrant once the vectors are copied there", async () => {
    if (!ready) return;
    const sb = admin();
    const points: VectorPoint[] = chunkIds.map((id, i) => ({
      id,
      embedding: axis(i),
      knowledgeBaseId: kbId,
      documentId: docId,
    }));
    await storeFor("qdrant", sb).upsert(points);

    const hits = await storeFor("qdrant", sb).search({
      embedding: axis(1),
      knowledgeBaseIds: [kbId],
      limit: 3,
    });
    // The planted vector is the query, so it is first at similarity 1.
    expect(hits[0]?.id).toBe(chunkIds[1]);
    expect(hits[0]?.score).toBeGreaterThan(0.99);
    expect(hits.map((h) => h.id).sort()).toEqual([...chunkIds].sort());
  });

  it("still answers from Postgres, which is what makes the move reversible", async () => {
    if (!ready) return;
    // The embeddings never left `kb_chunks`. That is why switching a
    // collection back costs nothing and why losing Qdrant degrades rather
    // than breaks.
    const hits = await storeFor("pgvector", admin()).search({
      embedding: axis(2),
      knowledgeBaseIds: [kbId],
      limit: 3,
    });
    expect(hits[0]?.id).toBe(chunkIds[2]);
  });

  it("returns nothing for a collection the caller did not name", async () => {
    if (!ready) return;
    const hits = await storeFor("qdrant", admin()).search({
      embedding: axis(1),
      knowledgeBaseIds: [otherKbId],
      limit: 3,
    });
    expect(hits).toEqual([]);
  });

  it("clears the store a collection leaves, and only that collection", async () => {
    if (!ready) return;
    const sb = admin();
    await storeFor("qdrant", sb).deleteByKnowledgeBases([kbId]);
    const after = await storeFor("qdrant", sb).search({
      embedding: axis(1),
      knowledgeBaseIds: [kbId],
      limit: 3,
    });
    expect(after).toEqual([]);
    // And the collection is still searchable, because Postgres kept the rows.
    const pg = await storeFor("pgvector", sb).search({
      embedding: axis(1),
      knowledgeBaseIds: [kbId],
      limit: 3,
    });
    expect(pg[0]?.id).toBe(chunkIds[1]);
  });
});
