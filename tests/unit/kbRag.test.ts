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
  chunkParentChild,
  fuseHybrid,
  parseQaPairs,
  resolveRetrievalSettings,
  DEFAULT_RETRIEVAL,
  isChunkMode,
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
  it("defaults to pure semantic, so upgrading changes no answers", () => {
    expect(resolveRetrievalSettings(null)).toEqual(DEFAULT_RETRIEVAL);
    expect(resolveRetrievalSettings(undefined).mode).toBe("semantic");
    expect(resolveRetrievalSettings({}).mode).toBe("semantic");
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
    expect(resolveRetrievalSettings({ mode: "magic" }).mode).toBe("semantic");
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

  it("runs keyword search whenever the mode is not semantic", () => {
    expect(KB).toMatch(/if \(retrieval\.mode !== "semantic"\) \{/);
    expect(KB).toMatch(/rpc\("keyword_kb_chunks"/);
  });

  it("uses the parent-aware vector RPC", () => {
    expect(KB).toMatch(/rpc\("match_kb_chunks_v2"/);
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
    expect(KNOWLEDGE).toMatch(/id === "openai_builtin" && builtinConfigured !== false/);
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
