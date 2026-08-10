// A settings panel that steers nothing must say so.
//
// The Retrieval tab offers search mode, a semantic/keyword slider, parent
// expansion and Q&A pairs. Every one of them steers vector search, keyword
// search over chunks, or the fusion between the two — and all three read
// kb_chunks. A collection with no chunks answers from a different code path
// entirely: a substring scan over whole documents that consults none of them.
//
// Measured against this instance, not inferred:
//
//   kb_chunks rows across all 17 shipped sample collections ....... 0
//   "AgentSwarms — How-To Guide": 19 documents ............... 0 chunks
//
//   same question, semanticWeight 1.0 vs 0.0 → byte-identical citations
//     03_How_to_Create_a_Knowledge_Base.md
//     04_How_to_Upload_CSV_and_Query_with_SQL_Agents.md
//     01_Getting_Started_Overview.md
//     …
//
// So on a fresh install the panel is decoration on every collection the
// product ships. The samples arrive un-embedded on purpose — indexing costs
// embedding calls — which makes it a disclosure problem, not a pipeline bug.
//
// The old readout made it worse: "Indexed 0/19 documents" beside an empty grey
// progress bar is the same shape as a loading state, and this campaign has
// already been fooled once by exactly that (a dashboard greeting mid-load).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const page = readFileSync(resolve("src/routes/_authenticated/knowledge.tsx"), "utf8");
const server = readFileSync(resolve("src/utils/tools/kb.server.ts"), "utf8");

/** The Retrieval tab of the RAG Settings dialog. */
function retrievalTab(): string {
  const i = page.indexOf('<TabsContent value="retrieval"');
  expect(i, "the retrieval tab moved; this test needs re-anchoring").toBeGreaterThan(0);
  return page.slice(i, page.indexOf("</TabsContent>", i));
}

describe("an unindexed collection says its retrieval settings are inert", () => {
  it("computes coverage from chunk counts, not from document count", () => {
    // Documents exist; chunks are what retrieval needs. Counting the wrong
    // one would report a fully-indexed collection that has never been embedded.
    expect(page).toMatch(/const indexCoverage = useMemo\(/);
    expect(page).toMatch(/chunkCounts\.get\(d\.id\) \?\? 0\) > 0/);
  });

  it("shows the disclosure only when there are documents and none are indexed", () => {
    const tab = retrievalTab();
    expect(tab).toMatch(/indexCoverage\.total > 0 && indexCoverage\.indexed === 0/);
  });

  it("states plainly that the settings are not in effect", () => {
    expect(retrievalTab()).toMatch(/not in\s+effect/);
  });

  it("offers the way out rather than just naming the problem", () => {
    // This first said "Back-fill embeddings on the Embedding tab" — directions
    // to a control two tabs away, which was itself hidden on every sample
    // collection. The warning now carries the button, so assert the control,
    // not the sentence that pointed at it.
    expect(retrievalTab()).toContain("{indexButton}");
  });

  it("does not fire once something is indexed", () => {
    // A partially-indexed collection DOES honour the settings for the chunks
    // it has, so an unconditional banner would be a new false statement.
    const tab = retrievalTab();
    expect(tab).not.toMatch(/indexCoverage\.indexed >= 0/);
    expect(tab).not.toMatch(/indexCoverage\.total > 0 &&\s*\(/);
  });
});

describe("the coverage readout does not look like a loading state at zero", () => {
  it("says keyword-only instead of 'Indexed 0/N'", () => {
    expect(page).toMatch(/keyword search only/);
    expect(page).toMatch(/const none = indexed === 0/);
  });

  it("keeps the plain count once indexing has started", () => {
    expect(page).toMatch(/Indexed \$\{indexed\}\/\$\{total\} documents/);
  });
});

describe("the premise still holds — settings really do only steer chunks", () => {
  // If retrieval ever starts honouring these settings on unembedded documents,
  // the disclosure becomes the false statement and must go. Anchor on the
  // fallback so that change surfaces here.
  it("the unembedded-document fallback scores by substring count", () => {
    const i = server.indexOf("// 3) Keyword fallback over docs");
    expect(i, "the fallback moved; re-check whether the disclosure is still true").toBeGreaterThan(
      0,
    );
    const block = server.slice(i, server.indexOf("// 4)", i));
    expect(block).toContain("lower.indexOf(term, from)");
    // …and never consults the retrieval settings while doing it.
    expect(block).not.toMatch(/retrieval\.(mode|semanticWeight)/);
  });

  it("fusion, vector search and chunk-keyword search all read chunks", () => {
    expect(server).toMatch(/rpc\("match_kb_chunks_v2"/);
    expect(server).toMatch(/rpc\("keyword_kb_chunks"/);
    expect(server).toMatch(/fuseHybrid\(vectorScores, keywordScores, retrieval\)/);
  });
});
