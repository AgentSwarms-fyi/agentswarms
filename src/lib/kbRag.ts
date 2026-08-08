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

export type RetrievalSettings = {
  mode: RetrievalMode;
  /** Share of the fused score from vector similarity. 1 = pure semantic. */
  semanticWeight: number;
};

export const DEFAULT_RETRIEVAL: RetrievalSettings = { mode: "semantic", semanticWeight: 1 };

/**
 * Read per-KB settings from jsonb.
 *
 * Defaults to pure semantic, which is what the product did before hybrid
 * existed — so an un-migrated KB behaves exactly as it did yesterday rather
 * than silently changing its answers on upgrade.
 */
export function resolveRetrievalSettings(raw: unknown): RetrievalSettings {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_RETRIEVAL };
  const o = raw as Record<string, unknown>;
  const mode: RetrievalMode =
    o.mode === "hybrid" || o.mode === "keyword" || o.mode === "semantic"
      ? o.mode
      : DEFAULT_RETRIEVAL.mode;
  const w = typeof o.semantic_weight === "number" ? o.semantic_weight : Number(o.semantic_weight);
  const semanticWeight = Number.isFinite(w) ? Math.min(1, Math.max(0, w)) : 0.7;
  // The weight only means anything in hybrid mode. Collapsing it here means
  // downstream code never has to ask "which field wins?" — a question two call
  // sites would eventually answer differently.
  if (mode === "semantic") return { mode, semanticWeight: 1 };
  if (mode === "keyword") return { mode, semanticWeight: 0 };
  return { mode, semanticWeight };
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
