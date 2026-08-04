// Deciding when a chat question asks for MORE THAN ONE visual.
//
// Splitting costs an extra LLM call and N extra analyst runs, so it must only
// happen when the user actually asked for it. A question like "revenue by
// region" stays exactly as fast as before; "show me 3 charts of sales" fans out.
//
// Pure module (no imports) so the cue rules are unit-testable.

/** Ceiling on visuals per answer — each one is a full plan → SQL → execute run. */
export const MAX_CHAT_VISUALS = 4;

// Only words that name a definite quantity. "Several" and "a few" are vague —
// treating them as an exact 3 would tell the splitter to produce EXACTLY three
// questions when the user expressed no such number. They still trigger a split
// via wantsMultipleVisuals; they just don't pin the count.
const NUMBER_WORDS: Record<string, number> = {
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  couple: 2,
};

const VISUAL_NOUN = "(?:charts?|graphs?|visuals?|visualisations?|visualizations?|plots?|figures?)";

/**
 * An explicit count, when the user named one: "3 charts", "two graphs",
 * "a couple of visuals". Returns null when no count was given.
 */
export function requestedVisualCount(question: string): number | null {
  const m = new RegExp(
    `\\b(\\d{1,2}|${Object.keys(NUMBER_WORDS).join("|")})\\b(?:\\s+\\w+){0,2}?\\s+${VISUAL_NOUN}\\b`,
    "i",
  ).exec(question);
  if (!m) return null;
  const raw = m[1].toLowerCase();
  const n = /^\d+$/.test(raw) ? parseInt(raw, 10) : NUMBER_WORDS[raw];
  if (!n || n < 2) return null;
  return Math.min(n, MAX_CHAT_VISUALS);
}

/**
 * Whether the question asks for several visuals.
 *
 * Deliberately narrow: an explicit count, an explicit quantifier
 * ("multiple charts"), or a bare plural noun ("show me charts for …"). A
 * question that merely mentions two subjects ("revenue and margin") does NOT
 * qualify — that is usually one chart with two series, and treating it as two
 * questions would split a comparison the user wanted together.
 */
export function wantsMultipleVisuals(question: string): boolean {
  if (requestedVisualCount(question) !== null) return true;
  const quantified = new RegExp(
    `\\b(?:multiple|several|various|different|separate|some|a\\s+few|couple\\s+of)\\s+(?:\\w+\\s+){0,2}?${VISUAL_NOUN}\\b`,
    "i",
  );
  if (quantified.test(question)) return true;
  // Bare plural: "charts", "graphs" — but not the singular "chart".
  if (
    new RegExp(
      `\\b(?:charts|graphs|visuals|visualisations|visualizations|plots|figures)\\b`,
      "i",
    ).test(question)
  ) {
    return true;
  }
  // "one chart on X and another for Y" — singular throughout, but plainly two
  // visuals. Missing this was worse than not splitting at all: the analyst
  // tried to answer both in one turn and emitted two SQL statements and an
  // ARRAY of chart specs, which renders as a single empty frame.
  // Requires BOTH a visual noun and an "and one more" marker, so "a chart of
  // revenue and cost" (one chart, two series) still does not qualify.
  const additional =
    /\b(?:and\s+another|another\s+(?:one|for|on|showing)|a\s+second|second\s+(?:one|chart|graph|visual|plot)|as\s+well\s+as|plus\s+(?:a|an|one)\b|separately|also\s+(?:show|give|plot|chart))\b/i;
  return new RegExp(`\\b${VISUAL_NOUN}\\b`, "i").test(question) && additional.test(question);
}

/**
 * Whether the question only makes sense with the conversation in front of it.
 *
 * The BI analyst is stateless: it gets ONE question string and the dataset
 * schemas. A follow-up like "show me this as a bar chart" therefore names no
 * dataset, no dimension and no measure, so the planner cannot write SQL for it,
 * the turn produces nothing, and Visual BI silently falls through to the plain
 * agent — which then answers with prose telling the user to go and build the
 * chart by hand on /data-sql. The data was right there; only the referent was
 * missing.
 *
 * Two ways in, because the failure has two shapes:
 *  - a referring expression ("this", "that result", "the query above")
 *  - a bare restyle request ("as a bar chart", "make it a pie") that carries a
 *    visual noun but no subject at all
 *
 * A false positive costs one small LLM call and returns the question unchanged;
 * a false negative costs the whole visual. Erring wide is the cheaper mistake.
 */
export function needsConversationContext(question: string): boolean {
  const q = question.trim();
  if (!q) return false;
  // "this", "that", "it", "those", "the above", "the previous query", "same".
  const referring =
    /\b(?:this|that|these|those|it|them|the\s+(?:above|previous|last|first|former|latter)|above|earlier|same)\b/i;
  if (referring.test(q)) return true;
  // A visual noun with no subject: "as a bar chart", "show me a pie chart".
  // A question naming its own subject ("sales by region as a bar chart") has
  // more than the restyle verb, so require the whole question to be short.
  const bareRestyle =
    /^(?:now\s+|and\s+|ok\s+|please\s+)*(?:show|give|make|draw|plot|render|display|turn|convert)?\s*(?:me|it)?\s*(?:as|into|in|using|with|to)?\s*(?:a|an|the)?\s*\w*\s*(?:chart|graph|plot|visual|visualisation|visualization)\b/i;
  return bareRestyle.test(q) && q.split(/\s+/).length <= 10;
}

/** Clamp and de-duplicate the sub-questions a split produced. */
export function normalizeSubQuestions(raw: unknown, limit: number): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const q of raw) {
    if (typeof q !== "string") continue;
    const t = q.trim();
    if (t.length < 3) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= limit) break;
  }
  return out;
}
