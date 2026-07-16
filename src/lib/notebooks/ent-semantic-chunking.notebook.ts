import type { Notebook } from "./types";

export const entSemanticChunkingNotebook: Notebook = {
  id: "ent-semantic-chunking",
  title: "Semantic Chunking Evaluator",
  description:
    "Naive character-based chunking butchers ideas mid-sentence. This notebook chunks text by detecting semantic shifts — embedding each sentence, measuring cosine distance to its neighbour, and cutting at the distance peaks. Visual side-by-side comparison with naive chunking.",
  difficulty: "advanced",
  tags: ["langchain", "agent"],
  requires: ["lovable-ai"],
  cells: [
    {
      id: "intro", kind: "markdown",
      source: `# Semantic Chunking

\`\`\`
Sentences:  s1  s2  s3  s4  s5  s6  s7  s8
Distances:    d1  d2  d3  d4  d5  d6  d7
                    ↑           ↑
                  peak        peak
                    │           │
              cut here     cut here
\`\`\`

The standard RAG pipeline chops text every N characters. That's fast and stupid — it splits sentences, breaks paragraphs mid-thought, and produces chunks that embed poorly.

**Semantic chunking** does the opposite:
1. Split into sentences.
2. Embed each sentence.
3. Measure cosine distance between adjacent sentence embeddings.
4. Cut where the distance **spikes** — those spikes are where the topic actually changes.

You end up with chunks that respect ideas, not character counts. RAG retrieval gets noticeably better.`,
    },

    { id: "md-1", kind: "markdown", source: `## 1 · Load the corpus from the Knowledge Base\n\nWe pull a short essay with three obvious topic shifts (Roman aqueducts → photosynthesis → jazz) from the read-only **Sample · Notebook RAG Lab** KB. Same store the production \`kb_search\` tool reads from. Swap the document ID for any KB doc you own to chunk your own content.` },
    {
      id: "corpus", kind: "code", language: "js", runtime: "browser",
      source: `// 👇 Any KB document ID works here — sample or your own.
const DOCUMENT_ID = ctx.kb.DOCS.threeTopics;

const doc = await ctx.kb.getDocument(DOCUMENT_ID);
const TEXT = doc.content;

const sentences = TEXT.split(/(?<=[.!?])\\s+/).map((s) => s.trim()).filter(Boolean);
ctx.state.sentences = sentences;
ctx.state.text = TEXT;
ctx.log("loaded", doc.name, "(" + TEXT.length + " chars,", sentences.length, "sentences)");
return { source: doc.name, total_sentences: sentences.length, preview: sentences.slice(0, 3) };
`,
    },

    { id: "md-2", kind: "markdown", source: `## 2 · Embed every sentence\n\nWe call the Lovable AI Gateway with the default embedding model. Each sentence becomes a vector — the dimensionality doesn't matter for distance comparisons, only that we use the same model for everything.` },
    {
      id: "embed", kind: "code", language: "js", runtime: "browser",
      source: `const { OpenAIEmbeddings } = ctx.lc.openai;

const embedder = new OpenAIEmbeddings({
  model: "openai/text-embedding-3-small",
  apiKey: ctx.aiApiKey,
  configuration: { baseURL: ctx.aiBaseURL, dangerouslyAllowBrowser: true },
});

const vectors = await embedder.embedDocuments(ctx.state.sentences);
ctx.state.vectors = vectors;
ctx.log("embedded " + vectors.length + " sentences → " + vectors[0].length + "-dim vectors");
return { count: vectors.length, dims: vectors[0].length };
`,
    },

    { id: "md-3", kind: "markdown", source: `## 3 · Cosine distance between adjacent sentences\n\nDistance close to 0 = same topic. Distance climbing means we're drifting. The peaks are where the author changed subject — exactly where we want to cut.` },
    {
      id: "distances", kind: "code", language: "js", runtime: "browser",
      source: `function cosineDist(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return 1 - dot / (Math.sqrt(na) * Math.sqrt(nb));
}

const vs = ctx.state.vectors;
const distances = [];
for (let i = 0; i < vs.length - 1; i++) distances.push(cosineDist(vs[i], vs[i + 1]));

ctx.state.distances = distances;

// Render the distance series as a tiny ASCII bar chart so the peaks pop out.
const maxD = Math.max(...distances);
ctx.log("sentence-to-next-sentence cosine distance:");
distances.forEach((d, i) => {
  const bar = "█".repeat(Math.round((d / maxD) * 40));
  ctx.log(("s" + (i + 1) + "→s" + (i + 2)).padEnd(8) + " " + d.toFixed(3) + "  " + bar);
});

return { distances: distances.map((d) => +d.toFixed(4)) };
`,
    },

    { id: "md-4", kind: "markdown", source: `## 4 · Find the breakpoints\n\nA common heuristic: cut where the distance exceeds the **95th percentile** of all distances. Tunable — lower threshold = more chunks, higher threshold = fewer, larger chunks.` },
    {
      id: "breakpoints", kind: "code", language: "js", runtime: "browser",
      source: `// 👇 Tune me — try 0.75 (lots of cuts) or 0.99 (almost none)
const PERCENTILE = 0.90;

const sorted = [...ctx.state.distances].sort((a, b) => a - b);
const threshold = sorted[Math.floor(PERCENTILE * sorted.length)];

const cuts = [];
ctx.state.distances.forEach((d, i) => { if (d >= threshold) cuts.push(i + 1); }); // cut AFTER sentence i

const chunks = [];
let start = 0;
for (const c of [...cuts, ctx.state.sentences.length]) {
  chunks.push(ctx.state.sentences.slice(start, c).join(" "));
  start = c;
}

ctx.state.semanticChunks = chunks;
ctx.log("threshold (P" + Math.round(PERCENTILE * 100) + ") = " + threshold.toFixed(3));
ctx.log("cuts after sentences: " + cuts.join(", "));
ctx.log("produced " + chunks.length + " semantic chunks");

return { threshold, cuts, chunks };
`,
    },

    { id: "md-5", kind: "markdown", source: `## 5 · Side-by-side with naive character chunking\n\nA naive 400-character splitter on the same text. Notice it shreds sentences mid-phrase and merges unrelated topics — the chunks are technically the right size but semantically incoherent.` },
    {
      id: "compare", kind: "code", language: "js", runtime: "browser",
      source: `const CHUNK_SIZE = 400;
const naive = [];
for (let i = 0; i < ctx.state.text.length; i += CHUNK_SIZE) {
  naive.push(ctx.state.text.slice(i, i + CHUNK_SIZE).replace(/\\s+/g, " ").trim());
}

const colours = ["📘", "📗", "📙", "📕", "📓"]; // visual chunk markers in the log
ctx.log("=== NAIVE (every " + CHUNK_SIZE + " chars) ===");
naive.forEach((c, i) => ctx.log(colours[i % colours.length] + " chunk " + (i + 1) + " [" + c.length + " chars]: " + c.slice(0, 120) + "…"));

ctx.log("");
ctx.log("=== SEMANTIC (cut at distance peaks) ===");
ctx.state.semanticChunks.forEach((c, i) => ctx.log(colours[i % colours.length] + " chunk " + (i + 1) + " [" + c.length + " chars]: " + c.slice(0, 120) + "…"));

return {
  naive_chunks: naive.length,
  semantic_chunks: ctx.state.semanticChunks.length,
  naive_sizes: naive.map((c) => c.length),
  semantic_sizes: ctx.state.semanticChunks.map((c) => c.length),
};
`,
    },

    { id: "md-6", kind: "markdown", source: `**Things to try:**\n\n- Replace \`TEXT\` with one of your own documents — a privacy policy, a research paper section, a chat transcript. Documents with frequent topic shifts show the biggest gap between naive and semantic.\n- Add **rolling-window** smoothing in cell 3: average each distance with its neighbours before thresholding. Removes false peaks from single odd sentences.\n- Combine semantic chunks with a size cap: if a semantic chunk is larger than 1500 chars, fall back to character splitting **inside** that chunk. That's the production pattern — semantic where possible, hard cap where not.` },
  ],
};
