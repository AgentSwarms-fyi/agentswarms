// Lakehouse queries on Spark: the program a sandbox runs, the reference
// rewrite that makes it possible, and the wiring that keeps a query's
// cluster alive and its rows honest.
//
// What the reader relies on was established against the live catalog: a
// DuckLake data file carries two internal columns, a delete file is
// positional (file_path, pos), small writes stay inlined in the catalog until
// a flush, and ducklake_list_files pins to a snapshot with snapshot_version.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  compileSparkQuery,
  rewriteTableRefs,
  sparkTypeFor,
  viewNameFor,
  type SparkQueryPlan,
} from "@/utils/lakehouse/sparkQueryCodegen";
import {
  SPARK_QUERY_KEY,
  capResultBytes,
  sparkQueryMinutes,
  sparkQueryStashOf,
} from "@/utils/lakehouse/sparkQuery.server";

const rd = (p: string) => readFileSync(p, "utf8");

const plan = (over: Partial<SparkQueryPlan> = {}): SparkQueryPlan => ({
  queryId: "q-1",
  sql: "SELECT status, count(*) AS n FROM analytics.orders GROUP BY status",
  tables: [
    {
      schema: "analytics",
      table: "orders",
      columns: [
        { name: "id", type: "BIGINT" },
        { name: "status", type: "VARCHAR" },
        { name: "amount", type: "DECIMAL(10,2)" },
      ],
      dataFiles: ["s3://lakehouse/main/analytics/orders/ducklake-a.parquet"],
      deleteFiles: ["s3://lakehouse/main/analytics/orders/ducklake-a-delete.parquet"],
    },
  ],
  rowCap: 10_000,
  snapshot: 223,
  ...over,
});

describe("table references become views", () => {
  it("rewrites bare, quoted and mixed-case references, and nothing else", () => {
    const t = [{ schema: "analytics", table: "orders" }];
    expect(rewriteTableRefs("SELECT * FROM analytics.orders o", t)).toBe(
      "SELECT * FROM `analytics__orders` o",
    );
    expect(rewriteTableRefs('SELECT * FROM "analytics"."orders"', t)).toBe(
      "SELECT * FROM `analytics__orders`",
    );
    expect(rewriteTableRefs("SELECT * FROM Analytics.Orders", t)).toBe(
      "SELECT * FROM `analytics__orders`",
    );
    // A column that happens to be called orders is not a table.
    expect(rewriteTableRefs("SELECT o.orders FROM analytics.orders o", t)).toBe(
      "SELECT o.orders FROM `analytics__orders` o",
    );
    // analytics.orders_v2 is a different table and untouched.
    expect(rewriteTableRefs("SELECT * FROM analytics.orders_v2", t)).toBe(
      "SELECT * FROM analytics.orders_v2",
    );
  });

  it("names views so two schemas' same-named tables stay apart", () => {
    expect(viewNameFor("analytics", "orders")).toBe("analytics__orders");
    expect(viewNameFor("staging", "orders")).toBe("staging__orders");
    expect(viewNameFor("a-b", "c.d")).toBe("a_b__c_d");
  });

  it("maps DuckDB types to Spark ones for an empty table's schema", () => {
    expect(sparkTypeFor("BIGINT")).toBe("T.LongType()");
    expect(sparkTypeFor("INTEGER")).toBe("T.LongType()");
    expect(sparkTypeFor("DOUBLE")).toBe("T.DoubleType()");
    expect(sparkTypeFor("DECIMAL(10,2)")).toBe("T.DecimalType(10, 2)");
    expect(sparkTypeFor("BOOLEAN")).toBe("T.BooleanType()");
    expect(sparkTypeFor("DATE")).toBe("T.DateType()");
    expect(sparkTypeFor("TIMESTAMP WITH TIME ZONE")).toBe("T.TimestampType()");
    expect(sparkTypeFor("VARCHAR")).toBe("T.StringType()");
    expect(sparkTypeFor("STRUCT(a INTEGER)")).toBe("T.StringType()");
  });
});

describe("the program", () => {
  const code = compileSparkQuery(plan());

  it("connects through Spark Connect and reads with per-call S3 credentials", () => {
    expect(code).toContain("SparkSession.builder.remote(_url)");
    expect(code).toContain("os.environ.get('ETL_SPARK_CONNECT_URL', '')");
    expect(code).toContain("'fs.s3a.access.key': os.environ.get('ETL_LAKEHOUSE_S3_KEY_ID', '')");
    expect(code).toContain("spark.read.options(**_s3())");
    // s3:// paths from the catalog become s3a:// for Hadoop.
    expect(code).toContain("return 's3a://' + p[len('s3://'):] if p.startswith('s3://') else p");
  });

  it("builds one view per table from that table's files, with deletes applied by position", () => {
    expect(code).toContain(
      '_view("analytics__orders", T.StructType([T.StructField("id", T.LongType(), True), T.StructField("status", T.StringType(), True), T.StructField("amount", T.DecimalType(10, 2), True)]), ["s3://lakehouse/main/analytics/orders/ducklake-a.parquet"], ["s3://lakehouse/main/analytics/orders/ducklake-a-delete.parquet"])',
    );
    // The delete file's (file_path, pos) against the data file's row index.
    expect(code).toContain("F.col('_metadata.row_index')");
    expect(code).toContain("F.col('_metadata.file_path')");
    expect(code).toContain(".join(dels, ['_df', '_dp'], 'left_anti')");
    // Both sides compared without their scheme: s3:// in the delete file,
    // s3a:// as Spark read it.
    expect(code).toContain("F.regexp_replace(col, '^[a-z0-9]+://', '')");
    // The catalog's own columns never reach the user.
    expect(code).toContain(
      "df.drop('_ducklake_internal_row_id', '_ducklake_internal_snapshot_id')",
    );
    // Files written after a column was added still read.
    expect(code).toContain(".option('mergeSchema', 'true')");
  });

  it("runs the rewritten statement and returns one row past the cap to know it was cut", () => {
    expect(code).toContain(
      '_q = "SELECT status, count(*) AS n FROM `analytics__orders` GROUP BY status"',
    );
    expect(code).toContain("_rows = _df.limit(10001).collect()");
    expect(code).toContain("_out = [[_j(v) for v in list(r)] for r in _rows[:10000]]");
    expect(code).toContain("'truncated': len(_rows) > 10000");
    expect(code).toContain("'snapshot': 223");
    expect(code).toContain("def entrypoint(inputs):");
  });

  it("makes every value JSON-safe itself, because the runner would otherwise stringify the whole result", () => {
    expect(code).toContain("return v if math.isfinite(v) else str(v)");
    expect(code).toContain("if isinstance(v, (_dt.datetime, _dt.date, _dt.time)):");
    expect(code).toContain("if isinstance(v, _dec.Decimal):");
    expect(code).toContain("if isinstance(v, Row):");
  });

  it("an empty table still gets a view with the right schema", () => {
    const empty = compileSparkQuery(
      plan({ tables: [{ ...plan().tables[0], dataFiles: [], deleteFiles: [] }] }),
    );
    expect(empty).toContain("spark.createDataFrame([], schema)");
    expect(empty).toContain('_view("analytics__orders", T.StructType([');
  });

  it("a query with no snapshot says so rather than inventing one", () => {
    expect(compileSparkQuery(plan({ snapshot: null }))).toContain("'snapshot': None");
  });
});

describe("the session stash", () => {
  it("round-trips a query id and rejects anything else", () => {
    expect(sparkQueryStashOf({ [SPARK_QUERY_KEY]: { query_id: "abc" } })).toEqual({
      query_id: "abc",
    });
    expect(sparkQueryStashOf({ [SPARK_QUERY_KEY]: { query_id: "" } })).toBeNull();
    expect(sparkQueryStashOf({ __ml_job: { job_id: "x" } })).toBeNull();
    expect(sparkQueryStashOf(null)).toBeNull();
  });

  it("is dispatched by both sandbox routes, before the notebook fallback", () => {
    const source = rd("src/routes/api/notebook.runtime.source.ts");
    expect(source).toContain("sq.sparkQueryStashOf(session?.inputs)");
    expect(source).toContain("sq.sparkQueryEnvFor(stash, claims.sub)");
    expect(source).toContain("sq.sparkQueryBundleFor(stash, claims.sub)");
    expect(source.indexOf("sparkQueryStashOf")).toBeLessThan(
      source.indexOf("if (session?.mcp_app_id)"),
    );
    const result = rd("src/routes/api/notebook.runtime.result.ts");
    expect(result).toContain("m.appendSparkQueryLogs(sqStash.query_id, body.logs as string)");
    expect(result).toContain("m.finalizeSparkQuery(sqStash.query_id, {");
  });
});

describe("limits", () => {
  it("a query's wall clock is its own budget, not the training sandbox's", () => {
    expect(sparkQueryMinutes()).toBe(30);
    process.env.LAKEHOUSE_SPARK_QUERY_MINUTES = "5";
    try {
      expect(sparkQueryMinutes()).toBe(5);
    } finally {
      delete process.env.LAKEHOUSE_SPARK_QUERY_MINUTES;
    }
  });

  it("a result too large for its row is cut from the end and says so", () => {
    const rows = Array.from({ length: 1000 }, (_, i) => [i, "x".repeat(100)]);
    const full = { rows, truncated: false, row_count: rows.length };
    expect(capResultBytes(full, 50_000_000)).toBe(full);
    const cut = capResultBytes(full, 20_000);
    expect(cut.truncated).toBe(true);
    expect(cut.rows.length).toBeLessThan(200);
    expect(cut.row_count).toBe(cut.rows.length);
    expect(JSON.stringify(cut).length).toBeLessThanOrEqual(20_000);
  });

  it("the page remembers the engine choice, because the Query tab unmounts on every tab switch", () => {
    const page = rd("src/routes/_authenticated/lakehouse.tsx");
    expect(page).toContain('localStorage.getItem("lakehouse.engine")');
    expect(page).toContain('localStorage.setItem("lakehouse.engine", v)');
    // Offered only when the deployment has Spark; polled, not awaited.
    expect(page).toContain("{spark?.configured && (");
    expect(page).toContain("getSparkFn({ data: { access_token: token, id } })");
  });

  it("the cluster reaper counts a query's driver as live", () => {
    const src = rd("src/utils/etl/sparkCluster.server.ts");
    expect(src).toContain('.from("lakehouse_spark_queries")');
    expect(src).toContain('.in("status", ["queued", "running"])');
  });
});

describe("governance the planner keeps", () => {
  const src = rd("src/utils/lakehouse/sparkQuery.server.ts");

  it("refuses everything but a SELECT, a mounted schema, a policed table and encrypted files", () => {
    expect(src).toContain('if (classified.kind !== "select")');
    expect(src).toContain("assertSchemasAllowed(schemas, allowed)");
    expect(src).toContain("row?.lake_source_id || row?.iceberg_catalog_id");
    expect(src).toContain("has a security policy, which Spark cannot enforce");
    expect(src).toContain("is stored encrypted");
  });

  it("flushes inlined rows and pins every table to one snapshot before listing files", () => {
    const flush = src.indexOf("CALL ducklake_flush_inlined_data('lake')");
    const snap = src.indexOf("SELECT max(snapshot_id) AS s FROM ducklake_snapshots('lake')");
    const list = src.indexOf("ducklake_list_files('lake'");
    expect(flush).toBeGreaterThan(-1);
    expect(flush).toBeLessThan(snap);
    expect(snap).toBeLessThan(list);
    expect(src).toContain("snapshot_version =>");
  });

  it("a cancel that lands while the sandbox is starting still stops it", () => {
    // The launch claims the row with a guarded update; when the claim fails
    // the row was cancelled meanwhile, and the session just started must not
    // be left running the query for nobody.
    const claim = src.indexOf('.eq("status", "queued")\n      .select("id")');
    expect(claim).toBeGreaterThan(-1);
    const after = src.slice(claim, claim + 700);
    expect(after).toContain("if (!claimed) {");
    expect(after).toContain("await stopSession(session).catch(() => {});");
  });

  it("records the answer in the shared history as a Spark one", () => {
    expect(src).toContain('engine: "spark"');
    expect(src).toContain('.from("lakehouse_query_history")');
  });
});
