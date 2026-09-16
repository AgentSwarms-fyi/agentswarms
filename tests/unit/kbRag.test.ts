// RAG depth: parent-child chunking, Q&A indexing, hybrid fusion.
//
// These three features fail QUIETLY when they are wrong — a bad fusion weight
// or a child that isn't inside its parent produces a plausible answer built on
// the wrong text, with no error anywhere. So the invariants are pinned here
// rather than left to a live spot-check.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyGroundingBudget,
  assembleCitationTexts,
  chunkParentChild,
  CHUNKS_PER_DOCUMENT,
  CITATION_CHARS_PER_CHUNK,
  DEFAULT_MIN_SIMILARITY,
  fuseHybrid,
  groundingPasses,
  GROUNDING_MAX_CHARS,
  parseQaPairs,
  resolveRetrievalSettings,
  DEFAULT_RETRIEVAL,
  isChunkMode,
  overlapLength,
  type CitationPiece,
} from "@/lib/kbRag";

// A document with real paragraph structure — chunkers behave differently on
// lorem-style filler with no punctuation, and that difference is the bug.
const DOC = [
  "API keys authenticate machine callers. Each key belongs to exactly one swarm and carries its own scopes.",
  "Rotating a key issues a replacement and records which key it superseded. The old key keeps working until you revoke it, so a rotation does not cause an outage.",
  "Revocation is immediate and cannot be undone. The next request made with a revoked key fails closed with a 401.",
  "Expiry is optional. A key with an expiry stops working at that moment without any action from you, which is the recommended setting for a key handed to a third party.",
].join("\n\n");

describe("chunkParentChild", () => {
  it("embeds children that are all contained in their parent", () => {
    // THE invariant. Expanding a match to its parent has to return a superset
    // of the text that matched, or the citation shown to the user would not
    // contain the words that caused it to be retrieved.
    const pcs = chunkParentChild(DOC, { parentTokens: 128, childTokens: 32 });
    expect(pcs.length).toBeGreaterThan(0);
    for (const { parent, children } of pcs) {
      expect(children.length).toBeGreaterThan(0);
      for (const child of children) {
        // Overlap prepends the previous child's tail, so compare on the
        // longest run of original words rather than the whole child string.
        const core = child.split(/\s+/).slice(-6).join(" ");
        expect(parent.replace(/\s+/g, " ")).toContain(core.replace(/\s+/g, " "));
      }
    }
  });

  it("produces children strictly smaller than the parent when the parent is long", () => {
    const pcs = chunkParentChild(DOC, { parentTokens: 256, childTokens: 32 });
    const multi = pcs.filter((p) => p.children.length > 1);
    expect(multi.length, "expected at least one parent to split").toBeGreaterThan(0);
    for (const { parent, children } of multi) {
      for (const c of children) expect(c.length).toBeLessThan(parent.length);
    }
  });

  it("refuses a child size that would equal the parent", () => {
    // Asking for 1024-token children inside 1024-token parents is asking for
    // flat chunking with extra tables. Halving the parent is the useful
    // interpretation; silently agreeing would waste a re-embed.
    const pcs = chunkParentChild(DOC, { parentTokens: 64, childTokens: 4096 });
    const anySplit = pcs.some(
      (p) => p.children.length > 1 || p.children[0].length < p.parent.length,
    );
    expect(anySplit).toBe(true);
  });

  it("covers the whole document — no text is dropped between parents", () => {
    // A chunker that loses a paragraph is undetectable at retrieval time: you
    // just never get that answer.
    const pcs = chunkParentChild(DOC, { parentTokens: 128, childTokens: 32 });
    const joined = pcs
      .map((p) => p.parent)
      .join(" ")
      .replace(/\s+/g, " ");
    for (const distinctive of ["superseded", "fails closed", "third party", "scopes"]) {
      expect(joined, `lost "${distinctive}"`).toContain(distinctive);
    }
  });

  it("does not overlap PARENTS, only children", () => {
    // Overlapping parents would send the model the same sentences twice
    // whenever two neighbouring children both matched — which is precisely
    // when parent-child retrieval is doing its job. Parents partition the
    // document; children overlap within a parent.
    const pcs = chunkParentChild(DOC, { parentTokens: 64, childTokens: 24, childOverlap: 16 });
    expect(pcs.length, "expected several parents").toBeGreaterThan(1);
    const total = pcs.reduce((n, p) => n + p.parent.length, 0);
    // A partition cannot exceed the source; the slack covers whitespace
    // normalisation at the split points.
    expect(total).toBeLessThanOrEqual(DOC.length + 40);
  });

  it("returns nothing for empty input rather than one empty parent", () => {
    expect(chunkParentChild("")).toEqual([]);
    expect(chunkParentChild("   \n\n  ")).toEqual([]);
  });
});

describe("parseQaPairs", () => {
  it("parses a plain JSON array", () => {
    const out = parseQaPairs(
      '[{"question":"How do I rotate a key?","answer":"Use the Deploy dialog."}]',
    );
    expect(out).toEqual([{ question: "How do I rotate a key?", answer: "Use the Deploy dialog." }]);
  });

  it("survives markdown fences and surrounding prose", () => {
    // Not hypothetical: models add both, and a parse failure here would show up
    // as "Q&A indexing produced nothing" with no other clue.
    const out = parseQaPairs(
      'Sure!\n```json\n[{"q":"What is a scope?","a":"A permission on a key."}]\n```\nHope that helps.',
    );
    expect(out).toHaveLength(1);
    expect(out[0].question).toBe("What is a scope?");
  });

  it("parses a bare fenced block with nothing around it", () => {
    // There was a dedicated fence-stripper here once. Mutation testing showed
    // breaking it changed no outcome: the bracket-span fallback below already
    // handles fences, so the stripper was removed. This test keeps the
    // BEHAVIOUR pinned regardless of which path provides it.
    const out = parseQaPairs('```json\n[{"question":"Q1","answer":"A1"}]\n```');
    expect(out).toEqual([{ question: "Q1", answer: "A1" }]);
  });

  it("accepts a wrapper object key", () => {
    expect(parseQaPairs('{"pairs":[{"question":"Q1","answer":"A1"}]}')).toHaveLength(1);
    expect(parseQaPairs('{"qa_pairs":[{"question":"Q1","answer":"A1"}]}')).toHaveLength(1);
  });

  it("drops pairs missing either half", () => {
    const out = parseQaPairs(
      '[{"question":"Only a question"},{"answer":"Only an answer"},{"question":"  ","answer":"x"},{"question":"Good","answer":"Fine"}]',
    );
    expect(out).toEqual([{ question: "Good", answer: "Fine" }]);
  });

  it("drops duplicate questions", () => {
    // Two rows with the same question compete for the same match, and the
    // loser can only displace a distinct pair from the top-k.
    const out = parseQaPairs(
      '[{"question":"Same","answer":"First"},{"question":"same","answer":"Second"}]',
    );
    expect(out).toHaveLength(1);
    expect(out[0].answer).toBe("First");
  });

  it("returns [] on unparseable output instead of throwing", () => {
    expect(parseQaPairs("I could not do that.")).toEqual([]);
    expect(parseQaPairs("")).toEqual([]);
    expect(parseQaPairs("{{{")).toEqual([]);
  });
});

describe("resolveRetrievalSettings", () => {
  it("defaults to hybrid leaning semantic — measured, not inherited (R12)", () => {
    expect(resolveRetrievalSettings(null)).toEqual(DEFAULT_RETRIEVAL);
    expect(DEFAULT_RETRIEVAL).toEqual({
      mode: "hybrid",
      semanticWeight: 0.7,
      // A collection follows the instance until someone picks an index for it.
      vectorStore: "default",
    });
    expect(resolveRetrievalSettings(undefined).mode).toBe("hybrid");
    expect(resolveRetrievalSettings({}).mode).toBe("hybrid");
    expect(resolveRetrievalSettings({}).semanticWeight).toBe(0.7);
    // A collection that chose semantic keeps it — the default is for the undecided.
    expect(resolveRetrievalSettings({ mode: "semantic" })).toEqual({
      mode: "semantic",
      semanticWeight: 1,
      vectorStore: "default",
    });
  });

  it("forces the weight to match the mode", () => {
    // Otherwise "semantic mode, weight 0.2" is a state two call sites would
    // resolve differently.
    expect(
      resolveRetrievalSettings({ mode: "semantic", semantic_weight: 0.2 }).semanticWeight,
    ).toBe(1);
    expect(resolveRetrievalSettings({ mode: "keyword", semantic_weight: 0.9 }).semanticWeight).toBe(
      0,
    );
  });

  it("keeps the weight in hybrid mode and clamps it to 0..1", () => {
    expect(resolveRetrievalSettings({ mode: "hybrid", semantic_weight: 0.3 }).semanticWeight).toBe(
      0.3,
    );
    expect(resolveRetrievalSettings({ mode: "hybrid", semantic_weight: 5 }).semanticWeight).toBe(1);
    expect(resolveRetrievalSettings({ mode: "hybrid", semantic_weight: -2 }).semanticWeight).toBe(
      0,
    );
    expect(
      resolveRetrievalSettings({ mode: "hybrid", semantic_weight: "nonsense" }).semanticWeight,
    ).toBe(0.7);
  });

  it("ignores an unknown mode rather than trusting it", () => {
    expect(resolveRetrievalSettings({ mode: "magic" }).mode).toBe("hybrid");
  });
});

describe("fuseHybrid", () => {
  const V = [
    { id: "v1", score: 0.9 },
    { id: "v2", score: 0.6 },
  ];
  const K = [
    { id: "k1", score: 0.3 },
    { id: "v2", score: 0.1 },
  ];

  it("returns vector order untouched at weight 1", () => {
    const out = fuseHybrid(V, K, { mode: "hybrid", semanticWeight: 1 });
    expect(out.map((c) => c.id).slice(0, 2)).toEqual(["v1", "v2"]);
    // A keyword-only hit contributes nothing at weight 1 but must still be
    // reachable — dropping it would make the slider a cliff instead of a dial.
    expect(out.find((c) => c.id === "k1")?.score).toBe(0);
  });

  it("puts the keyword winner on top at weight 0", () => {
    const out = fuseHybrid(V, K, { mode: "hybrid", semanticWeight: 0 });
    expect(out[0].id).toBe("k1");
  });

  it("actually moves results as the weight changes", () => {
    // The whole point of exposing a slider. If this ever stops being true the
    // control is decorative.
    const heavySemantic = fuseHybrid(V, K, { mode: "hybrid", semanticWeight: 0.9 })[0].id;
    const heavyKeyword = fuseHybrid(V, K, { mode: "hybrid", semanticWeight: 0.1 })[0].id;
    expect(heavySemantic).not.toBe(heavyKeyword);
  });

  it("rewards a chunk found by BOTH retrievers", () => {
    // v2 is second on both lists; agreement is the signal hybrid exists to use.
    const both = [{ id: "a", score: 0.5 }];
    const alsoBoth = [{ id: "a", score: 0.5 }];
    const onlyOne = fuseHybrid(both, [], { mode: "hybrid", semanticWeight: 0.5 })[0];
    const inBoth = fuseHybrid(both, alsoBoth, { mode: "hybrid", semanticWeight: 0.5 })[0];
    expect(inBoth.score).toBeGreaterThan(onlyOne.score);
    expect(inBoth.from).toBe("both");
  });

  it("normalises per list, so cosine and ts_rank scales cannot dominate", () => {
    // ts_rank lives around 0.01–0.3 while cosine sits near 0.8. Raw addition
    // would make a 0.5 weight behave like 0.95.
    const cosine = [{ id: "c", score: 0.82 }];
    const tsRank = [{ id: "t", score: 0.02 }];
    const out = fuseHybrid(cosine, tsRank, { mode: "hybrid", semanticWeight: 0.5 });
    expect(out[0].score).toBeCloseTo(out[1].score, 10);
  });

  it("labels where each result came from", () => {
    const out = fuseHybrid(V, K, { mode: "hybrid", semanticWeight: 0.5 });
    expect(out.find((c) => c.id === "v1")?.from).toBe("vector");
    expect(out.find((c) => c.id === "k1")?.from).toBe("keyword");
    expect(out.find((c) => c.id === "v2")?.from).toBe("both");
  });

  it("handles empty lists and non-finite scores without producing NaN", () => {
    expect(fuseHybrid([], [], DEFAULT_RETRIEVAL)).toEqual([]);
    const out = fuseHybrid(
      [
        { id: "a", score: Number.NaN },
        { id: "b", score: 0.5 },
      ],
      [],
      {
        mode: "hybrid",
        semanticWeight: 0.5,
      },
    );
    for (const c of out) expect(Number.isFinite(c.score)).toBe(true);
  });

  it("keeps the FIRST occurrence when an id repeats", () => {
    // A ranked list is ordered best-first, so a repeated id is a worse
    // duplicate and must not overwrite the better score. Asserting only the
    // LENGTH here proved nothing — a Map dedupes by key regardless, which is
    // why the original version of this test could not detect the guard being
    // removed at all.
    const dup = [
      { id: "a", score: 1 },
      { id: "a", score: 0.1 },
    ];
    const out = fuseHybrid(dup, [], { mode: "hybrid", semanticWeight: 1 });
    expect(out).toHaveLength(1);
    expect(out[0].score).toBe(1);
  });

  it("is deterministic when scores tie", () => {
    const a = fuseHybrid(
      [
        { id: "b", score: 1 },
        { id: "a", score: 1 },
      ],
      [],
      DEFAULT_RETRIEVAL,
    );
    const b = fuseHybrid(
      [
        { id: "a", score: 1 },
        { id: "b", score: 1 },
      ],
      [],
      DEFAULT_RETRIEVAL,
    );
    expect(a.map((c) => c.id)).toEqual(b.map((c) => c.id));
  });
});

describe("indexing wiring", () => {
  const EMB = readFileSync(resolve("src/utils/tools/embedding.server.ts"), "utf8");

  it("embeds _embedText, not content", () => {
    // The single line that makes Q&A mode mean anything: the vector has to
    // represent the QUESTION even though the row stores the answer. Embedding
    // `content` instead still produces a working index — just one that answers
    // questions no better than flat chunking, with the extra cost of having
    // called a model per passage.
    expect(EMB).toMatch(/const inputs = indices\.map\(\(i\) => rows\[i\]\._embedText\)/);
  });

  it("embeds the CHILD in parent-child mode", () => {
    // Embedding the parent instead would give back exactly flat chunking with
    // an extra table, and nothing would error.
    expect(EMB).toMatch(/for \(const child of pc\.children\) pushRow\(child, child, slot,/);
  });

  it("writes parents before children so parent_id can be real", () => {
    const parentsIdx = EMB.indexOf("kb_chunk_parents insert failed");
    const chunksIdx = EMB.indexOf('onConflict: "document_id,chunk_index"');
    expect(parentsIdx).toBeGreaterThan(-1);
    expect(chunksIdx).toBeGreaterThan(-1);
    expect(parentsIdx, "parents must be inserted before chunks").toBeLessThan(chunksIdx);
  });

  it("reports Q&A failures instead of falling back to flat chunks", () => {
    // Silently downgrading would leave a knowledge base that disagrees with the
    // mode shown in its own settings dialog.
    expect(EMB).toMatch(/warnings\.push\(/);
    expect(EMB).toMatch(/if \(!res\.ok\) \{/);
  });
});

describe("retrieval wiring", () => {
  const KB = readFileSync(resolve("src/utils/tools/kb.server.ts"), "utf8");

  it("gives parent text its own, larger budget", () => {
    // trimSnippet caps at 560 chars. Reusing it for a 4,000-character parent
    // would trim away 86% of the context and deliver flat chunking under a
    // different name — with no error and no visible symptom.
    expect(KB).toMatch(/PARENT_SNIPPET_MAX/);
    expect(KB).toMatch(
      /parent_content\.replace\([^)]*\)\.trim\(\)\.slice\(0, PARENT_SNIPPET_MAX\)/,
    );
  });

  it("runs keyword search whenever the mode is not semantic — or the vectors failed", () => {
    // `effective`, not `retrieval`: the collection's own mode decides
    // normally, and a vector search that could not answer forces the keyword
    // pass on so an unreachable store degrades retrieval rather than emptying
    // it. See the fallback tests in vectorStore.test.ts.
    expect(KB).toMatch(/if \(effective\.mode !== "semantic"\) \{/);
    expect(KB).toMatch(/vectorSearchFailed\s*\n?\s*\?/);
    expect(KB).toMatch(/rpc\("keyword_kb_chunks"/);
  });

  it("searches for ids and fetches the parent-aware rows separately", () => {
    // These were one RPC, `match_kb_chunks_v2`, until the vectors were allowed
    // to live outside this database — at which point the search and the fetch
    // happen in two different systems and no single function can do both. The
    // parent join did not go anywhere; it moved into kb_chunks_by_ids.
    expect(KB).toMatch(/storeFor\(kind, sb\)\.search\(/);
    expect(KB).toMatch(/rpc\("kb_chunks_by_ids"/);
  });

  it("applies the knowledge base's own retrieval settings", () => {
    expect(KB).toMatch(/resolveRetrievalSettings\(row\.retrieval_settings\)/);
    expect(KB).toMatch(/if \(r\.semanticWeight < retrieval\.semanticWeight\) retrieval = r;/);
  });

  it("over-fetches when something will re-rank the list", () => {
    // Fusion can only promote what it was given, so a top-k fetch would leave
    // the keyword side nothing to rescue.
    expect(KB).toMatch(
      /reranker \|\| retrieval\.mode !== "semantic" \? Math\.min\(topK \* 3, 30\)/,
    );
  });
});

describe("embedding provider catalogue", () => {
  const KNOWLEDGE = readFileSync(resolve("src/routes/_authenticated/knowledge.tsx"), "utf8");
  const TARGET = readFileSync(resolve("src/utils/tools/embedTarget.server.ts"), "utf8");

  it("advertises only OpenRouter models that were probed against the live endpoint", () => {
    // Two nvidia/* embedding models were listed here and BOTH returned 404
    // "No endpoints found" — selecting one produced a failed embed with no
    // hint that the model never existed. OpenRouter does not list embedding
    // models in its /models catalogue, so a plausible id is not evidence.
    const block = KNOWLEDGE.slice(
      KNOWLEDGE.indexOf("const OPENROUTER_EMBED_MODELS"),
      KNOWLEDGE.indexOf("const EMBED_PROVIDERS"),
    );
    expect(block).toContain("openai/text-embedding-3-small");
    expect(block).not.toContain("nvidia/");
    // bge-m3 exists but returns 1024 dimensions and would fail the pgvector
    // column, which is a different kind of wrong from "does not exist".
    expect(block).not.toContain("bge-m3");
  });

  it("leads with the model that shares the built-in key's vector space", () => {
    // Moving a collection between the built-in OpenAI key and OpenRouter must
    // not invalidate chunks that are already embedded.
    const block = KNOWLEDGE.slice(KNOWLEDGE.indexOf("const OPENROUTER_EMBED_MODELS"));
    const first = block.slice(0, block.indexOf("]"));
    expect(first.split('"')[1]).toBe("openai/text-embedding-3-small");
  });

  it("keeps the UI's default preference in step with the server's", () => {
    // If these disagreed, the dialog would name one provider while ingest used
    // another, and the per-document stamp would be the only evidence.
    expect(TARGET).toMatch(/export const DEFAULT_EMBED_PROVIDER = "openrouter"/);
    expect(KNOWLEDGE).toMatch(/p\.id === DEFAULT_EMBED_PROVIDER/);
  });

  it("treats an operator-key provider as usable", () => {
    // connectedProviders only tracks per-user integrations, so without this the
    // dialog fell back to OpenAI on an instance whose server was already
    // resolving embeddings through OpenRouter — and then warned that the
    // provider it had just defaulted to was "not connected".
    expect(KNOWLEDGE).toMatch(/id === "openrouter" && openrouterAvailable === true/);
  });

  it("offers no operator-OpenAI-key option at all", () => {
    // Embeddings come from a connected model provider, the same place the chat
    // models do. A self-hosted install should not need an OpenAI account to
    // search its own documents, so the "Built-in (operator OpenAI key)" entry
    // is gone rather than merely deprioritised — and nothing in the dialog
    // still branches on whether that key is configured.
    expect(KNOWLEDGE).not.toContain("openai_builtin");
    expect(KNOWLEDGE).not.toContain("builtinConfigured");
    expect(KNOWLEDGE).not.toContain("OPENAI_API_KEY");
  });

  it("asks 'is this provider usable' in exactly one place", () => {
    // Three call sites used to answer this question independently, which is how
    // the dialog contradicted itself. The model filter, the provider list and
    // the warning must all go through the same rule.
    const defs = KNOWLEDGE.match(/const providerUsable = /g) ?? [];
    expect(defs.length, "providerUsable should be defined once").toBe(1);
    // Three call sites: the model filter, the provider list, and the
    // "not connected" warning. The definition itself reads `= useCallback(`,
    // so it does not count here.
    const uses = KNOWLEDGE.match(/providerUsable\(/g) ?? [];
    expect(uses.length, "expected all three call sites to use it").toBeGreaterThanOrEqual(3);
  });
});

describe("schema", () => {
  const SQL = readFileSync(resolve("supabase/migrations/20260815000000_rag_depth.sql"), "utf8");

  it("indexes the question alongside the content for full-text search", () => {
    // In Q&A mode the answer often does not contain the asking words at all. A
    // keyword search that cannot find a pair by its question would make hybrid
    // retrieval actively WORSE than semantic in that mode.
    expect(SQL).toMatch(/to_tsvector\('english', coalesce\(question, ''\) \|\| ' ' \|\| content\)/);
  });

  it("mirrors the kb_chunks sharing policy onto parents", () => {
    // A reader who can see children but not their parents is silently degraded
    // to child-only context rather than shown an error.
    expect(SQL).toMatch(/Shared KB chunk parents are readable/);
    expect(SQL).toMatch(
      /has_resource_access\('knowledge_base', knowledge_base_id, auth\.uid\(\)\)/,
    );
  });

  it("defaults existing chunks to 'text' so old rows keep working", () => {
    expect(SQL).toMatch(/chunk_kind text NOT NULL DEFAULT 'text'/);
  });
});

describe("isChunkMode", () => {
  it("accepts the three real modes and rejects anything else", () => {
    expect(isChunkMode("flat")).toBe(true);
    expect(isChunkMode("parent_child")).toBe(true);
    expect(isChunkMode("qa")).toBe(true);
    expect(isChunkMode("parent-child")).toBe(false);
    expect(isChunkMode(null)).toBe(false);
  });
});

// ── What the model reads ─────────────────────────────────────────────────────
//
// R12: one chunk per document, cut to 560 characters, is why "what is the Gold
// Severity 1 response time" was answered "the excerpt does not include the
// table" against a document whose chunk 0 IS the table. These pin the
// replacement: several chunks per document in reading order, whole, budgeted.

describe("assembleCitationTexts — one citation carries a document's best chunks", () => {
  const piece = (
    id: string,
    doc: string,
    idx: number,
    text: string,
    extra: Partial<CitationPiece> = {},
  ) =>
    [id, { key: id, documentId: doc, chunkIndex: idx, text, ...extra } as CitationPiece] as const;
  const pieces = new Map<string, CitationPiece>([
    piece("p4", "sla", 4, "prose about response times"),
    piece("p0", "sla", 0, "| Severity 1 | 30 minutes |"),
    piece("p2", "sla", 2, "exclusions"),
    piece("p7", "sla", 7, "more prose"),
    piece("f1", "faq", 1, "partners resell"),
    piece("g0", "glossary", 0, "MDR — Meridian Drain Request"),
  ]);
  const of = (id: string) => pieces.get(id);
  const ranked = ["p4", "f1", "p0", "p2", "p7", "g0"].map((id) => ({ id }));

  it("keeps the best few chunks of a document, in reading order, joined by adjacency", () => {
    const out = assembleCitationTexts(ranked, of, { chunksPerDocument: 3 });
    // Documents in the order their best chunk ranked; the table (chunk 0)
    // ranked third overall but is inside the SLA citation and comes first
    // in it, because reading order is the author's order.
    expect(out.map((c) => c.documentId)).toEqual(["sla", "faq", "glossary"]);
    expect(out[0].pieceKeys).toEqual(["p0", "p2", "p4"]);
    expect(out[0].text).toBe(
      "| Severity 1 | 30 minutes | … exclusions … prose about response times",
    );
    // Chunk 7 was the fourth of the document and is left out.
    expect(out[0].text).not.toContain("more prose");
  });

  it("drops the chunker's overlap when adjacent chunks are read back to back", () => {
    // Chunks are cut with ~160 characters of overlap so no sentence is lost at
    // a boundary. Joined, that is the same sentence twice — seen live as
    // "## Do not affic forwarding across the whole fabric … ## Do not Never".
    const tail = "Recovery point objective: not applicable, the fabric carries no state. ";
    const adj = new Map<string, CitationPiece>([
      piece("a", "d", 0, "RTO: 20 minutes. " + tail),
      piece("b", "d", 1, tail + "Never restart the controller during a partition."),
    ]);
    const out = assembleCitationTexts([{ id: "a" }, { id: "b" }], (id) => adj.get(id));
    expect(out[0].text).toBe(
      "RTO: 20 minutes. Recovery point objective: not applicable, the fabric carries no state. Never restart the controller during a partition.",
    );
    // A shared short word is not an overlap — through the assembly, where a
    // wrong trim would eat the second chunk's first word.
    const word = new Map<string, CitationPiece>([
      piece("a", "d", 0, "A restart drops the drain state of every node"),
      piece("b", "d", 1, "node re-admission takes sixty seconds"),
    ]);
    expect(assembleCitationTexts([{ id: "a" }, { id: "b" }], (id) => word.get(id))[0].text).toBe(
      "A restart drops the drain state of every node node re-admission takes sixty seconds",
    );
    expect(overlapLength("ends with the", "the start")).toBe(0);
    expect(
      overlapLength(
        "x".repeat(50) + "SHARED SENTENCE OF SOME LENGTH",
        "SHARED SENTENCE OF SOME LENGTH" + "y".repeat(50),
      ),
    ).toBe(30);
  });

  it("joins adjacent chunks with a space and non-adjacent ones with an ellipsis", () => {
    const adj = new Map<string, CitationPiece>([
      piece("a", "d", 3, "three"),
      piece("b", "d", 4, "four"),
      piece("c", "d", 9, "nine"),
    ]);
    const out = assembleCitationTexts([{ id: "c" }, { id: "a" }, { id: "b" }], (id) => adj.get(id));
    expect(out[0].text).toBe("three four … nine");
  });

  it("one chunk per document is the old behaviour, and still available", () => {
    const out = assembleCitationTexts(ranked, of, { chunksPerDocument: 1 });
    expect(out[0].pieceKeys).toEqual(["p4"]);
  });

  it("caps each piece at charsPerChunk unless the piece carries its own cap", () => {
    const long = new Map<string, CitationPiece>([
      piece("x", "d", 0, "x".repeat(5000)),
      piece("y", "e", 0, "y".repeat(5000), { charsCap: 4000 }),
    ]);
    const out = assembleCitationTexts([{ id: "x" }, { id: "y" }], (id) => long.get(id), {
      charsPerChunk: 1600,
    });
    expect(out[0].text).toHaveLength(1600);
    expect(out[1].text).toHaveLength(4000);
  });

  it("does not repeat a parent two children matched", () => {
    const shared = new Map<string, CitationPiece>([
      ["c1", { key: "parent-1", documentId: "d", chunkIndex: 0, text: "the parent" }],
      ["c2", { key: "parent-1", documentId: "d", chunkIndex: 1, text: "the parent" }],
    ]);
    const out = assembleCitationTexts([{ id: "c1" }, { id: "c2" }], (id) => shared.get(id));
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe("the parent");
    expect(out[0].pieceKeys).toEqual(["parent-1"]);
  });

  it("cites at most maxDocuments, but still collects later chunks of the documents it kept", () => {
    const out = assembleCitationTexts(ranked, of, { maxDocuments: 1 });
    expect(out.map((c) => c.documentId)).toEqual(["sla"]);
    expect(out[0].pieceKeys).toEqual(["p0", "p2", "p4"]);
  });

  it("skips ids the resolver does not know and squashes whitespace", () => {
    const out = assembleCitationTexts([{ id: "nope" }, { id: "g0" }], (id) =>
      id === "g0"
        ? { key: "g0", documentId: "g", chunkIndex: 0, text: "  MDR\n\n  drain  " }
        : undefined,
    );
    expect(out).toEqual([{ documentId: "g", text: "MDR drain", pieceKeys: ["g0"] }]);
  });

  it("the defaults are the documented ones", () => {
    expect(CHUNKS_PER_DOCUMENT).toBe(3);
    expect(CITATION_CHARS_PER_CHUNK).toBe(1600);
    expect(GROUNDING_MAX_CHARS).toBe(12_000);
  });
});

describe("applyGroundingBudget — the turn's ceiling, applied in rank order", () => {
  const cit = (i: number, n: number) => ({ index: i, snippet: String(i).repeat(n) });

  it("leaves citations that fit alone, the same objects", () => {
    const cs = [cit(1, 100), cit(2, 100)];
    const out = applyGroundingBudget(cs, 1000);
    expect(out[0]).toBe(cs[0]);
    expect(out[1]).toBe(cs[1]);
  });

  it("shortens the citation that crosses the budget and drops the ones after it", () => {
    const out = applyGroundingBudget([cit(1, 600), cit(2, 600), cit(3, 600)], 1000);
    expect(out.map((c) => c.snippet.length)).toEqual([600, 400]);
  });

  it("never shows a stub: less than a paragraph of room ends the list", () => {
    const out = applyGroundingBudget([cit(1, 900), cit(2, 600)], 1000);
    expect(out).toHaveLength(1);
  });

  it("never trims an earlier citation to make room for a later one", () => {
    const out = applyGroundingBudget([cit(1, 3000), cit(2, 10)], 1000);
    expect(out.map((c) => c.snippet.length)).toEqual([1000]);
  });

  it("uses the documented default and a floor that keeps at least one citation", () => {
    expect(applyGroundingBudget([cit(1, 20_000)])[0].snippet).toHaveLength(GROUNDING_MAX_CHARS);
    expect(applyGroundingBudget([cit(1, 20_000)], 5)[0].snippet).toHaveLength(500);
  });
});

describe("retrieval wiring — what the model reads", () => {
  const KB = readFileSync(resolve("src/utils/tools/kb.server.ts"), "utf8");

  it("builds citations with assembleCitationTexts, not a one-chunk collapse", () => {
    expect(KB).toContain("assembleCitationTexts(");
    expect(KB).not.toMatch(/seenDocs/);
    // The fused list is what is assembled, and a parent keeps its own cap.
    expect(KB).toMatch(/assembleCitationTexts\(\s*fused,/);
    expect(KB).toContain("charsCap: row.parent_content ? PARENT_SNIPPET_MAX : undefined");
  });

  it("a flat chunk reaches the prompt whole — the 560-character cap is gone", () => {
    expect(KB).not.toMatch(/SNIPPET_MAX = 560/);
    expect(KB).toMatch(/slice\(0, citationCharsPerChunk\(\)\)/);
  });

  it("applies the turn budget on both return paths, after reranking", () => {
    expect(KB).toContain("if (ranked) return applyGroundingBudget(ranked, groundingMaxChars());");
    expect(KB).toMatch(/return applyGroundingBudget\(\s*merged\.slice\(0, topK\)/);
  });

  it("the three settings are environment knobs with the library defaults", () => {
    for (const [name, fallback] of [
      ["KB_CHUNKS_PER_DOCUMENT", "CHUNKS_PER_DOCUMENT"],
      ["KB_CITATION_CHARS_PER_CHUNK", "CITATION_CHARS_PER_CHUNK"],
      ["KB_GROUNDING_MAX_CHARS", "GROUNDING_MAX_CHARS"],
    ]) {
      expect(KB).toMatch(new RegExp(`envInt\\("${name}", ${fallback},`));
      expect(readFileSync(resolve(".env.example"), "utf8")).toContain(name);
    }
  });
});

describe("groundingPasses — a turn is grounded only on something that resembles it", () => {
  // R12: document questions' best chunk 0.38–0.75, off-topic 0.10–0.32, no
  // keyword hit on any off-topic question. The floor sits under the lowest
  // document question with room for a different embedding model.
  it("passes at or above the floor and fails below it", () => {
    expect(groundingPasses(0.383, 0)).toBe(true);
    expect(groundingPasses(0.3, 0)).toBe(true);
    expect(groundingPasses(0.299, 0)).toBe(false);
    expect(groundingPasses(0.104, 0)).toBe(false);
  });

  it("a keyword hit always passes — an exact term is evidence whatever the vector says", () => {
    expect(groundingPasses(0.1, 1)).toBe(true);
  });

  it("no vector score is unknown, not unrelated", () => {
    expect(groundingPasses(null, 0)).toBe(true);
    expect(groundingPasses(Number.NaN, 0)).toBe(true);
  });

  it("a floor of 0 (or below) disables the rule", () => {
    expect(groundingPasses(0.01, 0, 0)).toBe(true);
    expect(groundingPasses(0.01, 0, -1)).toBe(true);
    // Cosine similarity can be negative; off means off for those too.
    expect(groundingPasses(-0.2, 0, 0)).toBe(true);
  });

  it("the default is the documented one", () => {
    expect(DEFAULT_MIN_SIMILARITY).toBe(0.3);
  });
});

describe("the floor applies to auto-RAG and never to the kb_search tool", () => {
  const KB = readFileSync(resolve("src/utils/tools/kb.server.ts"), "utf8");
  const CHAT = readFileSync(resolve("src/routes/api/chat.ts"), "utf8");
  const EMBED = readFileSync(resolve("src/routes/api/embed.chat.ts"), "utf8");
  const REG = readFileSync(resolve("src/utils/tools/registry.server.ts"), "utf8");

  it("the retrieval gates the fused citations by groundingPasses with the caller's floor", () => {
    expect(KB).toMatch(
      /groundingPasses\(\s*bestSimilarity,\s*keywordRows\.length,\s*opts\.minSimilarity \?\? 0,?\s*\)/,
    );
    expect(KB).toContain("fusedCits = (grounded ? assembled : []).map(");
    expect(KB).toContain("process.env.KB_MIN_SIMILARITY");
  });

  it("both chat routes pass the operator's floor; the tool passes none", () => {
    expect(CHAT).toContain("minSimilarity: autoRagMinSimilarity(),");
    expect(EMBED).toContain("minSimilarity: autoRagMinSimilarity(),");
    const at = REG.indexOf("const cits = await retrieveCitationsServer({");
    const toolCall = REG.slice(at, REG.indexOf("});", at));
    expect(toolCall).not.toContain("minSimilarity");
    expect(readFileSync(resolve(".env.example"), "utf8")).toContain("KB_MIN_SIMILARITY");
  });
});
