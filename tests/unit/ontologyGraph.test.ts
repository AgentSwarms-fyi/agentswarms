// The Graph tab's walk (src/lib/ontology/graph.ts), run for real against the
// sample business in an in-memory DuckDB, and checked against hand-written
// queries over the raw tables. R433, found from the UI:
//   - an order line and its product, both on screen, had no line between
//     them: only expanded objects' links were fetched;
//   - it asked once per object and link (a dozen queries for two steps);
//   - "more than shown" did not say where, and a link that failed vanished.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";

import { compileLinkPairs, type CompileOpts } from "@/lib/ontology/compile";
import {
  neighborhood,
  nodeId,
  type GraphRow,
  type GraphRunner,
  type Neighborhood,
} from "@/lib/ontology/graph";
import { sampleSpec, sampleSql } from "@/lib/ontology/sample";
import type { OntologySpec } from "@/lib/ontology/spec";

const SCHEMA = "ontology_graph";
let conn: DuckDBConnection;
let spec: OntologySpec;
const owner: CompileOpts = { seeRestricted: true, maxRows: 5000 };

/** What the server's plainCell makes of a DuckDB value. */
function cell(v: unknown): string | number | boolean | null {
  if (typeof v === "bigint") return Number(v);
  if (v === undefined || v === null) return null;
  if (typeof v === "object") {
    const s = String(v);
    return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : s;
  }
  return v as string | number | boolean;
}

let calls: string[] = [];
const run: GraphRunner = async (sql, columns) => {
  calls.push(sql);
  const r = await conn.runAndReadAll(sql);
  return r.getRowObjects().map((row) => {
    const o: GraphRow = {};
    const keys = columns ? columns.map((c) => c.key) : Object.keys(row);
    for (const k of keys) o[k] = cell(row[k]);
    return o;
  });
};

async function raw(sql: string): Promise<Record<string, unknown>[]> {
  return (await conn.runAndReadAll(sql)).getRowObjectsJson() as Record<string, unknown>[];
}

const ids = (g: Neighborhood, type: string) =>
  g.nodes
    .filter((n) => n.objectType === type)
    .map((n) => n.id)
    .sort();
const edgesOf = (g: Neighborhood, link: string) =>
  g.edges
    .filter((e) => e.link === link)
    .map((e) => `${e.from} -> ${e.to}`)
    .sort();

beforeAll(async () => {
  conn = await (await DuckDBInstance.create(":memory:")).connect();
  await conn.run(`CREATE SCHEMA ${SCHEMA}`);
  for (const sql of sampleSql(SCHEMA)) await conn.run(sql);
  spec = sampleSpec(SCHEMA);
}, 120_000);

afterAll(() => conn?.closeSync());

async function walk(over: Partial<Parameters<typeof neighborhood>[0]> = {}) {
  calls = [];
  const g = await neighborhood({
    spec,
    objectType: "Customer",
    key: { customer_id: 1 },
    depth: 2,
    perLink: 25,
    opts: owner,
    run,
    ...over,
  });
  if ("notFound" in g) throw new Error("not found");
  return g;
}

describe("two steps out from a customer", () => {
  it("finds their orders, and those orders' lines, products and shipment, as the raw tables do", async () => {
    const g = await walk();
    const orders = (
      await raw(`SELECT order_id FROM ${SCHEMA}.orders WHERE customer_id = 1 ORDER BY order_id`)
    ).map((r) => nodeId("Order", { order_id: Number(r.order_id) }));
    const lines = (
      await raw(
        `SELECT line_id FROM ${SCHEMA}.order_lines WHERE order_id IN (SELECT order_id FROM ${SCHEMA}.orders WHERE customer_id = 1)`,
      )
    ).map((r) => nodeId("OrderLine", { line_id: Number(r.line_id) }));
    const products = (
      await raw(
        `SELECT DISTINCT product_id FROM ${SCHEMA}.order_lines WHERE order_id IN (SELECT order_id FROM ${SCHEMA}.orders WHERE customer_id = 1)`,
      )
    ).map((r) => nodeId("Product", { product_id: Number(r.product_id) }));
    expect(orders.length).toBeGreaterThan(1);
    expect(ids(g, "Order")).toEqual(orders.sort());
    // Each order points at the customer, once, and nothing points back.
    expect(edgesOf(g, "placed_by")).toEqual(
      orders.map((o) => `${o} -> ${nodeId("Customer", { customer_id: 1 })}`).sort(),
    );
    expect(ids(g, "OrderLine")).toEqual(lines.sort());
    expect(ids(g, "Product")).toEqual(products.sort());
    expect(g.nodes.find((n) => n.depth === 0)?.id).toBe(nodeId("Customer", { customer_id: 1 }));
    // Each order sits one step out, with the customer as its parent; each
    // line two steps out, reached from its order.
    for (const n of g.nodes.filter((x) => x.objectType === "Order")) {
      expect(n.depth).toBe(1);
      expect(n.parent).toBe(nodeId("Customer", { customer_id: 1 }));
    }
    for (const n of g.nodes.filter((x) => x.objectType === "OrderLine")) expect(n.depth).toBe(2);
    expect(g.skipped).toEqual([]);
    expect(g.capped).toBe(false);
  });

  it("draws each line's product, though neither the line nor the product was expanded", async () => {
    const g = await walk();
    const pairs = await raw(
      `SELECT line_id, product_id FROM ${SCHEMA}.order_lines WHERE order_id IN (SELECT order_id FROM ${SCHEMA}.orders WHERE customer_id = 1)`,
    );
    expect(edgesOf(g, "product")).toEqual(
      pairs
        .map(
          (r) =>
            `${nodeId("OrderLine", { line_id: Number(r.line_id) })} -> ${nodeId("Product", { product_id: Number(r.product_id) })}`,
        )
        .sort(),
    );
    // And every edge joins two objects that are drawn.
    const drawn = new Set(g.nodes.map((n) => n.id));
    for (const e of g.edges) {
      expect(drawn.has(e.from)).toBe(true);
      expect(drawn.has(e.to)).toBe(true);
    }
  });

  it("asks once per type and link at each step, however many objects there are", async () => {
    const [top] = (await raw(
      `SELECT customer_id, count(*) AS n FROM ${SCHEMA}.orders GROUP BY customer_id ORDER BY n DESC, customer_id LIMIT 1`,
    )) as { customer_id: unknown; n: unknown }[];
    const orders = Number(top.n);
    const g = await walk({ key: { customer_id: Number(top.customer_id) } });
    expect(ids(g, "Order")).toHaveLength(orders);
    // The bound: the root, each type on each step times its links, and one
    // per link type for the links among them. Six link types, two steps.
    const directions = spec.linkTypes.length * 2;
    expect(calls.length).toBeLessThanOrEqual(1 + 2 * directions + spec.linkTypes.length);
    // The walk this replaces asked once per object and link: the root, the
    // customer's one link, then every order's four.
    expect(calls.length).toBeLessThan(1 + 1 + orders * 4);
  });
});

describe("what it says about the edges of what it shows", () => {
  it("names each object whose link has more than it drew", async () => {
    const g = await walk({ depth: 1, perLink: 1 });
    expect(ids(g, "Order")).toHaveLength(1);
    expect(g.capped).toBe(true);
    expect(g.cappedLinks).toContainEqual({
      node: nodeId("Customer", { customer_id: 1 }),
      link: "placed_by",
      // From the customer's side: her orders, not "placed by".
      label: "orders",
    });
  });

  it("reports a link it could not follow, and still draws the rest", async () => {
    const broken: OntologySpec = JSON.parse(JSON.stringify(spec));
    broken.objectTypes.find((t) => t.name === "Shipment")!.source!.table =
      `${SCHEMA}.no_such_table`;
    const g = await walk({ spec: broken, objectType: "Order", key: { order_id: 1001 }, depth: 1 });
    expect(g.skipped.map((s) => s.link)).toContain("ships");
    expect(g.skipped.find((s) => s.link === "ships")?.error).toMatch(/no_such_table/i);
    expect(ids(g, "Customer")).toHaveLength(1);
  });

  it("stops at the node cap and says so", async () => {
    const g = await walk({ maxNodes: 5 });
    expect(g.nodes.length).toBeLessThanOrEqual(5);
    expect(g.capped).toBe(true);
  });

  it("returns notFound for a key that is not there", async () => {
    const g = await neighborhood({
      spec,
      objectType: "Customer",
      key: { customer_id: 999_999 },
      depth: 1,
      perLink: 8,
      opts: owner,
      run,
    });
    expect(g).toEqual({ notFound: true });
  });
});

describe("links among what the caller already shows", () => {
  it("draws a link between two objects the caller sent, neither reached by this walk", async () => {
    const [line] = await raw(
      `SELECT line_id, product_id FROM ${SCHEMA}.order_lines WHERE order_id NOT IN (SELECT order_id FROM ${SCHEMA}.orders WHERE customer_id = 1) LIMIT 1`,
    );
    const lineNode = { objectType: "OrderLine", key: { line_id: Number(line.line_id) } };
    const productNode = { objectType: "Product", key: { product_id: Number(line.product_id) } };
    const g = await walk({ depth: 1, known: [lineNode, productNode] });
    expect(edgesOf(g, "product")).toContain(
      `${nodeId("OrderLine", lineNode.key)} -> ${nodeId("Product", productNode.key)}`,
    );
    // Known objects are linked, not returned as new nodes.
    expect(ids(g, "OrderLine")).toEqual([]);
  });

  it("finds the pairs a link joins with one query, a join table included", async () => {
    const c = compileLinkPairs(
      spec,
      "contains",
      [{ order_id: 1001 }, { order_id: 1002 }],
      [{ product_id: 1 }, { product_id: 2 }, { product_id: 3 }, { product_id: 4 }],
      owner,
    );
    const got = (await run(c.sql, c.columns, 100)).map((r) => `${r.a_order_id}-${r.b_product_id}`);
    const want = (
      await raw(
        `SELECT DISTINCT order_id, product_id FROM ${SCHEMA}.order_lines WHERE order_id IN (1001, 1002) AND product_id IN (1, 2, 3, 4)`,
      )
    ).map((r) => `${r.order_id}-${r.product_id}`);
    expect(got.sort()).toEqual(want.sort());
  });
});

describe("a grantee's policy holds in the graph", () => {
  it("a row filter on orders leaves out the orders it hides, and their lines", async () => {
    const g = await walk({
      opts: {
        seeRestricted: false,
        policy: {
          rowFilters: [{ objectType: "Order", property: "status", values: ["delivered"] }],
        },
      },
    });
    const delivered = (
      await raw(
        `SELECT order_id FROM ${SCHEMA}.orders WHERE customer_id = 1 AND status = 'delivered'`,
      )
    ).map((r) => nodeId("Order", { order_id: Number(r.order_id) }));
    expect(ids(g, "Order")).toEqual(delivered.sort());
    const shownOrders = new Set(delivered);
    for (const e of g.edges.filter((x) => x.link === "order"))
      expect(shownOrders.has(e.to)).toBe(true);
  });
});
