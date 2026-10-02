// The catalog, when its local tables cannot be read.
//
// Measured on the running deployment: normally "All assets 54 · Local tables
// 26 · 54 of 54 assets"; with every user_data_tables read rejected, "All assets
// 21 · Local tables 0 · 21 of 21 assets" — no toast, no banner, one
// console.warn. Thirty-three assets gone, and a search for any of them answers
// "no results". reloadLocal's catch read
//
//   console.warn("[Catalog] local table hydration failed", e);
//   setLocalAssets([]);
//
// so a failed hydration and an empty account produced the same screen. The
// prep tab's collapsed section header did the same beside its own error state:
// "Local tables 0".
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const CAT = readFileSync("src/components/catalog/CatalogView.tsx", "utf8");
const PREP = readFileSync("src/components/bi/DataPrepTab.tsx", "utf8");

function between(src: string, start: string, end: string, what: string): string {
  const i = src.indexOf(start);
  expect(i, `${what}: start anchor gone`).toBeGreaterThan(0);
  const j = src.indexOf(end, i);
  expect(j, `${what}: end anchor gone`).toBeGreaterThan(i);
  return src.slice(i, j);
}

describe("the catalog, when its local tables cannot be read", () => {
  const reloadLocal = () =>
    between(CAT, "const reloadLocal = useCallback(", "const reload = useCallback(", "reloadLocal");

  it("records the failure and keeps the last good list", () => {
    expect(CAT).toMatch(/const \[localError, setLocalError\] = useState<string \| null>\(null\);/);
    const body = reloadLocal().match(/\} catch \(e\) \{([\s\S]*?)\n {4}\}/);
    expect(body, "no catch (e) block").not.toBeNull();
    expect(body![1]).toMatch(/setLocalError\(\(e as Error\)\.message\)/);
    expect(body![1], "a failed hydration must not wipe the list").not.toMatch(/setLocalAssets\(/);
  });

  it("clears the failure when a hydration lands", () => {
    expect(reloadLocal()).toMatch(/setLocalAssets\(mapped\);\s*setLocalError\(null\);/);
  });

  it("distinguishes unknown from empty", () => {
    expect(CAT).toMatch(/const localUnknown = localError !== null && localAssets\.length === 0;/);
  });

  it("shows no count for local tables while they are unknown", () => {
    // "0" is a count. "—" is the absence of one.
    expect(CAT).toMatch(
      /Local tables\s*<span[^>]*>\s*\{localUnknown\s*\?\s*"—"\s*:\s*localLoading\s*\?\s*"…"\s*:\s*localAssets\.filter\(\(a\) => a\.source_id === LOCAL_SOURCE_ID\)\.length\}/,
    );
  });

  it("marks the totals as a floor while the local half is unknown", () => {
    // Two totals carry the marker, and either alone satisfies a bare pattern:
    // the Sources panel's is pinned by its label, and both are counted.
    expect(CAT).toMatch(
      /All assets\s*<span[\s\S]{0,600}?>\s*\{allAssets\.length\}\s*\{localUnknown \|\| localLoading \? "\+" : ""\}\s*<\/span>/,
    );
    expect(CAT).toMatch(
      /\{filtered\.length\} of \{allAssets\.length\}\s*\{localUnknown \|\| localLoading \? "\+" : ""\} assets/,
    );
    expect(CAT.match(/\{localUnknown \|\| localLoading \? "\+" : ""\}/g)).toHaveLength(2);
  });

  it("says so on the page, with a way back", () => {
    const banner = between(CAT, "{localError ? (", ") : null}", "banner");
    expect(banner).toContain('data-testid="catalog-local-error"');
    expect(banner).toMatch(/Local tables could not be loaded: \$\{localError\}/);
    expect(banner).toMatch(/Local tables may be stale — the last reload failed: \$\{localError\}/);
    expect(banner).toMatch(/onClick=\{\(\) => void reloadLocal\(\)\}/);
  });
});

describe("the prep tab's section header, when its tables cannot be read", () => {
  it("shows no count beside its own error state", () => {
    expect(PREP).toMatch(
      /\{datasetsError && localDatasets\.length === 0 \? "—" : localDatasets\.length\}/,
    );
  });
});
