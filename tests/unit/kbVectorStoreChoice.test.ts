// A knowledge base chooses the index it is searched in.
//
// The instance still has a default — VECTOR_STORE — and most collections will
// follow it. What is new is that one collection can differ, and the whole risk
// of the feature is in a single failure mode: vectors written to one index and
// searched in another. That fails silently. No error, no empty state, just an
// agent that stops citing a collection everybody believes is indexed.
//
// So the property under test throughout is AGREEMENT — ingest, retrieval,
// cleanup and rebuild all resolving the same collection to the same store —
// and the one operation that is allowed to change the answer (saving a new
// choice) moving the vectors before it does.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_RETRIEVAL, resolveRetrievalSettings, VECTOR_STORE_CHOICES } from "@/lib/kbRag";
import { storeKindByKnowledgeBase, storeKindForChoice } from "@/utils/vector/store.server";

const rd = (p: string) => readFileSync(p, "utf8");

/** A Supabase client stub that answers exactly one `knowledge_bases` select. */
function fakeClient(rows: { id: string; retrieval_settings: unknown }[] | null, fail = false) {
  return {
    from() {
      return {
        select() {
          return {
            in() {
              if (fail) throw new Error("no connection");
              return Promise.resolve({ data: rows, error: null });
            },
          };
        },
      };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("the choice a collection saves", () => {
  it("is read back out of the settings it was saved in", () => {
    expect(resolveRetrievalSettings({ vector_store: "qdrant" }).vectorStore).toBe("qdrant");
    expect(resolveRetrievalSettings({ vector_store: "pgvector" }).vectorStore).toBe("pgvector");
  });

  it("survives every search mode, because the two settings are unrelated", () => {
    // resolveRetrievalSettings pins the weight to 1 or 0 outside hybrid, and
    // an early version of that pinning returned a fresh object that dropped
    // the store — a collection on Qdrant silently moved back to Postgres the
    // moment somebody switched it to keyword search.
    for (const mode of ["semantic", "keyword", "hybrid"]) {
      const r = resolveRetrievalSettings({ mode, vector_store: "qdrant" });
      expect(r.vectorStore, mode).toBe("qdrant");
    }
  });

  it("falls back to the instance default rather than trusting the column", () => {
    // jsonb: anything can be in there, including a store this build has never
    // heard of after a downgrade.
    for (const raw of [undefined, null, {}, { vector_store: "pinecone" }, { vector_store: 7 }]) {
      expect(resolveRetrievalSettings(raw).vectorStore, JSON.stringify(raw)).toBe("default");
    }
    expect(DEFAULT_RETRIEVAL.vectorStore).toBe("default");
    expect(VECTOR_STORE_CHOICES).toEqual(["default", "pgvector", "qdrant"]);
  });
});

describe("resolving that choice to a store", () => {
  const before = process.env.VECTOR_STORE;
  afterEach(() => {
    if (before === undefined) delete process.env.VECTOR_STORE;
    else process.env.VECTOR_STORE = before;
  });

  it("follows the instance for a collection that did not choose", () => {
    delete process.env.VECTOR_STORE;
    expect(storeKindForChoice("default")).toBe("pgvector");
    expect(storeKindForChoice(undefined)).toBe("pgvector");
    process.env.VECTOR_STORE = "qdrant";
    expect(storeKindForChoice("default")).toBe("qdrant");
  });

  it("lets a collection differ from the instance, in both directions", () => {
    // This is the entire point of the feature. One large collection on Qdrant
    // while the rest stay in Postgres, AND one collection held back in
    // Postgres on an instance that moved to Qdrant.
    delete process.env.VECTOR_STORE;
    expect(storeKindForChoice("qdrant")).toBe("qdrant");
    process.env.VECTOR_STORE = "qdrant";
    expect(storeKindForChoice("pgvector")).toBe("pgvector");
  });

  it("answers for every collection asked about, including ones with no row", () => {
    delete process.env.VECTOR_STORE;
    return storeKindByKnowledgeBase(
      fakeClient([
        { id: "a", retrieval_settings: { vector_store: "qdrant" } },
        { id: "b", retrieval_settings: { mode: "hybrid" } },
      ]),
      ["a", "b", "c"],
    ).then((m) => {
      expect(m.get("a")).toBe("qdrant");
      expect(m.get("b")).toBe("pgvector");
      // `c` came back from no row at all — deleted mid-ingest, or invisible to
      // this caller. A map with a hole in it would read as `undefined` at the
      // call site and silently mean pgvector anyway; saying so is better.
      expect(m.get("c")).toBe("pgvector");
    });
  });

  it("degrades to the instance default when the settings cannot be read", async () => {
    // An ingest must not fail because a settings lookup did. The worst case is
    // a collection indexed into the instance's store instead of its own, which
    // a re-index repairs; failing the ingest loses the documents.
    delete process.env.VECTOR_STORE;
    const m = await storeKindByKnowledgeBase(fakeClient(null, true), ["a"]);
    expect(m.get("a")).toBe("pgvector");
  });

  it("asks nothing when there is nothing to ask about", async () => {
    expect((await storeKindByKnowledgeBase(fakeClient(null, true), [])).size).toBe(0);
  });
});

describe("ingest and retrieval agree about where a collection's vectors are", () => {
  const ingest = rd("src/utils/tools/embedding.server.ts");
  const retrieval = rd("src/utils/tools/kb.server.ts");

  it("both resolve the collection, neither reads the instance setting directly", () => {
    // The bug this prevents: one side asking `selectedStoreKind()` while the
    // other asks the collection. Both go through the same two functions.
    expect(ingest).toContain("storeKindByKnowledgeBase");
    expect(ingest).toMatch(/storeFor\(kind, sb\)\.upsert\(/);
    expect(retrieval).toContain("storeKindForChoice");
    expect(retrieval).toMatch(/storeFor\(kind, sb\)\.search\(/);
    // `vectorStore(sb)` is the instance-wide adapter. Either path using it
    // would ignore the collection's choice.
    expect(retrieval).not.toMatch(/vectorStore\(sb\)\.search\(/);
    expect(ingest).not.toMatch(/vectorStore\(sb\)\.upsert\(/);
  });

  it("writes a mixed batch to more than one store", () => {
    // One ingest run can carry rows from collections that chose differently,
    // so the points are grouped rather than sent somewhere as a batch.
    expect(ingest).toMatch(/byKind\.set\(kind,/);
    expect(ingest).toMatch(/for \(const \[kind, group\] of byKind\)/);
  });

  it("searches a mixed request in more than one store and merges by score", () => {
    expect(retrieval).toMatch(/byStore\.set\(kind,/);
    expect(retrieval).toMatch(/perStore[\s\S]{0,80}\.flat\(\)/);
    expect(retrieval).toMatch(/sort\(\(a, b\) => b\.score - a\.score\)/);
  });

  it("does not skip the external write because the INSTANCE is on pgvector", () => {
    // What was there before: `if (!usesExternalStore()) return`, asked once,
    // instance-wide. A collection that chose Qdrant on a Postgres-default
    // deployment would have been indexed nowhere.
    expect(ingest).not.toContain("usesExternalStore");
    expect(rd("src/utils/vector/store.server.ts")).not.toContain("usesExternalStore");
    expect(ingest).toMatch(/!\[\.\.\.kinds\.values\(\)\]\.some\(vectorStoreIsExternal\)/);
  });
});

describe("a vector is never left behind in a store nothing searches", () => {
  const ingest = rd("src/utils/tools/embedding.server.ts");
  const fns = rd("src/utils/vector/vector.functions.ts");

  it("clears the external store whenever one exists, not when it is the default", () => {
    // Deleting a knowledge base that chose Qdrant, on an instance whose
    // default is Postgres, used to delete nothing: the guard asked about the
    // instance. The vectors then outlived the rows that authorised them.
    expect(fns).toContain("if (!externalStoreConfigured()) return { ok: true, forgot: 0 };");
    expect(fns).not.toMatch(/if \(!vectorStoreIsExternal\(selectedStoreKind\(\)\)\) return \{ ok/);
    expect(ingest).toContain("if (externalStoreConfigured()) {");
  });

  it("rebuilds the collections that chose an external index, not the instance's", () => {
    const body = fns.slice(fns.indexOf("export const vectorStoreReindex"));
    expect(body).toContain("storeKindByKnowledgeBase");
    expect(body).toMatch(/vectorStoreIsExternal\(kinds\.get\(id\) \?\? kind\)/);
  });

  it("never re-embeds to move vectors, because Postgres already has them", () => {
    // The embeddings are a column on kb_chunks. Moving a collection between
    // indexes reads them back; charging for them twice would make the choice
    // one nobody could afford to change their mind about.
    const copy = fns.slice(fns.indexOf("async function copyChunksToStore"));
    expect(copy).toContain('.from("kb_chunks")');
    expect(copy).toContain("parseEmbedding");
    // The body reads a column and writes points. Nothing in it reaches an
    // embedding provider — `embedTexts` is what costs money, and the word
    // "embedding" in here is the name of the column being read.
    const body = copy.slice(0, copy.indexOf("\n}\n"));
    for (const call of ["embedTexts", "embedAndStoreDocuments", "openai", "apiKey"])
      expect(body, `copying re-embeds via ${call}`).not.toContain(call);
  });
});

describe("saving a new choice moves the vectors before it takes effect", () => {
  const fns = rd("src/utils/vector/vector.functions.ts");
  const handler = fns.slice(fns.indexOf("export const saveKbRetrievalSettings"));

  it("copies, then saves, then clears — in that order", () => {
    // Order is the whole guarantee. Saving first and failing the copy leaves a
    // collection pointed at an empty index: every agent silently stops citing
    // it. This order fails to a collection whose vectors are in two stores,
    // which costs disk and answers correctly.
    const copy = handler.indexOf("copyChunksToStore");
    const save = handler.indexOf(".update({");
    const clear = handler.indexOf("deleteByKnowledgeBases");
    expect(copy).toBeGreaterThan(-1);
    expect(save).toBeGreaterThan(copy);
    expect(clear).toBeGreaterThan(save);
  });

  it("clears only the store the collection actually left", () => {
    expect(handler).toMatch(/if \(after !== before && vectorStoreIsExternal\(before\)\)/);
    expect(handler).toMatch(/storeFor\(before, supabase\)\.deleteByKnowledgeBases\(\[kb\.id\]\)/);
  });

  it("does the move under the caller's own client", () => {
    // Which makes row-level security the permission check: a collection this
    // caller cannot read copies nothing, and the id is never handed to a store
    // on trust.
    expect(handler).toContain("requireSupabaseAuth");
    expect(handler).toContain("const { supabase } = context;");
    expect(handler).toMatch(/copyChunksToStore\(supabase,/);
    expect(handler).not.toContain("supabaseAdmin");
    // Read back first, so an id the caller cannot see stops here.
    expect(handler).toMatch(/\.maybeSingle\(\)[\s\S]{0,120}Knowledge base not found/);
  });

  it("records the move, because it is a change of where data lives", () => {
    expect(handler).toContain("auditEvent");
    expect(handler).toMatch(/action: "vector_store\.knowledge_base_changed"/);
    expect(handler).toMatch(/detail: \{ from: before, to: after, vectors: moved \}/);
  });
});

describe("the knowledge base page offers the choice", () => {
  const RAW = rd("src/routes/_authenticated/knowledge.tsx");
  const PAGE = RAW.replace(/\{\/\*[\s\S]*?\*\/\}/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");

  it("is a control bound to what is saved, not a dropdown shaped like a choice", () => {
    // FOUND FROM A QUESTION, TWICE. First: "I don't see it in RAG Settings" —
    // there was a "Vector Store Provider" dropdown with one option, bound to a
    // useState nothing read and nothing saved. It was removed. Then: "why not
    // provide option to the user so that they can select from UI" — so it is
    // back, and this time every part of the round trip is asserted.
    expect(PAGE).not.toContain("Vector Store Provider");
    expect(PAGE).toContain("<Label>Vector index</Label>");
    expect(PAGE).toMatch(/value=\{vectorStoreChoice\}/);
    expect(PAGE).toMatch(/setVectorStoreChoice\(v as VectorStoreChoice\)/);
    // read on open …
    expect(PAGE).toContain("setVectorStoreChoice(r.vectorStore);");
    // … and sent on save.
    expect(PAGE).toMatch(/vectorStore: vectorStoreChoice/);
    for (const choice of ["default", "pgvector", "qdrant"]) {
      expect(PAGE, choice).toContain(`<SelectItem value="${choice}">`);
    }
  });

  it("saves through the server, because the browser cannot move vectors", () => {
    expect(PAGE).toContain("saveKbRetrievalSettings");
    // The old direct update would have changed the setting and left the
    // vectors where they were.
    expect(PAGE).not.toMatch(/retrieval_settings: \{ mode: retrievalMode/);
  });

  it("says what saving will do before it is pressed", () => {
    expect(PAGE).toMatch(/vectorStoreChoice !== savedVectorStore/);
    expect(PAGE).toMatch(/moves this collection[\s\S]{0,60}existing vectors/);
    // And warns when the deployment cannot honour the choice at all, rather
    // than accepting it and falling back to pgvector in a server log.
    expect(PAGE).toMatch(/!storeBrief\.externalAvailable/);
    expect(PAGE).toContain("Qdrant is not configured on this deployment");
  });

  it("still tells a collection owner nothing an operator would not", () => {
    // The brief gained a field. It answers "can this deployment do it", not
    // "where is it and what is the key".
    const fns = rd("src/utils/vector/vector.functions.ts");
    const brief = fns.slice(
      fns.indexOf("export const vectorStoreBrief"),
      fns.indexOf("/**", fns.indexOf("export const vectorStoreBrief") + 10),
    );
    expect(brief).toContain("externalAvailable: externalStoreConfigured()");
    for (const leak of ["endpoint", "apiKey", "QDRANT_URL", "points", "info("]) {
      expect(brief, `the brief exposes ${leak}`).not.toContain(leak);
    }
  });
});
