// The sql_query tool's inline table listing has a budget (R12: 4,300 prompt
// tokens a turn for fifteen wide tables, on every turn of every agent with the
// tool on). These pin what the listing does at and past the budget, and that
// the registry uses it.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SQL_SCHEMA_SUMMARY_MAX_CHARS, summarizeTablesForPrompt } from "@/lib/sqlSchemaSummary";

const table = (name: string, n: number) => ({
  name,
  columns: Array.from({ length: n }, (_, i) => ({ name: `c${i}`, type: "text" })),
});

describe("summarizeTablesForPrompt", () => {
  it("lists every table with its columns when they fit, sorted by name", () => {
    const s = summarizeTablesForPrompt([table("orders", 2), table("customers", 1)]);
    expect(s.text).toBe("customers(c0:text); orders(c0:text, c1:text)");
    expect(s.listed).toBe(2);
    expect(s.namedOnly).toBe(0);
  });

  it("past the budget, names the rest with a column count and points at list_data_tables", () => {
    // Three tables of ~230 characters each against a 300-character budget:
    // the first fits, the second does not, and the third is named even
    // though it would fit — a listing that skips a wide table and then lists
    // a narrow one reads as if the wide one did not exist.
    const s = summarizeTablesForPrompt(
      [table("a_wide", 20), table("b_wide", 20), table("c_small", 1)],
      300,
    );
    expect(s.listed).toBe(1);
    expect(s.namedOnly).toBe(2);
    expect(s.text.startsWith("a_wide(c0:text")).toBe(true);
    expect(s.text).toContain(
      "columns not listed for b_wide (20 columns), c_small (1 columns) — call list_data_tables for them",
    );
    expect(s.text).not.toContain("b_wide(c0");
  });

  it("stays under the budget it was given for the listed part", () => {
    const tables = Array.from({ length: 40 }, (_, i) =>
      table(`t${String(i).padStart(2, "0")}`, 30),
    );
    const s = summarizeTablesForPrompt(tables, 2000);
    const listedPart = s.text.split("; columns not listed")[0];
    expect(listedPart.length).toBeLessThanOrEqual(2000);
    expect(s.listed + s.namedOnly).toBe(40);
    expect(s.listed).toBeGreaterThan(0);
  });

  it("treats a missing column list as no columns", () => {
    const s = summarizeTablesForPrompt([{ name: "bare", columns: null }]);
    expect(s.text).toBe("bare()");
  });

  it("clamps an absurd budget rather than obeying it", () => {
    expect(summarizeTablesForPrompt([table("t", 1)], 0).text).toBe("t(c0:text)");
    expect(summarizeTablesForPrompt([table("t", 1)], Number.NaN).text).toBe("t(c0:text)");
  });

  it("the default is the documented one", () => {
    expect(SQL_SCHEMA_SUMMARY_MAX_CHARS).toBe(4000);
  });
});

describe("the registry's sql_query description uses the budgeted listing", () => {
  const REG = readFileSync(resolve("src/utils/tools/registry.server.ts"), "utf8");

  it("builds the description from summarizeTablesForPrompt under SQL_TOOL_SCHEMA_MAX_CHARS", () => {
    expect(REG).toContain("summarizeTablesForPrompt(");
    expect(REG).toContain("process.env.SQL_TOOL_SCHEMA_MAX_CHARS");
    expect(REG).toContain("Available tables: ${summary.text}");
    // The old inline join is gone.
    expect(REG).not.toMatch(/\.join\(", "\)\}\)`;\s*\}\)\s*\.join\("; "\)/);
    expect(readFileSync(resolve(".env.example"), "utf8")).toContain("SQL_TOOL_SCHEMA_MAX_CHARS");
  });
});
