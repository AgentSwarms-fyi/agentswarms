// The vector-store seam.
//
// The property that matters most here is not "does search work" — it is that a
// store CANNOT WIDEN WHAT A CALLER CAN SEE. pgvector got that for free from
// row-level security. An external store has no rows and no policies, so the
// same guarantee has to be built out of two things that are both checked here:
// the search is filtered to knowledge bases the caller already had, and the
// rows are fetched back through the caller's own client rather than taken from
// the store's answer.
//
// Everything else in this file is the ordinary contract: what the config
// defaults to, what a malformed vector does, and which call happens before
// which.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { redactEndpoint, resolveStoreKind, VECTOR_DIMS, VECTOR_STORES } from "@/utils/vector/types";
import { qdrantConfig, qdrantStore } from "@/utils/vector/qdrant.server";
import { parseEmbedding } from "@/utils/vector/vector.functions";

const rd = (p: string) => readFileSync(p, "utf8");
const vec = (n = VECTOR_DIMS) => Array.from({ length: n }, (_, i) => i / n);

describe("choosing a store", () => {
  it("treats anything it does not recognise as pgvector", () => {
    // A deployment that typed `qrant` gets the working default rather than a
    // broken one — and the admin page shows which store is actually in use,
    // so the typo is visible rather than silent.
    for (const raw of [undefined, "", "  ", "qrant", "pinecone", "QDRANTT"]) {
      expect(resolveStoreKind(raw), `${raw}`).toBe("pgvector");
    }
  });

  it("accepts every store it offers, however it is typed", () => {
    for (const kind of VECTOR_STORES) {
      expect(resolveStoreKind(kind)).toBe(kind);
      expect(resolveStoreKind(` ${kind.toUpperCase()} `)).toBe(kind);
    }
  });
});

describe("what the admin page is allowed to show", () => {
  it("strips credentials out of an endpoint", () => {
    // This string is returned by a server function and rendered on a page. A
    // Qdrant URL can carry `user:pass@`, and a password shown once is a
    // password in a screenshot.
    expect(redactEndpoint("https://alice:hunter2@vectors.internal:6333")).not.toContain("hunter2");
    expect(redactEndpoint("https://alice:hunter2@vectors.internal:6333")).not.toContain("alice");
    expect(redactEndpoint("http://qdrant:6333/")).toBe("http://qdrant:6333");
    expect(redactEndpoint(null)).toBeNull();
    // Not a URL at all: shown as typed, because it is about to be reported as
    // unreachable and hiding it would hide the typo.
    expect(redactEndpoint("qdrant:6333")).toBe("qdrant:6333");
  });
});

describe("reading the Qdrant settings", () => {
  it("is null when no URL is set, which is what selects pgvector", () => {
    expect(qdrantConfig({})).toBeNull();
    expect(qdrantConfig({ QDRANT_URL: "   " })).toBeNull();
  });

  it("defaults everything else, and trims the trailing slash", () => {
    const cfg = qdrantConfig({ QDRANT_URL: "http://qdrant:6333/" });
    expect(cfg?.url).toBe("http://qdrant:6333");
    expect(cfg?.collection).toBe("agentswarms_kb_chunks");
    // 1, not 2: a single node cannot place a second copy, and asking for one
    // is a confusing way to start. A cluster is told explicitly.
    expect(cfg?.replication).toBe(1);
    expect(cfg?.shards).toBe(1);
    expect(cfg?.apiKey).toBeUndefined();
  });

  it("refuses a nonsense replication rather than sending it", () => {
    for (const raw of ["0", "-3", "two", "", "1.9"]) {
      const cfg = qdrantConfig({ QDRANT_URL: "http://q:6333", QDRANT_REPLICATION: raw });
      expect(cfg?.replication, raw).toBeGreaterThanOrEqual(1);
      expect(Number.isInteger(cfg?.replication), raw).toBe(true);
    }
    expect(
      qdrantConfig({ QDRANT_URL: "http://q:6333", QDRANT_REPLICATION: "3" })?.replication,
    ).toBe(3);
  });
});

/**
 * A config nobody else uses.
 *
 * "Does this collection exist?" is answered once per process per
 * `(url, collection)` — that cache is what stopped two requests racing to
 * create the same collection — so a test that wants the question asked again
 * asks about a different collection.
 */
let collectionSeq = 0;
const freshCfg = () =>
  qdrantConfig({
    QDRANT_URL: "http://q:6333",
    QDRANT_COLLECTION: `test_collection_${++collectionSeq}`,
  })!;

/** A fake Qdrant that records what it was asked. */
function fakeQdrant(opts: { collection?: unknown; search?: unknown[] } = {}) {
  const calls: { url: string; method: string; body: Record<string, unknown> }[] = [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ url, method: init.method ?? "GET", body });
    const json = (v: unknown, status = 200) =>
      ({
        ok: status < 400,
        status,
        json: async () => v,
        text: async () => JSON.stringify(v),
      }) as unknown as Response;

    if (/\/collections\/[^/]+$/.test(url) && (init.method ?? "GET") === "GET") {
      return opts.collection === undefined
        ? json({ result: { config: { params: { vectors: { size: VECTOR_DIMS } } } } })
        : json(opts.collection);
    }
    if (url.endsWith("/points/search")) return json({ result: opts.search ?? [] });
    return json({ result: true });
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("an external store cannot widen what a caller can see", () => {
  it("filters every search to the knowledge bases it was given", async () => {
    // THE LEAK GUARD. Without this filter a search returns the nearest chunks
    // in the whole deployment, and "the knowledge bases you may read" stops
    // being "the knowledge bases you do read". pgvector gets this from RLS;
    // Qdrant has no rows, so it has to be sent.
    const calls = fakeQdrant({ search: [{ id: "c1", score: 0.9 }] });
    const store = qdrantStore(freshCfg());
    const hits = await store.search({
      embedding: vec(),
      knowledgeBaseIds: ["kb-a", "kb-b"],
      limit: 5,
    });
    expect(hits).toEqual([{ id: "c1", score: 0.9 }]);

    const search = calls.find((c) => c.url.endsWith("/points/search"));
    expect(search, "no search was issued").toBeTruthy();
    const filter = search!.body.filter as { must?: { key?: string; match?: { any?: string[] } }[] };
    expect(filter?.must?.[0]?.key).toBe("kb");
    expect(filter?.must?.[0]?.match?.any).toEqual(["kb-a", "kb-b"]);
    // And it does not ask for the payload: the store holds no text worth
    // reading back, and the rows come from Postgres.
    expect(search!.body.with_payload).toBe(false);
  });

  it("asks nothing at all when there are no knowledge bases to search", async () => {
    // An empty list means "you may read nothing here". Sending it would be a
    // filter matching nothing on a good day and everything on a bad one.
    const calls = fakeQdrant();
    const hits = await qdrantStore(freshCfg()).search({
      embedding: vec(),
      knowledgeBaseIds: [],
      limit: 5,
    });
    expect(hits).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("hydrates rows through the caller's client, not from the store's answer", () => {
    // The second half of the guarantee, and the reason the store is allowed to
    // be untrusted: what it returns is a list of ids, and the ids are then
    // looked up with a SECURITY INVOKER function that filters on kb_ids again.
    const kb = rd("src/utils/tools/kb.server.ts");
    expect(kb).toMatch(/rpc\("kb_chunks_by_ids"/);
    expect(kb).toContain("chunk_ids: matches.map((m) => m.id)");
    expect(kb).toContain("kb_ids: kbIds");
    const sql = rd("supabase/migrations/20260902000000_vector_store.sql");
    expect(sql).toMatch(/AND c\.knowledge_base_id = ANY\(kb_ids\)/);
    // EVERY function here, not "at least one" — a first version of this test
    // asserted the file merely CONTAINED the words, so flipping one of the two
    // to SECURITY DEFINER passed. That one is the hydration function, and
    // DEFINER on it means the row fetch runs as the owner: the second ACL
    // check would be gone and the store's answer would be the answer.
    // EVERY function here, checked one body at a time. A first version of this
    // asserted the file merely CONTAINED the words "SECURITY INVOKER", and the
    // header comment says them — so flipping one function to SECURITY DEFINER
    // passed. That one is the hydration function, and DEFINER on it means the
    // row fetch runs as the owner: the second ACL check would be gone and the
    // store's answer would be the answer.
    const bodies = sql.split(/CREATE OR REPLACE FUNCTION public\./).slice(1);
    expect(bodies.map((b) => b.slice(0, b.indexOf("(")))).toEqual([
      "match_kb_chunk_ids",
      "kb_chunks_by_ids",
    ]);
    for (const body of bodies) {
      const head = body.slice(0, body.indexOf("AS $$"));
      expect(head, "a function here is not SECURITY INVOKER").toContain("SECURITY INVOKER");
      expect(head).not.toMatch(/SECURITY\s+DEFINER/i);
    }
  });

  it("keeps the store's ranking, which a uuid array does not carry", () => {
    // kb_chunks_by_ids returns rows in whatever order Postgres likes. Using
    // that order would silently replace the similarity ranking with a physical
    // one — retrieval would still "work" and would return the wrong best hit.
    const kb = rd("src/utils/tools/kb.server.ts");
    expect(kb).toContain("matches\n        .map((m) => byChunkId.get(m.id))");
    expect(kb).toContain("scoreOf.get(r.id)");
  });
});

describe("the Qdrant collection", () => {
  it("refuses one built for a different width, naming both numbers", async () => {
    // Qdrant's own error for this arrives per point, during an index run that
    // has already written half a collection. Saying it once, at the first
    // call, is the difference between a clear message and a mystery.
    fakeQdrant({ collection: { result: { config: { params: { vectors: { size: 768 } } } } } });
    const store = qdrantStore(freshCfg());
    await expect(
      store.search({ embedding: vec(), knowledgeBaseIds: ["kb"], limit: 1 }),
    ).rejects.toThrow(/768.*1536|1536.*768/s);
  });

  it("creates it with a payload index, or every filter is a full scan", async () => {
    const calls = fakeQdrant({ collection: {} }); // 404-shaped: no `result`
    await qdrantStore(freshCfg()).upsert([
      { id: "c1", embedding: vec(), knowledgeBaseId: "kb", documentId: "doc" },
    ]);
    const created = calls.find((c) => c.method === "PUT" && /\/collections\/[^/?]+$/.test(c.url));
    expect(created, "collection was never created").toBeTruthy();
    expect((created!.body.vectors as { size: number }).size).toBe(VECTOR_DIMS);
    expect((created!.body.vectors as { distance: string }).distance).toBe("Cosine");
    const indexed = calls.filter((c) => c.url.includes("/index"));
    expect(indexed.map((c) => c.body.field_name).sort()).toEqual(["doc", "kb"]);
  });

  it("indexes the payload on a collection that already exists", async () => {
    // FOUND FROM THE UI, on a collection created by an earlier build whose
    // create had thrown before reaching the index step. `payload_schema: {}`
    // and the "it is already there" path returned early, so it was never
    // repaired — and an unindexed payload makes every filtered search a full
    // scan of the collection, which is the one thing the filter exists to
    // avoid. Nothing failed; it just got slower for ever.
    const calls = fakeQdrant(); // default: the collection already exists
    await qdrantStore(freshCfg()).search({
      embedding: vec(),
      knowledgeBaseIds: ["kb"],
      limit: 1,
    });
    const indexed = calls.filter((c) => c.url.includes("/index"));
    expect(indexed.map((c) => c.body.field_name).sort()).toEqual(["doc", "kb"]);
    // And it did NOT try to create a collection that is already there.
    expect(calls.some((c) => c.method === "PUT" && /\/collections\/[^/?]+$/.test(c.url))).toBe(
      false,
    );
  });

  it("treats losing the create race as success", async () => {
    // FOUND FROM THE UI. Two requests that both see no collection both create
    // one; the loser got `409 Collection already exists` and the admin page
    // reported a perfectly healthy Qdrant as Unreachable. One page load
    // issuing two calls was enough — two app replicas make it routine.
    const cfg = freshCfg();
    let created = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit = {}) => {
        const method = init.method ?? "GET";
        const json = (v: unknown, status: number) =>
          ({
            ok: status < 400,
            status,
            json: async () => v,
            text: async () => JSON.stringify(v),
          }) as unknown as Response;
        if (/\/collections\/[^/?]+$/.test(url) && method === "GET") return json({}, 404);
        if (/\/collections\/[^/?]+$/.test(url) && method === "PUT") {
          created = true;
          return json({ status: { error: "Wrong input: Collection already exists!" } }, 409);
        }
        return json({ result: [] }, 200);
      }),
    );
    await expect(
      qdrantStore(cfg).search({ embedding: vec(), knowledgeBaseIds: ["kb"], limit: 1 }),
    ).resolves.toEqual([]);
    expect(created, "it never even tried to create one").toBe(true);
  });

  it("still fails when the create fails for a real reason", async () => {
    // The other half of tolerating a 409. A catch that swallowed everything
    // would hide a create rejected for shard placement, disk or a bad config —
    // and the next operation would then fail somewhere less explicable.
    const cfg = freshCfg();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit = {}) => {
        const method = init.method ?? "GET";
        const json = (v: unknown, status: number) =>
          ({
            ok: status < 400,
            status,
            json: async () => v,
            text: async () => JSON.stringify(v),
          }) as unknown as Response;
        if (/\/collections\/[^/?]+$/.test(url) && method === "GET") return json({}, 404);
        if (/\/collections\/[^/?]+$/.test(url) && method === "PUT") {
          return json({ status: { error: "No shard placement available" } }, 400);
        }
        return json({ result: [] }, 200);
      }),
    );
    await expect(
      qdrantStore(cfg).search({ embedding: vec(), knowledgeBaseIds: ["kb"], limit: 1 }),
    ).rejects.toThrow(/shard placement/);
  });

  it("refuses a vector of the wrong width instead of storing it", async () => {
    fakeQdrant();
    const store = qdrantStore(freshCfg());
    await expect(
      store.upsert([{ id: "c1", embedding: vec(768), knowledgeBaseId: "kb", documentId: "d" }]),
    ).rejects.toThrow(/768/);
  });

  it("forgets by document and by knowledge base with the matching filter", async () => {
    const calls = fakeQdrant();
    const store = qdrantStore(freshCfg());
    await store.deleteByDocuments(["d1", "d2"]);
    await store.deleteByKnowledgeBases(["kb1"]);
    const deletes = calls.filter((c) => c.url.includes("/points/delete"));
    expect(deletes).toHaveLength(2);
    const keys = deletes.map(
      (d) => ((d.body.filter as { must: { key: string }[] }).must[0] as { key: string }).key,
    );
    expect(keys).toEqual(["doc", "kb"]);
  });
});

describe("vectors read back out of Postgres", () => {
  it("takes the text form pgvector emits, and refuses anything else", () => {
    // A re-index reads `embedding` back over PostgREST, where a `vector`
    // column arrives as its text form. A row that came back as something else
    // is a chunk to skip, not a crash halfway through writing a collection.
    expect(parseEmbedding(`[${vec().join(",")}]`)).toHaveLength(VECTOR_DIMS);
    expect(parseEmbedding(vec())).toHaveLength(VECTOR_DIMS);
    expect(parseEmbedding(vec(768))).toBeNull();
    expect(parseEmbedding(`[${vec(768).join(",")}]`)).toBeNull();
    expect(parseEmbedding("not json")).toBeNull();
    expect(parseEmbedding(null)).toBeNull();
    expect(parseEmbedding(`["a","b"]`)).toBeNull();
  });

  it("agrees with the embedder about how wide a vector is", () => {
    // Two constants for one number is one constant too many: a disagreement
    // would mean a store holding vectors the embedder cannot produce.
    const embed = rd("src/utils/tools/embedding.server.ts");
    const m = embed.match(/const EMBED_DIMS = (\d+);/);
    expect(m, "EMBED_DIMS is gone or renamed").toBeTruthy();
    expect(Number(m![1])).toBe(VECTOR_DIMS);
  });
});

describe("writes and deletes reach the store in the right order", () => {
  it("mirrors AFTER the rows are committed", () => {
    // A point whose row was never written is a hit that hydrates to nothing.
    const src = rd("src/utils/tools/embedding.server.ts");
    const upsert = src.indexOf('.upsert(slice, { onConflict: "document_id,chunk_index" })');
    const mirror = src.indexOf("await mirrorToExternalStore(");
    expect(upsert).toBeGreaterThan(-1);
    expect(mirror).toBeGreaterThan(upsert);
  });

  it("never fails an ingest because the store was unreachable", () => {
    // The chunks ARE stored and keyword search still works; re-indexing
    // repairs the index. Throwing here would lose an ingest that succeeded.
    const src = rd("src/utils/tools/embedding.server.ts");
    const fn = src.slice(src.indexOf("async function mirrorToExternalStore"));
    expect(fn).toContain("catch");
    expect(fn).toContain("re-index to repair");
  });

  it("forgets the vectors BEFORE the rows that authorise forgetting them", () => {
    // Once the row is gone there is nothing left to check ownership against.
    const page = rd("src/routes/_authenticated/knowledge.tsx");
    for (const [forget, del] of [
      ["sourceIds: [src.id]", 'from("knowledge_documents").delete().eq("source_id", src.id)'],
      ["knowledgeBaseIds: [id]", 'from("knowledge_bases").delete().eq("id", id)'],
      ["documentIds: [id]", 'from("knowledge_documents").delete().eq("id", id)'],
    ]) {
      const f = page.indexOf(forget);
      const d = page.indexOf(del);
      expect(f, `${forget} is not called at all`).toBeGreaterThan(-1);
      expect(d, `${del} is gone`).toBeGreaterThan(-1);
      expect(f, `${forget} runs after the delete`).toBeLessThan(d);
    }
  });

  it("re-indexes by clearing first, so a deleted chunk cannot survive", () => {
    // Writing without clearing leaves a vector whose row is gone in the store
    // for ever. It hydrates to nothing and is dropped at query time, which
    // hides the drift rather than fixing it.
    const fns = rd("src/utils/vector/vector.functions.ts");
    const clear = fns.indexOf("await store.deleteByKnowledgeBases(kbIds)");
    const write = fns.indexOf("await store.upsert(points)");
    expect(clear).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(clear);
  });

  it("records a re-index in the audit trail", () => {
    const fns = rd("src/utils/vector/vector.functions.ts");
    expect(fns).toContain('action: "vector_store.reindex"');
    expect(fns).toContain("requireSuperadmin");
  });
});

describe("losing the store degrades retrieval instead of breaking it", () => {
  // The deployment docs promise this in the row where every other stateful
  // service says "restore", so it has to be true for EVERY collection — not
  // only the ones already configured for hybrid.
  const KB = rd("src/utils/tools/kb.server.ts");

  it("runs keyword search even for a semantic-only collection", () => {
    // `retrieval.mode !== "semantic"` skipped the keyword pass entirely, and
    // semantic is the default — so a collection nobody had reconfigured
    // returned NOTHING while the store was down.
    expect(KB).toContain("let vectorSearchFailed = false;");
    expect(KB).toContain("vectorSearchFailed = true;");
    expect(KB).toContain('if (effective.mode !== "semantic") {');
  });

  it("weights keyword as the only signal, not at the collection's usual weight", async () => {
    // Forcing the pass on is not enough. fuseHybrid multiplies keyword scores
    // by (1 - semanticWeight), which is ZERO for a semantic collection: every
    // hit would come back scored 0 and ordered by id — an answer that looks
    // like retrieval and ranks like nothing.
    expect(KB).toContain('{ ...retrieval, mode: "keyword", semanticWeight: 0 }');
    expect(KB).toContain("fuseHybrid(vectorScores, keywordScores, effective)");

    const { fuseHybrid } = await import("@/lib/kbRag");
    const semantic = { mode: "semantic" as const, semanticWeight: 1 };
    const keywordOnly = { mode: "keyword" as const, semanticWeight: 0 };
    const hits = [
      { id: "a", score: 0.2 },
      { id: "b", score: 0.9 },
    ];
    // At the collection's own weight the ranking is lost…
    expect(fuseHybrid([], hits, semantic).map((f) => f.score)).toEqual([0, 0]);
    // …and at the fallback weight it survives, best first.
    expect(fuseHybrid([], hits, keywordOnly).map((f) => f.id)).toEqual(["b", "a"]);
  });
});

describe("the knowledge base page says where its vectors go", () => {
  const RAW = rd("src/routes/_authenticated/knowledge.tsx");
  // Comments stripped before asserting an ABSENCE: the comment explaining why
  // the dropdown was removed contains its label, and the first version of this
  // test failed on its own explanation.
  const PAGE = RAW.replace(/\{\/\*[\s\S]*?\*\/\}/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");

  it("offers no per-collection store picker, because there is no such choice", () => {
    // FOUND FROM A QUESTION: "I don't see it in RAG Settings". What WAS there
    // was a "Vector Store Provider" dropdown with one option, bound to a
    // useState nothing read and nothing saved — a control shaped like a choice
    // that could not make one. And the choice is not per collection: splitting
    // it would put one knowledge base's vectors in Postgres and another's in
    // Qdrant, and switching would strand half of each.
    expect(PAGE).not.toContain("Vector Store Provider");
    expect(PAGE).not.toContain("const VECTOR_STORES");
    expect(PAGE).not.toMatch(/useState\("local"\)/);
  });

  it("reads the store it actually uses, rather than naming one", () => {
    // The banner said "Retrieval: Supabase pgvector" whatever was configured.
    expect(PAGE).toContain("vectorStoreBrief");
    expect(PAGE).toContain("storeBrief?.external");
    expect(RAW).toContain("Admin → Runtime → AI services");
  });

  it("tells a collection owner nothing an operator would not", () => {
    // Any KB owner can open that dialog, so the brief carries the store's NAME
    // and nothing else — not its address, not its size, not its key.
    const fns = rd("src/utils/vector/vector.functions.ts");
    const brief = fns.slice(
      fns.indexOf("export const vectorStoreBrief"),
      fns.indexOf("/**", fns.indexOf("export const vectorStoreBrief") + 10),
    );
    expect(brief).toContain("requireSupabaseAuth");
    for (const leak of ["endpoint", "apiKey", "QDRANT_URL", "points", "info("]) {
      expect(brief, `the brief exposes ${leak}`).not.toContain(leak);
    }
  });
});

describe("an operator can see whether the store is answering", () => {
  it("is on the monitoring page, probed on readiness rather than life", async () => {
    // A new Compose service that nobody can see the health of is a service
    // that fails silently — which is why the catalogue is guarded at all. And
    // /livez only says the process is up: a Qdrant node still loading its
    // index answers it while returning nothing useful to a search. The page
    // exists to tell those two apart, so it asks the question that does.
    const { SERVICE_CATALOGUE } = await import("@/lib/serviceHealth");
    const entry = SERVICE_CATALOGUE.find((s) => s.id === "qdrant");
    expect(entry, "qdrant is not in the monitoring catalogue").toBeTruthy();
    expect(entry!.path).toBe("/readyz");
    expect(entry!.profile).toBe("vectors");
    expect(entry!.optional).toBe(true);
    // In-network name first, host loopback last — the same discovery order
    // every other service here uses.
    expect(entry!.candidates[0]).toContain("qdrant:6333");
  });
});

describe("pgvector stays the default, and stays free", () => {
  it("does nothing on write, because the vector is the row", () => {
    const src = rd("src/utils/vector/pgvector.server.ts");
    expect(src).toContain("async upsert() {}");
    expect(src).toContain("async deleteByDocuments() {}");
    expect(src).toContain("async deleteByKnowledgeBases() {}");
  });

  it("says so out loud when qdrant is selected without a URL", () => {
    // Silently falling back would work — the vectors are still in kb_chunks —
    // while every operator reading the config believed otherwise.
    const src = rd("src/utils/vector/store.server.ts");
    expect(src).toContain("console.error");
    expect(src).toMatch(/VECTOR_STORE=qdrant but QDRANT_URL is not set/);
  });

  it("names each setting literally, so the docs guard can see it", () => {
    const src = rd("src/utils/vector/store.server.ts");
    for (const name of [
      "VECTOR_STORE",
      "QDRANT_URL",
      "QDRANT_API_KEY",
      "QDRANT_COLLECTION",
      "QDRANT_REPLICATION",
      "QDRANT_SHARDS",
    ]) {
      expect(src, `${name} is not read literally`).toContain(`process.env.${name}`);
    }
  });
});
