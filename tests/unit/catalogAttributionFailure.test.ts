// The catalog, when it cannot read where a synced dataset came from.
//
// Measured on the running deployment with only the attribution read
// (`select=id,saas_connection_id`) rejected: "Local tables 33" where 26, the
// sftest connector row gone from the Sources panel, and its seven synced
// datasets shown with SOURCE "Local tables" — no toast, no banner. First seen
// by accident during R50's validation, when the rebuilt container was still
// `health: starting` and the connections server call failed the same way.
//
// The read dropped its error (`const { data: attribution }`) and the
// connections call was `.catch(() => [])`. Either failure re-filed every
// connector-synced dataset as a local upload: a failed read of WHERE a table
// came from was answered as "it came from here".
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

const reloadLocal = () =>
  between(CAT, "const reloadLocal = useCallback(", "const reload = useCallback(", "reloadLocal");

describe("the catalog, when attribution cannot be read", () => {
  it("no longer swallows a failed connections call", () => {
    const body = reloadLocal();
    expect(body).not.toMatch(/listConnectionsFn\([\s\S]{0,300}?\.catch\(/);
    expect(body).toMatch(
      /listConnectionsFn\(\{ data: \{ access_token: token \} \}\)\.then\(\s*\(c\) => \(\{ conns: c, error: null as string \| null \}\),\s*\(e: unknown\) => \(\{ conns: null, error: \(e as Error\)\.message \}\),/,
    );
  });

  it("reads the attribution query's error, not only its data", () => {
    expect(reloadLocal()).toMatch(
      /select\("id, saas_connection_id"\)[\s\S]{0,200}?error: \{ message: string \} \| null;/,
    );
    expect(reloadLocal()).not.toMatch(/const \[\{ data: attribution \}/);
  });

  it("keeps the last answer that was read across a failed re-read", () => {
    const body = reloadLocal();
    expect(body).toMatch(
      /if \(!attributionRes\.error\) lastAttributionRef\.current = attributionRes\.data \?\? \[\];/,
    );
    expect(body).toMatch(
      /if \(connectionsRes\.conns\) lastConnsRef\.current = connectionsRes\.conns;/,
    );
    expect(body).toMatch(/const attribution = lastAttributionRef\.current \?\? \[\];/);
    expect(body).toMatch(/const conns = lastConnsRef\.current \?\? \[\];/);
  });

  it("records the failure and whether an answer is known at all", () => {
    const body = reloadLocal();
    expect(body).toMatch(
      /setAttributionError\(failures\.length \? failures\.join\("; "\) : null\);/,
    );
    expect(body).toMatch(
      /setAttributionKnown\(lastAttributionRef\.current !== null && lastConnsRef\.current !== null\);/,
    );
  });

  it("says so on the page, in the words that match what is known", () => {
    const banner = between(CAT, "{attributionError ? (", ") : null}", "attribution banner");
    expect(banner).toContain('data-testid="catalog-attribution-error"');
    expect(banner).toMatch(
      /attributionKnown\s*\?\s*`Where synced datasets came from could not be re-read — showing the last known attribution: \$\{attributionError\}`/,
    );
    expect(banner).toMatch(
      /`Where synced datasets came from could not be read — they are listed under Local tables until it can be: \$\{attributionError\}`/,
    );
    expect(banner).toMatch(/onClick=\{\(\) => void reloadLocal\(\)\}/);
  });
});
