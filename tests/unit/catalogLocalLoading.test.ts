// The catalog's local half, before it has been read.
//
// Measured on a fresh load of /data-sql, sampled every two seconds:
//
//   8 s   Local tables 0        (loading — rendered as a count)
//   18 s  Local tables 33       (a pass made before the session resolved: no
//                                token, so no connections, every synced
//                                dataset filed as an upload; zero server calls)
//   20 s  Local tables 26 · sftest 7   (the token-driven re-run)
//
// R50 taught the panel to say "—" when the read FAILED. Loading is not failed
// and it is not zero either; and a pass that cannot ask for the connections
// should not paint an answer at all.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const CAT = readFileSync("src/components/catalog/CatalogView.tsx", "utf8");

function between(src: string, start: string, end: string, what: string): string {
  const i = src.indexOf(start);
  expect(i, `${what}: start anchor gone`).toBeGreaterThan(0);
  const j = src.indexOf(end, i);
  expect(j, `${what}: end anchor gone`).toBeGreaterThan(i);
  return src.slice(i, j);
}

describe("the catalog's local half before its first read", () => {
  it("has a loading state distinct from empty and from failed", () => {
    expect(CAT).toMatch(/const \[localLoaded, setLocalLoaded\] = useState\(false\);/);
    expect(CAT).toMatch(/const localLoading = !localLoaded && localError === null;/);
  });

  it("makes no local pass before the session's token exists", () => {
    const head = between(CAT, "const reloadLocal = useCallback(", "try {", "reloadLocal head");
    expect(head).toMatch(/if \(!token\) return \[\];/);
  });

  it("marks the half as read on success and on failure alike", () => {
    // A failed read is a read. Only a pass that never ran leaves it loading.
    expect(CAT).toMatch(/setLocalError\(null\);\s*setLocalLoaded\(true\);/);
    expect(CAT).toMatch(/setLocalError\(\(e as Error\)\.message\);\s*setLocalLoaded\(true\);/);
  });

  it("shows a spinner — not zero, and not a bare ellipsis — while the local tables are loading", () => {
    // R384: the "…" that replaced the zero sat in the count for seven seconds
    // on a fresh load and still read as a value ("none") rather than as work.
    const row = between(
      CAT,
      '<HardDrive className="h-3.5 w-3.5" /> Local tables',
      "</button>",
      "Local tables row",
    );
    expect(row).toMatch(/localLoading \? \(\s*<Loader2[\s\S]*?aria-label="Loading local tables"/);
    expect(row).not.toMatch(/localLoading\s*\?\s*"…"/);
    // Failed is still a different answer from loading.
    expect(row).toMatch(/localUnknown \? \(\s*"—"/);
  });

  it("marks both totals as floors while the local half is loading", () => {
    expect(CAT.match(/\{localUnknown \|\| localLoading \? "\+" : ""\}/g)).toHaveLength(2);
    expect(CAT).toMatch(
      /localLoading\s*\?\s*"Local tables are still loading — crawled assets only"/,
    );
  });
});

// R384, from the user: "the local tables and tables connected via apps take
// some time to load … initially it might seem there's no local tables or any
// connected apps table." Measured on a fresh load of /data-sql, sampled every
// 250 ms: for ~6.9 s the rail read "All assets 71+ · Local tables … · MinIO 12 ·
// Lakehouse 59" with the connector "sftest" absent, the list held 71 of 106
// assets, then everything landed at once. Each state below is a place where
// that window used to read as "you have none".
describe("the local half says it is loading wherever it is missing", () => {
  it("says connected apps are being checked, instead of leaving them out", () => {
    // Connector sources come from the same read as the local tables, so until
    // it lands they were simply absent from the rail.
    expect(CAT).toMatch(
      /\{localLoading \? \(\s*<div[\s\S]*?data-testid="catalog-apps-loading"[\s\S]*?Checking connected apps/,
    );
  });

  it("puts a loading banner over the list once the crawled assets are up", () => {
    // Before the crawled list arrives the table is skeletons; after it, the
    // list looked complete while a third of it was missing.
    expect(CAT).toMatch(
      /\{localLoading && !loading \? \(\s*<div[\s\S]*?data-testid="catalog-local-loading"/,
    );
    expect(CAT).toContain(
      "Loading local tables and connected-app tables — they&apos;ll appear in this list",
    );
  });

  it("says the asset count is a running total while the local half loads", () => {
    const count = between(CAT, 'data-testid="catalog-asset-count"', "</span>", "asset count");
    expect(count).toMatch(/\{localLoading \? " so far" : ""\}/);
  });

  it("never answers 'no match' or 'nothing cataloged' while the local half is unread", () => {
    // The loading branch must be tested BEFORE the generic empty state, or a
    // local-only workspace is told to add a data source while 28 tables load.
    const loadingBranch = CAT.indexOf("filtered.length === 0 && awaitingLocal ?");
    const emptyBranch = CAT.indexOf("Nothing cataloged yet — add a data source");
    expect(loadingBranch, "the loading empty-state branch is gone").toBeGreaterThan(0);
    expect(emptyBranch).toBeGreaterThan(loadingBranch);
    expect(CAT).toContain('data-testid="catalog-empty-while-loading"');
  });

  it("does not hold back a crawled source's own empty view", () => {
    // Filtering to a crawled source does not depend on the local read, so its
    // genuine "no match" must still be said.
    expect(CAT).toMatch(/const awaitingLocal = localLoading && !sourceById\.has\(sourceFilter\);/);
  });
});
