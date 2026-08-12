// The measurement half of Validate, run against the real local engine.
//
// Declarations protect compiles; MEASUREMENT protects declarations. These
// tests feed known-shape data through measureModelHealth/checkAssertions with
// a real DuckDB exec — the same functions semanticValidateModel calls — and
// assert that what the data proves overrides what the model claims.
import { describe, expect, it } from "vitest";

import { checkAssertions, measureModelHealth, type ExecRows } from "@/lib/semanticMeasure";
import type { JoinCardinality, SemanticModel } from "@/lib/semanticLayer";
import { runLocalSqlDuckDB, type DuckTable } from "@/utils/data/duckdb.server";

const orders: DuckTable = {
  name: "orders",
  columns: [
    { name: "order_id", type: "string" },
    { name: "region", type: "string" },
    { name: "amount", type: "number" },
  ],
  rows: [
    { order_id: "A", region: "EMEA", amount: 100 },
    { order_id: "B", region: "EMEA", amount: 50 },
    { order_id: "C", region: "APAC", amount: 70 },
  ],
};

// A fans (2 items), B has none (an INNER join drops it), C has exactly one.
// INNER joined row count: 2 + 0 + 1 = 3 = base count — the bare COUNT(*) sees
// NOTHING, which is precisely the case the distinct-key probe exists for.
const items: DuckTable = {
  name: "order_items",
  columns: [
    { name: "order_id", type: "string" },
    { name: "qty", type: "number" },
  ],
  rows: [
    { order_id: "A", qty: 1 },
    { order_id: "A", qty: 2 },
    { order_id: "C", qty: 5 },
  ],
};

// One row per order — a genuine lookup.
const status: DuckTable = {
  name: "order_status",
  columns: [
    { name: "order_id", type: "string" },
    { name: "state", type: "string" },
  ],
  rows: [
    { order_id: "A", state: "paid" },
    { order_id: "B", state: "open" },
    { order_id: "C", state: "paid" },
  ],
};

const exec: ExecRows = async (sql) => (await runLocalSqlDuckDB(sql, [orders, items, status])).rows;

function model(over: Partial<SemanticModel> = {}): SemanticModel {
  return {
    name: "m",
    source: { kind: "data_table", table: "orders" },
    primaryKey: "order_id",
    joins: [],
    dimensions: [
      { name: "region", sql: "orders.region", type: "categorical" },
      { name: "day", sql: "orders.region", type: "time" },
    ],
    metrics: [
      { name: "revenue", agg: "sum", sql: "orders.amount" },
      { name: "orders_n", agg: "count_distinct", sql: "orders.order_id" },
    ],
    ...over,
  };
}

const itemsJoin = (cardinality?: JoinCardinality) => ({
  table: "order_items",
  type: "left" as const,
  on: "orders.order_id = order_items.order_id",
  ...(cardinality ? { cardinality } : {}),
});

describe("measureModelHealth — joins", () => {
  it("an UNDECLARED join that fans out is an issue naming the fix", async () => {
    const r = await measureModelHealth(exec, model({ joins: [itemsJoin()] }), "duckdb");
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]).toMatchObject({ kind: "join", name: "order_items" });
    expect(r.issues[0].error).toMatch(/fans out in the data \(3 rows → 4\).*one_to_many/s);
  });

  it("a declared-safe join contradicted by the data is an issue", async () => {
    const r = await measureModelHealth(
      exec,
      model({ joins: [itemsJoin("many_to_one")] }),
      "duckdb",
    );
    expect(r.issues.map((i) => i.error).join()).toMatch(
      /declared many_to_one but MEASURES fan-out: 3 rows → 4/,
    );
  });

  it("a correctly declared one_to_many raises nothing", async () => {
    const r = await measureModelHealth(
      exec,
      model({ joins: [itemsJoin("one_to_many")] }),
      "duckdb",
    );
    expect(r.issues).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.measured).toEqual([
      { name: "(source)", rows: 3, distinct: 3 },
      { name: "order_items", rows: 4, distinct: 3 },
    ]);
  });

  it("an undeclared join that measures 1:1 is a warning, not an error", async () => {
    const lookupJoin = {
      table: "order_status",
      type: "left" as const,
      on: "orders.order_id = order_status.order_id",
    };
    const r = await measureModelHealth(exec, model({ joins: [lookupJoin] }), "duckdb");
    expect(r.issues).toEqual([]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0].note).toMatch(/measures 1:1.*Declare its cardinality/s);
  });

  it("THE MASKED CASE: an INNER join whose drops offset its duplicates is still caught via the key", async () => {
    // COUNT(*): 3 → 3. Without the declared key this fan-out is invisible.
    const inner = { ...itemsJoin(), type: "inner" as const };
    const r = await measureModelHealth(exec, model({ joins: [inner] }), "duckdb");
    expect(r.measured).toEqual([
      { name: "(source)", rows: 3, distinct: 3 },
      { name: "order_items", rows: 3, distinct: 2 },
    ]);
    expect(r.issues.map((i) => i.error).join()).toMatch(/fans out in the data/);
  });

  it("without a primary key the masked INNER case honestly warns instead of pretending", async () => {
    const inner = { ...itemsJoin(), type: "inner" as const };
    const r = await measureModelHealth(
      exec,
      model({ joins: [inner], primaryKey: undefined }),
      "duckdb",
    );
    // n stayed 3 → no fan detectable; the warning says the measurement is
    // blind here and why.
    expect(r.issues).toEqual([]);
    expect(r.warnings.map((w) => w.note).join()).toMatch(/INNER join.*no primary key.*mask/s);
  });

  it("cardinality attribution is PER JOIN, not just cumulative", async () => {
    const r = await measureModelHealth(
      exec,
      model({
        joins: [
          {
            table: "order_status",
            type: "left",
            on: "orders.order_id = order_status.order_id",
            cardinality: "many_to_one",
          },
          itemsJoin(),
        ],
      }),
      "duckdb",
    );
    // The lookup is clean; the fan-out lands on the second join only.
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0].name).toBe("order_items");
  });

  it("a clean lookup AFTER a fanning join is not blamed for the earlier fan-out", async () => {
    // Attribution must compare each step against the PREVIOUS step, not the
    // base. If `prev` ever stops advancing, the fan-out of join 1 is
    // re-attributed to join 2 and a correct lookup gets accused.
    const r = await measureModelHealth(
      exec,
      model({
        joins: [
          itemsJoin("one_to_many"),
          {
            table: "order_status",
            type: "left",
            on: "orders.order_id = order_status.order_id",
          },
        ],
      }),
      "duckdb",
    );
    expect(r.issues).toEqual([]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatchObject({ kind: "join", name: "order_status" });
  });

  it("a broken ON condition surfaces as that join's issue, not a crash", async () => {
    const bad = {
      table: "order_items",
      type: "left" as const,
      on: "orders.nope = order_items.order_id",
    };
    const r = await measureModelHealth(exec, model({ joins: [bad] }), "duckdb");
    expect(r.issues.some((i) => i.kind === "join" && /could not be measured/i.test(i.error))).toBe(
      true,
    );
  });
});

describe("measureModelHealth — grain", () => {
  it("a non-unique primary key is an issue with the real counts", async () => {
    const r = await measureModelHealth(exec, model({ primaryKey: "region" }), "duckdb");
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0].error).toMatch(/"region" is not unique on orders: 3 rows but 2 distinct/);
  });

  it("a unique key passes silently", async () => {
    const r = await measureModelHealth(exec, model(), "duckdb");
    expect(r.issues).toEqual([]);
  });

  it("no joins and no key → nothing to measure, nothing invented", async () => {
    const r = await measureModelHealth(exec, model({ primaryKey: undefined }), "duckdb");
    expect(r).toEqual({ issues: [], warnings: [], measured: [] });
  });
});

describe("checkAssertions", () => {
  const m = model();

  it("a true pin passes", async () => {
    const r = await checkAssertions(
      exec,
      m,
      [
        {
          metric: "revenue",
          filters: [{ field: "region", op: "=", value: "EMEA" }],
          expected: 150,
        },
      ],
      "duckdb",
    );
    expect(r).toEqual({ issues: [], checked: 1 });
  });

  it("definition/data drift fails with both numbers", async () => {
    const r = await checkAssertions(
      exec,
      m,
      [{ metric: "revenue", expected: 999, label: "Q1 board deck" }],
      "duckdb",
    );
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]).toMatchObject({ kind: "assertion", name: "Q1 board deck" });
    expect(r.issues[0].error).toMatch(/expected 999, got 220/);
  });

  it("the default tolerance is far too small to hide a half-unit drift", async () => {
    const r = await checkAssertions(exec, m, [{ metric: "revenue", expected: 220.5 }], "duckdb");
    expect(r.issues).toHaveLength(1);
  });

  it("an explicit tolerance is honored in both directions", async () => {
    const pass = await checkAssertions(
      exec,
      m,
      [{ metric: "revenue", expected: 220.5, tolerance: 2 }],
      "duckdb",
    );
    expect(pass.issues).toEqual([]);
    const fail = await checkAssertions(
      exec,
      m,
      [{ metric: "revenue", expected: 220.5, tolerance: 0.1 }],
      "duckdb",
    );
    expect(fail.issues).toHaveLength(1);
  });

  it("a filter matching nothing reports 'no value', not a fake zero", async () => {
    const r = await checkAssertions(
      exec,
      m,
      [{ metric: "revenue", filters: [{ field: "region", op: "=", value: "MARS" }], expected: 0 }],
      "duckdb",
    );
    expect(r.issues[0]?.error).toMatch(/produced no value/);
  });

  it("an unknown metric or filter field is that assertion's issue, not a crash", async () => {
    const r = await checkAssertions(exec, m, [{ metric: "nope", expected: 1 }], "duckdb");
    expect(r.issues[0]?.error).toMatch(/Unknown metric "nope"/);
  });
});

describe("assertion schema — the zod rules the server enforces", () => {
  it("refuses a relative-date filter and says why", async () => {
    const { assertionSchema } = await import("@/utils/semantic.functions");
    const bad = assertionSchema.safeParse({
      metric: "revenue",
      filters: [{ field: "day", op: "ytd" }],
      expected: 100,
    });
    expect(bad.success).toBe(false);
    expect(JSON.stringify(bad.error?.issues)).toMatch(/absolute filters.*go stale/s);
  });

  it("accepts an absolute range", async () => {
    const { assertionSchema } = await import("@/utils/semantic.functions");
    const ok = assertionSchema.safeParse({
      metric: "revenue",
      filters: [
        { field: "day", op: ">=", value: "2025-01-01" },
        { field: "day", op: "<", value: "2025-04-01" },
      ],
      expected: 100,
      tolerance: 0.5,
      label: "Q1",
    });
    expect(ok.success).toBe(true);
  });
});

describe("semanticValidateModel wiring (source guard)", () => {
  // The server fn cannot run without live auth; what CAN be pinned is that it
  // calls the real helpers and surfaces their results. Removing either call
  // silently reverts Validate to "the SQL runs" — the exact blindness this
  // work removed.
  it("validate calls both measurement helpers and returns their findings", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/utils/semantic.functions.ts", "utf8");
    expect(src).toMatch(/await measureModelHealth\(exec, model, dialect\)/);
    expect(src).toMatch(/issues\.push\(\.\.\.health\.issues\)/);
    expect(src).toMatch(/await checkAssertions\(exec, model, m\.assertions \?\? \[\], dialect\)/);
    expect(src).toMatch(/issues\.push\(\.\.\.asserted\.issues\)/);
    expect(src).toMatch(/warnings: health\.warnings/);
    expect(src).toMatch(/measured: health\.measured/);
  });

  it("the upsert row persists the new fields", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/utils/semantic.functions.ts", "utf8");
    expect(src).toMatch(/primary_key: m\.primary_key\?\.trim\(\)/);
    expect(src).toMatch(/assertions: \(m\.assertions \?\? \[\]\) as never/);
  });
});
