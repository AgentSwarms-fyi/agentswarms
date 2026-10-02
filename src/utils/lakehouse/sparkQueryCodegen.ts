// Compile a governed lakehouse SELECT into the PySpark program a sandbox runs
// against a Spark Connect endpoint.
//
// DuckLake has no Spark connector, so the cluster never sees the catalog. The
// app resolves each table the statement reads to the Parquet files of one
// snapshot (core.server does that, governed, before anything is launched) and
// this module turns that manifest into code: one temporary view per table,
// read straight from object storage with the table's positional deletes
// applied, the statement's table references rewritten to the views, the rows
// collected under the row cap and returned as the batch result. Pure — no
// I/O — so a unit test can read the whole program.
//
// What a DuckLake data file looks like, verified live: the table's columns
// plus `_ducklake_internal_row_id` and `_ducklake_internal_snapshot_id`; a
// delete file is Parquet with `file_path` (the data file, as `s3://…`) and
// `pos` (the row's position in that file). Spark exposes the same position
// as `_metadata.row_index`, and the same file as `_metadata.file_path` under
// whatever scheme it read it with — so both sides are compared with the
// scheme stripped.

export type SparkQueryTable = {
  schema: string;
  table: string;
  /** Column names and DuckDB types, in order — an empty table still needs a schema. */
  columns: { name: string; type: string }[];
  dataFiles: string[];
  deleteFiles: string[];
};

export type SparkQueryPlan = {
  queryId: string;
  /** The statement as the user wrote it; references are rewritten here. */
  sql: string;
  tables: SparkQueryTable[];
  /** Rows returned at most; one more is fetched to know whether it was cut. */
  rowCap: number;
  /** The DuckLake snapshot every table was resolved at. */
  snapshot: number | null;
};

/** The temporary view a table becomes on the cluster: `schema__table`. */
export function viewNameFor(schema: string, table: string): string {
  return `${schema}__${table}`.replace(/[^A-Za-z0-9_]/g, "_");
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Rewrite every `schema.table` reference — bare or double-quoted, any case —
 * to its view's backticked name. The list of tables comes from DuckDB's own
 * parse of the statement, so nothing that is not a real table reference is
 * ever a candidate; a string literal that happens to spell one is the
 * documented limit.
 */
export function rewriteTableRefs(sql: string, tables: { schema: string; table: string }[]): string {
  let out = sql;
  for (const t of tables) {
    const re = new RegExp(
      `(?<![A-Za-z0-9_".])"?${escapeRe(t.schema)}"?\\s*\\.\\s*"?${escapeRe(t.table)}"?(?![A-Za-z0-9_"])`,
      "gi",
    );
    out = out.replace(re, "`" + viewNameFor(t.schema, t.table) + "`");
  }
  return out;
}

/** The Spark type constructor for a DuckDB column type, for an empty table's schema. */
export function sparkTypeFor(duckType: string): string {
  const t = duckType.trim().toUpperCase();
  const dec = /^DECIMAL\((\d+),\s*(\d+)\)$/.exec(t);
  if (dec) return `T.DecimalType(${dec[1]}, ${dec[2]})`;
  if (
    /^(BIGINT|HUGEINT|INTEGER|SMALLINT|TINYINT|UBIGINT|UINTEGER|USMALLINT|UTINYINT|INT\d*)$/.test(t)
  )
    return "T.LongType()";
  if (/^(DOUBLE|FLOAT|REAL|FLOAT\d*)$/.test(t)) return "T.DoubleType()";
  if (t === "BOOLEAN") return "T.BooleanType()";
  if (t === "DATE") return "T.DateType()";
  if (/^TIMESTAMP/.test(t)) return "T.TimestampType()";
  return "T.StringType()";
}

const py = (s: string) => JSON.stringify(s);
const pyList = (xs: string[]) => "[" + xs.map(py).join(", ") + "]";

/** The program. The server prepends the shared prelude that applies env. */
export function compileSparkQuery(plan: SparkQueryPlan): string {
  const cap = Math.max(1, Math.floor(plan.rowCap));
  const lines: string[] = [
    `# Lakehouse query on Spark — generated for query ${plan.queryId}`,
    `import datetime as _dt, decimal as _dec, json, math, os, time`,
    `from pyspark.sql import SparkSession, Row`,
    `from pyspark.sql import functions as F`,
    `from pyspark.sql import types as T`,
    ``,
    `_url = os.environ.get('ETL_SPARK_CONNECT_URL', '')`,
    `if not _url:`,
    `    raise RuntimeError('No Spark Connect endpoint is configured (Admin -> Developer runtime -> Spark engine).')`,
    `_t0 = time.time()`,
    `spark = SparkSession.builder.remote(_url).getOrCreate()`,
    `print('[sparkq] connected to ' + _url.split(';')[0] + ' (' + spark.version + ')')`,
    ``,
    `def _s3():`,
    `    # Hadoop S3A settings as per-read options: the credentials are scoped to`,
    `    # the call and never sit in the cluster's shared configuration.`,
    `    o = {`,
    `        'fs.s3a.access.key': os.environ.get('ETL_LAKEHOUSE_S3_KEY_ID', ''),`,
    `        'fs.s3a.secret.key': os.environ.get('ETL_LAKEHOUSE_S3_SECRET', ''),`,
    `        'fs.s3a.aws.credentials.provider': 'org.apache.hadoop.fs.s3a.SimpleAWSCredentialsProvider',`,
    `    }`,
    `    _ep = os.environ.get('ETL_LAKEHOUSE_S3_ENDPOINT')`,
    `    if _ep:`,
    `        _ssl = os.environ.get('ETL_LAKEHOUSE_S3_USE_SSL', 'false') == 'true'`,
    `        o['fs.s3a.endpoint'] = _ep if '://' in _ep else ('https://' if _ssl else 'http://') + _ep`,
    `        o['fs.s3a.path.style.access'] = 'true' if os.environ.get('ETL_LAKEHOUSE_S3_URL_STYLE', 'path') == 'path' else 'false'`,
    `        o['fs.s3a.connection.ssl.enabled'] = 'true' if _ssl else 'false'`,
    `    return o`,
    ``,
    `def _s3a(p):`,
    `    return 's3a://' + p[len('s3://'):] if p.startswith('s3://') else p`,
    ``,
    `def _bare(col):`,
    `    # s3:// and s3a:// name the same object; delete files record the former.`,
    `    return F.regexp_replace(col, '^[a-z0-9]+://', '')`,
    ``,
    `def _view(name, schema, data_files, delete_files):`,
    `    if not data_files:`,
    `        df = spark.createDataFrame([], schema)`,
    `    else:`,
    `        df = spark.read.options(**_s3()).option('mergeSchema', 'true').parquet(*[_s3a(f) for f in data_files])`,
    `        if delete_files:`,
    `            dels = (spark.read.options(**_s3()).parquet(*[_s3a(f) for f in delete_files])`,
    `                    .select(_bare(F.col('file_path')).alias('_df'), F.col('pos').alias('_dp')))`,
    `            df = (df.withColumn('_df', _bare(F.col('_metadata.file_path')))`,
    `                    .withColumn('_dp', F.col('_metadata.row_index'))`,
    `                    .join(dels, ['_df', '_dp'], 'left_anti')`,
    `                    .drop('_df', '_dp'))`,
    `        df = df.drop('_ducklake_internal_row_id', '_ducklake_internal_snapshot_id')`,
    `    df.createOrReplaceTempView(name)`,
    `    print('[sparkq] view ' + name + ': ' + str(len(data_files)) + ' file(s), ' + str(len(delete_files)) + ' delete file(s)')`,
    ``,
    `def _j(v):`,
    `    # Every value JSON-safe: the runner would otherwise stringify the whole result.`,
    `    if v is None or isinstance(v, (bool, int, str)):`,
    `        return v`,
    `    if isinstance(v, float):`,
    `        return v if math.isfinite(v) else str(v)`,
    `    if isinstance(v, (_dt.datetime, _dt.date, _dt.time)):`,
    `        return v.isoformat()`,
    `    if isinstance(v, _dec.Decimal):`,
    `        return str(v)`,
    `    if isinstance(v, (bytes, bytearray)):`,
    `        return v.hex()`,
    `    if isinstance(v, Row):`,
    `        return {k: _j(x) for k, x in v.asDict().items()}`,
    `    if isinstance(v, dict):`,
    `        return {str(k): _j(x) for k, x in v.items()}`,
    `    if isinstance(v, (list, tuple, set)):`,
    `        return [_j(x) for x in v]`,
    `    return str(v)`,
    ``,
    `def entrypoint(inputs):`,
  ];
  for (const t of plan.tables) {
    const schema =
      "T.StructType([" +
      t.columns
        .map((c) => `T.StructField(${py(c.name)}, ${sparkTypeFor(c.type)}, True)`)
        .join(", ") +
      "])";
    lines.push(
      `    _view(${py(viewNameFor(t.schema, t.table))}, ${schema}, ${pyList(t.dataFiles)}, ${pyList(t.deleteFiles)})`,
    );
  }
  lines.push(
    `    _q = ${py(rewriteTableRefs(plan.sql, plan.tables))}`,
    `    _df = spark.sql(_q)`,
    `    _rows = _df.limit(${cap + 1}).collect()`,
    `    _cols = [{'name': f.name, 'type': f.dataType.simpleString()} for f in _df.schema.fields]`,
    `    _out = [[_j(v) for v in list(r)] for r in _rows[:${cap}]]`,
    `    _ms = int((time.time() - _t0) * 1000)`,
    `    print('[sparkq] ' + json.dumps({'rows': len(_out), 'truncated': len(_rows) > ${cap}, 'ms': _ms}))`,
    `    return {`,
    `        'columns': _cols,`,
    `        'rows': _out,`,
    `        'row_count': len(_out),`,
    `        'truncated': len(_rows) > ${cap},`,
    `        'duration_ms': _ms,`,
    `        'spark_version': spark.version,`,
    `        'snapshot': ${plan.snapshot === null ? "None" : String(plan.snapshot)},`,
    `    }`,
  );
  return lines.join("\n") + "\n";
}
