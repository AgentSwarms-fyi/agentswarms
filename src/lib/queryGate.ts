/**
 * Loads that a browser query must not overtake.
 *
 * FOUND IN R210: on the real image, the Workbench's first
 * `SELECT count(*) FROM saas_sales` answered 6000 while the explorer beside
 * it said 9,994 rows, and a minute later 9994. A table is filled 500 rows at
 * a time, with an await between batches, and a query that came in between
 * read what was there so far, with no word that it was partial. Run earlier
 * still, while the rows were being fetched, the same query said "Table with
 * name saas_sales does not exist!" about a table that was on its way.
 *
 * A load holds queries until it settles; a query waits for every load held
 * when it starts. A load that fails releases them too, so a query then
 * fails on its own terms rather than waiting for ever.
 */
const held = new Set<Promise<unknown>>();

export function holdQueriesUntil(load: Promise<unknown>): void {
  held.add(load);
  const release = () => {
    held.delete(load);
  };
  load.then(release, release);
}

/** Resolves once every load held now has settled, whatever its outcome. */
export async function waitForLoads(): Promise<void> {
  if (held.size === 0) return;
  await Promise.allSettled([...held]);
}

/** For tests: how many loads are holding queries. */
export function heldLoads(): number {
  return held.size;
}
