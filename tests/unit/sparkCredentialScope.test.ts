// Credentials on the shared Spark cluster are the call's own.
//
// FOUND IN R229. Generated Spark code passes storage credentials per read and
// per write, as Hadoop options, so that no key sits in the cluster's shared
// configuration. Hadoop caches one S3A FileSystem per bucket per JVM, and a
// cached one keeps the credentials that built it: on the live cluster, after
// one read with the lake's keys, a read of the same bucket with wrong keys
// returned every row. With fs.s3a.impl.disable.cache on the call, the wrong
// keys were refused and the right ones still read.
//
// And a SQL step, which runs on that same cluster, is one query over its
// input frame: Spark SQL would otherwise read a file in place of a table.
import { describe, expect, it } from "vitest";

import { compileGraph, type EtlGraph, type EtlNode } from "@/utils/etl/codegen";
import { compileSparkGraph, sparkSqlScopeRefusal } from "@/utils/etl/sparkCodegen";
import { compileSparkQuery } from "@/utils/lakehouse/sparkQueryCodegen";

const node = (id: string, kind: EtlNode["kind"], config: Record<string, unknown>): EtlNode => ({
  id,
  kind,
  config: config as EtlNode["config"],
});
const linear = (...nodes: EtlNode[]): EtlGraph => ({
  nodes,
  edges: nodes.slice(0, -1).map((n, i) => ({ id: `e${i}`, from: n.id, to: nodes[i + 1]!.id })),
});
const SRC = node("s1", "source", { type: "object_storage", path: "raw/*.csv", format: "csv" });
const TGT = node("t1", "target", {
  type: "object_storage",
  dataset: "etl",
  table: "items",
  format: "parquet",
  write_mode: "replace",
});
const LAKE_TGT = node("t2", "target", {
  type: "lakehouse",
  schema: "analytics",
  table: "orders",
  write_mode: "append",
});

/** The body of a generated Python function, up to the next top-level def. */
function pyFn(code: string, name: string): string {
  const start = code.indexOf(`def ${name}(`);
  expect(start, `${name} is emitted`).toBeGreaterThan(-1);
  const next = code.indexOf("\ndef ", start + 1);
  return code.slice(start, next === -1 ? undefined : next);
}

describe("every S3A credential the generated Spark code passes", () => {
  it("builds a FileSystem of its own: the user's connections and the lake's", () => {
    const code = compileSparkGraph({
      nodes: [SRC, TGT, LAKE_TGT],
      edges: [
        { id: "e0", from: "s1", to: "t1" },
        { id: "e1", from: "s1", to: "t2" },
      ],
    } as EtlGraph);
    for (const fn of ["_s3_options", "_lake_s3_options"]) {
      const body = pyFn(code, fn);
      expect(body).toContain("'fs.s3a.access.key'");
      expect(body, fn).toContain("'fs.s3a.impl.disable.cache': 'true'");
    }
  });

  it("including a lakehouse query run on Spark", () => {
    const code = compileSparkQuery({
      queryId: "q1",
      sql: "SELECT * FROM analytics.orders",
      tables: [
        {
          schema: "analytics",
          table: "orders",
          columns: [{ name: "id", type: "INTEGER" }],
          dataFiles: ["s3://lake/main/analytics/orders/a.parquet"],
          deleteFiles: [],
        },
      ],
      rowCap: 100,
      snapshot: 1,
    });
    expect(pyFn(code, "_s3")).toContain("'fs.s3a.impl.disable.cache': 'true'");
  });
});

describe("a SQL step on the Spark engine", () => {
  it("runs one query over its input, comments and literals included", () => {
    for (const q of [
      "SELECT * FROM t",
      "select region, sum(amount) as total from t group by 1;",
      "WITH x AS (SELECT * FROM t) SELECT * FROM x",
      "-- the input\nSELECT `odd name`, 's3a://not/a/read' AS note FROM t",
      "(SELECT a FROM t) UNION ALL (SELECT b FROM t)",
    ]) {
      expect(sparkSqlScopeRefusal(q, "Q"), q).toBeNull();
    }
  });

  it("refuses a file read in place of a table, and anything but a query", () => {
    const path = [
      "SELECT * FROM parquet.`s3a://bucket/some/table/`",
      "SELECT * FROM t JOIN csv.`/etc/hosts` ON true",
      "SELECT * FROM delta.`abfss://c@acct.dfs.core.windows.net/x`",
    ];
    for (const q of path) expect(sparkSqlScopeRefusal(q, "Q"), q).toMatch(/not files by path/);
    const statements = [
      "CREATE TEMPORARY VIEW v USING parquet OPTIONS (path 'x')",
      "SET spark.sql.shuffle.partitions = 1",
      "SELECT * FROM t; DROP TABLE t",
    ];
    for (const q of statements) expect(sparkSqlScopeRefusal(q, "Q"), q).toMatch(/one SELECT/);
  });

  it("is refused when the pipeline compiles, not only when it is saved", () => {
    const g = linear(
      SRC,
      node("q", "transform", { type: "sql", query: "SELECT * FROM parquet.`s3a://b/x`" }),
      TGT,
    );
    expect(() => compileSparkGraph(g)).toThrow(/not files by path/);
    // The sandbox engine's SQL step runs in the sandbox's own DuckDB, which
    // holds no credential since R227, and is unchanged.
    expect(() => compileGraph(g)).not.toThrow();
  });
});
