// Turning a document REQUEST into usable web research.
//
// Two things went wrong between "the user asked for live OCI pricing" and "the
// planner had a rate to quote", and neither was the search provider's fault.
//
// 1. The whole instruction was used as the search query. Searching for
//    "Web-search the current Oracle Cloud (OCI) pricing for AMD E5 compute
//    instances, then build a bill of quantities for an example on-prem to OCI
//    sizing exercise: line items with quantity…" returned a YouTube video and a
//    GPU-pricing blog. The same search for just the subject returned Oracle's
//    own E5/E6 announcement — the page that actually carries the per-OCPU rate.
//
// 2. What did get fetched was truncated from the FRONT. A scraped page was cut
//    to 3500 characters, then again to 2000 in the planner prompt, and the
//    first 2000 characters of a vendor page are navigation, cookie text and an
//    intro paragraph. The pricing table is always further down. Measured: the
//    Oracle blog post reached the planner containing no currency figure at all,
//    while the same page read in full states the OCPU-hour and GB-hour rates.
//
// Both fixes are deterministic, so they can be tested without a network.

/** Words that carry no search signal — dropped when scoring an excerpt. */
const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "for",
  "with",
  "from",
  "into",
  "then",
  "that",
  "this",
  "those",
  "these",
  "of",
  "to",
  "in",
  "on",
  "at",
  "by",
  "as",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "it",
  "its",
  "their",
  "build",
  "create",
  "make",
  "write",
  "produce",
  "generate",
  "give",
  "show",
  "list",
  "plus",
  "also",
  "example",
  "current",
  "please",
  "using",
  "use",
  "need",
  "want",
  "should",
  "would",
  "could",
  "about",
]);

/** Leading imperatives that describe the ACTION, not the subject. */
const LEAD_IMPERATIVE =
  /^\s*(?:please\s+)?(?:can\s+you\s+)?(?:web[-\s]?search(?:\s+for)?|search(?:\s+the\s+web)?(?:\s+for)?|look\s*up|google|find(?:\s+me)?|research|browse|check)\b[\s:,-]*/i;

/** Where the request stops describing the subject and starts listing deliverables. */
const DELIVERABLE_BOUNDARY =
  /[,;]?\s*\b(?:then|and\s+then|after\s+that|next|afterwards)\b|\s*[:;]\s|\s+\band\s+(?:build|create|make|produce|generate|write|prepare|draft)\b/i;

/**
 * Derive a search query from a document request.
 *
 * Keeps the SUBJECT and drops the instruction scaffolding, because a search
 * engine matches on topic, not on what you intend to do with the answer.
 * Falls back to a trimmed prompt whenever stripping would leave too little to
 * search for — a mediocre query beats an empty one.
 */
export function searchQueryFromPrompt(prompt: string, maxChars = 160): string {
  const raw = (prompt || "").trim();
  if (!raw) return "";
  let q = raw.replace(LEAD_IMPERATIVE, "");
  const boundary = q.search(DELIVERABLE_BOUNDARY);
  if (boundary > 0) q = q.slice(0, boundary);
  q = q
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.,;:—-]+$/, "");
  // Too aggressive — fall back rather than search for a fragment.
  if (q.length < 12) return raw.slice(0, maxChars);
  return q.slice(0, maxChars);
}

/** Terms worth scoring an excerpt against. */
function keywords(query: string): string[] {
  return Array.from(
    new Set(
      (query.toLowerCase().match(/[a-z0-9][a-z0-9.$-]{1,}/g) ?? []).filter(
        (w) => w.length > 2 && !STOPWORDS.has(w),
      ),
    ),
  );
}

// A price, a rate, a percentage — the shapes a costing document needs. Scored
// separately from keywords so a pricing table outranks a paragraph that merely
// mentions the product name many times.
const FIGURE = /\$\s?\d|\d+(?:\.\d+)?\s*(?:%|per\s|\/\s?(?:hour|hr|month|mo|gb|ocpu|vcpu))/gi;

/**
 * Pick the passage of `text` most likely to contain what was asked for, rather
 * than simply taking the first `maxChars`.
 *
 * Vendor pages put navigation and marketing first and the numbers last, so a
 * head-truncated excerpt reliably omits the one thing a priced document needs.
 */
export function relevantExcerpt(text: string, query: string, maxChars: number): string {
  const body = (text || "").trim();
  if (body.length <= maxChars) return body;

  const terms = keywords(query);
  const step = Math.max(250, Math.floor(maxChars / 4));
  let bestStart = 0;
  let bestScore = -1;

  for (let start = 0; start < body.length; start += step) {
    const window = body.slice(start, start + maxChars).toLowerCase();
    let score = 0;
    for (const t of terms) {
      // Count occurrences without a per-term regex compile.
      let idx = window.indexOf(t);
      while (idx !== -1) {
        score += 2;
        idx = window.indexOf(t, idx + t.length);
      }
    }
    score += (window.match(FIGURE) ?? []).length * 3;
    if (score > bestScore) {
      bestScore = score;
      bestStart = start;
    }
    if (start + maxChars >= body.length) break;
  }

  // Nothing scored — the head is as good a guess as any.
  if (bestScore <= 0) return body.slice(0, maxChars);

  // Snap to a whitespace boundary so the excerpt doesn't open mid-word.
  let from = bestStart;
  if (from > 0) {
    const space = body.indexOf(" ", from);
    if (space !== -1 && space - from < 80) from = space + 1;
  }
  const cut = body.slice(from, from + maxChars);
  return (from > 0 ? "…" : "") + cut.trim() + (from + maxChars < body.length ? "…" : "");
}
