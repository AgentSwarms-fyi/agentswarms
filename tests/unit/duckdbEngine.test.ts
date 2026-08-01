// The DuckDB engine adapter itself — the seam between DuckDB's type system
// and this app's, which is where the sharp edges are.
import { afterEach, describe, expect, it } from "vitest";

import {
  duckdbEnabled,
  runLocalSqlDuckDB,
  toJsValue,
  type DuckTable,
} from "@/utils/data/duckdb.server";

describe("the opt-out flag", () => {
  const original = process.env.LOCAL_ENGINE;
  afterEach(() => {
    if (original === undefined) delete process.env.LOCAL_ENGINE;
    else process.env.LOCAL_ENGINE = original;
  });

  it("is on unless explicitly opted out of", () => {
    delete process.env.LOCAL_ENGINE;
    expect(duckdbEnabled()).toBe(true);
  });

  it("takes the escape hatch case- and whitespace-insensitively", () => {
    for (const v of ["alasql", "AlaSQL", "  ALASQL  "]) {
      process.env.LOCAL_ENGINE = v;
      expect(duckdbEnabled()).toBe(false);
    }
  });

  it("treats an unrecognised value as the default engine, not as opting out", () => {
    // A typo must not silently downgrade the engine. Under the old opt-in
    // reading LOCAL_ENGINE=duckdbb left you on AlaSQL and nothing said so;
    // only an exact "alasql" now moves you off the default.
    for (const v of ["", "duckdb", "duck", "alasq", "true", "1"]) {
      process.env.LOCAL_ENGINE = v;
      expect(duckdbEnabled(), `LOCAL_ENGINE=${JSON.stringify(v)}`).toBe(true);
    }
  });
});

const t = (over: Partial<DuckTable> = {}): DuckTable => ({
  name: "t",
  columns: [
    { name: "id", type: "number" },
    { name: "label", type: "string" },
  ],
  rows: [
    { id: 1, label: "a" },
    { id: 2, label: "b" },
  ],
  ...over,
});

describe("values crossing back into JS", () => {
  it("COUNT returns a JS number, not a BigInt", async () => {
    // DuckDB returns BIGINT for COUNT. A BigInt makes JSON.stringify throw,
    // so an unconverted value would surface as a 500, not a wrong number.
    const r = await runLocalSqlDuckDB("SELECT COUNT(*) AS n FROM t", [t()]);
    expect(typeof r.rows[0].n).toBe("number");
    expect(r.rows[0].n).toBe(2);
    expect(() => JSON.stringify(r.rows)).not.toThrow();
  });

  it("DECIMAL becomes a number rather than [object Object]", async () => {
    const r = await runLocalSqlDuckDB("SELECT CAST(1.25 AS DECIMAL(10,2)) AS d FROM t LIMIT 1", [
      t(),
    ]);
    expect(r.rows[0].d).toBe(1.25);
  });

  it("every result is JSON-serialisable", async () => {
    const r = await runLocalSqlDuckDB(
      "SELECT COUNT(*) AS n, SUM(id) AS s, AVG(id) AS a, MIN(label) AS lo FROM t",
      [t()],
    );
    expect(() => JSON.stringify(r.rows)).not.toThrow();
  });

  describe("toJsValue", () => {
    it("keeps a safe BigInt exact as a number", () => {
      expect(toJsValue(BigInt(42))).toBe(42);
    });

    it("falls back to a string beyond Number's safe range", () => {
      // Silently losing precision on a large SUM would be worse than a string.
      const huge = BigInt(Number.MAX_SAFE_INTEGER) + BigInt(10);
      expect(toJsValue(huge)).toBe(huge.toString());
    });

    it("maps null and undefined to null", () => {
      expect(toJsValue(null)).toBeNull();
      expect(toJsValue(undefined)).toBeNull();
    });

    it("passes primitives through untouched", () => {
      expect(toJsValue(1.5)).toBe(1.5);
      expect(toJsValue("x")).toBe("x");
      expect(toJsValue(false)).toBe(false);
      expect(toJsValue("")).toBe("");
    });

    it("renders a Date as an ISO string", () => {
      expect(toJsValue(new Date("2026-03-04T00:00:00.000Z"))).toBe("2026-03-04T00:00:00.000Z");
    });
  });
});

describe("NULL and the empty string stay distinct", () => {
  const mixed = t({
    columns: [
      { name: "id", type: "number" },
      { name: "s", type: "string" },
    ],
    rows: [
      { id: 1, s: "" },
      { id: 2, s: null },
      { id: 3, s: "x" },
    ],
  });

  it("an empty string is not loaded as NULL", async () => {
    const r = await runLocalSqlDuckDB("SELECT id FROM t WHERE s IS NULL", [mixed]);
    expect(r.rows.map((x) => x.id)).toEqual([2]);
  });

  it("an empty string is matchable as itself", async () => {
    const r = await runLocalSqlDuckDB("SELECT id FROM t WHERE s = ''", [mixed]);
    expect(r.rows.map((x) => x.id)).toEqual([1]);
  });

  it("an empty numeric cell is NULL, because it holds no number", async () => {
    const nums = t({
      columns: [{ name: "n", type: "number" }],
      rows: [{ n: "" }, { n: 5 }],
    });
    const r = await runLocalSqlDuckDB("SELECT COUNT(n) AS n FROM t", [nums]);
    expect(r.rows[0].n).toBe(1);
  });
});

describe("column names from real files", () => {
  it("handles spaces, punctuation and non-ASCII", async () => {
    const odd = t({
      columns: [
        { name: "Order ID", type: "string" },
        { name: "Größe", type: "number" },
      ],
      rows: [{ "Order ID": "A-1", Größe: 3 }],
    });
    const r = await runLocalSqlDuckDB(`SELECT "Order ID", "Größe" FROM t`, [odd]);
    expect(r.rows[0]["Order ID"]).toBe("A-1");
    expect(r.rows[0]["Größe"]).toBe(3);
  });

  it("a column name containing a double quote cannot break out", async () => {
    // Identifier quoting doubles embedded quotes; without that this is an
    // injection point, since column names come from user file headers.
    const evil = t({
      columns: [{ name: 'a" , x INTEGER); DROP TABLE t; --', type: "string" }],
      rows: [{ 'a" , x INTEGER); DROP TABLE t; --': "safe" }],
    });
    const r = await runLocalSqlDuckDB("SELECT * FROM t", [evil]);
    expect(r.rows).toHaveLength(1);
    expect(Object.values(r.rows[0])[0]).toBe("safe");
  });

  it("refuses an unsafe table name instead of interpolating it", async () => {
    await expect(
      runLocalSqlDuckDB("SELECT 1", [t({ name: 'x"; DROP TABLE y; --' })]),
    ).rejects.toThrow(/unsafe table name/i);
  });
});

describe("read-only enforcement", () => {
  it.each([
    "INSERT INTO t VALUES (3, 'c')",
    "UPDATE t SET label = 'z'",
    "DELETE FROM t",
    "DROP TABLE t",
    "CREATE TABLE evil (id int)",
    "ATTACH 'x.db' AS x",
    "SELECT 1; DROP TABLE t",
  ])("refuses %s", async (sql) => {
    await expect(runLocalSqlDuckDB(sql, [t()])).rejects.toThrow();
  });
});

describe("shape and edge cases", () => {
  it("an empty dataset is still queryable", async () => {
    const r = await runLocalSqlDuckDB("SELECT COUNT(*) AS n FROM t", [t({ rows: [] })]);
    expect(r.rows[0].n).toBe(0);
  });

  it("a dataset with no declared schema derives columns from its rows", async () => {
    const r = await runLocalSqlDuckDB("SELECT a FROM t", [
      t({ columns: [], rows: [{ a: "1" }, { a: "2" }] }),
    ]);
    expect(r.rows.map((x) => x.a)).toEqual(["1", "2"]);
  });

  it("reports coercion failures rather than hiding them", async () => {
    const r = await runLocalSqlDuckDB("SELECT COUNT(n) AS n FROM t", [
      t({ columns: [{ name: "n", type: "number" }], rows: [{ n: "abc" }, { n: 1 }] }),
    ]);
    expect(r.coercionFailures).toBe(1);
    expect(r.rows[0].n).toBe(1);
  });

  it("parses thousands separators in numeric columns", async () => {
    const r = await runLocalSqlDuckDB("SELECT SUM(n) AS s FROM t", [
      t({ columns: [{ name: "n", type: "number" }], rows: [{ n: "1,234" }, { n: 1 }] }),
    ]);
    expect(r.rows[0].s).toBe(1235);
  });

  it("applies a row cap when asked", async () => {
    const many = t({
      columns: [{ name: "n", type: "number" }],
      rows: Array.from({ length: 50 }, (_, i) => ({ n: i })),
    });
    const r = await runLocalSqlDuckDB("SELECT n FROM t ORDER BY n", [many], { rowCap: 5 });
    expect(r.rows).toHaveLength(5);
  });

  it("surfaces the column list even when no rows match", async () => {
    const r = await runLocalSqlDuckDB("SELECT id, label FROM t WHERE id > 999", [t()]);
    expect(r.rows).toHaveLength(0);
    expect(r.columns).toEqual(["id", "label"]);
  });

  it("reports a SQL error rather than returning empty results", async () => {
    await expect(runLocalSqlDuckDB("SELECT nope FROM t", [t()])).rejects.toThrow();
  });

  it("each call gets its own database", async () => {
    // Tenant isolation depends on this: one query must never see another's
    // tables, whatever ran before it.
    await runLocalSqlDuckDB("SELECT 1", [t({ name: "secret_table" })]);
    await expect(runLocalSqlDuckDB("SELECT * FROM secret_table", [t()])).rejects.toThrow();
  });

  it("joins two loaded datasets", async () => {
    const a = t({
      name: "a",
      columns: [{ name: "k", type: "number" }],
      rows: [{ k: 1 }, { k: 2 }],
    });
    const b = t({
      name: "b",
      columns: [
        { name: "k", type: "number" },
        { name: "v", type: "string" },
      ],
      rows: [{ k: 2, v: "two" }],
    });
    const r = await runLocalSqlDuckDB(
      "SELECT a.k, b.v FROM a LEFT JOIN b ON a.k = b.k ORDER BY a.k",
      [a, b],
    );
    expect(r.rows).toEqual([
      { k: 1, v: null },
      { k: 2, v: "two" },
    ]);
  });
});
