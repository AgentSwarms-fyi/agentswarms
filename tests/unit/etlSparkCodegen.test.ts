// The Spark engine's compiler: the same graph the pandas compiler reads,
// emitted as a Spark Connect program.
//
// Two things are pinned here. What runs on the cluster and what runs on the
// driver is the engine's whole design, so each node kind is checked for the
// side it lands on. And the pandas semantics the emitter reproduces on purpose
// — null keys grouping, a null failing a range check — are asserted in the
// generated code rather than trusted. Every script is fed to the local
// Python's compile(), as the pandas compiler's tests do, because the quoting
// edges are the same injection surface here.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  compileGraph,
  pyStr,
  requirementsFor,
  sourceFn,
  starterGraph,
  type EtlGraph,
  type EtlNode,
} from "@/utils/etl/codegen";
import { ETL_ENGINES, compilePipeline, engineOf, pipelineRequirements } from "@/utils/etl/compile";
import {
  compileSparkGraph,
  sparkRefusal,
  sparkRequirementsFor,
  sqlDialectRefusal,
} from "@/utils/etl/sparkCodegen";

// ── Python syntax oracle (skips silently when no interpreter exists) ────────

function pythonBin(): string | null {
  for (const bin of ["python", "python3", "py"]) {
    try {
      execFileSync(bin, ["--version"], { stdio: "pipe" });
      return bin;
    } catch {
      /* try next */
    }
  }
  return null;
}
const PY = pythonBin();

function assertParsesAsPython(code: string): void {
  if (!PY) return;
  const dir = mkdtempSync(join(tmpdir(), "etl-spark-codegen-"));
  try {
    const file = join(dir, "gen.py");
    writeFileSync(file, code, "utf8");
    execFileSync(
      PY,
      ["-c", `compile(open(${JSON.stringify(file)}, encoding='utf8').read(), 'gen.py', 'exec')`],
      { stdio: "pipe" },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const node = (
  id: string,
  kind: EtlNode["kind"],
  config: Record<string, unknown>,
  label?: string,
): EtlNode => ({ id, kind, config: config as EtlNode["config"], ...(label ? { label } : {}) });

const CSV_SRC = node("s1", "source", { type: "object_storage", path: "raw/*.csv", format: "csv" });
const PARQUET_TGT = node("t1", "target", {
  type: "object_storage",
  dataset: "etl",
  table: "items",
  format: "parquet",
  write_mode: "replace",
});

/** A straight line of nodes, each feeding the next. */
function linear(...nodes: EtlNode[]): EtlGraph {
  const edges = nodes
    .slice(0, -1)
    .map((n, i) => ({ id: `e${i}`, from: n.id, to: nodes[i + 1].id }));
  return { nodes, edges };
}

/** Source → one transform → parquet target, the shape most checks need. */
function through(transform: Record<string, unknown>): string {
  const code = compileSparkGraph(linear(CSV_SRC, node("x", "transform", transform), PARQUET_TGT));
  assertParsesAsPython(code);
  return code;
}

// ── The dispatcher ──────────────────────────────────────────────────────────

describe("compile — one graph, two compilers", () => {
  it("reads any stored value but 'spark' as the pandas engine", () => {
    expect(ETL_ENGINES).toEqual(["pandas", "spark"]);
    expect(engineOf("spark")).toBe("spark");
    expect(engineOf("pandas")).toBe("pandas");
    expect(engineOf(undefined)).toBe("pandas");
    expect(engineOf(null)).toBe("pandas");
    expect(engineOf("SPARK")).toBe("pandas");
  });

  it("leaves the pandas engine's output byte-for-byte what it was", () => {
    const g = starterGraph();
    expect(compilePipeline(g, "pandas")).toBe(compileGraph(g));
    expect(pipelineRequirements(g, "pandas")).toBe(requirementsFor(g));
  });

  it("emits a Spark program for the spark engine, over the same graph", () => {
    const g = linear(CSV_SRC, PARQUET_TGT);
    const code = compilePipeline(g, "spark");
    expect(code).toBe(compileSparkGraph(g));
    expect(code).toContain("for the SPARK engine");
    expect(code).toContain("SparkSession.builder.remote(_url)");
    expect(code).toContain("'engine': 'spark',");
    assertParsesAsPython(code);
  });

  it("the sandbox half of a Spark run does not install dlt or ibis", () => {
    const g = linear(
      CSV_SRC,
      node("q", "transform", { type: "sql", query: "select * from t" }),
      PARQUET_TGT,
    );
    expect(requirementsFor(g)).toMatch(/^dlt/m);
    expect(requirementsFor(g)).toMatch(/^ibis-framework/m);
    const spark = sparkRequirementsFor(g);
    expect(spark).not.toMatch(/^dlt/m);
    expect(spark).not.toMatch(/^ibis-framework/m);
    expect(pipelineRequirements(g, "spark")).toBe(spark);
  });
});

// ── Sources: native where Spark has a reader, the driver elsewhere ──────────

describe("compileSparkGraph — sources", () => {
  it.each([
    ["csv", ".option('header', 'true').option('inferSchema', 'true').csv(_p)"],
    ["tsv", ".option('sep', '\\t').csv(_p)"],
    ["json", ".option('multiLine', 'true').json(_p)"],
    ["jsonl", "_r.json(_p)"],
    ["parquet", "_r.parquet(_p)"],
  ])("reads %s from object storage on the cluster", (format, reader) => {
    const src = node("s1", "source", { type: "object_storage", path: "raw/x", format });
    const code = compileSparkGraph(linear(src, PARQUET_TGT));
    expect(code).toContain(reader);
    expect(code).toContain("_p = 's3a://' + _base + '/' + 'raw/x'.lstrip('/')");
    expect(code).toContain("_r = _sp.read.options(**_s3_options('ETL_S1'))");
    expect(code).toContain("    f_s1 = _src_s1()");
    expect(code).not.toContain("_lift(_src_s1())");
    assertParsesAsPython(code);
  });

  it("reads a spreadsheet on the driver and lifts it, with the pandas engine's own reader", () => {
    const src = node("s1", "source", {
      type: "object_storage",
      path: "raw/book.xlsx",
      format: "xlsx",
    });
    const g = linear(src, PARQUET_TGT);
    const code = compileSparkGraph(g);
    expect(code).toContain("    f_s1 = _lift(_src_s1())");
    // The very function the pandas compiler emits, so the engines cannot
    // disagree about what reading this node means.
    expect(code).toContain(sourceFn(src));
    expect(compileGraph(g)).toContain(sourceFn(src));
    assertParsesAsPython(code);
  });

  it("pushes an incremental cursor into the storage read", () => {
    const src = node("s1", "source", {
      type: "object_storage",
      path: "raw/*.parquet",
      format: "parquet",
      incremental: { cursor_column: "updated_at" },
    });
    const code = compileSparkGraph(linear(src, PARQUET_TGT));
    expect(code).toContain("_cur = os.environ.get('ETL_S1_CURSOR')");
    // The column's own type, as on the pandas engine: comparing as text hides
    // every row from 10 up behind a watermark of 9.
    expect(code).toContain("_t = _sdf.schema['updated_at'].dataType");
    // try_cast, not cast: under ANSI mode a bad cast raises rather than
    // yielding the null the fallback tests for.
    expect(code).toContain("_lit = F.lit(_cur).try_cast(_t)");
    expect(code).toContain("_sdf = _sdf.filter(_c > _lit)");
    // A watermark the type cannot hold falls back to text rather than casting
    // to null, which would drop every row instead of none.
    expect(code).toContain("_sp.range(1).select(_lit.alias('_v')).first()['_v'] is None");
    expect(code).toContain("_wm_s1 = _max_of(f_s1, 'updated_at')");
    expect(code).toContain("_watermarks['s1'] = str(_wm_s1)");
    expect(code).toContain("'watermarks': _watermarks,");
    assertParsesAsPython(code);
  });

  it("reads a database table over JDBC, the cursor pushed down as a WHERE", () => {
    const src = node("s1", "source", {
      type: "database",
      mode: "table",
      table: "public.orders",
      provider: "postgres",
      incremental: { cursor_column: "id" },
    });
    const code = compileSparkGraph(linear(src, PARQUET_TGT));
    expect(code).toContain("_j = _jdbc(os.environ['ETL_S1_URL'])");
    expect(code).toContain("_q = 'SELECT * FROM ' + 'public.orders'");
    expect(code).toContain('WHERE id > \' + "\'" + _cur.replace("\'", "\'\'") + "\'"');
    expect(code).toContain(".option('query', _q).load()");
    expect(code).not.toContain("pandas_api");
    assertParsesAsPython(code);
  });

  it("reads a database query over JDBC and refuses an empty one", () => {
    const src = node("s1", "source", {
      type: "database",
      mode: "query",
      query: "SELECT id, total FROM sales WHERE total > 0",
      provider: "mysql",
    });
    const code = compileSparkGraph(linear(src, PARQUET_TGT));
    expect(code).toContain("_q = 'SELECT id, total FROM sales WHERE total > 0'");
    assertParsesAsPython(code);
    const empty = node("s1", "source", {
      type: "database",
      mode: "query",
      query: "  ",
      provider: "mysql",
    });
    expect(() => compileSparkGraph(linear(empty, PARQUET_TGT))).toThrow(/has no query/);
  });

  it("maps every warehouse family to its JDBC driver, and names the gap", () => {
    const code = compileSparkGraph(linear(CSV_SRC, PARQUET_TGT));
    expect(code).toContain("'driver': 'org.postgresql.Driver'");
    expect(code).toContain("'driver': 'com.mysql.cj.jdbc.Driver'");
    expect(code).toContain("'driver': 'com.microsoft.sqlserver.jdbc.SQLServerDriver'");
    expect(code).toContain(
      "raise RuntimeError('The Spark engine has no JDBC driver for ' + scheme)",
    );
  });

  it("keeps the pandas compiler's refusals: an unsupported source provider", () => {
    const src = node("s1", "source", {
      type: "database",
      mode: "table",
      table: "t",
      provider: "bigquery",
    });
    const g = linear(src, PARQUET_TGT);
    expect(() => compileGraph(g)).toThrow(/not supported as a pipeline source/);
    expect(() => compileSparkGraph(g)).toThrow(/not supported as a pipeline source/);
  });

  it("runs an HTTP fetch, CDC and a lakehouse read on the driver, lifted", () => {
    const http = node("h", "source", { type: "http_api", url: "https://api.example.com/items" });
    const cdc = node("c", "source", {
      type: "database",
      mode: "cdc",
      table: "public.orders",
      provider: "postgres",
    });
    const lake = node("l", "source", {
      type: "lakehouse",
      schema: "main",
      mode: "table",
      table: "t",
    });
    const union = node("u", "transform", { type: "union" });
    const g: EtlGraph = {
      nodes: [http, cdc, lake, union, PARQUET_TGT],
      edges: [
        { id: "e1", from: "h", to: "u" },
        { id: "e2", from: "c", to: "u" },
        { id: "e3", from: "l", to: "u" },
        { id: "e4", from: "u", to: "t1" },
      ],
    };
    const code = compileSparkGraph(g);
    for (const id of ["h", "c", "l"]) expect(code).toContain(`    f_${id} = _lift(_src_${id}())`);
    expect(code).toContain("_cdc_last_c = None");
    expect(code).toContain("_watermarks['c'] = _cdc_last_c");
    expect(code).toContain("def _lakehouse_con():");
    expect(code).toContain(
      "f_u = f_h.unionByName(f_c, allowMissingColumns=True).unionByName(f_l, allowMissingColumns=True)",
    );
    assertParsesAsPython(code);
  });
});

// ── Transforms: pandas-on-Spark, so the expressions people typed still work ─

describe("compileSparkGraph — transforms", () => {
  it("filter is the pandas condition translated to Spark SQL at compile time", () => {
    expect(through({ type: "filter", expr: "amount > 10 and status == 'paid'" })).toContain(
      "f_x = f_s1.filter('amount > 10 AND status == \\'paid\\'')",
    );
    expect(
      through({ type: "filter", expr: "(qty > 0) & ~region.isnull() & status in ['a', 'b']" }),
    ).toContain(
      "f_x = f_s1.filter('(qty > 0) AND NOT (region IS NULL) AND status IN (\\'a\\', \\'b\\')')",
    );
    expect(() => through({ type: "filter", expr: "amount > @limit" })).toThrow(
      /Filter "x": `@variable`/,
    );
  });

  it("select, rename, derive", () => {
    expect(through({ type: "select", columns: ["id", "amount"] })).toContain(
      "f_x = f_s1.select('id', 'amount')",
    );
    expect(
      through({ type: "rename", mapping: { amt: "amount", "Order Id": "order_id" } }),
    ).toContain("f_x = f_s1.withColumnsRenamed({'amt': 'amount', 'Order Id': 'order_id'})");
    expect(through({ type: "derive", column: "total", expr: "qty * price" })).toContain(
      "f_x = f_s1.withColumn('total', F.expr('qty * price'))",
    );
  });

  it("dedupe, limit, sort", () => {
    expect(through({ type: "dedupe" })).toContain("f_x = f_s1.dropDuplicates()");
    expect(through({ type: "dedupe", columns: ["id"] })).toContain(
      "f_x = f_s1.dropDuplicates(['id'])",
    );
    expect(through({ type: "limit", n: 7.9 })).toContain("f_x = f_s1.limit(7)");
    expect(through({ type: "limit", n: -3 })).toContain("f_x = f_s1.limit(0)");
    const sorted = through({ type: "sort", by: ["region", "amount"], descending: true });
    expect(sorted).toContain("f_x = _sort(f_s1, ['region', 'amount'], True)");
    // Nulls last either way, as pandas sorts them.
    expect(sorted).toContain(
      "F.col(c).desc_nulls_last() if descending else F.col(c).asc_nulls_last()",
    );
  });

  it("aggregate is native Spark with pandas' null semantics written out", () => {
    const code = through({
      type: "aggregate",
      group_by: ["region"],
      aggs: [
        { column: "amount", fn: "sum", as: "total" },
        { column: "id", fn: "nunique", as: "customers" },
        { column: "amount", fn: "median", as: "median_amount" },
        { column: "ts", fn: "first", as: "first_ts" },
      ],
    });
    expect(code).toContain(
      "f_x = _agg(f_s1, ['region'], [('total', 'amount', 'sum'), ('customers', 'id', 'nunique'), ('median_amount', 'amount', 'median'), ('first_ts', 'ts', 'first')])",
    );
    // dropna=False, count skips nulls, first/last skip nulls — each explicit.
    expect(code).toContain("elif _fn == 'nunique': _e = F.count_distinct(_c)");
    expect(code).toContain("elif _fn == 'first': _e = F.first(_c, ignorenulls=True)");
    expect(code).toContain("return sdf.groupBy(*keys).agg(*_exprs)");
  });

  it("aggregate refuses an unknown function and a non-identifier output name", () => {
    expect(() =>
      through({ type: "aggregate", group_by: [], aggs: [{ column: "a", fn: "stddev", as: "s" }] }),
    ).toThrow(/Unknown aggregate function/);
    expect(() =>
      through({
        type: "aggregate",
        group_by: [],
        aggs: [{ column: "a", fn: "sum", as: "bad name; import os" }],
      }),
    ).toThrow(/Aggregate output name/);
  });

  it("fill and drop nulls, numeric fills kept numeric", () => {
    const fill = through({ type: "fill_nulls", value: "0" });
    expect(fill).toContain("f_x = _fill(f_s1, 0, [])");
    // pandas' reach: the value is cast to each column's own type.
    expect(fill).toContain("F.coalesce(F.col(f.name), F.lit(value).cast(f.dataType))");
    expect(through({ type: "fill_nulls", value: "n/a", columns: ["name", "city"] })).toContain(
      "f_x = _fill(f_s1, 'n/a', ['name', 'city'])",
    );
    expect(through({ type: "drop_nulls" })).toContain("f_x = f_s1.dropna()");
    expect(through({ type: "drop_nulls", columns: ["id"] })).toContain(
      "f_x = f_s1.dropna(subset=['id'])",
    );
  });

  it("join honours the chosen left side and its key lists", () => {
    const orders = node("o", "source", {
      type: "object_storage",
      path: "orders/*.parquet",
      format: "parquet",
    });
    const customers = node("c", "source", {
      type: "object_storage",
      path: "customers/*.csv",
      format: "csv",
    });
    const join = node("j", "transform", {
      type: "join",
      how: "left",
      left_on: ["customer_id"],
      right_on: ["id"],
      left_node: "o",
    });
    const g: EtlGraph = {
      nodes: [customers, orders, join, PARQUET_TGT],
      edges: [
        { id: "e1", from: "c", to: "j" },
        { id: "e2", from: "o", to: "j" },
        { id: "e3", from: "j", to: "t1" },
      ],
    };
    const code = compileSparkGraph(g);
    expect(code).toContain("f_j = _merge(f_o, f_c, 'left', ['customer_id'], ['id'])");
    // pandas' merge, reproduced: suffixes, one column for a same-named key, null keys matching.
    expect(code).toContain("l = l.withColumnRenamed(c, c + '_x')");
    expect(code).toContain("e = l[a].eqNullSafe(r[b])");
    expect(code).toContain(
      "{'inner': 'inner', 'left': 'left', 'right': 'right', 'outer': 'full'}[how]",
    );
    assertParsesAsPython(code);
  });

  it("SQL is Spark SQL over a temp view of the frame", () => {
    const code = through({
      type: "sql",
      query: "SELECT region, SUM(amount) AS total FROM t GROUP BY 1",
    });
    expect(code).toContain(
      "f_x = _sql_over(f_s1, 'SELECT region, SUM(amount) AS total FROM t GROUP BY 1')",
    );
    expect(code).toContain("sdf.createOrReplaceTempView('t')");
    expect(code).toContain("return _spark().sql(query)");
    expect(code).not.toContain("import ibis");
  });

  it("Custom Python keeps its whole-frame contract: collected, run, lifted back", () => {
    const code = through({
      type: "python",
      code: "df['flag'] = df['amount'] > 100\ndf = df.sort_values('amount')",
    });
    expect(code).toContain(
      "def _fn_x(df):\n    df['flag'] = df['amount'] > 100\n    df = df.sort_values('amount')\n    return df",
    );
    expect(code).toContain("f_x = _lift(_fn_x(f_s1.toPandas()))");
  });

  it("quotes user text so a column name cannot become code", () => {
    const evil = "id'); import os; os.system('x'); ('";
    const code = through({ type: "select", columns: [evil] });
    expect(code).toContain(`f_x = f_s1.select(${pyStr(evil)})`);
    expect(code).not.toContain("f_s1.select('id'); import os");
    // A filter is translated, so a second statement is a translation error,
    // not a second statement.
    expect(() => through({ type: "filter", expr: "a == 'x'\nimport os" })).toThrow(
      /Filter "x": `import` follows a value/,
    );
    const code2 = through({ type: "filter", expr: "a == 'x\\'); import os; ('" });
    expect(code2).toContain(`f_x = f_s1.filter(${pyStr("a == 'x\\'); import os; ('")})`);
  });
});

// ── Quality gates: native, with nulls counted the way the pandas engine does ─

describe("compileSparkGraph — quality gates", () => {
  const gate = (rules: Record<string, unknown>[]) => through({ type: "quality_gate", rules });

  it("emits one helper column per rule and drops them all at the end", () => {
    const code = gate([
      { check: "not_null", column: "id", severity: "fail" },
      { check: "unique", column: "id", severity: "fail" },
    ]);
    expect(code).toContain("_sdf = _sdf.withColumn('__v0', F.col('id').isNull())");
    expect(code).toContain(
      "_sdf = _sdf.withColumn('__v1', (F.count(F.lit(1)).over(Window.partitionBy('id')) > 1))",
    );
    expect(code).toContain("def _gate_x(_sdf):");
    expect(code).toContain("return _sdf.drop(*_helpers)");
    expect(code).toContain("f_x = _gate_x(f_s1)");
    expect(code).toContain("'quality': _quality,");
  });

  it("a null is a violation of range, regex and allowed-values — coalesced, not three-valued", () => {
    const code = gate([
      { check: "range", column: "amount", min: 0, max: 1000, severity: "warn" },
      { check: "range", column: "qty", min: 1, severity: "warn" },
      { check: "range", column: "pct", max: 100, severity: "warn" },
      { check: "regex", column: "email", pattern: "[^@]+@[^@]+", severity: "drop" },
      { check: "allowed_values", column: "status", values: ["new", "paid"], severity: "drop" },
    ]);
    expect(code).toContain("~F.coalesce(F.col('amount').between(0, 1000), F.lit(False))");
    expect(code).toContain("~F.coalesce(F.col('qty') >= 1, F.lit(False))");
    expect(code).toContain("~F.coalesce(F.col('pct') <= 100, F.lit(False))");
    expect(code).toContain(
      "~F.coalesce(F.col('email').cast('string').rlike('^(?:[^@]+@[^@]+)$'), F.lit(False))",
    );
    expect(code).toContain("~F.coalesce(F.col('status').isin(['new', 'paid']), F.lit(False))");
  });

  it("severity: fail raises, drop filters and recounts, warn prints", () => {
    const code = gate([
      { check: "not_null", column: "id", severity: "fail" },
      { check: "not_null", column: "email", severity: "drop" },
      { check: "not_null", column: "phone", severity: "warn" },
    ]);
    expect(code).toContain("raise RuntimeError('Quality gate ' + 'x' + ': ' + ");
    expect(code).toContain("_sdf = _sdf.filter(~F.col('__v1'))\n        _rows = _sdf.count()");
    expect(code).toContain("print('[quality] WARN ' + ");
    expect(code).toContain("'severity': 'drop'");
  });

  it("row_count_min checks the count, without a column", () => {
    const code = gate([{ check: "row_count_min", min: 10, severity: "fail" }]);
    expect(code).toContain("_n0 = 10 - int(_rows) if _rows < 10 else 0");
    expect(code).toContain("need 10')");
  });

  it("refuses a gate with no rules, a rule with no column, a range with no bound", () => {
    expect(() => gate([])).toThrow(/has no rules/);
    expect(() => gate([{ check: "not_null", severity: "fail" }])).toThrow(/needs a column/);
    expect(() => gate([{ check: "range", column: "a", severity: "fail" }])).toThrow(
      /min, a max, or both/,
    );
  });
});

// ── Targets ─────────────────────────────────────────────────────────────────

describe("compileSparkGraph — targets", () => {
  it.each([
    ["parquet", "replace", ".format('parquet').mode('overwrite').save(_dest)"],
    ["csv", "append", ".option('header', 'true').format('csv').mode('append').save(_dest)"],
    ["jsonl", "append", ".format('json').mode('append').save(_dest)"],
  ])("writes %s (%s) to object storage on the cluster", (format, write_mode, writer) => {
    const tgt = node("t1", "target", {
      type: "object_storage",
      dataset: "etl",
      table: "items",
      format,
      write_mode,
    });
    const code = compileSparkGraph(linear(CSV_SRC, tgt));
    expect(code).toContain("_sdf = f_s1\n");
    expect(code).toContain(
      "_dest = os.environ['ETL_T1_BUCKET_URL'].replace('s3://', 's3a://', 1).rstrip('/') + '/etl/items'",
    );
    expect(code).toContain(`_sdf.write.options(**_o)${writer}`);
    expect(code).toContain("'target': 'etl.items', 'fqn': ");
    expect(code).not.toContain("import dlt");
    assertParsesAsPython(code);
  });

  it("merge into Delta is Delta's own MERGE over the path, first write creating the table", () => {
    const tgt = node("t1", "target", {
      type: "object_storage",
      dataset: "etl",
      table: "customers",
      format: "parquet",
      table_format: "delta",
      write_mode: "merge",
      primary_key: ["id", "region"],
    });
    const code = compileSparkGraph(linear(CSV_SRC, tgt));
    expect(code).toContain("_sp = _s3_session('ETL_T1')");
    expect(code).toContain(
      "_sdf.write.options(**_o).format('delta').mode('overwrite').save(_dest)",
    );
    expect(code).toContain(
      'MERGE INTO delta.`" + _dest + "` AS t USING _src_t1 AS s ON t.id = s.id AND t.region = s.region WHEN MATCHED THEN UPDATE SET * WHEN NOT MATCHED THEN INSERT *',
    );
    expect(code).toContain("'fqn': 'etl/customers/*.parquet'");
    assertParsesAsPython(code);
  });

  it("merge needs primary keys, and a Delta target may replace or append too", () => {
    const noKeys = node("t1", "target", {
      type: "object_storage",
      dataset: "etl",
      table: "c",
      format: "parquet",
      table_format: "delta",
      write_mode: "merge",
    });
    expect(() => compileSparkGraph(linear(CSV_SRC, noKeys))).toThrow(/needs primary key columns/);
    const appendDelta = node("t1", "target", {
      type: "object_storage",
      dataset: "etl",
      table: "c",
      format: "parquet",
      table_format: "delta",
      write_mode: "append",
    });
    expect(compileSparkGraph(linear(CSV_SRC, appendDelta))).toContain(
      "_sdf.write.options(**_o).format('delta').mode('append').save(_dest)",
    );
  });

  it("writes a database table over JDBC", () => {
    const tgt = node("t1", "target", {
      type: "database",
      provider: "postgres",
      dataset: "analytics",
      table: "orders",
      write_mode: "replace",
    });
    const code = compileSparkGraph(linear(CSV_SRC, tgt));
    expect(code).toContain("_j = _jdbc(os.environ['ETL_T1_URL'])");
    expect(code).toContain(
      "_sdf.write.format('jdbc').option('url', _j['url']).option('dbtable', 'analytics.orders')",
    );
    expect(code).toContain(".mode('overwrite').save()");
    expect(code).toContain("'target': 'analytics.orders', 'fqn': 'analytics.orders'");
    assertParsesAsPython(code);
  });

  it("schema drift: recorded always, compared under warn and strict", () => {
    const mk = (schema_policy?: string) =>
      compileSparkGraph(
        linear(
          CSV_SRC,
          node("t1", "target", {
            type: "object_storage",
            dataset: "etl",
            table: "items",
            format: "parquet",
            write_mode: "append",
            ...(schema_policy ? { schema_policy } : {}),
          }),
        ),
      );
    const evolve = mk();
    expect(evolve).toContain("_schemas['t1'] = _schema_of(_sdf)");
    expect(evolve).not.toContain("_prev_raw");
    const warn = mk("warn");
    expect(warn).toContain("_prev_raw = os.environ.get('ETL_T1_SCHEMA')");
    expect(warn).toContain("print('[schema] WARN ' + _msg)");
    const strict = mk("strict");
    expect(strict).toContain("raise RuntimeError('[schema] ' + _msg)");
    assertParsesAsPython(strict);
    // Type names as the pandas engine would report them, so a baseline one
    // engine recorded does not read as total drift to the other.
    expect(strict).toContain("'bigint': 'int64'");
    expect(strict).toContain("'double': 'float64'");
  });

  it("HTTP and SaaS targets take the collected result; the lakehouse does not", () => {
    // The lakehouse USED to be on this list. It is not any more — an HTTP
    // target is a few hundred records posted to an API, which a cluster has
    // nothing to parallelise, while a lakehouse target can be the whole
    // result of the pipeline and used to have to fit in the driver.
    const lake = node("t1", "target", {
      type: "lakehouse",
      schema: "main",
      table: "items",
      write_mode: "replace",
    });
    const http = node("t2", "target", { type: "http_api", url: "https://sink.example.com/rows" });
    const g: EtlGraph = {
      nodes: [CSV_SRC, lake, http],
      edges: [
        { id: "e1", from: "s1", to: "t1" },
        { id: "e2", from: "s1", to: "t2" },
      ],
    };
    const code = compileSparkGraph(g);
    expect(code).not.toContain("_pd_t1 = f_s1.toPandas()");
    expect(code).toContain("_pd_t2 = f_s1.toPandas()");
    expect(code).toContain("def _lakehouse_con():");
    expect(code).toContain("# target t1: lakehouse → main.items (replace), written by the cluster");
    assertParsesAsPython(code);
  });
});

// ── What the engine says no to, at save time ────────────────────────────────

describe("compileSparkGraph — the lakehouse is written by the cluster", () => {
  // THE LAST WRITE THAT WENT THROUGH THE DRIVER. Object storage and JDBC
  // targets always wrote from the executors; a lakehouse target called
  // `.toPandas()` and handed the frame to the pandas loader, so a pipeline
  // sized for a cluster still had to fit its RESULT in one process. DuckLake
  // has no Spark connector and still has not — what changed is that it does
  // not need one: the executors write Parquet into the lake's own bucket and
  // the driver loads it with one statement that streams the files in.
  const lakeTarget = (write_mode: string, primary_key?: string[]) =>
    node("t1", "target", {
      type: "lakehouse",
      schema: "analytics",
      table: "orders",
      write_mode,
      ...(primary_key ? { primary_key } : {}),
    });

  it("never collects the frame to the driver", () => {
    for (const mode of ["replace", "append"]) {
      const code = compileSparkGraph(linear(CSV_SRC, lakeTarget(mode)));
      // The whole point. `.toPandas()` on a target's input is the bug.
      expect(code, `${mode} collects to the driver`).not.toContain("_pd_t1 = f_s1.toPandas()");
      expect(code).toContain("_sdf.write.options(**_lake_s3_options()).mode('overwrite').parquet(");
      assertParsesAsPython(code);
    }
  });

  it("stages under the lake's own bucket, per run and per node", () => {
    // Per RUN because a re-run must not write over Parquet an earlier run is
    // still loading; per NODE because two lakehouse targets in one graph
    // would otherwise share a prefix and load each other's rows.
    const code = compileSparkGraph(linear(CSV_SRC, lakeTarget("append")));
    expect(code).toContain("_spark_stage/t1/");
    expect(code).toContain("os.environ.get('ETL_RUN_ID'");
    expect(code).toContain("os.environ['ETL_LAKEHOUSE_DATA_URL'].rstrip('/')");
    // Spark writes s3a://, DuckDB reads s3://. Getting that backwards is a
    // scheme error at the far end of a long job.
    expect(code).toContain("_stage = _lake.replace('s3://', 's3a://', 1)");
    expect(code).toContain("_q = _lake + '/' + _stage_key + '/*.parquet'");
  });

  it("loads by streaming the files, not by reading them into the driver", () => {
    const code = compileSparkGraph(linear(CSV_SRC, lakeTarget("replace")));
    expect(code).toContain("con = _lakehouse_con()");
    expect(code).toContain(
      'CREATE OR REPLACE TABLE "analytics"."orders" AS SELECT * FROM read_parquet(',
    );
    expect(code).not.toContain("register('_src'");
  });

  it("appends without letting an empty batch shape the table", () => {
    // read_parquet over a prefix Spark wrote nothing to is an error, not zero
    // rows — and a stream with nothing new is an ordinary Tuesday.
    const code = compileSparkGraph(linear(CSV_SRC, lakeTarget("append")));
    expect(code).toContain("if _n:");
    expect(code).toContain(`CREATE TABLE IF NOT EXISTS "analytics"."orders"`);
    expect(code).toContain(
      `INSERT INTO "analytics"."orders" BY NAME SELECT * FROM read_parquet(' + _qlit + ')`,
    );
  });

  it("upserts in one transaction, as the pandas engine does", () => {
    // A reader must never see the gap between the delete and the insert.
    const code = compileSparkGraph(linear(CSV_SRC, lakeTarget("merge", ["id", "region"])));
    const block = code.slice(code.indexOf("# target t1"));
    const begin = block.indexOf("BEGIN TRANSACTION");
    const del = block.indexOf('DELETE FROM "analytics"."orders"');
    const ins = block.indexOf('INSERT INTO "analytics"."orders"');
    const commit = block.indexOf("COMMIT");
    expect(begin).toBeGreaterThan(-1);
    expect(del).toBeGreaterThan(begin);
    expect(ins).toBeGreaterThan(del);
    expect(commit).toBeGreaterThan(ins);
    expect(block).toContain(
      `WHERE ("id", "region") IN (SELECT "id", "region" FROM read_parquet(' + _qlit + ')`,
    );
    assertParsesAsPython(code);
  });

  it("refuses a merge with no keys rather than writing duplicates", () => {
    // The refusal comes from the pandas compiler, which compileSparkGraph runs
    // over the same graph as a validation pass — one list of rules, one
    // wording. This pins the BEHAVIOUR, not where it lives.
    expect(() => compileSparkGraph(linear(CSV_SRC, lakeTarget("merge")))).toThrow(/primary key/i);
  });

  it("stages under a prefix the run can be traced from", () => {
    // ETL_RUN_ID has to be SET for the prefix to mean anything — the code
    // falls back to a clock, and two runs of one pipeline starting in the same
    // second would then write over each other. The one call that is about to
    // become a running sandbox is the one that knows the run.
    const svc = readFileSync("src/utils/etl/service.server.ts", "utf8");
    expect(svc).toContain("env.ETL_RUN_ID = opts.runId");
    // The whole function body, not up to the first brace: the signature has
    // braces of its own and the first version of this read only those.
    const from = svc.indexOf("export async function etlEnvFor");
    const launch = svc.slice(from, svc.indexOf("\n}", from));
    expect(launch).toContain("runId: run.id");
  });

  it("installs the client the cleanup needs", () => {
    // The pandas compiler asks for s3fs when a graph READS object storage. On
    // this engine every lakehouse target WRITES it, to clear its staging
    // prefix — and without the package that cleanup fails on every run with an
    // ImportError while the bucket grows.
    // A source that does NOT read object storage, or s3fs is already there for
    // its own reasons and this test proves nothing — which it did, until a
    // mutation deleted the line and changed no result.
    const src = node("s1", "source", { type: "lakehouse", schema: "raw", table: "events" });
    expect(sparkRequirementsFor(linear(src, lakeTarget("append")))).toMatch(/^s3fs/m);
    // And it is the TARGET that asks: the same source with a non-lakehouse
    // target does not need it.
    expect(sparkRequirementsFor(linear(src, PARQUET_TGT))).not.toMatch(/^s3fs/m);
  });

  it("clears the staging prefix, and never fails the run for failing to", () => {
    // The load COPIED the rows, so the staged Parquet is rubbish the moment it
    // commits — left behind it grows the bucket by every run for ever. But the
    // rows are already committed, so failing to tidy up is not a failed run.
    const code = compileSparkGraph(linear(CSV_SRC, lakeTarget("replace")));
    const block = code.slice(code.indexOf("# target t1"));
    // fsspec, NOT Hadoop's FileSystem API: under Spark Connect the client has
    // no JVM gateway, so `_jsc` does not exist and the obvious spelling is
    // silently skipped on exactly the deployment this engine is for.
    expect(block).toContain("_fs.rm(_lake + '/' + _stage_key, recursive=True)");
    expect(block).not.toContain("_jsc");
    expect(block).toContain("except Exception as _e:");
    expect(block).toContain("staged files left at");
    // And the tidy-up comes after the load, not before it.
    expect(block.indexOf("con.close()")).toBeLessThan(block.indexOf("_fs.rm("));
  });
});

describe("SQL steps: the dialect traps, said before the run", () => {
  // FOUND BY RUNNING ONE. A pipeline with a SQL step died minutes into a
  // cluster run with `INVALID_PARAMETER_VALUE.REGEX_GROUP_INDEX`, having
  // already read its sources — because `regexp_extract(s, pattern)` returns
  // the whole match in DuckDB and Spark reads the missing third argument as
  // capture group 1. Both engines run the same SQL step; where they disagree,
  // save time is the place to say so.
  const sqlStep = (query: string) => node("x", "transform", { type: "sql", query });

  it("refuses a two-argument regexp_extract, and says what to write instead", () => {
    const why = sqlDialectRefusal("SELECT regexp_extract(ref, '[0-9]+') AS n FROM t", "Normalise");
    expect(why).toMatch(/Normalise/);
    expect(why).toMatch(/regexp_extract\(x, pattern, 0\)/);
    // The refusal has to carry the fix, not just the complaint.
    expect(why).toMatch(/whole match/i);
  });

  it("accepts the explicit forms, which both engines agree on", () => {
    // Verified against DuckDB: idx 0 and idx 1 both return "123" for
    // regexp_extract('ORD-123', '([0-9]+)', idx). Spark matches.
    for (const q of [
      "SELECT regexp_extract(ref, '([0-9]+)', 0) FROM t",
      "SELECT regexp_extract(ref, '([0-9]+)', 1) FROM t",
      "SELECT upper(ref) FROM t",
    ]) {
      expect(sqlDialectRefusal(q, "s"), q).toBeNull();
    }
  });

  it("does not read a function call out of a string literal", () => {
    // The whole reason literals are blanked first: a query that merely
    // MENTIONS the call in text is not making it.
    const q = "SELECT 'regexp_extract(a, b)' AS note, regexp_extract(ref, 'x', 0) FROM t";
    expect(sqlDialectRefusal(q, "s")).toBeNull();
  });

  it("counts arguments at the top level, not inside nested calls", () => {
    // `regexp_extract(concat(a, b), p)` is still two arguments; the comma
    // inside concat() belongs to concat.
    expect(sqlDialectRefusal("SELECT regexp_extract(concat(a, b), '[0-9]+') FROM t", "s")).toMatch(
      /regexp_extract/,
    );
    expect(
      sqlDialectRefusal("SELECT regexp_extract(concat(a, b), '[0-9]+', 0) FROM t", "s"),
    ).toBeNull();
  });

  it("refuses the graph at save time, through sparkRefusal", () => {
    // The point of finding it here: compileSparkGraph throws before anything
    // reaches a cluster.
    const g = linear(CSV_SRC, sqlStep("SELECT regexp_extract(a, 'p') FROM t"), PARQUET_TGT);
    expect(sparkRefusal(g)).toMatch(/regexp_extract/);
    expect(() => compileSparkGraph(g)).toThrow(/regexp_extract/);
  });

  it("leaves the pandas engine alone — it is the Spark default that differs", () => {
    // DuckDB is happy with the two-argument form and always was. Refusing it
    // on both engines would be inventing a rule to make two engines agree.
    const g = linear(CSV_SRC, sqlStep("SELECT regexp_extract(a, 'p') FROM t"), PARQUET_TGT);
    expect(() => compileGraph(g)).not.toThrow();
  });
});

describe("sparkRefusal", () => {
  const tgt = (extra: Record<string, unknown>, label?: string) =>
    node(
      "t1",
      "target",
      {
        type: "object_storage",
        dataset: "etl",
        table: "x",
        format: "parquet",
        write_mode: "replace",
        ...extra,
      },
      label,
    );

  it("accepts the ordinary graph", () => {
    expect(sparkRefusal(linear(CSV_SRC, PARQUET_TGT))).toBeNull();
    expect(sparkRefusal(starterGraph())).toBeNull();
  });

  it("Iceberg is not on the Spark engine yet", () => {
    const g = linear(CSV_SRC, tgt({ table_format: "iceberg" }, "Gold"));
    expect(sparkRefusal(g)).toMatch(/Target "Gold": Iceberg is not on the Spark engine yet/);
    expect(() => compileSparkGraph(g)).toThrow(/Iceberg/);
    // The pandas engine still takes it.
    expect(() => compileGraph(g)).not.toThrow();
  });

  it("merge into plain files has nothing to merge on", () => {
    const g = linear(CSV_SRC, tgt({ write_mode: "merge", primary_key: ["id"] }));
    expect(sparkRefusal(g)).toMatch(/merge needs a Delta table/);
  });

  it("merge into a database is not there yet", () => {
    const g = linear(
      CSV_SRC,
      node("t1", "target", {
        type: "database",
        provider: "postgres",
        dataset: "public",
        table: "x",
        write_mode: "merge",
        primary_key: ["id"],
      }),
    );
    expect(sparkRefusal(g)).toMatch(/merge into a database is not supported yet/);
    expect(() => compileGraph(g)).not.toThrow();
  });
});

// ── The whole program ───────────────────────────────────────────────────────

describe("compileSparkGraph — the program", () => {
  it("a wide pipeline: two sources, join, derive, filter, aggregate, gate, sort, two targets", () => {
    const orders = node("o", "source", {
      type: "object_storage",
      path: "orders/*.csv",
      format: "csv",
    });
    const customers = node("c", "source", {
      type: "database",
      mode: "table",
      table: "public.customers",
      provider: "postgres",
    });
    const nodes: EtlNode[] = [
      orders,
      customers,
      node("j", "transform", {
        type: "join",
        how: "inner",
        left_on: ["customer_id"],
        right_on: ["id"],
        left_node: "o",
      }),
      node("d", "transform", { type: "derive", column: "total", expr: "qty * price" }),
      node("f", "transform", { type: "filter", expr: "total > 0" }),
      node(
        "g",
        "transform",
        {
          type: "quality_gate",
          rules: [{ check: "not_null", column: "region", severity: "drop" }],
        },
        "Clean",
      ),
      node("a", "transform", {
        type: "aggregate",
        group_by: ["region"],
        aggs: [{ column: "total", fn: "sum", as: "revenue" }],
      }),
      node("s", "transform", { type: "sort", by: ["revenue"], descending: true }),
      node("t1", "target", {
        type: "object_storage",
        dataset: "gold",
        table: "revenue",
        format: "parquet",
        table_format: "delta",
        write_mode: "merge",
        primary_key: ["region"],
      }),
      node("t2", "target", {
        type: "database",
        provider: "mysql",
        dataset: "reports",
        table: "revenue",
        write_mode: "replace",
      }),
    ];
    const g: EtlGraph = {
      nodes,
      edges: [
        { id: "e1", from: "o", to: "j" },
        { id: "e2", from: "c", to: "j" },
        { id: "e3", from: "j", to: "d" },
        { id: "e4", from: "d", to: "f" },
        { id: "e5", from: "f", to: "g" },
        { id: "e6", from: "g", to: "a" },
        { id: "e7", from: "a", to: "s" },
        { id: "e8", from: "s", to: "t1" },
        { id: "e9", from: "s", to: "t2" },
      ],
    };
    const code = compileSparkGraph(g);
    assertParsesAsPython(code);
    // The per-tick body; `entrypoint` is the dispatcher appended after it.
    const entry = code.slice(code.indexOf("def _tick("));
    const seq = [
      "f_o = _src_o()",
      "f_c = _src_c()",
      "f_j = _merge(f_o, f_c, 'inner', ['customer_id'], ['id'])",
      "f_d = f_j.withColumn('total', F.expr('qty * price'))",
      "f_f = f_d.filter('total > 0')",
      "f_g = _gate_g(f_f)",
      "f_a = _agg(f_g, ['region'], [('revenue', 'total', 'sum')])",
      "f_s = _sort(f_a, ['revenue'], True)",
      "# target t1: object storage → gold.revenue (merge, delta)",
      "# target t2: database → reports.revenue (replace, JDBC)",
      "'engine': 'spark',",
      "'quality': _quality,",
    ];
    let at = -1;
    for (const s of seq) {
      const i = entry.indexOf(s, at + 1);
      expect(i, `expected "${s}" after position ${at}`).toBeGreaterThan(at);
      at = i;
    }
    // Nothing collected to the driver on this path: every node is native.
    expect(entry).not.toContain("toPandas()");
    expect(entry).not.toContain("_lift(");
    expect(code).toContain("'lineage_sources': ['orders/*.csv','public.customers'],");
  });

  it("never sets credentials on the cluster's shared configuration, only per call", () => {
    const code = compileSparkGraph(linear(CSV_SRC, PARQUET_TGT));
    expect(code).toContain("'fs.s3a.access.key': os.environ.get(stem + '_ACCESS_KEY_ID', '')");
    expect(code).toContain("_sp.read.options(**_s3_options('ETL_S1'))");
    expect(code).toContain("_sdf.write.options(**_o)");
    expect(code).not.toContain("spark.hadoop.fs.s3a");
  });

  it("prints a metrics line the run parser already understands, plus the engine", () => {
    const code = compileSparkGraph(linear(CSV_SRC, PARQUET_TGT));
    expect(code).toContain("print('[etl] ' + json.dumps(metrics))");
    expect(code).toContain("'rows_loaded': sum(l['rows'] for l in _loads),");
    expect(code).toContain("'schemas': _schemas,");
    expect(code).toContain("'engine': 'spark',");
    expect(code).toContain("return metrics");
  });
});
