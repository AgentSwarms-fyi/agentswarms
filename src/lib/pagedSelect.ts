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
// Aggregating in SQL is the cheaper fix and the codebase already does it where
// a migration was available (`budget_spend_since`, `admin_spend_by_user`). This
// is for the call sites that need the rows themselves, or that cannot ship a
// migration.

/** The largest page PostgREST will return. Asking for more is silently capped. */
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
  for (let from = 0; from < maxRows; from += PAGE) {
    const to = Math.min(from + PAGE, maxRows) - 1;
    const { data, error } = await build().range(from, to);
    if (error) throw new Error(error.message);
    const page = data ?? [];
    rows.push(...page);
    // A short page means the filter is exhausted. Only a page that came back
    // completely full can have more behind it.
    if (page.length < to - from + 1) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}
