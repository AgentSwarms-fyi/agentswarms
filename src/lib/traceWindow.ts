// What the analytics header may claim about how many traces it is showing.
//
// MEASURED on /analytics: the page requested .limit(2000) and told the user
// "1,000 traces over the last 30 days" for an account holding 2,731. The
// PostgREST max-rows setting capped the response at 1,000 and supabase-js
// returned the first page as if it were everything; the .limit(2000) never
// mattered. Every KPI inherited the truncation — spend −5.6%, tokens −46%,
// active agents 18 of 22 — and average latency was not merely undercounted
// but BIASED (+32%), because the newest thousand rows happened to be slower
// than the month they were standing in for.
//
// The fix reads the exact count first, then pages. This module owns the two
// sentences that depend on how that went, so they are testable and cannot
// drift into implying completeness the read does not have.

export type TraceWindow = {
  /** Rows actually fetched (after paging). */
  fetched: number;
  /** The exact count PostgREST reported for the same filter. */
  total: number;
};

/** True when the rows on hand are every row the filter matches. */
export function windowComplete(w: TraceWindow): boolean {
  return w.fetched >= w.total;
}

/**
 * The header sentence. Complete data keeps the old claim; incomplete data
 * says what is actually on screen — "the most recent N of M" — because
 * "N traces over the last 30 days" is a statement about the account, and a
 * capped read is only entitled to a statement about itself.
 */
export function traceCountHeadline(w: TraceWindow, rangeLabel = "the last 30 days"): string {
  if (windowComplete(w)) {
    return `${w.total.toLocaleString()} traces over ${rangeLabel}`;
  }
  return `showing the most recent ${w.fetched.toLocaleString()} of ${w.total.toLocaleString()} traces from ${rangeLabel}`;
}

/**
 * The KPI qualifier, or null when the numbers are whole. Rendered beside the
 * cards so a partial total reads as a floor rather than a measurement.
 */
export function traceKpiQualifier(w: TraceWindow): string | null {
  if (windowComplete(w)) return null;
  return `Totals below cover only these ${w.fetched.toLocaleString()} traces.`;
}

// The paging loop itself, lifted out of the component so its correctness is
// testable rather than only inspectable. The component owns Supabase and
// React state; this owns the one decision that broke — "keep asking until a
// short page proves the end, bounded by a hard ceiling" — and returns both
// the rows and the window so the header can be honest about truncation.
//
// A page read that ERRORS must abort the whole load: a half-fetched window
// summed as if whole is the same defect as the original cap, wearing an error
// instead of a limit. `fetchPage` throws to signal that; the loop lets it
// propagate so the caller records the error rather than totalling a fragment.

export type TracePage<Row> = { rows: Row[] };

export async function pageTraces<Row>(
  // Fetch rows [offset, offset+pageSize). Throw to abort the whole load.
  fetchPage: (offset: number, pageSize: number) => Promise<TracePage<Row>>,
  opts: { pageSize: number; maxRows: number },
): Promise<Row[]> {
  const { pageSize, maxRows } = opts;
  const all: Row[] = [];
  for (let offset = 0; offset < maxRows; offset += pageSize) {
    const { rows } = await fetchPage(offset, pageSize);
    all.push(...rows);
    // A short page is the only proof the end was reached; a full page could
    // be a coincidence exactly at the boundary, so we ask once more.
    if (rows.length < pageSize) break;
  }
  return all;
}
