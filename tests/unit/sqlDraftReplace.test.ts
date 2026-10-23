// A query typed into the Data SQL editor and never run (R304, sweep 8).
//
// FOUND IN R304. A table clicked in the explorer, a pick from Recent queries
// and "Run … in the Workbench" on the Catalog each replaced the editor's text,
// and a query typed there and never run was gone: not in Recent queries,
// because it never ran, and not behind Ctrl+Z, because the editor is a
// controlled textarea. Driven: three typed queries lost, one per path. Each
// replacement now goes through `replaceSql`, which offers Undo when it would
// lose such a query. The rule is a function; the wiring is pinned by reading
// the page.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { losesUnrunQuery } from "@/lib/sqlDraft";

const page = readFileSync(join(process.cwd(), "src/routes/_authenticated/data-sql.tsx"), "utf8");

describe("losesUnrunQuery", () => {
  const TABLE = "SELECT * FROM analytics.t LIMIT 50;";

  it("is a typed query that was never run, about to be replaced", () => {
    expect(losesUnrunQuery("SELECT region FROM t", "", TABLE)).toBe(true);
    expect(losesUnrunQuery("SELECT region FROM t", "SELECT 1", TABLE)).toBe(true);
  });

  it("is not an empty editor, nor one holding only whitespace", () => {
    expect(losesUnrunQuery("", "", TABLE)).toBe(false);
    expect(losesUnrunQuery("  \n ", "", TABLE)).toBe(false);
  });

  it("is not the query last run, nor the text the page last put there", () => {
    expect(losesUnrunQuery("SELECT 1", "SELECT 1", TABLE)).toBe(false);
  });

  it("is not the same text coming in again", () => {
    expect(losesUnrunQuery(TABLE, "", TABLE)).toBe(false);
  });
});

describe("the Data SQL Workbench", () => {
  it("replaces the editor's text only through replaceSql, typing and Format aside", () => {
    const calls = [...page.matchAll(/\bsetSql\(([^)]*)\)/g)].map((m) => m[1]);
    expect(calls.sort()).toEqual(["e.target.value", "next", "out", "previous"]);
  });

  it("sends the table, the Recent queries pick and the Catalog's query through it", () => {
    expect(page).toContain("replaceSql(`SELECT * FROM ${t.schema}.${t.name} LIMIT 50;`)");
    expect(page).toMatch(/onPick=\{\(e\) => \{\s*replaceSql\(e\.sql\);/);
    expect(page).toMatch(/setDataSource\(seed\.dataSource\);\s*replaceSql\(seed\.sql\);/);
  });

  it("judges the loss before it moves what is kept, and offers the old text back", () => {
    expect(page).toMatch(
      /const previous = sqlRef\.current;\s*const lost = losesUnrunQuery\(previous, keptSqlRef\.current, next\);\s*keptSqlRef\.current = next;\s*setSql\(next\);\s*if \(!lost\) return;/,
    );
    expect(page).toContain('action: { label: "Undo", onClick: () => setSql(previous) },');
  });

  it("keeps a query once it is run, since it goes into Recent queries", () => {
    expect(page).toMatch(
      /if \(!sql\.trim\(\)\) return;\s*\/\/[^\n]*\n\s*keptSqlRef\.current = sql;\s*setRunning\(true\);/,
    );
  });
});
