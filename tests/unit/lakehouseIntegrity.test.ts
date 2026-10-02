// A lakehouse table can look perfectly healthy and be unreadable.
//
// THE GAP THESE WERE WRITTEN FOR. A DuckLake table is two things — rows in the
// catalog database and Parquet objects in the store — and nothing keeps them
// together. On this very instance the object store was replaced while the
// catalog Postgres survived on its own volume, so the catalog went on
// describing eight data files of which two had never existed in the new store.
//
// The Lakehouse page showed no sign of it, and the reason is exact: `count(*)`
// on a DuckLake table is answered from `ducklake_data_file.record_count`
// WITHOUT reading a Parquet. Measured on the broken instance:
//
//   analytics.f1_standings   count(*) -> 21 rows      SELECT * -> HTTP 404
//   analytics.orders         count(*) ->  4 rows      SELECT * -> HTTP 404
//   analytics.revenue_facts  count(*) -> 836 rows     SELECT * -> fine
//
// So the table list reported full row counts for two tables that could not be
// read at all. That is the worst shape this kind of failure can take: the UI
// says the rows are there, and it is quoting a source that genuinely believes
// it. The only way to know is to list the store and compare.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const mod = readFileSync("src/utils/lakehouse/integrity.server.ts", "utf8");
const fns = readFileSync("src/utils/lakehouse.functions.ts", "utf8");
const ui = readFileSync("src/routes/_authenticated/lakehouse.tsx", "utf8");

describe("the check compares the catalog against the store", () => {
  it("reads the catalog's LIVE data files only", () => {
    // Superseded files are supposed to be absent; reporting them would make
    // every compacted table look broken.
    expect(mod).toContain("ducklake_data_file df");
    expect(mod).toContain("df.end_snapshot IS NULL AND t.end_snapshot IS NULL");
  });

  it("lists the store once instead of probing every file", () => {
    // A HEAD per file is O(files) round trips against someone's object store,
    // behind a page load.
    expect(mod).toContain("glob(");
    expect(mod).toContain("present.add(");
  });

  it("honours an absolute file path", () => {
    // A table can be created with its own location; composing the relative path
    // for those would report every one of their files as missing.
    expect(mod).toContain("path_is_relative");
    expect(mod).toContain("const relative = r[5] !== false");
  });

  it("counts the rows behind the missing files, not just the file count", () => {
    // "2 files missing" understates it. The number that matters is how many
    // rows can no longer be read.
    expect(mod).toContain("missing_rows");
    expect(mod).toContain("record_count");
  });
});

describe("it fails safe", () => {
  it("never throws into the page", () => {
    // An integrity check that takes the Lakehouse down is worse than the
    // divergence it looks for.
    expect(mod).toContain("catch (e)");
    expect(mod).toMatch(/error: \(e as Error\)\.message/);
  });

  it("does not cry wolf when the listing is capped", () => {
    // A truncated listing cannot prove absence. Reporting issues from a partial
    // listing would mark healthy tables broken — which would train people to
    // ignore the warning, and then it is worth nothing.
    expect(mod).toContain("MAX_OBJECTS");
    expect(mod).toContain("issues: truncated ? [] : issues");
    expect(mod).toContain("truncated");
  });

  it("says it was capped rather than hiding it", () => {
    // No silent caps: a check that quietly stopped looking must say so.
    expect(mod).toMatch(/truncated: boolean/);
  });
});

describe("the server function", () => {
  it("scopes results to schemas the caller can see", () => {
    // Otherwise it enumerates the shape of a lake belonging to someone else.
    expect(fns).toContain("export const getLakehouseIntegrity");
    expect(fns).toContain("accessibleSchemas(userId)");
    expect(fns).toContain("allowed.has(i.schema)");
  });

  it("is separate from the overview, which runs on every page load", () => {
    expect(fns).toContain('await import("./lakehouse/integrity.server")');
  });
});

describe("the table list stops reassuring", () => {
  it("marks an affected table instead of showing its metadata row count", () => {
    // The count is real, comes from the catalog, and is worse than useless
    // here: it is the thing telling the reader everything is fine.
    expect(ui).toContain("broken.get(");
    expect(ui).toContain("file${hurt.missing === 1");
    expect(ui).toContain("AlertTriangle");
  });

  it("explains the state on hover, including what to do", () => {
    expect(ui).toContain("missing from object storage");
    expect(ui).toMatch(/Re-import the table, or drop it/);
  });

  it("does not let the check block the page", () => {
    // Fetched after the overview resolves and swallowed on failure — the
    // Lakehouse must render with or without it.
    expect(ui).toContain("integrityFn({ data: { access_token: token } })");
    expect(ui).toContain(".catch(() => setBroken(new Map()))");
  });
});
