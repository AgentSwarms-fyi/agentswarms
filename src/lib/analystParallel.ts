// Running an analysis's steps concurrently, and not running the same query
// twice inside one of them.
//
// WHY THIS IS SAFE, WHICH IS THE ONLY INTERESTING QUESTION. Steps could not be
// parallelised if one consumed another's output. They do not: each step's SQL
// is generated from its own GOAL — the planner's sentence — and the results
// array is written during the loop and read only afterwards, by the self-check
// and the write-up. The old loop ran in sequence for presentation ("the trace
// reads top to bottom"), not for correctness.
//
// That is a property of the current loop rather than a law, so it is worth
// saying plainly: if a step ever comes to depend on an earlier step's rows,
// this has to be revisited. A parallel run of dependent steps does not fail
// loudly — it produces plausible numbers computed from missing context.
//
// CONCURRENCY IS BOUNDED because each step costs an LLM call and a query. An
// unbounded fan-out turns a five-step analysis into five simultaneous
// warehouse queries and five simultaneous model calls, which is how one user's
// question becomes everyone's rate limit.
//
// THE CACHE IS DELIBERATELY SMALL. It de-duplicates identical SQL WITHIN ONE
// TURN — same query, same instant, provably the same answer, so nothing has to
// be disclosed. It is not carried across questions: between two questions the
// data can move, and a cached row served later is a number that is no longer
// true with nothing on screen saying so. A cache that outlives its warrant is
// worse than no cache, because it is invisible.

/** How many steps may be in flight at once. */
export const ANALYST_STEP_CONCURRENCY = 3;

/**
 * Map over items with bounded concurrency, preserving input order.
 *
 * Order matters more than it looks: `results[i]` is matched to `steps[i]` by
 * the self-check and the write-up, so a result landing at the wrong index
 * attributes one query's numbers to another query's goal.
 *
 * If `fn` rejects, every other item still runs to completion before the error
 * is raised — abandoning in-flight work would leave steps half-updated.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const n = items.length;
  const out = new Array<R>(n);
  if (n === 0) return out;
  const width = Math.max(1, Math.min(Math.trunc(limit) || 1, n));

  let next = 0;
  let firstError: unknown = null;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= n) return;
      try {
        out[i] = await fn(items[i], i);
      } catch (e) {
        if (firstError === null) firstError = e;
      }
    }
  };
  await Promise.all(Array.from({ length: width }, worker));
  if (firstError !== null) throw firstError;
  return out;
}

/**
 * Identity of a query for caching: the source it runs against, plus the SQL.
 *
 * The source is part of the key and not an afterthought — the same SELECT
 * against two warehouses is two different questions, and sharing a result
 * between them would be the worst kind of wrong: confidently, silently.
 * Whitespace is normalised because the generator's formatting varies between
 * calls while the query does not; nothing else is, since any deeper
 * "equivalence" is a guess.
 *
 * The separator is a character no source key contains, so no pair of
 * (source, sql) can be rearranged into another pair's key.
 */
const KEY_SEP = "|";

export function resultCacheKey(sourceKey: string, sql: string): string {
  return `${sourceKey}${KEY_SEP}${(sql ?? "").replace(/\s+/g, " ").trim().toLowerCase()}`;
}

/**
 * A per-turn store of in-flight and finished queries.
 *
 * It holds PROMISES, not values, which is the point once steps run
 * concurrently: two steps issuing the same SQL at the same moment both miss a
 * value-cache and both hit the warehouse. Caching the promise collapses them
 * into one round-trip.
 */
export type TurnCache<R> = {
  /** Run `fn` for this key, or join the run already under way. */
  run: (key: string, fn: () => Promise<R>) => Promise<R>;
  /** How many distinct queries were issued — exposed for tests and telemetry. */
  size: () => number;
};

export function createTurnCache<R>(): TurnCache<R> {
  const inflight = new Map<string, Promise<R>>();
  return {
    run(key, fn) {
      const hit = inflight.get(key);
      if (hit) return hit;
      const p = fn();
      inflight.set(key, p);
      // A failed query is NOT cached: the next step asking the same thing
      // should get a real attempt, not a replayed failure. Warehouses time
      // out, and one transient error should not poison the rest of the turn.
      p.catch(() => inflight.delete(key));
      return p;
    },
    size: () => inflight.size,
  };
}
