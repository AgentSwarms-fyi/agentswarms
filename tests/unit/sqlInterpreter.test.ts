// Golden assertions for the SELECT interpreter behind the sql_query agent tool.
//
// The differential suite proves the engines agree with each other. It cannot
// prove they are RIGHT — two engines can be wrong in the same way, and a
// regression that hits both would pass unnoticed. These are absolute
// expectations, checked against what SQL actually specifies.
//
// The first three describe blocks are regressions for bugs the differential
// harness found on its first run. Each of them silently returned wrong data to
// an AI agent, which is the worst possible way to be wrong.
import { describe, expect, it } from "vitest";

import { runSelectOnTables } from "@/utils/tools/sql.server";
import { freshTables } from "../differential/fixtures";

function rows(sql: string): Record<string, unknown>[] {
  const r = runSelectOnTables(sql, freshTables());
  if (!r.ok) throw new Error(r.error);
  return r.rows;
}

describe("regression: NULL comparisons use SQL three-valued logic", () => {
  it("!= excludes NULL rows", () => {
    // region: EMEA×2, APAC×2, NULL×1, ''×1, AMER×2, 'Zürich'×1
    // NULL != 'EMEA' is UNKNOWN, so row 5 must NOT appear.
    const ids = rows("SELECT id FROM orders WHERE region != 'EMEA'").map((r) => r.id);
    expect(ids.sort()).toEqual([3, 4, 6, 7, 8, 9]);
    expect(ids).not.toContain(5);
  });

  it("= excludes NULL rows", () => {
    expect(rows("SELECT id FROM orders WHERE region = 'EMEA'").map((r) => r.id)).toEqual([1, 2]);
  });

  it("ordered comparisons exclude NULL rows", () => {
    // amount is NULL on id 6; it must not satisfy > or <.
    const gt = rows("SELECT id FROM orders WHERE amount > -1000").map((r) => r.id);
    expect(gt).not.toContain(6);
    const lt = rows("SELECT id FROM orders WHERE amount < 1000").map((r) => r.id);
    expect(lt).not.toContain(6);
  });

  it("IS NULL / IS NOT NULL still work", () => {
    expect(rows("SELECT id FROM orders WHERE region IS NULL").map((r) => r.id)).toEqual([5]);
    expect(rows("SELECT id FROM orders WHERE amount IS NOT NULL")).toHaveLength(8);
  });

  it("the empty string is not NULL", () => {
    expect(rows("SELECT id FROM orders WHERE region = ''").map((r) => r.id)).toEqual([6]);
  });
});

describe("regression: LIMIT ... OFFSET pages correctly", () => {
  it("standard LIMIT n OFFSET m", () => {
    // ids 1..9 ordered; skip 2, take 3 → 3,4,5. The parser emits
    // [count, offset] for this form; reading it as [offset, count] returned
    // only two rows starting in the wrong place.
    expect(rows("SELECT id FROM orders ORDER BY id LIMIT 3 OFFSET 2").map((r) => r.id)).toEqual([
      3, 4, 5,
    ]);
  });

  it("LIMIT alone is unaffected", () => {
    expect(rows("SELECT id FROM orders ORDER BY id LIMIT 3").map((r) => r.id)).toEqual([1, 2, 3]);
  });

  it("an offset past the end yields nothing", () => {
    expect(rows("SELECT id FROM orders ORDER BY id LIMIT 5 OFFSET 100")).toHaveLength(0);
  });
});

describe("regression: qualified columns resolve to their own table", () => {
  it("o.id is the order id, not the customer id", () => {
    // Both tables have `id`. Rows are prefixed with the ALIAS, so resolving
    // the alias to the real table name missed and fell through to the merged
    // unqualified key — which held the RIGHT table's value.
    const out = rows(
      "SELECT o.id, c.name FROM orders o INNER JOIN customers c ON o.customer_id = c.id",
    );
    expect(out.map((r) => r.id).sort((a, b) => Number(a) - Number(b))).toEqual([
      1, 2, 3, 4, 5, 6, 8, 9,
    ]);
    // Order 7 references customer 99, which does not exist — INNER JOIN drops it.
    expect(out.map((r) => r.id)).not.toContain(7);
    expect(out.find((r) => r.id === 3)?.name).toBe("Beta");
    expect(out.find((r) => r.id === 9)?.name).toBe("Zürich GmbH");
  });

  it("unaliased qualified references also resolve", () => {
    const out = rows(
      "SELECT orders.id FROM orders INNER JOIN customers ON orders.customer_id = customers.id",
    );
    expect(out).toHaveLength(8);
    expect(out.map((r) => r.id)).toContain(9);
  });
});

describe("aggregates follow SQL NULL rules", () => {
  it("COUNT(*) counts rows, COUNT(col) skips NULLs", () => {
    expect(rows("SELECT COUNT(*) AS n FROM orders")[0].n).toBe(9);
    expect(rows("SELECT COUNT(amount) AS n FROM orders")[0].n).toBe(8);
  });

  it("SUM and AVG ignore NULLs", () => {
    expect(rows("SELECT SUM(amount) AS s FROM orders")[0].s).toBeCloseTo(1017.75, 6);
    // 1017.75 over the EIGHT non-null rows, not nine.
    expect(Number(rows("SELECT AVG(amount) AS a FROM orders")[0].a)).toBeCloseTo(1017.75 / 8, 6);
  });

  it("MIN/MAX span negatives and zero", () => {
    const r = rows("SELECT MIN(amount) AS lo, MAX(amount) AS hi FROM orders")[0];
    expect(r.lo).toBe(-40);
    expect(r.hi).toBe(310);
  });
});

describe("only SELECT is executable", () => {
  for (const sql of [
    "INSERT INTO orders (id) VALUES (1)",
    "UPDATE orders SET amount = 0",
    "DELETE FROM orders",
    "DROP TABLE orders",
    "CREATE TABLE evil (id int)",
  ]) {
    it(`refuses: ${sql}`, () => {
      const r = runSelectOnTables(sql, freshTables());
      expect(r.ok).toBe(false);
    });
  }

  it("reports unknown tables instead of returning empty results", () => {
    const r = runSelectOnTables("SELECT * FROM does_not_exist", freshTables());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/unknown table/i);
  });
});
