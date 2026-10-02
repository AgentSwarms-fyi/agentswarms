// A failed dataset list is not an empty account.
//
// hydrateFromSupabase read the table list as
//
//   if (error || !tables) return [];
//
// Measured by driving /data-sql with every user_data_tables request rejected
// and pressing Refresh: thirty real tables were replaced by "No tables yet.
// Upload a file to get started." with no toast and the spinner cleared. The
// same [] reaches the mount path, which takes an empty list for an empty
// account and seeds the samples (tests/unit/sampleSeeding.test.ts has that
// half), and the Data Prep tab, whose catch wiped the list to [] on failure.
//
// These pin the three call sites' shape; the seeder is covered behaviourally.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const ENGINE = readFileSync("src/lib/sqlEngine.ts", "utf8");
const PREP = readFileSync("src/components/bi/DataPrepTab.tsx", "utf8");
const WB = readFileSync("src/routes/_authenticated/data-sql.tsx", "utf8");

function between(src: string, start: string, end: string, what: string): string {
  const i = src.indexOf(start);
  expect(i, `${what}: start anchor gone`).toBeGreaterThan(0);
  const j = src.indexOf(end, i);
  expect(j, `${what}: end anchor gone`).toBeGreaterThan(i);
  return src.slice(i, j);
}

/**
 * Branch order is the assertion: the error branch's condition, then its copy,
 * then the empty branch's condition — searched forward from the copy, so a
 * mutant that puts the empty branch first finds nothing after it.
 */
function errorBranchComesFirst(src: string, cond: string, copy: string, emptyCond: string) {
  const c = src.indexOf(cond);
  expect(c, "error branch condition gone").toBeGreaterThan(0);
  const k = src.indexOf(copy, c);
  expect(k, "error copy is not inside the error branch").toBeGreaterThan(c);
  expect(
    src.indexOf(emptyCond, k),
    "empty branch must come AFTER the error branch",
  ).toBeGreaterThan(k);
}

describe("hydrateFromSupabase, when the table list itself cannot be read", () => {
  const listRead = () =>
    between(
      ENGINE,
      "const { data: tables, error } = await supabase",
      "async function loadShared",
      "list read",
    );

  it("throws with the server's reason instead of answering []", () => {
    expect(listRead()).toMatch(
      /if \(error\) throw new Error\(`could not list datasets: \$\{error\.message\}`\);/,
    );
  });

  it("has no path from a failed list to an empty list", () => {
    expect(listRead()).not.toMatch(/return \[\]/);
  });
});

describe("the Data Prep tab, when its reload fails", () => {
  const reload = () =>
    between(PREP, "const reloadDatasets = useCallback(", "}, []);", "reloadDatasets");

  it("keeps the last good list rather than wiping it", () => {
    const body = reload().match(/catch \(e\) \{([\s\S]*?)\n {4}\}/);
    expect(body, "no catch (e) block").not.toBeNull();
    expect(body![1]).not.toMatch(/setDatasets\(\[\]\)/);
    expect(body![1]).toMatch(/setDatasets\(\(d\) => d \?\? \[\]\)/);
    expect(body![1]).toMatch(/setDatasetsError\(\(e as Error\)\.message\)/);
  });

  it("clears the error on a successful reload", () => {
    expect(reload()).toMatch(
      /setDatasets\(await hydrateFromSupabase\(\)\);\s*setDatasetsError\(null\);/,
    );
  });

  it("says the load failed before it would ever say the account is empty", () => {
    // Or the empty-state copy ("upload a CSV") wins on a failed first load.
    errorBranchComesFirst(
      PREP,
      ") : datasetsError && localDatasets.length === 0 ? (",
      "Tables could not be loaded: {datasetsError}",
      ") : localDatasets.length === 0 ? (",
    );
  });
});

describe("the Workbench sidebar, when the list cannot be read", () => {
  it("records the failure from both entry points and clears it on success", () => {
    expect(WB).toMatch(/const \[tablesError, setTablesError\] = useState<string \| null>\(null\);/);
    expect(WB).toMatch(
      /toast\.error\(`Could not load datasets: \$\{\(e as Error\)\.message\}`\);\s*setTablesError\(\(e as Error\)\.message\);/,
    );
    expect(WB).toMatch(
      /toast\.error\(`Could not refresh datasets: \$\{\(e as Error\)\.message\}`\);\s*setTablesError\(\(e as Error\)\.message\);/,
    );
    expect(WB).toMatch(
      /let tables = await hydrateFromSupabase\(\);\s*setDatasets\(tables\);\s*setTablesError\(null\);/,
    );
    expect(WB).toMatch(
      /const tables = await hydrateFromSupabase\(\);\s*setDatasets\(tables\);\s*setTablesError\(null\);/,
    );
  });

  it("says the load failed before it would ever say there are no tables", () => {
    errorBranchComesFirst(
      WB,
      ") : datasets.length === 0 && tablesError ? (",
      "Datasets could not be loaded: {tablesError}",
      ") : datasets.length === 0 ? (",
    );
  });

  it("marks a kept list as stale when the refresh behind it failed", () => {
    // The toast lasts four seconds; the list it failed to replace lasts until
    // the next refresh. Something on the list has to say which it is.
    const note = WB.indexOf("Last refresh failed: {tablesError}");
    expect(note).toBeGreaterThan(0);
    expect(WB.slice(note - 260, note)).toMatch(/tablesError && datasets\.length > 0 \?/);
  });
});
