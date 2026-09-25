// Lakehouse: questions about a statement's shape read it outside its string
// literals. Both cases were found building Sheets, whose formula columns put
// user text into SQL literals and call TODAY().
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { classifyStatement } from "@/utils/lakehouse/core.server";
import { blankLiterals, callsVolatileFunction } from "@/utils/lakehouse/sqlRefs";

describe("a ; inside a literal is data, not a second statement", () => {
  it("accepts semicolons in strings and quoted names", () => {
    expect(classifyStatement("SELECT 'north; south' AS regions").kind).toBe("select");
    expect(classifyStatement(`SELECT "a;b" FROM analytics.t`).kind).toBe("select");
    expect(classifyStatement("SELECT 'it''s; fine' AS x").kind).toBe("select");
    expect(classifyStatement("SELECT $$a;b$$ AS x").kind).toBe("select");
    expect(classifyStatement("SELECT concat_ws('; ', a, b) FROM analytics.t").kind).toBe("select");
  });

  it("still refuses a real second statement, in any disguise", () => {
    expect(() => classifyStatement("SELECT 1; SELECT 2")).toThrow(/One statement/);
    expect(() => classifyStatement("SELECT 'x'; DROP TABLE a.t")).toThrow(/One statement/);
    // A quote closed early does not hide what follows it.
    expect(() => classifyStatement("SELECT 'a''; DROP TABLE a.t; --'")).not.toThrow();
    expect(() => classifyStatement("SELECT 'a'''; DROP TABLE a.t")).toThrow(/One statement/);
  });

  it("blanks literal contents and keeps every index in place", () => {
    const sql = "SELECT 'a;b', \"c;d\" -- e;f\n FROM t";
    const blanked = blankLiterals(sql);
    expect(blanked).toHaveLength(sql.length);
    expect(blanked).not.toContain(";");
    expect(blanked).toContain("FROM t");
  });
});

describe("statements that read the clock are never served from the cache", () => {
  it("knows which calls change from run to run", () => {
    for (const sql of [
      "SELECT now()",
      "SELECT current_date",
      "SELECT CURRENT_TIMESTAMP",
      "SELECT * FROM a.t WHERE d > today() - 7",
      "SELECT random() AS r",
      "SELECT gen_random_uuid()",
    ]) {
      expect(callsVolatileFunction(sql), sql).toBe(true);
    }
    for (const sql of [
      "SELECT * FROM a.t",
      "SELECT 'now()' AS label",
      "SELECT nowhere FROM a.t",
      "SELECT 1 -- random()",
    ]) {
      expect(callsVolatileFunction(sql), sql).toBe(false);
    }
  });

  it("the cache lookup is skipped for them", () => {
    const src = readFileSync(resolve(process.cwd(), "src/utils/lakehouse/core.server.ts"), "utf8");
    // A result is only read from or written to the cache through the slot
    // this block sets, so the block's own condition is what must exclude them.
    const slot = src.indexOf("cacheSlot = { key, snapshot }");
    const block = src.lastIndexOf("if (", src.lastIndexOf("currentSnapshotId(c)", slot));
    expect(slot).toBeGreaterThan(0);
    expect(src.slice(block, src.indexOf("{", src.indexOf(")\n", block)))).toContain(
      "!callsVolatileFunction(effectiveSql)",
    );
  });
});
