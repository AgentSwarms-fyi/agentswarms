// A quote inside a filter value, per engine.
//
// FOUND IN R499: every dialect escaped a quote by doubling it. Spark/Databricks
// reads 'O''Brien' as the two literals 'O' and 'Brien' and coalesces them, so
// a governed filter `customer = 'O''Brien'` silently matched "OBrien" — wrong
// rows, no error. BigQuery concatenates adjacent literals only with whitespace
// between them, so the same text was a syntax error. Both document `\'` as the
// escape. These pin the literal each engine receives, through the compiler and
// the parameter path, not the private helper.
import { describe, expect, it } from "vitest";

import {
  compileSemanticQuery,
  resolveParamValues,
  sqlStringLiteral,
  type SemanticModel,
  type SqlDialect,
} from "@/lib/semanticLayer";

const model = {
  name: "m",
  source: { kind: "data_table", table: "orders" },
  dimensions: [{ name: "customer", sql: "customer", type: "categorical" }],
  metrics: [{ name: "total", agg: "sum", sql: "amount" }],
  parameters: [{ name: "who", type: "string", default: "x" }],
} as SemanticModel;

/**
 * Where a literal starting at 0 closes, read like the engine's lexer: a
 * backslash escapes the next character on backslash dialects, and `''` is a
 * quote everywhere except Spark and BigQuery, where it ends the literal.
 */
function closingQuote(lit: string, d: SqlDialect): number {
  const backslash = ["databricks", "bigquery", "mysql", "snowflake", "redshift", "alasql"].includes(
    d,
  );
  const doubled = d !== "databricks" && d !== "bigquery";
  for (let i = 1; i < lit.length; i++) {
    if (backslash && lit[i] === "\\") {
      i++;
      continue;
    }
    if (lit[i] === "'") {
      if (doubled && lit[i + 1] === "'") {
        i++;
        continue;
      }
      return i;
    }
  }
  return -1;
}

function whereFor(dialect: SqlDialect, value: string, op: "=" | "contains" = "=") {
  const { sql } = compileSemanticQuery(
    model,
    { model: "m", metrics: ["total"], filters: [{ field: "customer", op, value }] },
    { dialect },
  );
  return sql;
}

describe("a quote in a string value", () => {
  it("is a backslash escape on Spark and BigQuery, where '' is two literals", () => {
    for (const d of ["databricks", "bigquery"] as const) {
      expect(sqlStringLiteral("O'Brien", d)).toBe("'O\\'Brien'");
      expect(whereFor(d, "O'Brien")).toContain("'O\\'Brien'");
      expect(whereFor(d, "O'Brien")).not.toContain("O''Brien");
    }
  });

  it("stays doubled where '' is the standard escape", () => {
    for (const d of [
      "postgres",
      "duckdb",
      "lakehouse",
      "snowflake",
      "redshift",
      "mysql",
    ] as const) {
      expect(sqlStringLiteral("O'Brien", d)).toBe("'O''Brien'");
    }
  });

  it("never lets a trailing backslash escape the closing quote", () => {
    // On these a lone `\'` would end nothing, and the rest of the query would
    // become part of the string — or worse, the value's tail would become SQL.
    for (const d of [
      "databricks",
      "bigquery",
      "mysql",
      "snowflake",
      "redshift",
      "alasql",
    ] as const) {
      expect(sqlStringLiteral("a\\", d)).toBe("'a\\\\'");
      // Read the way the engine's lexer reads it, the literal ends at its
      // last character: nothing of the value is left outside it as SQL.
      for (const v of ["a\\' OR 1=1 --", "\\\\'", "'\\'", "it's \\"]) {
        const lit = sqlStringLiteral(v, d);
        expect(closingQuote(lit, d), `${d}: ${lit}`).toBe(lit.length - 1);
      }
    }
    // Postgres and T-SQL read a backslash literally; doubling would change the value.
    expect(sqlStringLiteral("a\\", "postgres")).toBe("'a\\'");
    expect(sqlStringLiteral("a\\", "azure_synapse")).toBe("'a\\'");
  });

  it("is escaped the same way inside a contains pattern", () => {
    // BigQuery's LIKE escapes with a backslash, so the pattern's own escapes
    // are doubled for the literal; the quote is `\'`.
    expect(whereFor("bigquery", "O'Brien_1", "contains")).toContain("LIKE '%O\\'Brien\\\\_1%'");
    expect(whereFor("databricks", "O'Brien_1", "contains")).toContain(
      "LIKE '%O\\'Brien~_1%' ESCAPE '~'",
    );
    expect(whereFor("postgres", "O'Brien_1", "contains")).toContain(
      "LIKE '%O''Brien~_1%' ESCAPE '~'",
    );
  });

  it("is escaped the same way in a string parameter", () => {
    const q = { model: "m", metrics: ["total"], params: { who: "O'Brien" } };
    expect(resolveParamValues(model, q, "databricks").get("who")).toBe("'O\\'Brien'");
    expect(resolveParamValues(model, q, "bigquery").get("who")).toBe("'O\\'Brien'");
    expect(resolveParamValues(model, q, "postgres").get("who")).toBe("'O''Brien'");
  });
});
