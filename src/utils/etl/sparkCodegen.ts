// Visual ETL graph → PySpark program: the Spark engine's compiler.
//
// The same graph the pandas compiler reads, emitted as a program that drives a
// Spark cluster over Spark Connect from the sandbox. The sandbox holds only
// the pure-Python client — no JVM — so every hardening decision made for it
// stands, and the cluster is a resource the run attaches to rather than a
// second place code runs.
//
// WHAT IS NATIVE AND WHAT IS NOT is the whole design, so it is stated here
// rather than discovered:
//
//   Native (distributed): object-storage reads and writes, JDBC reads and
//   writes, every transform, quality gates, Delta including MERGE.
//
//   Driver-side (the sandbox, then lifted into Spark): CDC, stream drains,
//   webhook ingest, platform datasets, HTTP fetches, spreadsheets, the
//   lakehouse (DuckLake has no Spark connector), Custom Python (its contract is
//   a whole pandas frame), HTTP and SaaS targets. Every one of these is bounded
//   by design and none is where the size problem lives — and each reuses the
//   pandas compiler's own emitter for that node, so the two engines cannot
//   disagree about what a CDC peek or a SaaS push does.
//
// Everything native is the plain Spark DataFrame API — not pandas-on-Spark,
// which is a shim over the same API that carries an index and its own set of
// gaps. Where pandas semantics differ from SQL's on purpose — null group keys
// (dropna=False), nulls sorting last in either direction, `_x`/`_y` suffixes
// on a join, a null failing a range check — the pandas behaviour is
// reproduced explicitly, so a pipeline gives the same answer on either engine.
// Filter and derive expressions, typed in pandas' query/eval dialect, are
// translated to Spark SQL at compile time (sparkExpr.ts), which is also where
// a construct Spark lacks is refused: at save, in words, not on the cluster.
//
// Every user-authored string goes through pyStr()/pyIdent(), exactly as in
// the pandas compiler: a column name is an injection surface here too.
import {
  AGG_FNS,
  analyzeGraph,
  compileGraph,
  dbFamily,
  envKey,
  indent,
  lakehouseAttachFn,
  lineageSourcesOf,
  pyIdent,
  pyStr,
  requirementsFor,
  ruleDesc,
  sourceFn,
  targetBlock,
  type EtlGraph,
  type EtlNode,
  type EtlSourceConfig,
  type EtlTargetConfig,
  type EtlTransformConfig,
  type QualityRule,
  type SourceFileFormat,
} from "@/utils/etl/codegen";
import { isCatalogAsset, unwrapSourceConfig } from "@/utils/etl/catalogAsset";
import { toSparkSql } from "@/utils/etl/sparkExpr";
import { isStreamSource } from "@/utils/etl/streaming";

/** The engines a pipeline can run on. `pandas` is what every pipeline was. */
export const ETL_ENGINES = ["pandas", "spark"] as const;
export type EtlEngine = (typeof ETL_ENGINES)[number];

/** Storage formats Spark reads natively; anything else is read on the driver. */
const SPARK_READ: Partial<Record<SourceFileFormat, string>> = {
  csv: `_r.option('header', 'true').option('inferSchema', 'true').csv(_p)`,
  tsv: `_r.option('header', 'true').option('inferSchema', 'true').option('sep', '\\t').csv(_p)`,
  json: `_r.option('multiLine', 'true').json(_p)`,
  jsonl: `_r.json(_p)`,
  parquet: `_r.parquet(_p)`,
};

const SPARK_WRITE_FORMAT: Record<string, string> = {
  parquet: "parquet",
  csv: "csv",
  jsonl: "json",
};

function effective(node: EtlNode): EtlSourceConfig {
  const c = node.config as EtlSourceConfig;
  return isCatalogAsset(c) ? (unwrapSourceConfig(c) as EtlSourceConfig) : c;
}

/** How a source is read on the Spark engine. */
function sourceMode(node: EtlNode): "storage" | "jdbc" | "driver" {
  const c = effective(node) as { type?: string; format?: string; mode?: string; provider?: string };
  if (c.type === "object_storage" && c.format && SPARK_READ[c.format as SourceFileFormat]) {
    return "storage";
  }
  if (c.type === "database" && c.mode !== "cdc" && dbFamily(c.provider) !== null) return "jdbc";
  return "driver";
}

/** How a target is written on the Spark engine. */
function targetMode(node: EtlNode): "storage" | "jdbc" | "driver" {
  const c = node.config as EtlTargetConfig;
  if (c.type === "object_storage") return "storage";
  if (c.type === "database" && dbFamily(c.provider) !== null) return "jdbc";
  return "driver";
}

/**
 * Why this graph cannot run on the Spark engine, or null.
 *
 * Said at save time in the words of the fix, because each of these would
 * otherwise fail inside a cluster after the data had been read.
 */
export function sparkRefusal(graph: EtlGraph): string | null {
  for (const n of graph.nodes ?? []) {
    if (n.kind !== "target") continue;
    const c = n.config as EtlTargetConfig;
    const label = n.label || n.id;
    if (c.type === "object_storage" && c.table_format === "iceberg") {
      return `Target "${label}": Iceberg is not on the Spark engine yet — write Delta, or land the rows in the lakehouse and publish from there.`;
    }
    if (c.type === "object_storage" && c.write_mode === "merge" && c.table_format !== "delta") {
      return `Target "${label}": on the Spark engine, merge needs a Delta table — plain files have no keys to merge on. Pick Delta as the table format, or use replace/append.`;
    }
    if (c.type === "database" && c.write_mode === "merge") {
      return `Target "${label}": on the Spark engine, merge into a database is not supported yet — write append or replace, or merge on the pandas engine.`;
    }
  }
  return null;
}

/** pip requirements for the sandbox half of a Spark run. */
export function sparkRequirementsFor(graph: EtlGraph): string {
  // The Spark Connect client is baked into the runtime image. dlt and ibis
  // are the two things the pandas engine needed that this one does not: the
  // cluster does the loading, and SQL steps run as Spark SQL.
  return requirementsFor(graph)
    .split("\n")
    .filter((l) => l.trim() && !/^(dlt|ibis-framework)\b/.test(l.trim()))
    .join("\n");
}

// ── Python fragments ────────────────────────────────────────────────────────

function prelude(): string[] {
  return [
    `# Generated by the AgentSwarms pipeline builder for the SPARK engine. Edits`,
    `# here are overwritten on the next visual save — switch the pipeline to code`,
    `# mode to make this file the source of truth.`,
    `import json`,
    `import os`,
    ``,
    `import pandas as pd`,
    `from pyspark.sql import SparkSession, Window`,
    `from pyspark.sql import functions as F`,
    ``,
    `_SPARK = None`,
    ``,
    `def _spark():`,
    `    global _SPARK`,
    `    if _SPARK is None:`,
    `        _url = os.environ.get('ETL_SPARK_CONNECT_URL', '')`,
    `        if not _url:`,
    `            raise RuntimeError('This pipeline uses the Spark engine, but no Spark Connect endpoint is configured (Admin -> Developer runtime -> Spark).')`,
    `        _SPARK = SparkSession.builder.remote(_url).getOrCreate()`,
    `        print('[etl] spark: connected to ' + _url.split(';')[0] + ' (' + _SPARK.version + ')')`,
    `    return _SPARK`,
    ``,
    `def _s3_options(stem):`,
    `    # Hadoop S3A settings passed as data-source options, per read and per`,
    `    # write: the credentials are scoped to the call and never sit in the`,
    `    # cluster's shared configuration where another session could read them.`,
    `    o = {`,
    `        'fs.s3a.access.key': os.environ.get(stem + '_ACCESS_KEY_ID', ''),`,
    `        'fs.s3a.secret.key': os.environ.get(stem + '_SECRET_ACCESS_KEY', ''),`,
    `        'fs.s3a.aws.credentials.provider': 'org.apache.hadoop.fs.s3a.SimpleAWSCredentialsProvider',`,
    `    }`,
    `    _ep = os.environ.get(stem + '_ENDPOINT_URL')`,
    `    if _ep:`,
    `        o['fs.s3a.endpoint'] = _ep`,
    `        o['fs.s3a.path.style.access'] = 'true'`,
    `        o['fs.s3a.connection.ssl.enabled'] = 'true' if _ep.startswith('https') else 'false'`,
    `    return o`,
    ``,
    `def _s3_session(stem):`,
    `    # SQL statements that name a path (a Delta MERGE) read the session's`,
    `    # Hadoop configuration rather than per-call options, so the same`,
    `    # settings are put there too, for this session only.`,
    `    _sp = _spark()`,
    `    for k, v in _s3_options(stem).items():`,
    `        _sp.conf.set(k, v)`,
    `    return _sp`,
    ``,
    `def _jdbc(url):`,
    `    # A SQLAlchemy URL, as every warehouse connection is stored, to what the`,
    `    # JDBC driver on the cluster wants. Query parameters are not carried.`,
    `    from urllib.parse import urlsplit, unquote`,
    `    u = urlsplit(url)`,
    `    scheme = u.scheme.split('+')[0]`,
    `    host = u.hostname or 'localhost'`,
    `    db = (u.path or '/').lstrip('/')`,
    `    user = unquote(u.username or '')`,
    `    pw = unquote(u.password or '')`,
    `    if scheme.startswith('postgres'):`,
    `        return {'url': 'jdbc:postgresql://%s:%d/%s' % (host, u.port or 5432, db), 'driver': 'org.postgresql.Driver', 'user': user, 'password': pw}`,
    `    if scheme in ('mysql', 'mariadb'):`,
    `        return {'url': 'jdbc:mysql://%s:%d/%s' % (host, u.port or 3306, db), 'driver': 'com.mysql.cj.jdbc.Driver', 'user': user, 'password': pw}`,
    `    if scheme == 'mssql':`,
    `        return {'url': 'jdbc:sqlserver://%s:%d;databaseName=%s;encrypt=false' % (host, u.port or 1433, db), 'driver': 'com.microsoft.sqlserver.jdbc.SQLServerDriver', 'user': user, 'password': pw}`,
    `    raise RuntimeError('The Spark engine has no JDBC driver for ' + scheme)`,
    ``,
    `def _lift(df):`,
    `    # A frame the driver produced — a stream drain, a CDC peek, an HTTP`,
    `    # fetch, a Custom Python step — becomes a Spark frame here. These are`,
    `    # bounded by design. A column with no values at all has no type for`,
    `    # Arrow to carry, so it travels as a string column of nulls.`,
    `    import pyarrow as pa`,
    `    if not isinstance(df, pd.DataFrame):`,
    `        df = pd.DataFrame(df)`,
    `    df = df.reset_index(drop=True)`,
    `    df.columns = [str(c) for c in df.columns]`,
    `    for c in df.columns:`,
    `        if df[c].dtype == object and df[c].isna().all():`,
    `            df[c] = df[c].astype('string')`,
    `    # Through an Arrow table with one chunk per column: a frame built by`,
    `    # concatenation carries chunked columns, which the client's own`,
    `    # pandas conversion does not take.`,
    `    return _spark().createDataFrame(pa.Table.from_pandas(df, preserve_index=False).combine_chunks())`,
    ``,
    `def _merge(l, r, how, left_on, right_on):`,
    `    # pandas' merge, reproduced: shared non-key names get _x/_y suffixes,`,
    `    # a key with the same name on both sides comes out as one column, and`,
    `    # null keys match each other.`,
    `    same = [a for a, b in zip(left_on, right_on) if a == b]`,
    `    shared = [c for c in l.columns if c in r.columns and c not in same]`,
    `    for c in shared:`,
    `        l = l.withColumnRenamed(c, c + '_x')`,
    `        r = r.withColumnRenamed(c, c + '_y')`,
    `    lk = [k + '_x' if k in shared else k for k in left_on]`,
    `    rk = [k + '_y' if k in shared else k for k in right_on]`,
    `    for i, (a, b) in enumerate(zip(lk, rk)):`,
    `        if a == b:`,
    `            r = r.withColumnRenamed(b, '__rk_' + b)`,
    `            rk[i] = '__rk_' + b`,
    `    cond = None`,
    `    for a, b in zip(lk, rk):`,
    `        e = l[a].eqNullSafe(r[b])`,
    `        cond = e if cond is None else (cond & e)`,
    `    j = l.join(r, cond, {'inner': 'inner', 'left': 'left', 'right': 'right', 'outer': 'full'}[how])`,
    `    for a, b in zip(lk, rk):`,
    `        if b.startswith('__rk_'):`,
    `            if how in ('right', 'outer'):`,
    `                j = j.withColumn(a, F.coalesce(F.col(a), F.col(b)))`,
    `            j = j.drop(b)`,
    `    return j`,
    ``,
    `def _fill(sdf, value, columns):`,
    `    # pandas fills every column it can with the one value; Spark's fillna`,
    `    # only touches columns of the value's own type. Casting the value to`,
    `    # each column's type gives pandas' reach — a value the type cannot hold`,
    `    # casts to null and leaves that column as it was.`,
    `    for f in sdf.schema.fields:`,
    `        if columns and f.name not in columns:`,
    `            continue`,
    `        sdf = sdf.withColumn(f.name, F.coalesce(F.col(f.name), F.lit(value).cast(f.dataType)))`,
    `    return sdf`,
    ``,
    `def _sort(sdf, by, descending):`,
    `    # Nulls last either way, as pandas sorts them.`,
    `    return sdf.orderBy(*[(F.col(c).desc_nulls_last() if descending else F.col(c).asc_nulls_last()) for c in by])`,
    ``,
    `def _max_of(sdf, column):`,
    `    return sdf.agg(F.max(F.col(column))).first()[0]`,
    ``,
    `_PD_TYPES = {'string': 'object', 'bigint': 'int64', 'int': 'int64', 'smallint': 'int64', 'tinyint': 'int64',`,
    `             'double': 'float64', 'float': 'float64', 'boolean': 'bool', 'timestamp': 'datetime64[ns]',`,
    `             'timestamp_ntz': 'datetime64[ns]', 'date': 'object', 'binary': 'object'}`,
    ``,
    `def _schema_of(sdf):`,
    `    # Named the way the pandas engine names types, so a schema baseline`,
    `    # recorded by one engine does not read as total drift to the other.`,
    `    # Every integer width is int64 and every float is float64, because that`,
    `    # is what pandas reads from text, JSON and a database; Spark infers the`,
    `    # narrowest width, and a strict policy must not abort on the switch.`,
    `    return {f.name: _PD_TYPES.get(f.dataType.simpleString(), f.dataType.simpleString()) for f in sdf.schema.fields}`,
    ``,
    `def _agg(sdf, keys, aggs):`,
    `    # pandas' semantics reproduced: null keys form a group (dropna=False),`,
    `    # count skips nulls, first/last skip nulls.`,
    `    _exprs = []`,
    `    for _as, _col, _fn in aggs:`,
    `        _c = F.col(_col)`,
    `        if _fn == 'sum': _e = F.sum(_c)`,
    `        elif _fn == 'mean': _e = F.avg(_c)`,
    `        elif _fn == 'min': _e = F.min(_c)`,
    `        elif _fn == 'max': _e = F.max(_c)`,
    `        elif _fn == 'count': _e = F.count(_c)`,
    `        elif _fn == 'nunique': _e = F.count_distinct(_c)`,
    `        elif _fn == 'median': _e = F.median(_c)`,
    `        elif _fn == 'first': _e = F.first(_c, ignorenulls=True)`,
    `        elif _fn == 'last': _e = F.last(_c, ignorenulls=True)`,
    `        else: raise RuntimeError('unknown aggregate ' + _fn)`,
    `        _exprs.append(_e.alias(_as))`,
    `    return sdf.groupBy(*keys).agg(*_exprs)`,
    ``,
  ];
}

function sqlOverFn(): string[] {
  return [
    ``,
    `def _sql_over(sdf, query):`,
    `    # SQL step: the incoming frame is table 't', and the SQL is Spark SQL.`,
    `    sdf.createOrReplaceTempView('t')`,
    `    return _spark().sql(query)`,
    ``,
  ];
}

// ── Sources ─────────────────────────────────────────────────────────────────

function storageSource(node: EtlNode, c: Extract<EtlSourceConfig, { type: "object_storage" }>) {
  const key = envKey(node.id);
  return [
    `def _src_${node.id}():`,
    `    _sp = _spark()`,
    `    _base = os.environ['${key}_BUCKET'].rstrip('/')`,
    `    _p = 's3a://' + _base + '/' + ${pyStr(c.path)}.lstrip('/')`,
    `    _r = _sp.read.options(**_s3_options('${key}'))`,
    `    _sdf = ${SPARK_READ[c.format]}`,
    ...(c.incremental?.cursor_column
      ? [
          `    _cur = os.environ.get('${key}_CURSOR')`,
          `    if _cur:`,
          `        # Compared in the COLUMN's own type. As text, a numeric`,
          `        # watermark of 9 hides every row from 10 up — and the run`,
          `        # reports success, so the loss is silent. A watermark the`,
          `        # column's type cannot hold falls back to text rather than`,
          `        # dropping everything — try_cast because a plain cast RAISES`,
          `        # under ANSI mode instead of yielding null.`,
          `        _t = _sdf.schema[${pyStr(c.incremental.cursor_column)}].dataType`,
          `        _lit = F.lit(_cur).try_cast(_t)`,
          `        if _sp.range(1).select(_lit.alias('_v')).first()['_v'] is None:`,
          `            _lit, _c = F.lit(_cur), F.col(${pyStr(c.incremental.cursor_column)}).cast('string')`,
          `        else:`,
          `            _c = F.col(${pyStr(c.incremental.cursor_column)})`,
          `        _sdf = _sdf.filter(_c > _lit)`,
        ]
      : []),
    `    return _sdf`,
  ].join("\n");
}

function jdbcSource(node: EtlNode, c: Extract<EtlSourceConfig, { type: "database" }>) {
  const key = envKey(node.id);
  const base =
    c.mode === "table"
      ? `'SELECT * FROM ' + ${pyStr((c.table ?? "").replace(/[^A-Za-z0-9_.]/g, ""))}`
      : pyStr(c.query ?? "");
  if (c.mode === "query" && !(c.query ?? "").trim()) {
    throw new Error(`Database source "${node.label || node.id}" has no query`);
  }
  const cursorCol = c.incremental?.cursor_column
    ? pyIdent(c.incremental.cursor_column, "Cursor column")
    : null;
  return [
    `def _src_${node.id}():`,
    `    _sp = _spark()`,
    `    _j = _jdbc(os.environ['${key}_URL'])`,
    `    _q = ${base}`,
    ...(cursorCol
      ? [
          `    _cur = os.environ.get('${key}_CURSOR')`,
          `    if _cur:`,
          `        _q = 'SELECT * FROM (' + _q + ') AS _q WHERE ${cursorCol} > ' + "'" + _cur.replace("'", "''") + "'"`,
        ]
      : []),
    `    _r = _sp.read.format('jdbc').option('url', _j['url']).option('user', _j['user']).option('password', _j['password']).option('driver', _j['driver'])`,
    `    return _r.option('query', _q).load()`,
  ].join("\n");
}

// ── Transforms ──────────────────────────────────────────────────────────────

function transform(node: EtlNode, ins: string[]): string {
  const c = node.config as EtlTransformConfig;
  const f = (id: string) => `f_${id}`;
  const one = f(ins[0]);
  const label = node.label || node.id;
  const cols = (xs: string[]) => xs.map((x) => pyStr(x)).join(", ");
  switch (c.type) {
    case "filter":
      return `${one}.filter(${pyStr(toSparkSql(c.expr, `Filter "${label}"`))})`;
    case "select":
      return `${one}.select(${cols(c.columns)})`;
    case "rename": {
      const pairs = Object.entries(c.mapping)
        .map(([a, b]) => `${pyStr(a)}: ${pyStr(b)}`)
        .join(", ");
      return `${one}.withColumnsRenamed({${pairs}})`;
    }
    case "derive":
      return `${one}.withColumn(${pyStr(c.column)}, F.expr(${pyStr(toSparkSql(c.expr, `Derive "${label}"`))}))`;
    case "dedupe":
      return c.columns?.length
        ? `${one}.dropDuplicates([${cols(c.columns)}])`
        : `${one}.dropDuplicates()`;
    case "limit":
      return `${one}.limit(${Math.max(0, Math.floor(c.n))})`;
    case "sort":
      return `_sort(${one}, [${cols(c.by)}], ${c.descending ? "True" : "False"})`;
    case "aggregate": {
      for (const a of c.aggs) {
        if (!AGG_FNS.includes(a.fn)) throw new Error(`Unknown aggregate function "${a.fn}"`);
        pyIdent(a.as, "Aggregate output name");
      }
      const aggs = `[${c.aggs.map((a) => `(${pyStr(a.as)}, ${pyStr(a.column)}, ${pyStr(a.fn)})`).join(", ")}]`;
      return `_agg(${one}, [${cols(c.group_by)}], ${aggs})`;
    }
    case "fill_nulls": {
      const raw = c.value ?? "";
      const num = Number(raw);
      const lit = raw !== "" && Number.isFinite(num) ? String(num) : pyStr(raw);
      return `_fill(${one}, ${lit}, [${cols(c.columns ?? [])}])`;
    }
    case "drop_nulls":
      return c.columns?.length ? `${one}.dropna(subset=[${cols(c.columns)}])` : `${one}.dropna()`;
    case "join": {
      const left = c.left_node && ins.includes(c.left_node) ? c.left_node : ins[0];
      const right = ins.find((x) => x !== left) ?? ins[1];
      if (c.left_on.length !== c.right_on.length || !c.left_on.length) {
        throw new Error(`Join "${label}" needs the same number of left and right key columns`);
      }
      return `_merge(${f(left)}, ${f(right)}, ${pyStr(c.how)}, [${cols(c.left_on)}], [${cols(c.right_on)}])`;
    }
    case "union": {
      // Aligned by name with missing columns as nulls, as pd.concat does.
      const [first, ...rest] = ins.map((x) => f(x));
      return rest.reduce((acc, x) => `${acc}.unionByName(${x}, allowMissingColumns=True)`, first);
    }
    case "sql":
      return `_sql_over(${one}, ${pyStr(c.query)})`;
    case "python":
      // The node's contract is a whole pandas frame in and out, so it runs on
      // the driver. Distributing it would hand the function a partition and
      // make a global sort or dedupe silently wrong.
      return `_lift(_fn_${node.id}(${one}.toPandas()))`;
    case "quality_gate":
      return `_gate_${node.id}(${one})`;
  }
}

// ── Quality gates, native ───────────────────────────────────────────────────

/**
 * A rule's violation as a Spark Column — TRUE for a row that breaks it.
 *
 * Null handling is the part that must match the pandas engine on purpose: a
 * null is not "in range", does not "match" a pattern and is not "allowed", so
 * each of those is wrapped in coalesce(…, False) before negation. Without it
 * Spark's three-valued logic drops nulls from the count and a gate passes rows
 * the pandas engine would refuse.
 */
function violation(r: QualityRule): string {
  const col = `F.col(${pyStr(r.column ?? "")})`;
  switch (r.check) {
    case "not_null":
      return `${col}.isNull()`;
    case "unique":
      return `(F.count(F.lit(1)).over(Window.partitionBy(${pyStr(r.column ?? "")})) > 1)`;
    case "range": {
      const lo = r.min != null && Number.isFinite(r.min) ? Number(r.min) : null;
      const hi = r.max != null && Number.isFinite(r.max) ? Number(r.max) : null;
      if (lo != null && hi != null)
        return `~F.coalesce(${col}.between(${lo}, ${hi}), F.lit(False))`;
      if (lo != null) return `~F.coalesce(${col} >= ${lo}, F.lit(False))`;
      if (hi != null) return `~F.coalesce(${col} <= ${hi}, F.lit(False))`;
      throw new Error("Range rule needs a min, a max, or both");
    }
    case "regex":
      return `~F.coalesce(${col}.cast('string').rlike(${pyStr(`^(?:${r.pattern ?? ""})$`)}), F.lit(False))`;
    case "allowed_values":
      return `~F.coalesce(${col}.isin([${(r.values ?? []).map((v) => pyStr(v)).join(", ")}]), F.lit(False))`;
    default:
      throw new Error(`Unknown quality check "${r.check}"`);
  }
}

function gateFn(node: EtlNode): string {
  const c = node.config as Extract<EtlTransformConfig, { type: "quality_gate" }>;
  const label = (node.label ?? node.id).replace(/[\r\n]/g, " ");
  const rules = c.rules ?? [];
  if (!rules.length) throw new Error(`Quality gate "${label}" has no rules`);
  const lines = [`def _gate_${node.id}(_sdf):`, `    _rows = _sdf.count()`, `    _helpers = []`];
  rules.forEach((r, i) => {
    if (r.check !== "row_count_min" && !r.column) {
      throw new Error(`Rule ${ruleDesc(r)} in gate "${label}" needs a column`);
    }
    const desc = ruleDesc(r);
    const sev = r.severity === "drop" || r.severity === "warn" ? r.severity : "fail";
    if (r.check === "row_count_min") {
      const min = Math.max(0, Math.floor(r.min ?? 0));
      lines.push(
        `    _n${i} = ${min} - int(_rows) if _rows < ${min} else 0`,
        `    _quality.append({'gate': ${pyStr(label)}, 'rule': ${pyStr(desc)}, 'violations': _n${i}, 'severity': ${pyStr(sev)}, 'rows': int(_rows)})`,
        `    if _n${i}:`,
        ...(sev === "warn"
          ? [
              `        print('[quality] WARN ' + ${pyStr(desc)} + ': ' + str(int(_rows)) + ' row(s), need ${min}')`,
            ]
          : [
              `        raise RuntimeError('Quality gate ' + ${pyStr(label)} + ': ' + ${pyStr(desc)} + ' failed — ' + str(int(_rows)) + ' row(s), need ${min}')`,
            ]),
      );
      return;
    }
    // A helper column rather than a bare filter: a window expression (the
    // uniqueness check) is not allowed inside a WHERE, so every rule is
    // materialised the same way and dropped again at the end.
    lines.push(
      `    _sdf = _sdf.withColumn('__v${i}', ${violation(r)})`,
      `    _helpers.append('__v${i}')`,
      `    _n${i} = _sdf.filter(F.col('__v${i}')).count()`,
      `    _quality.append({'gate': ${pyStr(label)}, 'rule': ${pyStr(desc)}, 'violations': int(_n${i}), 'severity': ${pyStr(sev)}, 'rows': int(_rows)})`,
      `    if _n${i}:`,
    );
    if (sev === "fail") {
      lines.push(
        `        raise RuntimeError('Quality gate ' + ${pyStr(label)} + ': ' + ${pyStr(desc)} + ' failed for ' + str(int(_n${i})) + ' row(s)')`,
      );
    } else if (sev === "drop") {
      lines.push(
        `        _sdf = _sdf.filter(~F.col('__v${i}'))`,
        `        _rows = _sdf.count()`,
        `        print('[quality] dropped ' + str(int(_n${i})) + ' row(s): ' + ${pyStr(desc)})`,
      );
    } else {
      lines.push(
        `        print('[quality] WARN ' + ${pyStr(desc)} + ': ' + str(int(_n${i})) + ' row(s)')`,
      );
    }
  });
  lines.push(`    return _sdf.drop(*_helpers)`);
  return lines.join("\n");
}

// ── Targets ─────────────────────────────────────────────────────────────────

function driftLines(node: EtlNode, c: { dataset: string; table: string; schema_policy?: string }) {
  const policy =
    c.schema_policy === "warn" || c.schema_policy === "strict" ? c.schema_policy : "evolve";
  return [
    `    _schemas['${node.id}'] = _schema_of(_sdf)`,
    ...(policy !== "evolve"
      ? [
          `    _prev_raw = os.environ.get('${envKey(node.id)}_SCHEMA')`,
          `    if _prev_raw:`,
          `        _prev = json.loads(_prev_raw)`,
          `        _cur = _schemas['${node.id}']`,
          `        _added = sorted(c for c in _cur if c not in _prev)`,
          `        _removed = sorted(c for c in _prev if c not in _cur)`,
          `        _retyped = sorted(f"{c}: {_prev[c]} -> {_cur[c]}" for c in _cur if c in _prev and _prev[c] != _cur[c])`,
          `        if _added or _removed or _retyped:`,
          `            _parts = []`,
          `            if _added: _parts.append('added ' + ', '.join(_added))`,
          `            if _removed: _parts.append('removed ' + ', '.join(_removed))`,
          `            if _retyped: _parts.append('retyped ' + ', '.join(_retyped))`,
          `            _msg = 'schema drift on ${c.dataset}.${c.table}: ' + '; '.join(_parts)`,
          ...(policy === "strict"
            ? [`            raise RuntimeError('[schema] ' + _msg)`]
            : [`            print('[schema] WARN ' + _msg)`]),
        ]
      : []),
  ];
}

function storageTarget(
  node: EtlNode,
  c: Extract<EtlTargetConfig, { type: "object_storage" }>,
  input: string,
): string {
  const key = envKey(node.id);
  const dataset = pyIdent(c.dataset, "Target dataset");
  const table = pyIdent(c.table, "Target table");
  const delta = c.table_format === "delta";
  const fmt = delta ? "delta" : SPARK_WRITE_FORMAT[c.format];
  if (!fmt) throw new Error(`Target "${node.label || node.id}": unknown file format "${c.format}"`);
  if (c.write_mode === "merge" && !c.primary_key?.length) {
    throw new Error(`Merge on target "${node.label || node.id}" needs primary key columns`);
  }
  const fqn = delta
    ? `'${dataset}/${table}/*.parquet'`
    : `'${dataset}/${table}/*.${c.format === "jsonl" ? "ndjson" : c.format}'`;
  const lines = [
    `    # target ${node.id}: object storage → ${dataset}.${table} (${c.write_mode}${delta ? ", delta" : ""})`,
    `    _sdf = ${input}`,
    ...driftLines(node, c),
    `    _n = _sdf.count()`,
    `    _o = _s3_options('${key}')`,
    `    _dest = os.environ['${key}_BUCKET_URL'].replace('s3://', 's3a://', 1).rstrip('/') + '/${dataset}/${table}'`,
  ];
  if (c.write_mode === "merge") {
    const keys = c.primary_key ?? [];
    const on = keys
      .map((k) => `t.${pyIdent(k, "Primary key column")} = s.${pyIdent(k, "Primary key column")}`)
      .join(" AND ");
    lines.push(
      `    _sp = _s3_session('${key}')`,
      `    try:`,
      `        _sp.read.format('delta').options(**_o).load(_dest).limit(1).collect()`,
      `        _exists = True`,
      `    except Exception:`,
      `        _exists = False`,
      `    if not _exists:`,
      `        _sdf.write.options(**_o).format('delta').mode('overwrite').save(_dest)`,
      `    else:`,
      `        _sdf.createOrReplaceTempView('_src_${node.id}')`,
      // Delta's own MERGE, over the path, so the table's history records it
      // as one upsert rather than a rewrite.
      `        _sp.sql("MERGE INTO delta.\`" + _dest + "\` AS t USING _src_${node.id} AS s ON ${on} WHEN MATCHED THEN UPDATE SET * WHEN NOT MATCHED THEN INSERT *")`,
    );
  } else {
    const writer = [
      `_sdf.write.options(**_o)`,
      fmt === "csv" ? `.option('header', 'true')` : "",
      `.format('${fmt}').mode('${c.write_mode === "replace" ? "overwrite" : "append"}').save(_dest)`,
    ].join("");
    lines.push(`    ${writer}`);
  }
  lines.push(
    `    print('[etl] spark: wrote ' + str(_n) + ' row(s) to ' + _dest)`,
    `    _loads.append({'target': '${dataset}.${table}', 'fqn': ${fqn}, 'rows': int(_n), 'load_id': None})`,
  );
  return lines.join("\n");
}

function jdbcTarget(
  node: EtlNode,
  c: Extract<EtlTargetConfig, { type: "database" }>,
  input: string,
): string {
  const key = envKey(node.id);
  const dataset = pyIdent(c.dataset, "Target dataset");
  const table = pyIdent(c.table, "Target table");
  return [
    `    # target ${node.id}: database → ${dataset}.${table} (${c.write_mode}, JDBC)`,
    `    _sdf = ${input}`,
    ...driftLines(node, c),
    `    _n = _sdf.count()`,
    `    _j = _jdbc(os.environ['${key}_URL'])`,
    `    _sdf.write.format('jdbc').option('url', _j['url']).option('dbtable', '${dataset}.${table}').option('user', _j['user']).option('password', _j['password']).option('driver', _j['driver']).mode('${c.write_mode === "replace" ? "overwrite" : "append"}').save()`,
    `    print('[etl] spark: wrote ' + str(_n) + ' row(s) to ${dataset}.${table}')`,
    `    _loads.append({'target': '${dataset}.${table}', 'fqn': '${dataset}.${table}', 'rows': int(_n), 'load_id': None})`,
  ].join("\n");
}

// ── The program ─────────────────────────────────────────────────────────────

export function compileSparkGraph(graph: EtlGraph): string {
  const refusal = sparkRefusal(graph);
  if (refusal) throw new Error(refusal);
  // Every refusal the pandas compiler makes — an unsupported database
  // provider, a CDC source off PostgreSQL, a merge without keys — stands here
  // too, and its wording is the one users already know. A validation pass
  // through it is cheaper than keeping two lists of the same rules.
  compileGraph(graph);
  const { order, incoming } = analyzeGraph(graph);

  const lines = prelude();
  if (
    order.some((n) => n.kind === "transform" && (n.config as EtlTransformConfig).type === "sql")
  ) {
    lines.push(...sqlOverFn());
  }
  for (const n of order) {
    if (n.kind !== "transform") continue;
    const c = n.config as EtlTransformConfig;
    if (c.type === "python")
      lines.push(``, `def _fn_${n.id}(df):`, indent(c.code, "    "), `    return df`, ``);
  }
  if (
    order.some(
      (n) =>
        effective(n).type === "lakehouse" || (n.config as { type?: string }).type === "lakehouse",
    )
  ) {
    lines.push(``, lakehouseAttachFn());
  }
  const gates = order.filter(
    (n) => n.kind === "transform" && (n.config as { type?: string }).type === "quality_gate",
  );
  if (gates.length) {
    lines.push(``, `_quality = []`);
    for (const n of gates) lines.push(``, gateFn(n), ``);
  }

  const modes = new Map<string, "storage" | "jdbc" | "driver">();
  for (const n of order.filter((x) => x.kind === "source")) {
    const mode = sourceMode(n);
    modes.set(n.id, mode);
    const c = effective(n);
    if (mode === "storage") {
      lines.push(
        ``,
        storageSource(n, c as Extract<EtlSourceConfig, { type: "object_storage" }>),
        ``,
      );
    } else if (mode === "jdbc") {
      lines.push(``, jdbcSource(n, c as Extract<EtlSourceConfig, { type: "database" }>), ``);
    } else {
      // The pandas compiler's own emitter for this node, lifted into Spark
      // in the entrypoint — one definition of what a CDC peek or a stream
      // drain does, shared by both engines.
      lines.push(``, sourceFn(n), ``);
    }
  }
  for (const n of order.filter(
    (x) => x.kind === "source" && (x.config as { mode?: string }).mode === "cdc",
  )) {
    lines.push(`_cdc_last_${n.id} = None`);
  }
  for (const n of order.filter(
    (x) => x.kind === "source" && (x.config as { type?: string }).type === "ingest",
  )) {
    lines.push(`_ingest_last_${n.id} = None`);
  }
  for (const n of order.filter((x) => x.kind === "source" && isStreamSource(x.config))) {
    lines.push(`_stream_last_${n.id} = None`);
  }

  const incremental = order.filter(
    (n) =>
      n.kind === "source" &&
      ((n.config as { incremental?: { cursor_column?: string } }).incremental?.cursor_column ||
        (n.config as { mode?: string }).mode === "cdc" ||
        (n.config as { type?: string }).type === "ingest" ||
        isStreamSource(n.config)),
  );

  lines.push(``, `def entrypoint(inputs=None):`);
  if (incremental.length) lines.push(`    _watermarks = {}`);
  for (const n of order) {
    const ins = incoming.get(n.id)!;
    if (n.kind === "source") {
      lines.push(
        modes.get(n.id) === "driver"
          ? `    f_${n.id} = _lift(_src_${n.id}())`
          : `    f_${n.id} = _src_${n.id}()`,
      );
      if ((n.config as { type?: string }).type === "ingest") {
        lines.push(
          `    if _ingest_last_${n.id} is not None:`,
          `        _watermarks['${n.id}'] = str(_ingest_last_${n.id})`,
        );
      }
      if ((n.config as { mode?: string }).mode === "cdc") {
        lines.push(
          `    if _cdc_last_${n.id}:`,
          `        _watermarks['${n.id}'] = _cdc_last_${n.id}`,
        );
      }
      if (isStreamSource(n.config)) {
        lines.push(
          `    if _stream_last_${n.id}:`,
          `        _watermarks['${n.id}'] = _stream_last_${n.id}`,
        );
      }
      const inc = (n.config as { incremental?: { cursor_column?: string } }).incremental;
      if (inc?.cursor_column) {
        // The new high-water mark; on an empty read, nothing, so the engine
        // keeps the previous cursor.
        lines.push(
          `    _wm_${n.id} = _max_of(f_${n.id}, ${pyStr(inc.cursor_column)})`,
          `    if _wm_${n.id} is not None:`,
          `        _watermarks['${n.id}'] = str(_wm_${n.id})`,
        );
      }
    } else if (n.kind === "transform") {
      lines.push(`    f_${n.id} = ${transform(n, ins)}`);
    }
  }

  lines.push(`    _loads = []`, `    _schemas = {}`);
  for (const n of order.filter((x) => x.kind === "target")) {
    const inputId = incoming.get(n.id)![0];
    const inputNode = order.find((x) => x.id === inputId);
    const cdcInput = (inputNode?.config as { mode?: string } | undefined)?.mode === "cdc";
    const c = n.config as EtlTargetConfig;
    const mode = targetMode(n);
    lines.push(``);
    if (mode === "storage") {
      lines.push(
        storageTarget(n, c as Extract<EtlTargetConfig, { type: "object_storage" }>, `f_${inputId}`),
      );
    } else if (mode === "jdbc") {
      lines.push(
        jdbcTarget(n, c as Extract<EtlTargetConfig, { type: "database" }>, `f_${inputId}`),
      );
    } else {
      // Lakehouse, HTTP and SaaS targets: the pandas compiler's own block,
      // fed the result collected to the driver. The lakehouse has no Spark
      // connector, and the other two are HTTP calls that are small by nature.
      lines.push(
        `    _pd_${n.id} = f_${inputId}.toPandas()`,
        targetBlock(n, `_pd_${n.id}`, cdcInput),
      );
    }
  }

  lines.push(
    ``,
    `    metrics = {`,
    `        'rows_loaded': sum(l['rows'] for l in _loads),`,
    `        'targets': _loads,`,
    `        'schemas': _schemas,`,
    `        'engine': 'spark',`,
    `        'lineage_sources': ${JSON.stringify(lineageSourcesOf(order))},`.replace(/"/g, "'"),
    ...(gates.length ? [`        'quality': _quality,`] : []),
    ...(incremental.length ? [`        'watermarks': _watermarks,`] : []),
    `    }`,
    `    print('[etl] ' + json.dumps(metrics))`,
    `    return metrics`,
  );
  return lines.join("\n") + "\n";
}
