// RAG depth: parent-child chunking, Q&A indexing, hybrid fusion.
//
// PURE module — no Supabase, no fetch. The indexing path and the retrieval path
// both depend on these rules agreeing, and they run in different processes at
// different times: chunks are written once at index time and read back weeks
// later. A disagreement between them does not throw, it just quietly retrieves
// the wrong text, so the rules live in one place that can be tested directly.

import { chunkText, type ChunkStrategy } from "@/lib/kbChunking";

/**
 * How a document is turned into embedded rows.
 *
 * - `flat` — one chunk list; the matched chunk is what the model sees. The
 *   original behaviour, and still the right default for short documents.
 * - `parent_child` — small children are embedded, the parent is what the model
 *   sees. Retrieval and generation want opposite chunk sizes; this stops one
 *   from being compromised for the other.
 * - `qa` — generated question/answer pairs, with the QUESTION embedded.
 */
export type ChunkMode = "flat" | "parent_child" | "qa";

export const CHUNK_MODES: ChunkMode[] = ["flat", "parent_child", "qa"];

export function isChunkMode(v: unknown): v is ChunkMode {
  return typeof v === "string" && (CHUNK_MODES as string[]).includes(v);
}

// ── Parent-child ─────────────────────────────────────────────────────────────

export type ParentChild = { parent: string; children: string[] };

export type ParentChildOptions = {
  strategy?: ChunkStrategy;
  /** Tokens per parent — what the model reads. */
  parentTokens?: number;
  /** Tokens per child — what gets embedded and matched. */
  childTokens?: number;
  /** Overlap between children, in tokens. */
  childOverlap?: number;
};

export const DEFAULT_PARENT_TOKENS = 1024;
export const DEFAULT_CHILD_TOKENS = 200;

/**
 * Split into parents, then split each parent into children.
 *
 * Children are cut from the parent text and never across it, which is the
 * invariant the whole feature rests on: expanding a matched child to its parent
 * has to yield a superset of what matched, or the citation shown to the user
 * would not contain the text that caused the match.
 */
export function chunkParentChild(raw: string, opts: ParentChildOptions = {}): ParentChild[] {
  const parentTokens = clampInt(opts.parentTokens ?? DEFAULT_PARENT_TOKENS, 128, 4096);
  // A child must be smaller than its parent, or "parent-child" is just "flat"
  // with extra rows. When callers ask for the impossible, halve the parent
  // rather than silently producing one child per parent.
  const childTokens = clampInt(
    Math.min(opts.childTokens ?? DEFAULT_CHILD_TOKENS, Math.floor(parentTokens / 2)),
    32,
    2048,
  );
  const strategy = opts.strategy ?? "recursive";

  // Parents are cut with no overlap: overlapping parents would send the model
  // the same sentences twice whenever two neighbouring children both matched.
  const parents = chunkText(raw, { strategy, chunkSize: parentTokens, chunkOverlap: 0 });

  return parents
    .map((parent) => ({
      parent,
      children: chunkText(parent, {
        strategy,
        chunkSize: childTokens,
        chunkOverlap: opts.childOverlap ?? Math.floor(childTokens / 8),
      }),
    }))
    .filter((pc) => pc.parent.trim().length > 0 && pc.children.length > 0);
}

// ── Q&A indexing ─────────────────────────────────────────────────────────────

export type QaPair = { question: string; answer: string };

const MAX_QUESTION_CHARS = 500;
const MAX_ANSWER_CHARS = 4000;

/**
 * Parse a model's Q&A output.
 *
 * Deliberately forgiving about SHAPE and strict about CONTENT: models wrap JSON
 * in prose or fences often enough that failing on it would make the feature
 * flaky, but a pair missing either half is useless — a question with no answer
 * embeds fine and then retrieves nothing worth reading.
 */
export function parseQaPairs(rawOutput: string): QaPair[] {
  const text = (rawOutput || "").trim();
  if (!text) return [];

  const candidates: unknown[] = [];
  const push = (v: unknown) => {
    if (Array.isArray(v)) candidates.push(...v);
    else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      // Models like to wrap the array in a key of their own choosing.
      for (const key of ["pairs", "qa", "qa_pairs", "questions", "items", "data"]) {
        if (Array.isArray(o[key])) candidates.push(...(o[key] as unknown[]));
      }
      if (candidates.length === 0 && ("question" in o || "q" in o)) candidates.push(o);
    }
  };

  try {
    push(JSON.parse(text));
  } catch {
    // Fall back to the widest JSON-looking span, for output with prose around
    // it ("Sure!\n```json\n[...]\n```\nHope that helps.").
    const starts = [text.indexOf("["), text.indexOf("{")].filter((i) => i >= 0);
    const end = Math.max(text.lastIndexOf("]"), text.lastIndexOf("}"));
    try {
      // Start at the first bracket. Defaulting it to 0 — which an earlier
      // version did — silently re-included the prose and turned every fenced
      // response into a parse failure.
      //
      // Text with no brackets at all needs no guard: Math.min() of nothing is
      // Infinity, the slice comes back empty, and the parse below throws into
      // the same catch that handles every other malformed response.
      push(JSON.parse(text.slice(Math.min(...starts), end + 1)));
    } catch {
      return [];
    }
  }

  const out: QaPair[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    if (!c || typeof c !== "object") continue;
    const o = c as Record<string, unknown>;
    const question = str(o.question ?? o.q);
    const answer = str(o.answer ?? o.a);
    if (!question || !answer) continue;
    const key = question.toLowerCase();
    // A duplicated question is two rows competing for the same match; the
    // second can only push a distinct pair out of the top-k.
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      question: question.slice(0, MAX_QUESTION_CHARS),
      answer: answer.slice(0, MAX_ANSWER_CHARS),
    });
  }
  return out;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

// ── Hybrid retrieval ─────────────────────────────────────────────────────────

export type RetrievalMode = "semantic" | "keyword" | "hybrid";

/**
 * Where THIS collection's nearest-neighbour search runs.
 *
 * `default` follows the instance's VECTOR_STORE, which is what every
 * collection did before this was a per-collection choice. The point of the
 * choice is that collections differ: one that has outgrown the database can
 * use Qdrant while the rest stay in Postgres, where the rows already are and
 * row-level security is the permission check.
 *
 * Postgres holds the chunk text, its permissions AND the embedding either
 * way; an external store holds a copy for searching. So this decides where a
 * query runs, never where the data lives.
 */
export type VectorStoreChoice = "default" | "pgvector" | "qdrant";

export const VECTOR_STORE_CHOICES: VectorStoreChoice[] = ["default", "pgvector", "qdrant"];

export type RetrievalSettings = {
  mode: RetrievalMode;
  /** Share of the fused score from vector similarity. 1 = pure semantic. */
  semanticWeight: number;
  /** Which index answers this collection's vector search. */
  vectorStore: VectorStoreChoice;
};

/**
 * A collection that never chose gets hybrid, weighted toward meaning.
 *
 * It was semantic-only, on the argument that an upgrade should change no
 * answers until someone opts in. Measured on a twelve-document evaluation
 * set (ADVERSARIAL_LOG R12), semantic-only lost the exact-term questions —
 * "Severity 1", "RTO", "HIPAA" — to boilerplate paragraphs that merely
 * resembled them, and the keyword pass rescued every one of those it was
 * allowed to run on. Changing no answers was the wrong thing to protect.
 */
export const DEFAULT_RETRIEVAL: RetrievalSettings = {
  mode: "hybrid",
  semanticWeight: 0.7,
  vectorStore: "default",
};

/**
 * Read per-KB settings from jsonb.
 *
 * NULL, {} and an unknown mode all resolve to DEFAULT_RETRIEVAL; a saved
 * `semantic` or `keyword` is honoured exactly.
 */
export function resolveRetrievalSettings(raw: unknown): RetrievalSettings {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_RETRIEVAL };
  const o = raw as Record<string, unknown>;
  const store = (VECTOR_STORE_CHOICES as string[]).includes(String(o.vector_store))
    ? (o.vector_store as VectorStoreChoice)
    : DEFAULT_RETRIEVAL.vectorStore;
  const mode: RetrievalMode =
    o.mode === "hybrid" || o.mode === "keyword" || o.mode === "semantic"
      ? o.mode
      : DEFAULT_RETRIEVAL.mode;
  const w = typeof o.semantic_weight === "number" ? o.semantic_weight : Number(o.semantic_weight);
  const semanticWeight = Number.isFinite(w) ? Math.min(1, Math.max(0, w)) : 0.7;
  // The weight only means anything in hybrid mode. Collapsing it here means
  // downstream code never has to ask "which field wins?" — a question two call
  // sites would eventually answer differently.
  if (mode === "semantic") return { mode, semanticWeight: 1, vectorStore: store };
  if (mode === "keyword") return { mode, semanticWeight: 0, vectorStore: store };
  return { mode, semanticWeight, vectorStore: store };
}

export type Candidate = {
  /** Chunk id — the fusion key. */
  id: string;
  score: number;
};

export type FusedCandidate = {
  id: string;
  score: number;
  /** Which retriever(s) found it — surfaced in traces so tuning is possible. */
  from: "vector" | "keyword" | "both";
};

/**
 * Weighted fusion of two ranked lists.
 *
 * Scores are normalised WITHIN each list before weighting, because cosine
 * similarity (~0.3–0.9) and ts_rank (~0.0–0.3) are not comparable numbers —
 * adding them raw would let the weight slider do almost nothing at one end of
 * its range and everything at the other.
 *
 * Normalisation is score/max, NOT min-max. Min-max was the first attempt and it
 * is wrong here: it maps the worst entry of every list to exactly 0, so with a
 * short candidate list the second-best vector hit — often a perfectly good
 * passage — scored zero and tied with keyword noise. Dividing by the max keeps
 * relative magnitude, so "0.9 and 0.6" stays a near-miss rather than becoming
 * "everything and nothing".
 *
 * The consequence worth knowing: each list's best result is 1.0 regardless of
 * how good it actually is, so a weak keyword hit leads a list of weak keyword
 * hits. The SQL side drops non-matches entirely, which is what bounds that.
 */
export function fuseHybrid(
  vector: Candidate[],
  keyword: Candidate[],
  settings: RetrievalSettings,
): FusedCandidate[] {
  const w = Math.min(1, Math.max(0, settings.semanticWeight));
  const v = normalise(vector);
  const k = normalise(keyword);

  const merged = new Map<string, FusedCandidate>();
  for (const [id, score] of v) {
    merged.set(id, { id, score: w * score, from: "vector" });
  }
  for (const [id, score] of k) {
    const existing = merged.get(id);
    if (existing) {
      existing.score += (1 - w) * score;
      existing.from = "both";
    } else {
      merged.set(id, { id, score: (1 - w) * score, from: "keyword" });
    }
  }

  return [...merged.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

/** Scale to 0..1 by the list maximum, preserving relative magnitude. */
function normalise(list: Candidate[]): Map<string, number> {
  const out = new Map<string, number>();
  if (list.length === 0) return out;
  const scores = list.map((c) => c.score).filter((s) => Number.isFinite(s));
  if (scores.length === 0) return out;
  const max = Math.max(...scores);
  for (const c of list) {
    if (!Number.isFinite(c.score)) continue;
    // Keep the LAST occurrence out: a duplicate id would otherwise be counted
    // twice against the same weight.
    if (out.has(c.id)) continue;
    // A non-positive maximum means nothing in this list matched at all;
    // contribute zero rather than promoting the least-bad entry to 1.
    out.set(c.id, max > 0 ? Math.max(0, c.score) / max : 0);
  }
  return out;
}

function clampInt(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, Math.floor(n)));
}

// ── What the model reads ─────────────────────────────────────────────────────
//
// Retrieval ranks CHUNKS; the prompt cites DOCUMENTS. Between the two sat a
// collapse that kept one chunk per document — the best-scoring one — and cut
// it to 560 characters. Measured on a policy corpus (ADVERSARIAL_LOG R12) that
// starved the model twice over: the chunk that held the answer (a table of
// response times) ranked BELOW a paragraph of the same document that merely
// talked about response times, so the collapse dropped it; and a chunk that
// did win was shown to the model with its second half missing. The model was
// honest — "the excerpt does not include the table" — and wrong for the user.
//
// So a citation now carries a document's best few chunks in reading order,
// each whole, and the turn as a whole has a character budget so a wide
// question cannot flood the prompt. All three are operator settings.

/** Best chunks of one document that a citation may carry. */
export const CHUNKS_PER_DOCUMENT = 3;
/** Characters of a flat chunk that reach the prompt. A default chunk is ~1,024 characters. */
export const CITATION_CHARS_PER_CHUNK = 1600;
/** Characters of grounding per turn across every citation — about 3,000 tokens. */
export const GROUNDING_MAX_CHARS = 12_000;

export type CitationPiece = {
  /** Groups pieces that are the same text — two children of one parent. */
  key: string;
  documentId: string;
  chunkIndex: number;
  text: string;
  /** A piece that is already a whole passage (a parent) keeps its own cap. */
  charsCap?: number;
};

export type AssembledCitation = { documentId: string; text: string; pieceKeys: string[] };

export type AssembleOptions = {
  chunksPerDocument?: number;
  charsPerChunk?: number;
  /** Documents to cite at most; a document outside the first N is skipped, its chunks with it. */
  maxDocuments?: number;
};

/**
 * From a ranked chunk list to one text per document.
 *
 * Documents come out in the order their best chunk ranked. Within a
 * document the pieces are in READING order, not score order — a table
 * followed by the paragraph that explains it reads as the author wrote it —
 * joined directly when adjacent and with an ellipsis when not. A piece
 * whose key was already taken (a parent both children matched) is not
 * repeated.
 */
export function assembleCitationTexts(
  ranked: { id: string }[],
  pieceOf: (id: string) => CitationPiece | undefined,
  opts: AssembleOptions = {},
): AssembledCitation[] {
  const perDoc = clampInt(opts.chunksPerDocument ?? CHUNKS_PER_DOCUMENT, 1, 10);
  const perChunk = clampInt(opts.charsPerChunk ?? CITATION_CHARS_PER_CHUNK, 100, 20_000);
  const maxDocs = clampInt(
    opts.maxDocuments ?? Number.MAX_SAFE_INTEGER,
    1,
    Number.MAX_SAFE_INTEGER,
  );
  const groups = new Map<string, CitationPiece[]>();
  for (const r of ranked) {
    const p = pieceOf(r.id);
    if (!p) continue;
    let g = groups.get(p.documentId);
    if (!g) {
      if (groups.size >= maxDocs) continue;
      g = [];
      groups.set(p.documentId, g);
    }
    if (g.length >= perDoc || g.some((x) => x.key === p.key)) continue;
    g.push(p);
  }
  const out: AssembledCitation[] = [];
  for (const [documentId, pieces] of groups) {
    const ordered = [...pieces].sort((a, b) => a.chunkIndex - b.chunkIndex);
    let text = "";
    let prev = "";
    for (let i = 0; i < ordered.length; i++) {
      const cap = clampInt(ordered[i].charsCap ?? perChunk, 100, 100_000);
      let t = ordered[i].text.replace(/\s+/g, " ").trim().slice(0, cap);
      if (i === 0) text = t;
      else if (ordered[i].chunkIndex - ordered[i - 1].chunkIndex === 1) {
        // Adjacent chunks were cut with an overlap so a sentence is never
        // lost at a boundary; read back to back, the overlap is the same
        // sentence twice. Drop it from the second chunk.
        t = t.slice(overlapLength(prev, t)).trimStart();
        text += " " + t;
      } else text += " … " + t;
      prev = t;
    }
    out.push({ documentId, text, pieceKeys: ordered.map((p) => p.key) });
  }
  return out;
}

/**
 * Characters at the start of `next` that repeat the end of `prev` — the
 * chunker's overlap, found as the longest suffix of one that is a prefix of
 * the other. Short matches are ignored: a shared word is not an overlap.
 */
export function overlapLength(prev: string, next: string, maxChars = 600, minChars = 24): number {
  const max = Math.min(maxChars, prev.length, next.length);
  for (let n = max; n >= minChars; n--) {
    if (prev.endsWith(next.slice(0, n))) return n;
  }
  return 0;
}

/**
 * Fit citations to the turn's budget, in rank order: a later citation is
 * shortened to what is left, and one that would get less than a paragraph
 * is dropped rather than shown as a stub — a 60-character fragment under a
 * document's name misleads more than it informs. Earlier citations are
 * never touched to make room for later ones.
 */
/**
 * Whether a turn's retrieval is worth grounding on at all.
 *
 * Retrieval runs on every turn of an agent with a collection attached —
 * "what is the weather in Frankfurt" included — and until now every turn
 * was grounded on whatever ranked first, five documents and ~2,400 prompt
 * tokens the model then had to ignore. Measured on the R12 collection with
 * text-embedding-3-small: every document question's best chunk scored
 * 0.38–0.75, every off-topic question's 0.10–0.32, and no off-topic question
 * had a keyword hit. So: below the floor with no keyword evidence, the
 * turn is not grounded and the model is told the search found nothing.
 * A keyword hit always passes — an exact term is evidence whatever the
 * vector thinks — and a floor of 0 disables the rule. Different embedding
 * models score differently; the default is set low for that reason.
 */
export const DEFAULT_MIN_SIMILARITY = 0.3;

export function groundingPasses(
  bestSimilarity: number | null,
  keywordHits: number,
  floor: number = DEFAULT_MIN_SIMILARITY,
): boolean {
  if (!(floor > 0)) return true;
  if (keywordHits > 0) return true;
  // No vector score at all (the store failed, or there were no chunks) is
  // not "unrelated" — it is unknown, and the keyword paths decide.
  if (bestSimilarity === null || !Number.isFinite(bestSimilarity)) return true;
  return bestSimilarity >= floor;
}

export function applyGroundingBudget<T extends { snippet: string }>(
  citations: T[],
  maxChars: number = GROUNDING_MAX_CHARS,
): T[] {
  const budget = clampInt(maxChars, 500, 1_000_000);
  const out: T[] = [];
  let used = 0;
  for (const c of citations) {
    const room = budget - used;
    if (room < 200) break;
    const snippet = c.snippet.length > room ? c.snippet.slice(0, room) : c.snippet;
    out.push(snippet === c.snippet ? c : { ...c, snippet });
    used += snippet.length;
  }
  return out;
}
