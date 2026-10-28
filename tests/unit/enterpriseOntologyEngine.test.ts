// Enterprise Ontology, run for real: the sample business is created in an
// in-memory DuckDB (the lakehouse's engine) and every kind of compiled query
// is executed and checked against a hand-written query over the raw tables —
// never against the compiler's own output, so a wrong join cannot agree with
// itself.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import {
  compileAction,
  compileGetObject,
  compileLinked,
  compileMetric,
  compileObjectSet,
  compileRule,
  impliedRules,
  type CompileOpts,
} from "@/lib/ontology/compile";
import { sampleSpec, sampleSql } from "@/lib/ontology/sample";
import { validateSpec } from "@/lib/ontology/validate";
import type { OntologySpec } from "@/lib/ontology/spec";

const SCHEMA = "ontology_sample";
let conn: DuckDBConnection;
let spec: OntologySpec;
const owner: CompileOpts = { seeRestricted: true, maxRows: 5000 };

async function rows(sql: string): Promise<Record<string, unknown>[]> {
  return (await conn.runAndReadAll(sql)).getRowObjectsJson() as Record<string, unknown>[];
}
async function one(sql: string): Promise<Record<string, unknown>> {
  return (await rows(sql))[0];
}
const num = (v: unknown) => Number(v);

beforeAll(async () => {
  conn = await (await DuckDBInstance.create(":memory:")).connect();
  await conn.run(`CREATE SCHEMA ${SCHEMA}`);
  for (const sql of sampleSql(SCHEMA)) await conn.run(sql);
  spec = sampleSpec(SCHEMA);
}, 120_000);

afterAll(() => conn?.closeSync());

describe("the sample business", () => {
  it("is a valid ontology", () => {
    const r = validateSpec(spec);
    expect(r.issues.filter((i) => i.level === "error")).toEqual([]);
  });

  it("has the rows the sample promises", async () => {
    expect(num((await one(`SELECT count(*) AS n FROM ${SCHEMA}.orders`)).n)).toBe(600);
    expect(num((await one(`SELECT count(*) AS n FROM ${SCHEMA}.customers`)).n)).toBe(120);
    expect(num((await one(`SELECT count(*) AS n FROM ${SCHEMA}.order_lines`)).n)).toBe(1500);
  });
});

describe("object sets compile to SQL the engine runs, with the right answer", () => {
  it("counts a type, and a filtered subtype, like the raw table does", async () => {
    const all = compileObjectSet(spec, { objectType: "Customer" }, owner);
    expect(num((await one(all.countSql!)).n)).toBe(120);
    const vip = compileObjectSet(spec, { objectType: "VipCustomer" }, owner);
    const expected = num(
      (await one(`SELECT count(*) AS n FROM ${SCHEMA}.customers WHERE segment = 'Enterprise'`)).n,
    );
    expect(expected).toBeGreaterThan(0);
    expect(num((await one(vip.countSql!)).n)).toBe(expected);
  });

  it("filters with typed literals and an enum value", async () => {
    const c = compileObjectSet(
      spec,
      {
        objectType: "Order",
        filters: [
          { property: "status", op: "eq", value: "delivered" },
          { property: "ordered_on", op: "gte", value: "2025-01-01" },
          { property: "total_amount", op: "gt", value: "100" },
        ],
        limit: 5000,
      },
      owner,
    );
    const got = await rows(c.sql);
    const exp = num(
      (
        await one(
          `SELECT count(*) AS n FROM ${SCHEMA}.orders WHERE status = 'delivered' AND ordered_on >= DATE '2025-01-01' AND total_amount > 100`,
        )
      ).n,
    );
    expect(got.length).toBe(exp);
    expect(num((await one(c.countSql!)).n)).toBe(exp);
  });

  it("searches the string properties", async () => {
    const c = compileObjectSet(
      spec,
      { objectType: "Product", search: "backpack", limit: 100 },
      owner,
    );
    const got = await rows(c.sql);
    expect(got.length).toBeGreaterThan(0);
    for (const r of got) expect(String(r.name).toLowerCase()).toContain("backpack");
  });

  it("walks a link forward: the customers of delivered orders", async () => {
    const c = compileObjectSet(
      spec,
      {
        objectType: "Order",
        filters: [{ property: "status", op: "eq", value: "delivered" }],
        path: [{ link: "placed_by", direction: "forward" }],
        limit: 5000,
      },
      owner,
    );
    const exp = num(
      (
        await one(
          `SELECT count(DISTINCT c.customer_id) AS n FROM ${SCHEMA}.orders o JOIN ${SCHEMA}.customers c USING (customer_id) WHERE o.status = 'delivered'`,
        )
      ).n,
    );
    expect((await rows(c.sql)).length).toBe(exp);
    expect(num((await one(c.countSql!)).n)).toBe(exp);
  });

  it("walks a link backward and then through a join table", async () => {
    // Products ordered by customer 7: Customer ← orders, then Order → contains (join table).
    const c = compileObjectSet(
      spec,
      {
        objectType: "Customer",
        filters: [{ property: "customer_id", op: "eq", value: 7 }],
        path: [
          { link: "orders", direction: "inverse" },
          { link: "contains", direction: "forward" },
        ],
        limit: 5000,
      },
      owner,
    );
    const exp = num(
      (
        await one(
          `SELECT count(DISTINCT l.product_id) AS n FROM ${SCHEMA}.orders o JOIN ${SCHEMA}.order_lines l ON l.order_id = o.order_id WHERE o.customer_id = 7`,
        )
      ).n,
    );
    expect(num((await one(c.countSql!)).n)).toBe(exp);
  });

  it("reads one object by key, and the objects linked to it", async () => {
    const g = compileGetObject(spec, "Order", { order_id: 1005 }, owner);
    const got = await rows(g.sql);
    expect(got).toHaveLength(1);
    expect(num(got[0].order_id)).toBe(1005);
    const lines = compileLinked(
      spec,
      "Order",
      { order_id: 1005 },
      { link: "lines", direction: "inverse" },
      owner,
    );
    const exp = num(
      (await one(`SELECT count(*) AS n FROM ${SCHEMA}.order_lines WHERE order_id = 1005`)).n,
    );
    expect(num((await one(lines.countSql!)).n)).toBe(exp);
  });

  it("evaluates derived properties", async () => {
    const c = compileObjectSet(
      spec,
      { objectType: "OrderLine", filters: [{ property: "line_id", op: "eq", value: 3 }] },
      owner,
    );
    const [r] = await rows(c.sql);
    const raw = await one(
      `SELECT round(quantity * unit_price * (1 - discount), 2) AS t FROM ${SCHEMA}.order_lines WHERE line_id = 3`,
    );
    expect(num(r.line_total)).toBeCloseTo(num(raw.t), 6);
  });
});

describe("metrics", () => {
  it("totals revenue like the raw table", async () => {
    const c = compileMetric(spec, { objectType: "Order", metric: "revenue" }, owner);
    const [r] = await rows(c.sql);
    const raw = await one(`SELECT sum(total_amount) AS s FROM ${SCHEMA}.orders`);
    expect(num(r.revenue)).toBeCloseTo(num(raw.s), 4);
  });

  it("breaks revenue down by the customer's segment through a to-one link", async () => {
    const c = compileMetric(
      spec,
      {
        objectType: "Order",
        metric: "revenue",
        groupBy: [{ property: "segment", path: [{ link: "placed_by", direction: "forward" }] }],
      },
      owner,
    );
    const got = await rows(c.sql);
    const exp = await rows(
      `SELECT c.segment AS seg, sum(o.total_amount) AS s FROM ${SCHEMA}.orders o LEFT JOIN ${SCHEMA}.customers c USING (customer_id) GROUP BY 1`,
    );
    const key = Object.keys(got[0]).find((k) => k.endsWith("_segment"))!;
    const toMap = (rs: Record<string, unknown>[], k: string, v: string) =>
      new Map(rs.map((r) => [String(r[k]), num(r[v])]));
    const a = toMap(got, key, "revenue");
    const b = toMap(exp, "seg", "s");
    expect([...a.keys()].sort()).toEqual([...b.keys()].sort());
    for (const [k, v] of b) expect(a.get(k)).toBeCloseTo(v, 4);
    // The total still adds up: the orphan order's revenue sits under "null".
    const total = [...a.values()].reduce((x, y) => x + y, 0);
    expect(total).toBeCloseTo(
      num((await one(`SELECT sum(total_amount) AS s FROM ${SCHEMA}.orders`)).s),
      3,
    );
  });

  it("buckets by month", async () => {
    const c = compileMetric(
      spec,
      {
        objectType: "Order",
        metric: "order_count",
        groupBy: [{ property: "ordered_on", grain: "month" }],
        order: "group_asc",
      },
      owner,
    );
    const got = await rows(c.sql);
    expect(got.reduce((s, r) => s + num(r.order_count), 0)).toBe(600);
  });
});

describe("rules find the rows the sample breaks on purpose", () => {
  const run = async (id: string) => {
    const rule = [...spec.rules, ...impliedRules(spec)].find((r) => r.id === id);
    if (!rule) throw new Error(`no rule ${id}`);
    const c = compileRule(spec, rule, { ...owner, sample: 10 });
    const counts = await one(c.checkSql);
    return {
      violations: num(counts.violations),
      checked: num(counts.checked),
      sample: await rows(c.sampleSql),
    };
  };

  it("two order lines with a negative quantity", async () => {
    const r = await run("line-quantity-positive");
    expect(r.violations).toBe(2);
    expect(r.sample.map((s) => num(s.line_id)).sort((a, b) => a - b)).toEqual([777, 1201]);
    // Each example shows what the condition read, so it says why it breaks.
    for (const s of r.sample) expect(num(s.quantity)).toBeLessThanOrEqual(0);
  });

  it("two customers whose e-mail is not an e-mail (the value type's pattern)", async () => {
    const r = await run("auto-customer-email-pattern");
    expect(r.violations).toBe(2);
    expect(r.sample.map((s) => num(s.customer_id)).sort((a, b) => a - b)).toEqual([17, 58]);
  });

  it("two orders in a status the vocabulary does not have", async () => {
    const r = await run("auto-order-status-values");
    expect(r.violations).toBe(2);
  });

  it("one order whose customer does not exist (the link's target)", async () => {
    const r = await run("auto-order-placed_by-exists");
    expect(r.violations).toBe(1);
    expect(num(r.sample[0].order_id)).toBe(1333);
    // And the key it points with, which is the one that names no customer.
    expect(r.sample[0]).toHaveProperty("customer_id");
    expect(r.sample[0].customer_id).not.toBeNull();
  });

  it("keys that are unique pass", async () => {
    const r = await run("auto-order-order_id-key");
    expect(r.violations).toBe(0);
    expect(r.checked).toBe(600);
  });

  it("the negative quantities make order totals the rule watches", async () => {
    const r = await run("order-total-not-negative");
    const exp = num(
      (await one(`SELECT count(*) AS n FROM ${SCHEMA}.orders WHERE total_amount < 0`)).n,
    );
    expect(r.violations).toBe(exp);
  });
});

describe("actions write what they say", () => {
  it("modify: before, criteria, update, after", async () => {
    const a = spec.actionTypes.find((x) => x.name === "update_status")!;
    const w = compileAction(spec, a, { order_id: 1010 }, { status: "returned" });
    const before = await rows(w.beforeSql!);
    expect(before).toHaveLength(1);
    const ok = await one(w.criteriaSql!);
    expect(typeof ok.ok).toBe("boolean");
    await conn.run(w.writeSql);
    const after = await rows(w.afterSql!);
    expect(after[0].status).toBe("returned");
  });

  it("create: a new customer appears; its key must be new", async () => {
    const a = spec.actionTypes.find((x) => x.name === "add_customer")!;
    const w = compileAction(spec, a, null, {
      customer_id: 9001,
      name: "Test Buyer",
      email: "t@example.com",
      segment: "Consumer",
      country: "US",
    });
    expect(await rows(w.beforeSql!)).toHaveLength(0);
    await conn.run(w.writeSql);
    const after = await rows(w.afterSql!);
    expect(after[0].name).toBe("Test Buyer");
  });

  it("a subtype's action cannot reach rows outside its filter", () => {
    const vipChange = {
      name: "rename_vip",
      objectType: "VipCustomer",
      kind: "modify" as const,
      parameters: [{ name: "name", property: "name" }],
      requiresApproval: false,
      agentMode: "none" as const,
    };
    const w = compileAction(spec, vipChange, { customer_id: 1 }, { name: "x" });
    expect(w.writeSql).toContain(`"segment" = 'Enterprise'`);
  });
});

describe("a grantee's policy holds in executed queries", () => {
  it("a row filter limits the set, through a walk too", async () => {
    const opts: CompileOpts = {
      seeRestricted: false,
      policy: { rowFilters: [{ objectType: "Customer", property: "country", values: ["US"] }] },
    };
    const c = compileObjectSet(spec, { objectType: "Customer" }, opts);
    const exp = num(
      (await one(`SELECT count(*) AS n FROM ${SCHEMA}.customers WHERE country = 'US'`)).n,
    );
    expect(num((await one(c.countSql!)).n)).toBe(exp);
    // Walking from orders to customers shows US customers only.
    const walk = compileObjectSet(
      spec,
      { objectType: "Order", path: [{ link: "placed_by", direction: "forward" }], limit: 5000 },
      opts,
    );
    for (const r of await rows(walk.sql)) expect(r.country).toBe("US");
  });

  it("a mask hides the value and refuses filtering on it", async () => {
    const opts: CompileOpts = {
      seeRestricted: false,
      policy: { maskedProperties: ["Customer.email"] },
    };
    const c = compileObjectSet(spec, { objectType: "Customer", limit: 3 }, opts);
    for (const r of await rows(c.sql)) expect(r.email).toBeNull();
    expect(() =>
      compileObjectSet(
        spec,
        { objectType: "Customer", filters: [{ property: "email", op: "contains", value: "a" }] },
        opts,
      ),
    ).toThrow(/hidden/);
  });
});
