// Matching and ranking for search: one scorer for objects, pages and "new"
// actions, so the three lists in the palette are ordered by the same idea of
// "close" and the results page agrees with the palette.
//
// The rules, in the order they decide:
//   1. every word typed must be found — in the name, or failing that in the
//      description. A row that misses one word is not a result.
//   2. a name that IS the query beats a name that starts with it, which beats
//      words that start with it, which beats text found inside a word, which
//      beats a match in the description only. A WHOLE word beats the start of
//      a longer one: "sales" is closer to "Sales performance" than to
//      "Salesforce".
//   3. among equals, what was changed most recently comes first, then the
//      shorter name.
//
// Words split on anything that is not a letter or digit AND on camelCase, so
// "sales" finds `saas_sales`, `SalesByRegion` and "Q3 sales review" alike —
// the palette returned nothing for "sales" over a table named saas_sales
// because it compared the whole string.
import type { ObjectEntry, ObjectKindId } from "@/lib/objectKinds";

/** Lower-cased, accents removed, so "resume" finds "Résumé". */
export function foldText(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** The words of a name: split on separators and on camelCase boundaries. */
export function wordsOf(text: string): string[] {
  const spaced = text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  return foldText(spaced)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** The words typed. A query of only separators has none and matches nothing. */
export function queryTokens(query: string): string[] {
  return wordsOf(query);
}

const EXACT = 1000;
/** The name starts with the words typed, as whole words. */
const NAME_STARTS_WORDS = 850;
/** The name starts with what was typed, part-way through a word. */
const NAME_PREFIX = 800;
/** A word of the name is the word typed. */
const WORD_EXACT = 650;
const WORD_PREFIX = 600;
const INSIDE_WORD = 400;
const DETAIL_ONLY = 150;

/**
 * How well `query` matches a name and its description: 0 for no match, larger
 * for closer. The score is the WEAKEST word's tier — "sales forecast" over a
 * row that has "sales" in its name and "forecast" only in its description is a
 * description-grade match, not a name-grade one.
 */
export function scoreMatch(query: string, name: string, detail?: string): number {
  const tokens = queryTokens(query);
  if (!tokens.length) return 0;
  const foldedName = foldText(name);
  const q = tokens.join(" ");
  const nameWords = wordsOf(name);
  const joined = nameWords.join(" ");
  if (joined === q || foldedName.trim() === foldText(query).trim()) return EXACT;
  if (joined.startsWith(q)) {
    return joined[q.length] === " " ? NAME_STARTS_WORDS : NAME_PREFIX;
  }

  const detailFolded = detail ? foldText(detail) : "";
  let weakest = EXACT;
  for (const t of tokens) {
    let tier = 0;
    if (nameWords.includes(t)) tier = WORD_EXACT;
    else if (nameWords.some((w) => w.startsWith(t))) tier = WORD_PREFIX;
    else if (foldedName.includes(t)) tier = INSIDE_WORD;
    else if (detailFolded.includes(t)) tier = DETAIL_ONLY;
    if (!tier) return 0;
    weakest = Math.min(weakest, tier);
  }
  return weakest;
}

export type RankedObject = ObjectEntry & { score: number };

const time = (iso?: string | null) => {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
};

/** Best first: score, then most recently changed, then the shorter name. */
export function compareRanked(
  a: { score: number; updatedAt?: string | null; name: string },
  b: { score: number; updatedAt?: string | null; name: string },
): number {
  return (
    b.score - a.score ||
    time(b.updatedAt) - time(a.updatedAt) ||
    a.name.length - b.name.length ||
    a.name.localeCompare(b.name)
  );
}

/**
 * The entries that match, best first. With `kinds`, only those kinds. An empty
 * query matches nothing: "everything" is a list page's job, not search's.
 */
export function rankObjects(
  entries: readonly ObjectEntry[],
  query: string,
  opts: { kinds?: ReadonlySet<ObjectKindId>; limit?: number } = {},
): RankedObject[] {
  if (!queryTokens(query).length) return [];
  const out: RankedObject[] = [];
  for (const e of entries) {
    if (opts.kinds && !opts.kinds.has(e.kind)) continue;
    const score = scoreMatch(query, e.name, e.detail);
    if (score > 0) out.push({ ...e, score });
  }
  out.sort(compareRanked);
  return opts.limit ? out.slice(0, opts.limit) : out;
}

/** How many matches each kind has, for the filter chips. */
export function countByKind(ranked: readonly RankedObject[]): Map<ObjectKindId, number> {
  const out = new Map<ObjectKindId, number>();
  for (const r of ranked) out.set(r.kind, (out.get(r.kind) ?? 0) + 1);
  return out;
}

/**
 * The stretches of `text` to show as matched: the first place each typed word
 * is found. Returned as [start, end) pairs in order, never overlapping, so the
 * caller can slice the original text.
 */
export function matchRanges(query: string, text: string): Array<[number, number]> {
  const tokens = queryTokens(query);
  if (!tokens.length || !text) return [];
  // Folding can change a string's length (an accented letter becomes two code
  // units under NFD before the mark is dropped), so positions are only safe
  // when the folded text is as long as the original.
  const folded = foldText(text);
  if (folded.length !== text.length) return [];
  const found: Array<[number, number]> = [];
  for (const t of tokens) {
    const at = folded.indexOf(t);
    if (at >= 0) found.push([at, at + t.length]);
  }
  found.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const r of found) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return merged;
}

/** Join entries from several sources, keeping the first of each kind+id. */
export function mergeEntries(...lists: Array<readonly ObjectEntry[]>): ObjectEntry[] {
  const seen = new Set<string>();
  const out: ObjectEntry[] = [];
  for (const list of lists) {
    for (const e of list) {
      const key = `${e.kind}:${e.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(e);
    }
  }
  return out;
}
