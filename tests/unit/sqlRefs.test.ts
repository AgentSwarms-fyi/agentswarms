// One SQL table-reference parser, shared by the catalog lineage index, the
// warehouse-query audit, the object-store query planner and the analyst
// lineage panel.
//
// It has to be wrong in NEITHER direction, and the two directions have
// different victims:
//   - a FALSE POSITIVE is a false statement — the lineage panel says an answer
//     read a table the query never opened, the audit records a table nobody
//     touched;
//   - a FALSE NEGATIVE breaks things — the object-store planner fetches no
//     file and the query fails, the catalog lineage silently loses an edge.
//
// The regex this replaced was wrong in the first direction (comments, string
// literals, CTE aliases). A scanner that treats quoted runs as opaque — which
// is the right call for KEYWORD detection — is wrong in the second, and
// spectacularly: on `FROM "orders" WHERE x` it reports WHERE as the table.
import { describe, expect, it } from "vitest";

import { extractTableRefs, scanWords } from "@/lib/sqlRefs";

describe("names that are not tables", () => {
  it("ignores a table named only in a line comment", () => {
    expect(extractTableRefs("SELECT 1 FROM orders -- was: from legacy_orders\n")).toEqual([
      "orders",
    ]);
  });

  it("ignores a table named only in a block comment", () => {
    expect(extractTableRefs("SELECT 1 /* from archived_orders */ FROM orders")).toEqual(["orders"]);
  });

  it("ignores a table named only inside a string literal", () => {
    expect(
      extractTableRefs("SELECT 1 FROM orders WHERE note = 'imported from stripe_charges'"),
    ).toEqual(["orders"]);
  });

  it("ignores an escaped quote inside a literal rather than ending it early", () => {
    // 'it''s from ghost' is ONE literal. Ending it at the doubled quote would
    // expose `from ghost` as SQL.
    expect(extractTableRefs("SELECT 1 FROM orders WHERE n = 'it''s from ghost'")).toEqual([
      "orders",
    ]);
  });

  it("drops CTE aliases — computed in the query, not read from storage", () => {
    expect(extractTableRefs("WITH t AS (SELECT 1 FROM orders) SELECT * FROM t")).toEqual([
      "orders",
    ]);
  });

  it("keeps a real table a CTE selects from, and the CTE's own sources", () => {
    expect(
      extractTableRefs(
        "WITH regional AS (SELECT * FROM orders) SELECT * FROM regional JOIN customers ON 1=1",
      ),
    ).toEqual(["orders", "customers"]);
  });

  it("descends into a subquery rather than naming the paren", () => {
    expect(extractTableRefs("SELECT * FROM (SELECT 1 FROM orders) AS x")).toEqual(["orders"]);
  });

  it("names a table once however many times the query reads it", () => {
    expect(
      extractTableRefs("SELECT * FROM orders WHERE id IN (SELECT id FROM orders WHERE amount > 0)"),
    ).toEqual(["orders"]);
  });
});

describe("quoted identifiers are still tables", () => {
  // The failure this guards is not cosmetic: the object-store planner
  // intersects these names against the files it holds, and finding none fails
  // the query outright.
  it("finds a double-quoted table", () => {
    expect(extractTableRefs('SELECT 1 FROM "orders"')).toEqual(["orders"]);
  });

  it("does NOT report the following keyword as the table", () => {
    // A scanner that skips quoted runs returns ["where"] here.
    expect(extractTableRefs('SELECT 1 FROM "orders" WHERE x = 1')).toEqual(["orders"]);
  });

  it("joins a quoted schema to a quoted table", () => {
    expect(extractTableRefs('SELECT 1 FROM "sales"."orders"')).toEqual(["sales.orders"]);
  });

  it("joins across mixed quoting", () => {
    expect(extractTableRefs('SELECT 1 FROM "sales".orders JOIN `raw`.events ON 1=1')).toEqual([
      "sales.orders",
      "raw.events",
    ]);
  });

  it("finds backticked and bracketed tables", () => {
    expect(extractTableRefs("SELECT 1 FROM `orders`")).toEqual(["orders"]);
    expect(extractTableRefs("SELECT 1 FROM [orders]")).toEqual(["orders"]);
    expect(extractTableRefs("SELECT 1 FROM [orders] WHERE x = 1")).toEqual(["orders"]);
  });

  it("keeps a fully-qualified name inside one backticked run", () => {
    expect(extractTableRefs("SELECT 1 FROM `proj.ds.orders`")).toEqual(["proj.ds.orders"]);
  });

  it("does not treat a quoted word as the FROM keyword itself", () => {
    // `SELECT "from" FROM orders` — the quoted "from" is a column.
    expect(extractTableRefs('SELECT "from" FROM orders')).toEqual(["orders"]);
  });
});

describe("the scanner keeps quoting distinguishable", () => {
  // biDrillThrough decides whether a word is a clause keyword. It must be able
  // to tell `ORDER BY` from a column named "order", which is exactly what the
  // quoted flag is for.
  it("marks quoted words and leaves bare words unmarked", () => {
    const words = scanWords('SELECT "order" FROM t ORDER BY 1');
    const order = words.filter((w) => w.word === "ORDER");
    expect(order).toHaveLength(2);
    expect(order[0].quoted).toBe(true); // the column
    expect(order[1].quoted).toBeUndefined(); // the clause
  });

  it("reports offsets INSIDE the quotes, so slicing yields the bare name", () => {
    const sql = 'SELECT 1 FROM "orders"';
    const w = scanWords(sql).find((x) => x.quoted)!;
    expect(sql.slice(w.start, w.end)).toBe("orders");
  });

  it("tracks paren depth for the words that follow", () => {
    const words = scanWords("SELECT * FROM (SELECT 1 FROM inner_t) x");
    expect(words.find((w) => w.word === "INNER_T")?.depth).toBe(1);
    expect(words.find((w) => w.word === "FROM")?.depth).toBe(0);
  });

  it("emits nothing for an empty quoted run rather than a blank word", () => {
    expect(scanWords('SELECT 1 FROM ""').some((w) => w.word === "")).toBe(false);
  });
});

describe("nothing to find", () => {
  it("survives empty and table-free SQL", () => {
    expect(extractTableRefs("")).toEqual([]);
    expect(extractTableRefs("SELECT 1")).toEqual([]);
  });
});
