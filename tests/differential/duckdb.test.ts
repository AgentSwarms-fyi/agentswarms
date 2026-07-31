// DuckDB measured against AlaSQL, the engine it is a candidate to replace.
//
// The rule for promoting DuckDB to the default is not "it looks better" — it
// is that every difference from today's behaviour is written down here with a
// reason. DUCKDB_DIFFERENCES is that record; anything not listed must match.
//
// This is also where the reject corpus is enforced for BOTH engines: a
// read-only guard that holds for one and not the other would be a hole the
// moment the flag flips.
import { describe, expect, it } from "vitest";

import { CORPUS, REJECT_CORPUS } from "./corpus";
import { canonRows, duckdbEngine, ENGINES, runAll } from "./engines";
import { freshTables } from "./fixtures";

/**
 * Where DuckDB deliberately differs from the incumbents.
 *
 * Every entry is a case where DuckDB follows PostgreSQL/standard SQL and
 * AlaSQL does not. They are recorded rather than "fixed" because
 * making DuckDB reproduce non-standard behaviour would mean shipping a bug on
 * purpose — but they are real user-visible changes, which is exactly why they
 * belong in a list someone has to read before flipping the flag.
 */
const DUCKDB_DIFFERENCES: Record<string, string> = {
  "order-asc":
    "NULL ordering. DuckDB sorts NULLS LAST (as PostgreSQL does); AlaSQL places them " +
    "mid-sequence. Visible in any chart ordered by a column containing NULLs.",
  "order-desc": "NULL ordering — see order-asc. DuckDB is NULLS LAST in both directions.",
  "order-text": "NULL ordering on a text column — see order-asc.",
  "numeric-strings":
    "SUM over a column declared numeric but holding strings. DuckDB coerces and returns " +
    "15; AlaSQL counts only the real number and returns 3. Reachable only for uncoerced " +
    "legacy rows — ingest coerces on write.",
};

describe("DuckDB runs everything the product emits", () => {
  for (const entry of CORPUS) {
    it(`executes ${entry.id} — ${entry.note}`, async () => {
      const res = await duckdbEngine.run(entry.sql, freshTables());
      // A parse or execution failure on a shape the product generates would
      // make DuckDB a non-starter, whatever its results look like.
      expect(res.ok, res.ok ? "" : `DuckDB failed: ${res.error}`).toBe(true);
    });
  }
});

describe("DuckDB matches the incumbents, except where recorded", () => {
  for (const entry of CORPUS) {
    const recorded = DUCKDB_DIFFERENCES[entry.id];

    it(`${entry.id}${recorded ? " (recorded difference)" : ""}`, async () => {
      const ordered = Boolean(entry.ordered);
      const sync = runAll(entry.sql);
      const duck = await duckdbEngine.run(entry.sql, freshTables());
      expect(duck.ok).toBe(true);
      if (!duck.ok) return;

      const duckCanon = canonRows(duck.rows, ordered);
      const alasql = sync.alasql;
      expect(alasql.ok, alasql.ok ? "" : `AlaSQL failed: ${alasql.error}`).toBe(true);
      if (!alasql.ok) return;
      const matches = canonRows(alasql.rows, ordered) === duckCanon;

      if (recorded) {
        expect(
          matches,
          `${entry.id} now matches AlaSQL. Remove it from DUCKDB_DIFFERENCES. ` +
            `Recorded reason: ${recorded}`,
        ).toBe(false);
      } else {
        expect(
          matches,
          `DuckDB diverges on "${entry.sql}" with no recorded reason. Either fix the ` +
            `adapter or add it to DUCKDB_DIFFERENCES explaining why the change is correct.`,
        ).toBe(true);
      }
    });
  }
});

describe("both engines refuse writes and DDL", () => {
  for (const entry of REJECT_CORPUS) {
    it(`rejects ${entry.id} (${entry.note})`, async () => {
      // Either engine would happily run these against its own scratch
      // database; the shared read-only guard is what stops both.
      const duck = await duckdbEngine.run(entry.sql, freshTables());
      expect(duck.ok, `DuckDB accepted "${entry.sql}"`).toBe(false);
      for (const engine of ENGINES) {
        const res = engine.run(entry.sql, freshTables());
        expect(res.ok, `${engine.id} accepted "${entry.sql}"`).toBe(false);
      }
    });
  }
});

describe("NULL ordering is the documented difference", () => {
  it("sorts NULLs last ascending, like PostgreSQL", async () => {
    const res = await duckdbEngine.run(
      "SELECT id, amount FROM orders ORDER BY amount ASC",
      freshTables(),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.rows.at(-1)?.amount).toBeNull();
    expect(res.rows[0]?.amount).toBe(-40);
  });

  it("sorts NULLs last descending too", async () => {
    const res = await duckdbEngine.run(
      "SELECT id, amount FROM orders ORDER BY amount DESC",
      freshTables(),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.rows.at(-1)?.amount).toBeNull();
    expect(res.rows[0]?.amount).toBe(310);
  });
});

describe("DuckDB brings SQL AlaSQL cannot be trusted with", () => {
  // Not a comparison — these are the reason for the migration.
  it.each([
    ["CTE", "WITH t AS (SELECT region, amount FROM orders) SELECT COUNT(*) AS n FROM t"],
    ["subquery", "SELECT id FROM orders WHERE amount > (SELECT AVG(amount) FROM orders)"],
    [
      "window function",
      "SELECT id, SUM(amount) OVER (PARTITION BY region) AS region_total FROM orders",
    ],
    [
      "LEFT JOIN",
      "SELECT o.id, c.name FROM orders o LEFT JOIN customers c ON o.customer_id = c.id",
    ],
    ["DISTINCT", "SELECT DISTINCT region FROM orders"],
    ["HAVING", "SELECT region, COUNT(*) AS n FROM orders GROUP BY region HAVING COUNT(*) > 1"],
    ["CASE", "SELECT CASE WHEN amount > 100 THEN 'big' ELSE 'small' END AS bucket FROM orders"],
    ["date_trunc", "SELECT date_trunc('month', CAST(day AS DATE)) AS m FROM orders"],
  ])("runs %s", async (_label, sql) => {
    const res = await duckdbEngine.run(sql, freshTables());
    expect(res.ok, res.ok ? "" : `failed: ${res.error}`).toBe(true);
  });

  it("a LEFT JOIN keeps the unmatched row", async () => {
    const res = await duckdbEngine.run(
      "SELECT o.id, c.name FROM orders o LEFT JOIN customers c ON o.customer_id = c.id",
      freshTables(),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Order 7 points at customer 99, which does not exist.
    expect(res.rows).toHaveLength(9);
    expect(res.rows.find((r) => r.id === 7)?.name).toBeNull();
  });
});
