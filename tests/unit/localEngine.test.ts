// Golden assertions for the local SQL engine — whichever one is active.
//
// The differential suite proves the engines agree with each other. It cannot
// prove they are RIGHT: two engines can be wrong in the same way, and a
// regression that hit both would pass unnoticed. These are absolute
// expectations, checked against what SQL actually specifies.
//
// The first three blocks began as regressions for bugs the harness found in
// the hand-written interpreter that used to back the agent tool. That
// interpreter is gone, but the assertions were never about it — they are about
// what any local engine must get right, so they now run against the shared
// entry point every server-side query goes through.
import { describe, expect, it } from "vitest";

import { runLocalSelect } from "@/utils/data/localEngine.server";
import { freshTables } from "../differential/fixtures";

async function rows(sql: string): Promise<Record<string, unknown>[]> {
  const r = await runLocalSelect(sql, freshTables());
  return r.rows;
}

async function ids(sql: string): Promise<unknown[]> {
  return (await rows(sql)).map((r) => r.id);
}

describe("NULL comparisons use SQL three-valued logic", () => {
  it("!= excludes NULL rows", async () => {
    // region: EMEA×2, APAC×2, NULL×1, ''×1, AMER×2, 'Zürich'×1.
    // NULL != 'EMEA' is UNKNOWN, so row 5 must NOT appear.
    const out = await ids("SELECT id FROM orders WHERE region != 'EMEA'");
    expect([...out].sort()).toEqual([3, 4, 6, 7, 8, 9]);
    expect(out).not.toContain(5);
  });

  it("= excludes NULL rows", async () => {
    expect(await ids("SELECT id FROM orders WHERE region = 'EMEA'")).toEqual([1, 2]);
  });

  it("ordered comparisons exclude NULL rows", async () => {
    // amount is NULL on id 6; it must satisfy neither > nor <.
    expect(await ids("SELECT id FROM orders WHERE amount > -1000")).not.toContain(6);
    expect(await ids("SELECT id FROM orders WHERE amount < 1000")).not.toContain(6);
  });

  it("IS NULL / IS NOT NULL still work", async () => {
    expect(await ids("SELECT id FROM orders WHERE region IS NULL")).toEqual([5]);
    expect(await rows("SELECT id FROM orders WHERE amount IS NOT NULL")).toHaveLength(8);
  });

  it("the empty string is not NULL", async () => {
    expect(await ids("SELECT id FROM orders WHERE region = ''")).toEqual([6]);
  });
});

describe("LIMIT ... OFFSET pages correctly", () => {
  it("standard LIMIT n OFFSET m", async () => {
    // ids 1..9 ordered; skip 2, take 3 → 3,4,5.
    expect(await ids("SELECT id FROM orders ORDER BY id LIMIT 3 OFFSET 2")).toEqual([3, 4, 5]);
  });

  it("LIMIT alone is unaffected", async () => {
    expect(await ids("SELECT id FROM orders ORDER BY id LIMIT 3")).toEqual([1, 2, 3]);
  });

  it("an offset past the end yields nothing", async () => {
    expect(await rows("SELECT id FROM orders ORDER BY id LIMIT 5 OFFSET 100")).toHaveLength(0);
  });
});

describe("qualified columns resolve to their own table", () => {
  it("o.id is the order id, not the customer id", async () => {
    // Both tables have `id` — the case that used to silently return the RIGHT
    // table's value for every row.
    const out = await rows(
      "SELECT o.id, c.name FROM orders o INNER JOIN customers c ON o.customer_id = c.id",
    );
    expect(out.map((r) => r.id).sort((a, b) => Number(a) - Number(b))).toEqual([
      1, 2, 3, 4, 5, 6, 8, 9,
    ]);
    // Order 7 references customer 99, which does not exist.
    expect(out.map((r) => r.id)).not.toContain(7);
    expect(out.find((r) => r.id === 3)?.name).toBe("Beta");
    expect(out.find((r) => r.id === 9)?.name).toBe("Zürich GmbH");
  });

  it("unaliased qualified references also resolve", async () => {
    const out = await rows(
      "SELECT orders.id FROM orders INNER JOIN customers ON orders.customer_id = customers.id",
    );
    expect(out).toHaveLength(8);
    expect(out.map((r) => r.id)).toContain(9);
  });
});

describe("aggregates follow SQL NULL rules", () => {
  it("COUNT(*) counts rows, COUNT(col) skips NULLs", async () => {
    expect(Number((await rows("SELECT COUNT(*) AS n FROM orders"))[0].n)).toBe(9);
    expect(Number((await rows("SELECT COUNT(amount) AS n FROM orders"))[0].n)).toBe(8);
  });

  it("SUM and AVG ignore NULLs", async () => {
    expect(Number((await rows("SELECT SUM(amount) AS s FROM orders"))[0].s)).toBeCloseTo(
      1017.75,
      6,
    );
    // Averaged over the EIGHT non-null rows, not nine.
    expect(Number((await rows("SELECT AVG(amount) AS a FROM orders"))[0].a)).toBeCloseTo(
      1017.75 / 8,
      6,
    );
  });

  it("MIN/MAX span negatives and zero", async () => {
    const r = (await rows("SELECT MIN(amount) AS lo, MAX(amount) AS hi FROM orders"))[0];
    expect(Number(r.lo)).toBe(-40);
    expect(Number(r.hi)).toBe(310);
  });
});

describe("only SELECT is executable", () => {
  it.each([
    "INSERT INTO orders (id) VALUES (1)",
    "UPDATE orders SET amount = 0",
    "DELETE FROM orders",
    "DROP TABLE orders",
    "CREATE TABLE evil (id int)",
    "SELECT 1; DROP TABLE orders",
  ])("refuses: %s", async (sql) => {
    await expect(runLocalSelect(sql, freshTables())).rejects.toThrow();
  });

  it("reports an unknown table rather than returning empty results", async () => {
    await expect(runLocalSelect("SELECT * FROM does_not_exist", freshTables())).rejects.toThrow();
  });
});

describe("the engine names itself", () => {
  it("reports which engine ran, so callers can log or surface it", async () => {
    const r = await runLocalSelect("SELECT id FROM orders LIMIT 1", freshTables());
    expect(["alasql", "duckdb"]).toContain(r.engine);
  });
});
