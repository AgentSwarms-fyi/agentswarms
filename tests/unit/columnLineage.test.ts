// Column-level lineage: the graph tracer over what a run saw, the SQL tracer
// over DuckDB's own parse, and the wiring that records and shows the edges.
import { readFileSync } from "node:fs";

import { DuckDBInstance } from "@duckdb/node-api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { columnsReferenced, traceColumnLineage, type ColumnEdge } from "@/lib/columnLineage";
import { traceSelectColumns } from "@/lib/sqlColumnLineage";
import { compileGraph, type EtlGraph } from "@/utils/etl/codegen";
import { compileSparkGraph } from "@/utils/etl/sparkCodegen";

const rd = (p: string) => readFileSync(p, "utf8");

const src = (id: string, label = id) => ({
  id,
  kind: "source" as const,
  label,
  config: { type: "object_storage", path: `raw/${id}.csv`, format: "csv" },
});
const tgt = (id: string, table: string) => ({
  id,
  kind: "target" as const,
  label: table,
  config: { type: "lakehouse", schema: "analytics", table, write_mode: "replace" },
});
const tr = (id: string, config: Record<string, unknown>) => ({
  id,
  kind: "transform" as const,
  label: id,
  config,
});
const edge = (from: string, to: string) => ({ id: `${from}-${to}`, from, to });

const pairs = (edges: ColumnEdge[], target: string, column: string) =>
  edges
    .filter((e) => e.targetNode === target && e.targetColumn === column)
    .map((e) => `${e.sourceNode}.${e.sourceColumn}${e.exact ? "" : "~"}`)
    .sort();

describe("the graph tracer", () => {
  it("follows rename, derive and aggregate to the source columns", () => {
    const graph = {
      nodes: [
        src("orders"),
        tr("r", { type: "rename", mapping: { qty: "quantity" } }),
        tr("d", { type: "derive", column: "total", expr: "quantity * price" }),
        tr("a", {
          type: "aggregate",
          group_by: ["status"],
          aggs: [
            { column: "total", fn: "sum", as: "revenue" },
            { column: "id", fn: "count", as: "orders" },
          ],
        }),
        tgt("t", "revenue"),
      ],
      edges: [edge("orders", "r"), edge("r", "d"), edge("d", "a"), edge("a", "t")],
    } as unknown as EtlGraph;
    const edges = traceColumnLineage(graph, {
      orders: ["id", "qty", "price", "status"],
    });
    expect(pairs(edges, "t", "revenue")).toEqual(["orders.price", "orders.qty"]);
    expect(pairs(edges, "t", "orders")).toEqual(["orders.id"]);
    expect(pairs(edges, "t", "status")).toEqual(["orders.status"]);
    // Nothing else reached the target.
    expect(new Set(edges.map((e) => e.targetColumn))).toEqual(
      new Set(["revenue", "orders", "status"]),
    );
  });

  it("a join keeps both sides, and reads pandas' suffixes as left and right", () => {
    const graph = {
      nodes: [
        src("o"),
        src("c"),
        tr("j", {
          type: "join",
          how: "inner",
          left_on: ["customer_id"],
          right_on: ["id"],
          left_node: "o",
        }),
        tgt("t", "joined"),
      ],
      edges: [edge("o", "j"), edge("c", "j"), edge("j", "t")],
    } as unknown as EtlGraph;
    const edges = traceColumnLineage(graph, {
      o: ["id", "customer_id", "name"],
      c: ["id", "name", "region"],
      // What pandas produced: the colliding `name` became name_x / name_y.
      j: ["id_x", "customer_id", "name_x", "id_y", "name_y", "region"],
    });
    expect(pairs(edges, "t", "name_x")).toEqual(["o.name"]);
    expect(pairs(edges, "t", "name_y")).toEqual(["c.name"]);
    expect(pairs(edges, "t", "region")).toEqual(["c.region"]);
    expect(pairs(edges, "t", "customer_id")).toEqual(["o.customer_id"]);
  });

  it("a union merges, a select narrows, a filter keeps everything", () => {
    const graph = {
      nodes: [
        src("a"),
        src("b"),
        tr("u", { type: "union" }),
        tr("f", { type: "filter", expr: "amount > 0" }),
        tr("s", { type: "select", columns: ["id"] }),
        tgt("t", "ids"),
      ],
      edges: [edge("a", "u"), edge("b", "u"), edge("u", "f"), edge("f", "s"), edge("s", "t")],
    } as unknown as EtlGraph;
    const edges = traceColumnLineage(graph, { a: ["id", "amount"], b: ["id", "amount"] });
    expect(pairs(edges, "t", "id")).toEqual(["a.id", "b.id"]);
    expect(edges.some((e) => e.targetColumn === "amount")).toBe(false);
  });

  it("a Python step is opaque: every output from every input, and the edge says so", () => {
    const graph = {
      nodes: [src("a"), tr("p", { type: "python", code: "df['score'] = 1" }), tgt("t", "scored")],
      edges: [edge("a", "p"), edge("p", "t")],
    } as unknown as EtlGraph;
    const edges = traceColumnLineage(graph, { a: ["id", "amount"], p: ["id", "amount", "score"] });
    expect(pairs(edges, "t", "score")).toEqual(["a.amount~", "a.id~"]);
    expect(pairs(edges, "t", "id")).toEqual(["a.amount~", "a.id~"]);
    expect(edges.every((e) => !e.exact)).toBe(true);
  });

  it("a wide opaque step keeps only same-named lines rather than flooding", () => {
    const wide = Array.from({ length: 30 }, (_, i) => `c${i}`);
    const graph = {
      nodes: [src("a"), tr("p", { type: "python", code: "pass" }), tgt("t", "w")],
      edges: [edge("a", "p"), edge("p", "t")],
    } as unknown as EtlGraph;
    const edges = traceColumnLineage(graph, { a: wide, p: wide });
    expect(edges.length).toBe(30);
    expect(pairs(edges, "t", "c7")).toEqual(["a.c7~"]);
  });

  it("never invents a column nobody observed", () => {
    const graph = {
      nodes: [src("a"), tgt("t", "x")],
      edges: [edge("a", "t")],
    } as unknown as EtlGraph;
    expect(traceColumnLineage(graph, {})).toEqual([]);
  });

  it("reads the columns an expression names, quoted or bare, any case", () => {
    expect(
      columnsReferenced("quantity * `unit price` + Tax", ["quantity", "unit price", "tax", "id"]),
    ).toEqual(["quantity", "unit price", "tax"]);
    expect(columnsReferenced("abs(x)", ["x", "abs"])).toEqual(["abs", "x"]);
  });
});

describe("the SQL tracer, over DuckDB's own parse", () => {
  let instance: DuckDBInstance;
  let conn: Awaited<ReturnType<DuckDBInstance["connect"]>>;
  beforeAll(async () => {
    instance = await DuckDBInstance.create(":memory:");
    conn = await instance.connect();
  });
  afterAll(() => conn?.closeSync());

  const columnsOf = (schema: string, table: string) =>
    ({
      "analytics.orders": ["id", "customer_id", "amount", "region"],
      "analytics.customers": ["id", "name", "tier"],
    })[`${schema}.${table}`] ?? null;

  const trace = async (sql: string) => {
    const rows = await (
      await conn.run(`SELECT json_serialize_sql('${sql.replace(/'/g, "''")}')`)
    ).getRows();
    return traceSelectColumns(JSON.parse(String(rows[0][0])), columnsOf);
  };
  const flat = (cols: { name: string; sources: { table: string; column: string }[] }[]) =>
    Object.fromEntries(
      cols.map((c) => [c.name, c.sources.map((s) => `${s.table}.${s.column}`).sort()]),
    );

  it("aliases, functions, qualified refs, a join and a qualified star", async () => {
    const out = await trace(
      "SELECT o.region, sum(o.amount) AS total, count(*) AS n, upper(c.name) || '!' AS shout, c.* FROM analytics.orders o JOIN analytics.customers c ON c.id = o.customer_id GROUP BY 1, c.name",
    );
    expect(flat(out!)).toEqual({
      region: ["orders.region"],
      total: ["orders.amount"],
      n: [],
      shout: ["customers.name"],
      id: ["customers.id"],
      name: ["customers.name"],
      tier: ["customers.tier"],
    });
  });

  it("through a CTE and a subquery, and a bare star", async () => {
    const cte = await trace(
      "WITH x AS (SELECT id, amount * 2 AS dbl FROM analytics.orders) SELECT dbl AS doubled, id FROM x",
    );
    expect(flat(cte!)).toEqual({ doubled: ["orders.amount"], id: ["orders.id"] });
    const sub = await trace(
      "SELECT * FROM (SELECT region, amount FROM analytics.orders) s WHERE amount > 1",
    );
    expect(flat(sub!)).toEqual({ region: ["orders.region"], amount: ["orders.amount"] });
  });

  it("CASE and CAST read their columns; a union feeds each column from both sides", async () => {
    const out = await trace(
      "SELECT CASE WHEN amount > 10 THEN region ELSE 'small' END AS bucket, CAST(amount AS INTEGER) AS amt FROM analytics.orders",
    );
    expect(flat(out!)).toEqual({
      bucket: ["orders.amount", "orders.region"],
      amt: ["orders.amount"],
    });
    const u = await trace(
      "SELECT id AS k FROM analytics.orders UNION ALL SELECT id FROM analytics.customers",
    );
    expect(flat(u!)).toEqual({ k: ["customers.id", "orders.id"] });
  });

  it("an unknown table gives no sources, never a guess", async () => {
    const out = await trace("SELECT * FROM analytics.unknown_table");
    expect(out).toEqual([]);
    const named = await trace("SELECT x FROM analytics.unknown_table");
    expect(flat(named!)).toEqual({ x: [] });
  });
});

describe("the wiring", () => {
  const graph = {
    nodes: [src("a"), tr("d", { type: "derive", column: "two", expr: "id * 2" }), tgt("t", "x")],
    edges: [edge("a", "d"), edge("d", "t")],
  } as unknown as EtlGraph;

  it("both programs report every frame's columns and name the node in each load", () => {
    for (const code of [compileGraph(graph), compileSparkGraph(graph)]) {
      expect(code).toContain("    _cols = {}");
      expect(code).toContain("_cols['a'] = [str(_c) for _c in f_a.columns]");
      expect(code).toContain("_cols['d'] = [str(_c) for _c in f_d.columns]");
      expect(code).toContain("'columns': _cols,");
      expect(code).toContain("_loads.append({'node': 't', 'target':");
    }
  });

  it("a run writes column edges beside its table edges, in one replace", () => {
    const s = rd("src/utils/etl/service.server.ts");
    const block = s.slice(s.indexOf('.eq("source_system", "etl");'));
    expect(block).toContain("traceColumnLineage(graph, columnsSeen)");
    expect(block).toContain("upstream_column: e.sourceColumn.slice(0, 255)");
    expect(block).toContain("downstream_column: e.targetColumn.slice(0, 255)");
    expect(block).toContain("exact: e.exact,");
    // Seen live: the table rows omitted `exact`, a bulk insert sent null for
    // it beside the column rows that had it, and every edge was refused.
    expect(block).toMatch(/source_system: "etl",\n(\s*\/\/[^\n]*\n)*\s*exact: true,/);
    expect(block).toContain("[etl] lineage not recorded for");
    expect(rd("src/utils/sqlModels/run.server.ts")).toContain(
      'source_system: "sql_model",\n        // Explicit',
    );
    expect(block.indexOf("traceColumnLineage")).toBeLessThan(
      block.indexOf('await supabaseAdmin.from("catalog_lineage").insert(edges);'),
    );
  });

  it("a model build traces its SELECT to lakehouse columns and never fails on it", () => {
    const s = rd("src/utils/sqlModels/run.server.ts");
    expect(s).toContain("rows.push(...(await columnLineageRows(userId, built, byName)));");
    const fn = s.slice(s.indexOf("async function columnLineageRows"));
    expect(fn).toContain("traceSelectColumns(");
    expect(fn).toContain("json_serialize_sql(");
    expect(fn).toContain("FROM duckdb_columns() WHERE database_name = 'lake'");
    expect(fn).toContain('source_system: "sql_model",');
    expect(fn).toContain("exact: true,");
    expect(fn).toContain("column lineage not recorded");
  });

  it("the catalog loads the flag and the drawer shows columns apart from tables", () => {
    expect(rd("src/lib/dataCatalog.ts")).toContain(
      '.select("upstream_fqn, downstream_fqn, upstream_column, downstream_column, exact")',
    );
    const view = rd("src/components/catalog/CatalogView.tsx");
    expect(view).toContain("Column lineage");
    expect(view).toContain("sourceLineage.upstream.filter((e) => !e.downstream_column)");
    expect(view).toContain('{e.exact ? "" : "≈ "}');
  });
});
