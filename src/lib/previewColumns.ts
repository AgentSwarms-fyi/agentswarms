// Which columns a stream preview shows first (R528).

/** Field names that say what a record is, in the order a person reads them. */
const TELLING = [
  "id",
  "number",
  "key",
  "name",
  "title",
  "subject",
  "tag_name",
  "email",
  "status",
  "state",
  "type",
  "amount",
  "total",
  "value",
  "currency",
  "created_at",
  "updated_at",
  "published_at",
  "date",
];

/**
 * The preview's columns, the telling ones first (found from the UI): an API
 * record often starts with its links and its nested author, and the first six
 * columns of a release were URLs, then author fields, before its tag or date.
 * Well-known names come first, links last, everything else in its own order.
 */
export function previewColumns(p: {
  columns: string[];
  rows: Record<string, string | number | boolean | null>[];
}): string[] {
  const isLink = (c: string) =>
    /(^|_)url$/i.test(c) ||
    p.rows.some((r) => typeof r[c] === "string" && /^https?:\/\//.test(r[c] as string));
  const rank = (c: string) => {
    const i = TELLING.indexOf(c.toLowerCase());
    return i >= 0 ? i : isLink(c) ? TELLING.length + 2 : TELLING.length + 1;
  };
  // Stable: equal ranks keep the record's own order.
  return p.columns
    .map((c, i) => ({ c, i, r: rank(c) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.c);
}
