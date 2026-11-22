// Finding the handbook section that answers a question.
//
// The assistant answers "how do I…" from what the handbook says, and links
// the section it used so the reader can check it. This ranks sections by the
// question's words: a word in the section's heading counts for more than one
// in its text, a rare word for more than a common one (BM25), and the whole
// question appearing as written counts most. Pure, so it is tested without
// a server; the sections themselves are generated from the docs pages
// (scripts/build-docs-text.mjs).

export type DocsSection = {
  route: string;
  page: string;
  id: string;
  heading: string;
  text: string;
};

export type DocsHit = {
  /** "/docs/bi#dashboard-schedule" */
  link: string;
  /** "BI Workspace › Sending a dashboard on a schedule" */
  title: string;
  /** The part of the section that matched, cut at word boundaries. */
  excerpt: string;
  score: number;
};

// Words that say nothing about which section answers a question.
const STOP = new Set(
  (
    "a an and are as at be by can could do does for from has have how i in is it its " +
    "me my of on or our should so that the their them then there these this to was we " +
    "what when where which who why will with would you your about into can't cannot " +
    "want need get make use using set up way show tell please"
  ).split(" "),
);

/**
 * A word in the form the index keeps: lower case, a plural, tense or "-ly"
 * trimmed, then a final "e" dropped, so share, shared, shares and sharing are
 * one word ("shar"), as are schedule and scheduling, week and weekly.
 */
export function stem(word: string): string {
  let w = word.toLowerCase();
  if (w.length > 4 && w.endsWith("ies")) w = w.slice(0, -3) + "y";
  else if (w.length > 5 && w.endsWith("ing")) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith("ed")) w = w.slice(0, -2);
  else if (w.length > 5 && w.endsWith("ly")) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith("es") && /(ch|sh|x|ss)es$/.test(w)) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
  if (w.length > 3 && w.endsWith("e")) w = w.slice(0, -1);
  return w;
}

/** The words of a text that can tell sections apart. */
export function docWords(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9_]+/g) ?? [])
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map(stem);
}

type Indexed = {
  section: DocsSection;
  tf: Map<string, number>;
  heading: Set<string>;
  page: Set<string>;
  length: number;
  lower: string;
};

export type DocsIndex = {
  docs: Indexed[];
  df: Map<string, number>;
  avgLength: number;
};

/**
 * `about` maps a page's route to its one-sentence description. A section
 * often never names what its page is about ("Sharing, export and embedding"
 * on the BI page never says "dashboard"); the page's title and description
 * say it for every section under them, at half weight.
 */
export function buildDocsIndex(
  sections: readonly DocsSection[],
  about: Readonly<Record<string, string>> = {},
): DocsIndex {
  const docs: Indexed[] = [];
  const df = new Map<string, number>();
  let total = 0;
  for (const s of sections) {
    const words = docWords(`${s.heading} ${s.text}`);
    const tf = new Map<string, number>();
    for (const w of words) tf.set(w, (tf.get(w) ?? 0) + 1);
    for (const w of tf.keys()) df.set(w, (df.get(w) ?? 0) + 1);
    total += words.length;
    docs.push({
      section: s,
      tf,
      heading: new Set(docWords(s.heading)),
      page: new Set(docWords(`${s.page} ${about[s.route] ?? ""}`)),
      length: words.length,
      lower: `${s.heading} ${s.text}`.toLowerCase(),
    });
  }
  return { docs, df, avgLength: docs.length ? total / docs.length : 0 };
}

const K1 = 1.2;
const B = 0.75;

/**
 * The part of `text` around the first run of the question's words: the
 * reader sees why the section was chosen, and the model gets the sentences
 * that matter rather than the section's first lines.
 */
export function excerptOf(text: string, words: readonly string[], max = 700): string {
  if (text.length <= max) return text;
  const lower = text.toLowerCase();
  let at = -1;
  for (const w of words) {
    const re = new RegExp(`\\b${w.replace(/[^a-z0-9_]/g, "")}`);
    const m = re.exec(lower);
    if (m && (at < 0 || m.index < at)) at = m.index;
  }
  if (at < 0) at = 0;
  // Start at the sentence the first word is in, so the excerpt reads.
  const sentence = lower.lastIndexOf(". ", at);
  let start = sentence >= 0 && at - sentence < max / 2 ? sentence + 2 : Math.max(0, at - 120);
  if (start + max > text.length) start = Math.max(0, text.length - max);
  let out = text.slice(start, start + max);
  // Drop a word only when the cut fell inside it.
  if (start > 0) out = "… " + (/\s/.test(text[start - 1]) ? out : out.replace(/^\S*\s/, ""));
  if (start + max < text.length) out = out.replace(/\s\S*$/, "") + " …";
  return out;
}

/**
 * The words people ask with, and the words the handbook uses for the same
 * thing. A question says "email it every week" or "a colleague"; the handbook
 * says "sending on a schedule" and "sharing". Related words count for half.
 */
const RELATED_WORDS: Record<string, string[]> = {
  email: ["send", "schedule"],
  mail: ["email", "send"],
  week: ["schedule"],
  daily: ["schedule"],
  month: ["schedule"],
  every: ["schedule"],
  recurring: ["schedule"],
  colleague: ["share", "grant"],
  teammate: ["share", "grant"],
  someone: ["share"],
  restore: ["trash", "undo"],
  undelete: ["trash", "restore"],
  recover: ["trash", "restore"],
  deleted: ["trash"],
  connect: ["connection", "source"],
  database: ["warehouse", "connection"],
  permission: ["access", "grant", "role"],
  see: ["access", "share"],
  visible: ["access", "share"],
  allowed: ["access", "role"],
};

const RELATED = new Map(
  Object.entries(RELATED_WORDS).map(([k, vs]) => [stem(k), vs.map(stem)] as const),
);

/** A question's words, each with the handbook's words for the same thing. */
export function questionTerms(query: string): Array<{ words: string[] }> {
  return [...new Set(docWords(query))].map((w) => ({
    words: [w, ...(RELATED.get(w) ?? []).filter((r) => r !== w)],
  }));
}

/** The sections that answer `query` best, best first. */
export function searchDocs(index: DocsIndex, query: string, limit = 5): DocsHit[] {
  const terms = questionTerms(query);
  if (!terms.length) return [];
  const words = terms.flatMap((t) => t.words);
  const n = index.docs.length;
  const phrase = query.trim().toLowerCase();
  const scored: Array<{ d: Indexed; score: number; link: string }> = [];
  for (const d of index.docs) {
    let score = 0;
    let matched = 0;
    for (const term of terms) {
      let hit = false;
      term.words.forEach((w, i) => {
        const df = index.df.get(w) ?? 0;
        if (!df) return;
        // The asker's own word counts in full; a related word for half.
        const weight = i === 0 ? 1 : 0.5;
        const idf = weight * Math.log(1 + (n - df + 0.5) / (df + 0.5));
        const tf = d.tf.get(w) ?? 0;
        if (tf) {
          hit = true;
          score +=
            idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * d.length) / (index.avgLength || 1))));
        }
        if (d.heading.has(w)) score += 1.5 * idf;
        // A page's opening is headed by the page's own title, so counting the
        // title again would put every page's opening above the section that
        // answers the question ("Tab 3 — Knowledge" under "Knowledge Base").
        if (d.section.id && d.page.has(w)) score += 0.5 * idf;
      });
      if (hit) matched++;
    }
    if (!matched) continue;
    // A question whose words all appear beats one that matched a single rare
    // word many times.
    score *= 0.5 + (0.5 * matched) / terms.length;
    if (phrase.length > 6 && d.lower.includes(phrase)) score *= 1.5;
    scored.push({ d, score, link: linkOf(d.section) });
  }
  scored.sort((a, b) => b.score - a.score || a.link.localeCompare(b.link));
  // The best section is quoted at length, since it is usually the answer and
  // steps cut off mid-way make a vague one. The rest say what they are about.
  return scored.slice(0, limit).map(({ d, score, link }, rank) => {
    const s = d.section;
    return {
      link,
      title: s.id && s.heading !== s.page ? `${s.page} › ${s.heading}` : s.page,
      excerpt: excerptOf(s.text, words, rank === 0 ? FIRST_EXCERPT : OTHER_EXCERPT),
      score,
    };
  });
}

/** How much of the best section is quoted, and of each other one. */
export const FIRST_EXCERPT = 1400;
export const OTHER_EXCERPT = 450;

const linkOf = (s: DocsSection) => (s.id ? `${s.route}#${s.id}` : s.route);
