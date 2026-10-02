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
  // This campaign's own, and it had the milder half of the defect it went on to
  // find elsewhere: it stopped at the first short page. It never SKIPPED, since
  // it stopped rather than advancing past one, so the window headline it feeds
  // stayed honest — it just said "showing the most recent N of M" for a much
  // smaller N than it needed to, on any deployment whose db-max-rows sits below
  // the page size asked for. A page shorter than one the server has already
  // produced is the end; a page shorter than the REQUEST is only news about the
  // server.
  let offset = 0;
  let observedMax = 0;
  while (offset < maxRows) {
    const { rows } = await fetchPage(offset, pageSize);
    if (rows.length === 0) break;
    all.push(...rows);
    offset += rows.length;
    const prevMax = observedMax;
    observedMax = Math.max(observedMax, rows.length);
    if (rows.length < prevMax) break;
  }
  return all;
}

/**
 * The same sentence for a list that is not traces.
 *
 * Swarm Observability had the identical defect this module was written for —
 * `.limit(200)` and then "N swarm runs · auto-deleted after 30 days", which is
 * a statement about the account made by a read that only saw the first page.
 * Rather than a second helper that could drift, the noun is a parameter: one
 * module keeps owning the two sentences, and the two Observability pages
 * cannot end up describing the same situation differently.
 */
export function countHeadline(
  w: TraceWindow,
  noun: { one: string; many: string },
  rangeLabel = "the last 30 days",
): string {
  if (windowComplete(w)) {
    const word = w.total === 1 ? noun.one : noun.many;
    return `${w.total.toLocaleString()} ${word} over ${rangeLabel}`;
  }
  return (
    `showing the most recent ${w.fetched.toLocaleString()} of ` +
    `${w.total.toLocaleString()} ${noun.many} from ${rangeLabel}`
  );
}

/**
 * The same sentence a third time, for a catalogue rather than a time window.
 *
 * The Model Registry read `.limit(2000)` and printed `models.length` as the
 * population. Two things were wrong with it. The cap is a prefix of an
 * ALPHABETICAL order, so truncation does not thin the list evenly — it removes
 * late-alphabet developers entirely, and they then never appear in the provider
 * filter either. And the declared 2,000 does not exist: PostgREST's max-rows on
 * this deployment is 1,000, measured again while writing this (a `limit=2000`
 * on a 1,109-row table returned exactly 1,000), so the ceiling the code thought
 * it had was twice the one it got.
 *
 * "most recent" is meaningless here, which is the only reason this is a second
 * sentence rather than another noun passed to `countHeadline`.
 */
export function catalogueCount(w: TraceWindow, noun: { one: string; many: string }): string {
  if (windowComplete(w)) {
    const word = w.total === 1 ? noun.one : noun.many;
    return `${w.total.toLocaleString()} ${word}`;
  }
  return `the first ${w.fetched.toLocaleString()} of ${w.total.toLocaleString()} ${noun.many}`;
}

/**
 * What a truncated catalogue costs the controls beside it, or null when the
 * page holds everything.
 *
 * Worth its own sentence because the filters here are client-side: they sort
 * and search the array in hand. On a capped read the missing rows are not one
 * page away, they are unreachable from this screen — and a filter that silently
 * cannot reach a model is worse than a count that is merely low.
 */
export function catalogueCaveat(
  w: TraceWindow,
  noun: { one: string; many: string },
): string | null {
  if (windowComplete(w)) return null;
  const rest = (w.total - w.fetched).toLocaleString();
  return (
    `Filters, counts and search on this page cover these ${w.fetched.toLocaleString()} ` +
    `${noun.many} only — the other ${rest} were not loaded and cannot be found from here.`
  );
}

/**
 * A run detail page whose header is whole and whose list is not.
 *
 * `/analytics/observability/$runId` reads `swarm_run_steps` and
 * `swarm_run_edges` with no bound, so past the server's cap the timeline, the
 * data-flow list and the DAG on the canvas are a prefix — and a DAG drawn from
 * a prefix is not a smaller graph, it is a WRONG one, with edges arriving from
 * nodes that are not there.
 *
 * The header is the opposite case: `total_cost_usd`, `total_tokens_*` and
 * `step_count` are columns on the run row, written by the executor, so they
 * describe the whole run however much of it was read back. (Verified against
 * this deployment: `step_count` matched the actual row count on all seven runs
 * checked.) That asymmetry is the sentence — the numbers above are right, the
 * detail below is partial, and without saying so the page looks like it simply
 * does not add up.
 */
export function runStepsCaveat(w: TraceWindow): string | null {
  if (windowComplete(w)) return null;
  return (
    `Showing the first ${w.fetched.toLocaleString()} of ${w.total.toLocaleString()} steps. ` +
    `The canvas, the timeline and the per-step figures cover these only — the totals ` +
    `above are recorded on the run itself and cover all of it.`
  );
}
