// Read every row a filter matches, not the first page of them.
//
// PostgREST caps a single response at `db-max-rows`. On the hosted project that
// ceiling is 1000, and it is a CEILING, not a default: measured against this
// instance, `.limit(5000)` and `.range(0, 2499)` each come back with exactly
// 1000 rows. Asking for more is not an error and nothing in the response says
// the result was cut, so a caller that totals the rows it got reports a number
// that is confidently, silently wrong.
//
// That is how the dashboard's "Spend & usage" panel came to show $1.84 for a
// window whose real cost was $5.77 — a 68% undercount, from a query that had no
// `.limit()` at all and therefore looked like it read everything.
//
// The bias matters more than the size of the error. A truncated total is never
// too high, always too low, and it drifts further from the truth the more the
// instance is used — so it looks most trustworthy on a new deployment and
// degrades exactly as the numbers start to matter.
//
// For MEMBERSHIP — "which of these ids have any row at all" — use
// `lib/cursorScan`'s `scanKeysPresent` instead. Offset paging reads every row
// of every key to answer that; a cursor skips the rest of a key the moment
// one of its rows proves the point.
//
// Aggregating in SQL is the cheaper fix and the codebase already does it where
// a migration was available (`budget_spend_since`, `admin_spend_by_user`). This
// is for the call sites that need the rows themselves, or that cannot ship a
// migration.

/**
 * The page this module ASKS for — not a promise about what comes back.
 * `db-max-rows` belongs to whoever runs the database, and a project tuned
 * below this answers every request short without saying so.
 */
export const PAGE = 1000;

/**
 * A ceiling on total rows read, so a pathological window cannot turn one page
 * render into a thousand round trips. Reaching it is REPORTED rather than
 * hidden — that is the whole difference between this and the bug it replaces.
 */
export const DEFAULT_MAX_ROWS = 100_000;

export type PagedResult<T> = {
  rows: T[];
  /** True when `maxRows` stopped the read before the filter was exhausted. */
  truncated: boolean;
};

/**
 * Page through a PostgREST query until it is exhausted.
 *
 * `build` is called once per page and must return a fresh query — Supabase
 * query builders are single-use, so reusing one silently returns the first
 * page forever, which is the very bug this exists to prevent.
 */
export async function selectAllPages<T>(
  build: () => {
    range: (
      from: number,
      to: number,
    ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>;
  },
  maxRows: number = DEFAULT_MAX_ROWS,
): Promise<PagedResult<T>> {
  const rows: T[] = [];
  let from = 0;
  // The largest page the server has ACTUALLY handed back.
  //
  // The exhaustion test used to be `page.length < what we asked for`, which is
  // only sound when the server gives everything it is asked for. `db-max-rows`
  // is the operator's setting: a project tuned below PAGE answers every request
  // short, and the very first page would have ended the read with
  // `truncated: false` holding a fraction of the rows. That flag is what the
  // dashboard's spend panel renders as "partial", so the failure mode was this
  // module's own reassurance printed over the undercount it exists to prevent.
  //
  // A page shorter than one the server has already produced proves the filter
  // is exhausted, whatever the cap turns out to be. It costs no extra requests
  // in the ordinary case, and the offset advances by what came back rather than
  // by what was requested so a smaller cap simply takes more rounds.
  let observedMax = 0;
  while (from < maxRows) {
    const to = Math.min(from + PAGE, maxRows) - 1;
    const want = to - from + 1;
    const { data, error } = await build().range(from, to);
    if (error) throw new Error(error.message);
    const page = data ?? [];
    if (page.length === 0) return { rows, truncated: false };
    rows.push(...page);
    from += page.length;
    const prevMax = observedMax;
    observedMax = Math.max(observedMax, page.length);
    // Only judge a full-width request: the last window before `maxRows` can be
    // narrower by design, and a page that fills it is not evidence of an end.
    if (want === PAGE && page.length < prevMax) return { rows, truncated: false };
  }
  // The ceiling stopped the loop, which is not the same as the ceiling biting:
  // a filter matching exactly `maxRows` rows would otherwise be reported as
  // truncated, and a caveat on a complete answer teaches readers to ignore
  // caveats. One more row settles it.
  const { data: probe, error: probeError } = await build().range(maxRows, maxRows);
  if (probeError) throw new Error(probeError.message);
  return { rows, truncated: (probe ?? []).length > 0 };
}
