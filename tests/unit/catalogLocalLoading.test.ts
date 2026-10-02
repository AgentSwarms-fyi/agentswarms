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

  it("shows an ellipsis, not zero, while the local tables are loading", () => {
    expect(CAT).toMatch(
      /Local tables\s*<span[^>]*>\s*\{localUnknown\s*\?\s*"—"\s*:\s*localLoading\s*\?\s*"…"\s*:\s*localAssets\.filter/,
    );
  });

  it("marks both totals as floors while the local half is loading", () => {
    expect(CAT.match(/\{localUnknown \|\| localLoading \? "\+" : ""\}/g)).toHaveLength(2);
    expect(CAT).toMatch(
      /localLoading\s*\?\s*"Local tables are still loading — crawled assets only"/,
    );
  });
});
