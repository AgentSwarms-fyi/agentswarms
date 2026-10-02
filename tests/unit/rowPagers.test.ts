// The pagers that write, rather than the ones that print.
//
// R41 fixed the shared helper; this is the sweep of the hand-rolled loops that
// never used it. Three of them do not render a sentence — they produce a
// lakehouse table, a materialised Parquet mirror, and the rows a dashboard
// widget computes its stored answer from. Each carried some combination of the
// same three faults:
//
//   * the page's error folded into the exhaustion test, so a statement timeout
//     was indistinguishable from the end of the data;
//   * `chunk.length < PAGE` as proof of the end, which holds only when the
//     server returns everything it is asked for, and db-max-rows belongs to
//     whoever runs the database;
//   * offset paging with NO ORDER BY, which Postgres makes no promise about —
//     two pages can repeat one row and drop another. That does not undercount,
//     it moves the answer in either direction.
//
// The lakehouse one is the sharpest: it collected rows and then ran
// CREATE OR REPLACE TABLE over them, so a failed page did not fail the import,
// it REPLACED an existing table with a prefix of itself — which SQL models,
// widgets and training runs then read as the dataset.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const LAKE = readFileSync("src/utils/lakehouse.functions.ts", "utf8");
const PARQ = readFileSync("src/utils/data/parquet.server.ts", "utf8");
const REFRESH = readFileSync("src/utils/bi/refresh.server.ts", "utf8");

/** The call and its arguments, bounded by the statement that follows it. */
function scanBlock(src: string, label: string): string {
  const i = src.indexOf("selectAllPages<");
  expect(i, `${label}: no selectAllPages call — the hand-rolled loop is back`).toBeGreaterThan(0);
  return src.slice(i, i + 700);
}

const SITES: [string, string][] = [
  ["lakehouse import", LAKE],
  ["parquet mirror", PARQ],
  ["widget refresh", REFRESH],
];

describe("row pagers that persist or compute", () => {
  for (const [label, src] of SITES) {
    describe(label, () => {
      it("reads through the shared pager rather than a hand-rolled loop", () => {
        expect(src).toContain('from "@/lib/pagedSelect"');
        expect(scanBlock(src, label)).toContain("selectAllPages<");
      });

      it("no longer ends a read on a short page", () => {
        // The assumption R41 removed from the helper. A copy of it left in a
        // call site is the same defect wearing a different loop.
        expect(src).not.toMatch(/\.length < PAGE\b/);
        expect(src).not.toMatch(/\.length < 1000\b/);
      });

      it("orders by a unique column, so offsets mean something", () => {
        // Without this, page 2 is not "the rows after page 1" — it is whatever
        // the planner returned second.
        expect(scanBlock(src, label)).toContain('.order("id", { ascending: true })');
      });

      it("refuses at its ceiling instead of persisting a prefix", () => {
        // Nothing downstream can tell a short table from a small one, so the
        // ceiling has to be a refusal and not a quiet stop.
        expect(scanBlock(src, label)).toMatch(/truncated\)/);
        expect(src).toMatch(/if \((?:imported|mirrored|scanned)\.truncated\)/);
      });
    });
  }

  it("the lakehouse import keeps its error instead of dropping it", () => {
    // It was `const { data: chunk }` — no error binding at all — so a failed
    // page became `break` and the rows so far were written with
    // CREATE OR REPLACE TABLE.
    expect(LAKE).not.toMatch(/const \{ data: chunk \}/);
    expect(LAKE).toContain("CREATE OR REPLACE TABLE");
  });

  it("the widget refresh no longer treats a failed page as the end of the data", () => {
    expect(REFRESH).not.toMatch(/rowErr \|\| !chunk/);
  });

  it("names the knob when it refuses, so the refusal is actionable", () => {
    expect(REFRESH).toContain("BI_LOCAL_ROWS_PER_TABLE_CAP");
    expect(PARQ).toContain("PARQUET_MAX_ROWS");
    expect(LAKE).toContain("500k row cap");
  });

  it("makes the widget cap configurable, since reaching it now fails a refresh", () => {
    expect(REFRESH).toMatch(/function localRowsPerTableCap\(\): number \{/);
    // The ARGUMENT position, not the identifier anywhere. A mutant that passed
    // a bare 20_000 to the scan and left the knob in the error message survived
    // a plain toContain: the sibling occurrence answered for the one under
    // test. Third time this session that a symmetric copy has stood in.
    expect(scanBlock(REFRESH, "widget refresh")).toMatch(/localRowsPerTableCap\(\),/);
  });
});

describe("the tail of the sweep: flags that described the wrong defect", () => {
  // `capped` and `truncated` report that fewer rows were read than the count,
  // which a reader takes to mean the work below ran over a PREFIX. Under a
  // server cap smaller than PAGE these two also SKIPPED — their offsets advanced
  // by the request size — so the rows on hand were a scatter. A null rate over a
  // scatter, or an ETL step over one, is wrong rather than short, and a flag
  // that names the wrong defect is worse than no flag.
  const QUALITY = readFileSync("src/utils/bi/quality.server.ts", "utf8");
  const ETL = readFileSync("src/utils/etl/service.server.ts", "utf8");

  for (const [label, src] of [
    ["data quality", QUALITY],
    ["etl dataset read", ETL],
  ] as const) {
    describe(label, () => {
      it("reads through the shared pager", () => {
        expect(src).toContain('from "@/lib/pagedSelect"');
        expect(src).toContain("await selectAllPages<{ row: unknown }>(");
      });

      it("no longer advances an offset by the page it asked for", () => {
        expect(src).not.toMatch(/(?:start|from)\s*\+=\s*PAGE\b/);
      });

      it("orders by a unique column", () => {
        const i = src.indexOf("selectAllPages<");
        expect(src.slice(i, i + 500)).toContain('.order("id", { ascending: true })');
      });
    });
  }

  it("data quality's capped flag now means what it says", () => {
    expect(QUALITY).toContain("capped: scan.truncated || total > rows.length,");
  });

  it("the etl read reports truncation from the scan rather than from a guess", () => {
    expect(ETL).toContain("truncated = scan.truncated;");
    // And a failed read still returns an error rather than throwing out of a
    // function whose callers expect `{ error }`.
    expect(ETL).toMatch(/return \{ error: err instanceof Error \? err\.message/);
  });
});
