// The DuckDB dialect in the shared compilers.
//
// The escaping tests are a security boundary, not a formatting preference:
// filter values come from dashboard users and reach the compiler as literals.
// A dialect placed in the wrong escaping class is a SQL-injection hole, so the
// assertion is made by EXECUTING the compiled SQL, not by reading it.
import { describe, expect, it } from "vitest";

import { compileSemanticQuery, truncateExpr, type SemanticModel } from "@/lib/semanticLayer";
import { runLocalSqlDuckDB, type DuckTable } from "@/utils/data/duckdb.server";

const table: DuckTable = {
  name: "t",
  columns: [
    { name: "s", type: "string" },
    { name: "day", type: "string" },
  ],
  rows: [
    { s: "a", day: "2026-03-04" },
    { s: "b", day: "2026-03-19" },
    // A value ending in a backslash — the classic break-out in MySQL-style
    // dialects, where `'a\'` swallows the closing quote.
    { s: "a\\", day: "2026-07-01" },
    { s: "O'Brien", day: "2026-07-02" },
  ],
};

/** Mirrors the compiler's ANSI escaping: double the quotes, touch nothing else. */
function ansiLiteral(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

describe("string literals are safe with ANSI escaping alone", () => {
  it("a trailing backslash does not escape the closing quote", async () => {
    // If DuckDB treated backslash as an escape, this literal would run on and
    // the appended SQL would execute. It must match exactly one row.
    const res = await runLocalSqlDuckDB(`SELECT s FROM t WHERE s = ${ansiLiteral("a\\")}`, [table]);
    expect(res.rows).toEqual([{ s: "a\\" }]);
  });

  it("an attempted break-out is treated as data, not SQL", async () => {
    const hostile = "a\\' OR 1=1 --";
    const res = await runLocalSqlDuckDB(`SELECT s FROM t WHERE s = ${ansiLiteral(hostile)}`, [
      table,
    ]);
    // No row holds that text, so a correctly-escaped query returns nothing.
    // Any rows at all would mean the OR 1=1 executed.
    expect(res.rows).toEqual([]);
  });

  it("doubling is the correct escape for an embedded quote", async () => {
    const res = await runLocalSqlDuckDB(`SELECT s FROM t WHERE s = ${ansiLiteral("O'Brien")}`, [
      table,
    ]);
    expect(res.rows).toEqual([{ s: "O'Brien" }]);
  });

  it("a lone backslash is a literal backslash", async () => {
    const res = await runLocalSqlDuckDB(`SELECT ${ansiLiteral("\\")} AS v`, [table]);
    expect(res.rows[0].v).toBe("\\");
  });
});

describe("time grains", () => {
  it.each([
    ["day", "2026-03-04"],
    ["month", "2026-03-01"],
    ["quarter", "2026-01-01"],
    ["year", "2026-01-01"],
  ])("%s truncates to %s", async (grain, expected) => {
    const expr = truncateExpr('"day"', grain as never, "duckdb");
    const res = await runLocalSqlDuckDB(`SELECT ${expr} AS b FROM t WHERE "day" = '2026-03-04'`, [
      table,
    ]);
    expect(res.rows[0].b).toBe(expected);
  });

  it("week truncates to the Monday", async () => {
    // 2026-03-04 is a Wednesday.
    const expr = truncateExpr('"day"', "week", "duckdb");
    const res = await runLocalSqlDuckDB(`SELECT ${expr} AS b FROM t WHERE "day" = '2026-03-04'`, [
      table,
    ]);
    expect(res.rows[0].b).toBe("2026-03-02");
  });

  it("an unparseable date becomes NULL instead of failing the query", async () => {
    // Column types come from a 50-row sample, so a stray non-date is normal.
    const junk: DuckTable = {
      name: "t",
      columns: [{ name: "day", type: "string" }],
      rows: [{ day: "not-a-date" }, { day: "2026-03-04" }],
    };
    const expr = truncateExpr('"day"', "month", "duckdb");
    const res = await runLocalSqlDuckDB(`SELECT ${expr} AS b FROM t ORDER BY 1`, [junk]);
    expect(res.rows.map((r) => r.b)).toEqual(["2026-03-01", null]);
  });

  it("casts, because DATE_TRUNC over VARCHAR is a binder error", () => {
    // Guards the fallthrough that would otherwise have applied: the postgres
    // form compiles but throws at runtime against a text column.
    expect(truncateExpr('"day"', "month", "duckdb")).toContain("TRY_CAST");
  });
});

describe("identifier quoting", () => {
  const model: SemanticModel = {
    name: "m",
    source: { kind: "data_table", table: "t" },
    dimensions: [{ name: "s", sql: "s", type: "string" }],
    metrics: [{ name: "n", agg: "count", sql: "s" }],
  } as SemanticModel;

  it("uses double quotes, not backticks", () => {
    const compiled = compileSemanticQuery(
      model,
      { model: "m", metrics: ["n"], dimensions: ["s"] },
      {
        dialect: "duckdb",
      },
    );
    expect(compiled.sql).toContain('"');
    expect(compiled.sql).not.toContain("`");
  });

  it("compiles to SQL DuckDB actually accepts", async () => {
    const compiled = compileSemanticQuery(
      model,
      { model: "m", metrics: ["n"], dimensions: ["s"] },
      {
        dialect: "duckdb",
      },
    );
    const res = await runLocalSqlDuckDB(compiled.sql, [table]);
    expect(res.rows.length).toBeGreaterThan(0);
  });
});
