// Reading a whole table through an API that answers with a page.
//
// PostgREST caps every response at `db-max-rows` — 1,000 on a default Supabase
// project — and supabase-js returns the short page with no error and no flag. A
// read written as "select the column, no limit" is therefore a read of the
// first thousand rows, and the caller cannot tell.
//
// MEASURED, twice, in the knowledge base, where the truncated read was used to
// answer a MEMBERSHIP question — which is the worst thing to do with a prefix,
// because absence from it is indistinguishable from absence from the table:
//
//   src/utils/tools/kbEmbed.functions.ts — before embedding, the backfill asks
//   which of the (up to 50) documents already have chunks and skips those. With
//   more than 1,000 chunk rows across that batch — 50 documents of ~10 KB at the
//   default 500-character chunk size reach it — documents that ARE indexed fall
//   outside the page, are read as pending, and get embedded a second time: paid
//   API calls, and duplicate chunks that then over-weight those passages in
//   every later retrieval.
//
//   src/routes/_authenticated/knowledge.tsx — the same read builds the per
//   document chunk counts, so the same documents show an amber "Pending
//   embedding" badge while "N of M indexed" and "Embed X pending" count them as
//   missing.
//
// `lib/pagedSelect` is the offset-based sibling of this module, for reading
// every row a filter matches when the rows themselves are wanted. Reach for
// this one when the question is MEMBERSHIP — a cursor skips the rest of a key
// as soon as one row answers it — or when a caller must stop early without
// pretending it saw everything.
//
// The two helpers below page with a CURSOR rather than an offset, and neither
// uses a short page as proof of the end. That matters: `.range()` paging that
// stops at the first short page is wrong the moment the server's cap is smaller
// than the page size asked for, which is exactly the assumption that produced
// these bugs. A cursor loop is correct at any cap, because every round asks for
// rows strictly after the last one it saw.

/**
 * Which of `keys` have at least one row.
 *
 * `fetchPage` must return the key column of rows whose key is strictly greater
 * than `after`, ORDERED ASCENDING, at most `pageSize` of them. Ordering is what
 * makes the last element the high-water mark; without it the scan would skip
 * keys.
 *
 * Membership needs no more than one row per key, so each round jumps past the
 * whole of the key it just resolved — a document with 40,000 chunks costs one
 * page, not forty. At most one round per key, so the loop terminates even if
 * `fetchPage` ignores `after` entirely.
 */
export async function scanKeysPresent(
  keys: string[],
  fetchPage: (after: string | null, pageSize: number) => Promise<string[]>,
  opts: { pageSize?: number } = {},
): Promise<Set<string>> {
  const found = new Set<string>();
  if (keys.length === 0) return found;
  const pageSize = opts.pageSize ?? 1000;
  let after: string | null = null;
  for (let round = 0; round <= keys.length; round++) {
    const page = await fetchPage(after, pageSize);
    if (page.length === 0) break;
    for (const k of page) found.add(k);
    const last = page[page.length - 1];
    // A fetchPage that ignores `after` would otherwise return the same page
    // forever; the loop is already bounded, this just stops it early.
    if (last === after) break;
    after = last;
  }
  return found;
}

/** Rows in hand, and whether they are all of them. */
export type Scan<Row> = { rows: Row[]; complete: boolean };

/**
 * Every row, by cursor, up to a ceiling.
 *
 * `fetchPage` must return rows whose cursor value is strictly greater than
 * `after`, ordered ascending by a UNIQUE column — unique because this scan
 * keeps every row rather than one per key, so a tie spanning a page boundary
 * would drop the rest of the tie.
 *
 * `complete` is false only when the ceiling stopped the scan, and the caller is
 * then holding a prefix and has to say so.
 */
export async function scanRows<Row>(
  fetchPage: (after: string | null, pageSize: number) => Promise<Row[]>,
  cursorOf: (row: Row) => string,
  opts: { pageSize?: number; maxRows: number },
): Promise<Scan<Row>> {
  const pageSize = opts.pageSize ?? 1000;
  const rows: Row[] = [];
  let after: string | null = null;
  while (rows.length < opts.maxRows) {
    const page = await fetchPage(after, pageSize);
    if (page.length === 0) return { rows, complete: true };
    rows.push(...page);
    const last = cursorOf(page[page.length - 1]);
    if (last === after) return { rows, complete: true };
    after = last;
  }
  // The ceiling stopped the loop, which is not the same as the ceiling biting:
  // a table holding exactly maxRows rows would otherwise be reported as a
  // prefix of itself and put a caveat on a complete answer. One more row
  // settles it.
  const probe = await fetchPage(after, 1);
  return { rows, complete: probe.length === 0 };
}
