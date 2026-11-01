// Every expression the ontology guide teaches with (docs/ONTOLOGY_GUIDE.md and
// the in-app /docs/ontology/modelling page), compiled by the real compiler and
// run on the sample in DuckDB, checked against hand-written SQL. And each one
// must appear, character for character, in both documents: an example a
// reader copies has to be one that works (R433).
import { existsSync, readFileSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";

import {
  CompileError,
  compileMetric,
  compileObjectSet,
  compileRule,
  type CompileOpts,
} from "@/lib/ontology/compile";
import { neighborhood, nodeId, type GraphRow } from "@/lib/ontology/graph";
import { sampleSpec, sampleSql } from "@/lib/ontology/sample";
import type { OntologySpec } from "@/lib/ontology/spec";
import { validateSpec } from "@/lib/ontology/validate";

const SCHEMA = "ontology_docs";
let conn: DuckDBConnection;
let spec: OntologySpec;
const owner: CompileOpts = { seeRestricted: true, maxRows: 5000 };

/** The examples, exactly as the guide prints them. */
export const DOC_EXAMPLES = {
  orderMonth: "date_trunc('month', ordered_on)",
  sizeBand:
    "CASE WHEN total_amount >= 1000 THEN 'large' WHEN total_amount >= 250 THEN 'medium' ELSE 'small' END",
  emailDomain: "lower(regexp_extract(email, '@(.+)$', 1))",
  deliveredOrders: "count_if(status = 'delivered')",
  deliveredShare: "count_if(status = 'delivered') / COUNT(*)",
  medianOrderValue: "median(total_amount)",
  deliveredRevenue: "SUM(total_amount) FILTER (WHERE status = 'delivered')",
  discountRange: "discount BETWEEN 0 AND 0.5",
} as const;

const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");
const flat = (s: string) => s.replace(/\s+/g, " ");
const guide = () => flat(read("docs/ONTOLOGY_GUIDE.md"));
const inApp = () =>
  flat(
    read("src/routes/docs.ontology_.modelling.tsx")
      // JSX writes ' as &apos; and > as &gt;: read it as the page shows it.
      .replace(/&apos;/g, "'")
      .replace(/&gt;/g, ">")
      .replace(/&lt;/g, "<")
      .replace(/\{" "\}\s*/g, " "),
  );

async function rows(sql: string): Promise<Record<string, unknown>[]> {
  return (await conn.runAndReadAll(sql)).getRowObjectsJson() as Record<string, unknown>[];
}
const num = (v: unknown) => Number(v);

beforeAll(async () => {
  conn = await (await DuckDBInstance.create(":memory:")).connect();
  await conn.run(`CREATE SCHEMA ${SCHEMA}`);
  for (const sql of sampleSql(SCHEMA)) await conn.run(sql);
  // A small org chart for the self-link pattern.
  await conn.run(
    `CREATE TABLE ${SCHEMA}.employees AS SELECT * FROM (VALUES (1, 'Dana', NULL), (2, 'Eli', 1), (3, 'Fay', 1), (4, 'Gus', 2)) AS t(employee_id, name, manager_id)`,
  );
  spec = sampleSpec(SCHEMA);
  const order = spec.objectTypes.find((t) => t.name === "Order")!;
  order.properties.push(
    { name: "order_month", type: "date", expression: DOC_EXAMPLES.orderMonth },
    { name: "size_band", type: "string", expression: DOC_EXAMPLES.sizeBand },
  );
  order.metrics.push(
    { name: "delivered_orders", expression: DOC_EXAMPLES.deliveredOrders },
    { name: "delivered_share", expression: DOC_EXAMPLES.deliveredShare },
    { name: "median_order_value", expression: DOC_EXAMPLES.medianOrderValue },
    { name: "delivered_revenue", expression: DOC_EXAMPLES.deliveredRevenue },
  );
  spec.objectTypes
    .find((t) => t.name === "Customer")!
    .properties.push({
      name: "email_domain",
      type: "string",
      expression: DOC_EXAMPLES.emailDomain,
    });
  spec.objectTypes.push({
    name: "Employee",
    source: { table: `${SCHEMA}.employees` },
    primaryKey: ["employee_id"],
    titleProperty: "name",
    properties: [
      { name: "employee_id", type: "integer", column: "employee_id", required: true },
      { name: "name", type: "string", column: "name" },
      { name: "manager_id", type: "integer", column: "manager_id" },
    ],
    metrics: [],
  } as unknown as OntologySpec["objectTypes"][number]);
  spec.linkTypes.push({
    name: "reports_to",
    from: "Employee",
    to: "Employee",
    inverseName: "direct_reports",
    cardinality: "many_to_one",
    join: { kind: "foreign_key", fromProperties: ["manager_id"], toProperties: ["employee_id"] },
  } as unknown as OntologySpec["linkTypes"][number]);
}, 120_000);

afterAll(() => conn?.closeSync());

describe("the guide's examples are in both documents, as printed", () => {
  for (const [name, expr] of Object.entries(DOC_EXAMPLES)) {
    it(name, () => {
      expect(guide()).toContain(expr);
      expect(inApp()).toContain(expr);
    });
  }
});

describe("the guide's examples work on the sample", () => {
  it("is still a valid ontology with them added", () => {
    const r = validateSpec(spec);
    expect(r.issues.filter((i) => i.level === "error")).toEqual([]);
  });

  it("derived properties: an order's month and size band, a customer's e-mail domain", async () => {
    const c = compileObjectSet(
      spec,
      { objectType: "Order", properties: ["order_id", "order_month", "size_band"], limit: 5000 },
      owner,
    );
    const got = await rows(c.sql);
    const want = await rows(
      `SELECT order_id, date_trunc('month', ordered_on) AS m, CASE WHEN total_amount >= 1000 THEN 'large' WHEN total_amount >= 250 THEN 'medium' ELSE 'small' END AS b FROM ${SCHEMA}.orders`,
    );
    const byId = new Map(want.map((r) => [num(r.order_id), r]));
    expect(got.length).toBe(want.length);
    for (const r of got) {
      expect(String(r.order_month)).toBe(String(byId.get(num(r.order_id))!.m));
      expect(r.size_band).toBe(byId.get(num(r.order_id))!.b);
    }
    const domains = await rows(
      compileObjectSet(
        spec,
        { objectType: "Customer", properties: ["customer_id", "email_domain"], limit: 5000 },
        owner,
      ).sql,
    );
    expect(domains.find((r) => num(r.customer_id) === 1)?.email_domain).toBe("example.com");
  });

  it("metrics: delivered orders, their share, the median order, delivered revenue", async () => {
    const one = async (metric: string) =>
      (await rows(compileMetric(spec, { objectType: "Order", metric }, owner).sql))[0][metric];
    const [raw] = await rows(
      `SELECT count(*) FILTER (WHERE status = 'delivered') AS d, count(*) AS n, median(total_amount) AS med, sum(total_amount) FILTER (WHERE status = 'delivered') AS rev FROM ${SCHEMA}.orders`,
    );
    expect(num(await one("delivered_orders"))).toBe(num(raw.d));
    expect(num(await one("delivered_share"))).toBeCloseTo(num(raw.d) / num(raw.n), 6);
    expect(num(await one("median_order_value"))).toBeCloseTo(num(raw.med), 2);
    expect(num(await one("delivered_revenue"))).toBeCloseTo(num(raw.rev), 2);
  });

  it("revenue by product: refused on Order through `contains`, right on OrderLine", async () => {
    // The guide's worked example of double counting.
    expect(() =>
      compileMetric(
        spec,
        {
          objectType: "Order",
          metric: "revenue",
          groupBy: [{ property: "name", path: [{ link: "contains", direction: "forward" }] }],
        },
        owner,
      ),
    ).toThrow(CompileError);
    const c = compileMetric(
      spec,
      {
        objectType: "OrderLine",
        metric: "line_revenue",
        groupBy: [{ property: "name", path: [{ link: "product", direction: "forward" }] }],
      },
      owner,
    );
    const got = await rows(c.sql);
    const want = await rows(
      `SELECT p.name, sum(l.quantity * l.unit_price * (1 - l.discount)) AS v FROM ${SCHEMA}.order_lines l JOIN ${SCHEMA}.products p ON p.product_id = l.product_id GROUP BY p.name`,
    );
    const w = new Map(want.map((r) => [r.name, num(r.v)]));
    const nameKey = c.columns.find((col) => col.property === "name")!.key;
    expect(got.length).toBe(want.length);
    for (const r of got) expect(num(r.line_revenue)).toBeCloseTo(w.get(r[nameKey])!, 2);
  });

  it("a rule predicate: discounts between 0 and 50%", async () => {
    const c = compileRule(
      spec,
      {
        id: "doc-discount",
        name: "Discounts are at most half",
        statement: "A line's discount is between none and half the price.",
        objectType: "OrderLine",
        kind: "predicate",
        predicate: DOC_EXAMPLES.discountRange,
        severity: "warning",
        enabled: true,
      },
      owner,
    );
    const [n] = await rows(c.checkSql);
    const [raw] = await rows(
      `SELECT count(*) AS n FROM ${SCHEMA}.order_lines WHERE NOT COALESCE(discount BETWEEN 0 AND 0.5, TRUE)`,
    );
    expect(num(n.violations)).toBe(num(raw.n));
    expect(num(n.checked)).toBe(1500);
  });

  it("a link to the same type: an employee reports to a manager, and the graph walks it both ways", async () => {
    const run = async (sql: string, columns: { key: string }[] | null) => {
      const r = await conn.runAndReadAll(sql);
      return r.getRowObjects().map((row) => {
        const o: GraphRow = {};
        for (const k of columns ? columns.map((c) => c.key) : Object.keys(row)) {
          const v = row[k];
          o[k] = typeof v === "bigint" ? Number(v) : (v as GraphRow[string]);
        }
        return o;
      });
    };
    const g = await neighborhood({
      spec,
      objectType: "Employee",
      key: { employee_id: 2 },
      depth: 1,
      perLink: 8,
      opts: owner,
      run,
    });
    if ("notFound" in g) throw new Error("not found");
    const e = (id: number) => nodeId("Employee", { employee_id: id });
    expect(g.edges.map((x) => `${x.from} ${x.label} ${x.to}`).sort()).toEqual(
      [`${e(2)} reports to ${e(1)}`, `${e(4)} reports to ${e(2)}`].sort(),
    );
    expect(g.edges.every((x) => x.inverseLabel === "direct reports")).toBe(true);
  });
});
