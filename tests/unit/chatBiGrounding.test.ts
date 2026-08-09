// Visual BI must not answer from a query that reads nothing.
//
// Reproduced in the browser. With Visual BI ON, asked a plain conversational
// question whose answer the user had supplied one turn earlier:
//
//   Q: "Who owns the Q3 migration project, and what is its codename?"
//   A: "The Q3 migration project currently has no designated owner and does
//       not have a codename assigned."
//   SOURCES (1): SELECT NULL AS owner, NULL AS codename
//
// The same agent, same conversation, Visual BI OFF:
//
//   A: "The owner of the Q3 migration project is Priya, and its internal
//       codename is BLUEHERON."   ← correct
//
// So memory and context were fine. Visual BI took a non-data question down the
// SQL path, the analyst wrote a query against no table, one row of NULLs came
// back, and the narrative stated the NULLs as fact — with the invented SELECT
// displayed as the source.
//
// The fall-through to the agent already existed and was meant for exactly this
// ("we fall through when the question isn't answerable from data"). It never
// fired, because the skip tested `row_count === 0` and a table-less SELECT
// returns one row. A row count is not evidence that data was read.
import { describe, expect, it } from "vitest";

import { readsATable } from "@/lib/chatBi";

describe("readsATable", () => {
  it("rejects the query that caused the bug", () => {
    expect(readsATable("SELECT NULL AS owner, NULL AS codename")).toBe(false);
  });

  it("rejects other queries that touch no table", () => {
    for (const sql of [
      "SELECT 1",
      "SELECT 'unknown' AS answer",
      "select current_date",
      "SELECT NULL AS a, NULL AS b, NULL AS c",
    ]) {
      expect(readsATable(sql), sql).toBe(false);
    }
  });

  it("accepts real queries against a table", () => {
    for (const sql of [
      'SELECT "Region", SUM(Sales) AS total FROM saas_sales GROUP BY "Region"',
      "select * from hr_roster limit 10",
      "SELECT a.x FROM t1 a JOIN t2 b ON a.id = b.id",
      "WITH d AS (SELECT * FROM orders) SELECT count(*) FROM d",
      'SELECT * FROM "quoted table"',
    ]) {
      expect(readsATable(sql), sql).toBe(true);
    }
  });

  it("is not fooled by the word FROM inside a string or comment", () => {
    // Otherwise a query selecting the literal text 'from' would count as a
    // data read — permissive failure here restores the bug.
    expect(readsATable("SELECT 'orders from europe' AS label")).toBe(false);
    expect(readsATable("SELECT NULL AS x -- from saas_sales")).toBe(false);
    expect(readsATable("SELECT NULL AS x /* from saas_sales */")).toBe(false);
  });

  it("treats absent SQL as no data read", () => {
    expect(readsATable(null)).toBe(false);
    expect(readsATable(undefined)).toBe(false);
    expect(readsATable("")).toBe(false);
  });
});
