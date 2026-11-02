// Explore's search around, narrowed at every step (R434, found from the UI):
// after "Search around → orders", the search box still said "Search
// customers" and it and Filter still narrowed the customers, while the table
// listed orders. Each step now carries what narrows the objects it reaches;
// run on the sample business in DuckDB against hand-written SQL.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";

import { compileObjectSet, type CompileOpts, type ObjectSetQuery } from "@/lib/ontology/compile";
import { sampleSpec, sampleSql } from "@/lib/ontology/sample";
import type { OntologySpec } from "@/lib/ontology/spec";

const SCHEMA = "ontology_steps";
let conn: DuckDBConnection;
let spec: OntologySpec;
const owner: CompileOpts = { seeRestricted: true, maxRows: 5000 };

beforeAll(async () => {
  conn = await (await DuckDBInstance.create(":memory:")).connect();
  await conn.run(`CREATE SCHEMA ${SCHEMA}`);
  for (const sql of sampleSql(SCHEMA)) await conn.run(sql);
  spec = sampleSpec(SCHEMA);
}, 120_000);

afterAll(() => conn?.closeSync());

async function ids(sql: string, key: string): Promise<number[]> {
  const rows = (await conn.runAndReadAll(sql)).getRowObjectsJson();
  return rows.map((r) => Number(r[key])).sort((a, b) => a - b);
}
async function count(sql: string): Promise<number> {
  const rows = (await conn.runAndReadAll(sql)).getRowObjectsJson();
  return Number(rows[0].n);
}

// Enterprise customers → their delivered orders → the gloves in them.
const query: ObjectSetQuery = {
  objectType: "Customer",
  filters: [{ property: "segment", op: "eq", value: "Enterprise" }],
  path: [
    {
      link: "orders",
      direction: "inverse",
      filters: [{ property: "status", op: "eq", value: "delivered" }],
    },
    { link: "contains", direction: "forward", search: "Gloves" },
  ],
  limit: 1000,
};
const expected = `SELECT DISTINCT p.product_id
  FROM ${SCHEMA}.customers c
  JOIN ${SCHEMA}.orders o ON o.customer_id = c.customer_id
  JOIN ${SCHEMA}.order_lines l ON l.order_id = o.order_id
  JOIN ${SCHEMA}.products p ON p.product_id = l.product_id
  WHERE c.segment = 'Enterprise' AND o.status = 'delivered'
    AND (contains(lower(p.name), 'gloves') OR contains(lower(p.category), 'gloves'))`;

describe("a search around narrowed at each step", () => {
  it("narrows the start, the orders reached, and the products reached, as the raw tables do", async () => {
    const c = compileObjectSet(spec, query, owner);
    const want = await ids(expected, "product_id");
    expect(want.length).toBeGreaterThan(0);
    expect(await ids(c.sql, "product_id")).toEqual(want);
    expect(await count(c.countSql!)).toBe(want.length);
  });

  it("each narrowing counts: without one, more products come back", async () => {
    const all = await ids(compileObjectSet(spec, query, owner).sql, "product_id");
    const drop = (i: number, field: "filters" | "search") => {
      const path = query.path!.map((s, j) => (j === i ? { ...s, [field]: undefined } : s));
      return compileObjectSet(spec, { ...query, path }, owner).sql;
    };
    const withoutStatus = await ids(drop(0, "filters"), "product_id");
    const withoutSearch = await ids(drop(1, "search"), "product_id");
    expect(withoutStatus.length).toBeGreaterThan(all.length);
    expect(withoutSearch.length).toBeGreaterThan(all.length);
    expect(withoutStatus).toEqual(
      await ids(expected.replace(" AND o.status = 'delivered'", ""), "product_id"),
    );
  });

  it("a step's search reads the type it reaches, not the start", async () => {
    // "Gloves" is no customer's name: read against customers it finds nothing.
    const onStart = compileObjectSet(
      spec,
      {
        ...query,
        search: "Gloves",
        path: [query.path![0], { link: "contains", direction: "forward" }],
      },
      owner,
    );
    expect(await ids(onStart.sql, "product_id")).toEqual([]);
  });

  it("a step cannot filter on what the caller's grant masks", () => {
    expect(() =>
      compileObjectSet(
        spec,
        {
          objectType: "Order",
          path: [
            {
              link: "placed_by",
              direction: "forward",
              filters: [{ property: "email", op: "contains", value: "example" }],
            },
          ],
        },
        { seeRestricted: false, maxRows: 5000, policy: { maskedProperties: ["Customer.email"] } },
      ),
    ).toThrow(/hidden from you/);
  });

  it("a step without narrowing compiles as before", () => {
    const plain: ObjectSetQuery = {
      objectType: "Customer",
      path: [{ link: "orders", direction: "inverse" }],
    };
    const narrowedNothing: ObjectSetQuery = {
      objectType: "Customer",
      path: [{ link: "orders", direction: "inverse", filters: [], search: "" }],
    };
    expect(compileObjectSet(spec, narrowedNothing, owner).sql).toBe(
      compileObjectSet(spec, plain, owner).sql,
    );
  });
});
