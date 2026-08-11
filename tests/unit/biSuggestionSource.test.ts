// The suggested questions must come from the tables the answer will run against.
//
// FOUND BY MEASUREMENT. With the Workbench pointed at a Snowflake connection
// holding only TPC-DS and TPC-H, the suggestion chips still read:
//
//   "Which department had the highest headcount last month?"
//   "What is the average salary by department?"
//
// — questions about the LOCAL HR sample. Clicking one sent an unanswerable
// question to the warehouse, and the model did what models do with a question
// the data cannot answer: it invented a plausible query. The observed SQL
// selected C_CUSTKEY (a TPC-H column) from TPCDS_SF10TCL.CUSTOMER (whose key
// is C_CUSTOMER_SK). Snowflake rejected it, which is the honest outcome.
//
// Measured on that connection: 80 tables, a 25 KB schema block (~6.3k tokens,
// so nothing was truncated), 31 bare table names appearing in more than one
// schema, and `customer` present SIX times with two different key columns.
// Given an impossible question and six candidate `customer` tables, the wrong
// guess was not a surprising failure — the question should never have been
// offered against that source.
//
// After the fix the same switch produces: "Which call center has the most
// employees?", "What are the top 5 reasons for returns?" — TPC-DS tables.
//
// Source-level guards: there is no React test harness in this repo. Each is
// mutation-verified.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const PAGE = readFileSync("src/routes/_authenticated/data-sql.tsx", "utf8");

describe("suggestions and answers read the same tables", () => {
  it("suggestions are generated from the selected source, not always the local one", () => {
    expect(PAGE).toMatch(
      /const suggestionDatasets = activeWarehouse \? warehouseDatasets : datasets;/,
    );
    expect(PAGE).toMatch(/datasets: suggestionDatasets,/);
  });

  it("that is the SAME expression the turn runs against", () => {
    // The two used to differ, which is the whole bug. If someone changes one,
    // this fails until they change the other.
    const turn = PAGE.match(/datasets: (activeWarehouse \? warehouseDatasets : datasets),/);
    expect(turn, "the BI turn no longer picks datasets by active warehouse").toBeTruthy();
    expect(PAGE).toContain(`const suggestionDatasets = ${turn![1]};`);
  });

  it("switching source clears the old questions immediately", () => {
    // Leaving the previous source's chips up while new ones load is precisely
    // the window in which one gets clicked.
    expect(PAGE).toMatch(/useEffect\(\(\) => \{\s*setSuggestions\(\[\]\);\s*\}, \[dataSource\]\)/);
  });

  it("and refetches whenever the list it should describe changes", () => {
    expect(PAGE).toMatch(/\[suggestionDatasets\.length, suggestions\.length\]/);
    expect(PAGE, "the refetch still keys off the local dataset count").not.toMatch(
      /\}, \[datasets\.length\]\);/,
    );
  });

  it("the generator is stable across renders so the effect cannot loop", () => {
    // It is now a dependency of an effect; a fresh function identity every
    // render would refetch forever.
    expect(PAGE).toMatch(/const refreshSuggestions = useCallback\(async \(\) => \{/);
  });
});
