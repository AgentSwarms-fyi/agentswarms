// Iceberg on the Spark engine (R459), the pure half: how a registered REST
// catalog is described to a Spark session, the maintenance procedures the
// upkeep panel runs, and the program a sandbox runs for one.
//
// Spark has had Iceberg only since R459 moved it to 4.1 (sparkVersions.ts):
// there is no Iceberg runtime for Spark 4.2. The catalog is configured on the
// run's own Spark Connect session, never on the server, so two users' catalogs
// never share a session; and every credential reaches the session from the
// sandbox's environment, never from the program text, which the logs and the
// row keep.
//
// What is configured, by the catalog's own settings:
//   type rest, uri, warehouse                 always
//   token                                     bearer
//   credential, oauth2-server-uri, scope      OAuth2 client credentials
//   header.X-Iceberg-Access-Delegation        storage "vended": the catalog hands
//                                             out storage credentials per table
//   s3.* (endpoint, keys, path style)         storage "lakehouse": the files are
//                                             read with the lakehouse's own keys
//   io-impl S3FileIO                          the FileIO that applies either
//
// Pure: no I/O, so a test reads every line a session is given.

import { SPARK_CONNECT_FN, sparkConnectClientFragment } from "@/utils/etl/sparkConnectClient";
import { ICEBERG_NAMESPACE, ICEBERG_TABLE, type IcebergCatalogConfig } from "./iceberg";

/** The maintenance the upkeep panel can run, by the advice that suggests it. */
export const ICEBERG_MAINTENANCE = ["compact", "deletes", "expire"] as const;
export type IcebergMaintenanceAction = (typeof ICEBERG_MAINTENANCE)[number];

export type IcebergMaintenance = {
  action: IcebergMaintenanceAction;
  /** expire: snapshots older than this many days go (branches and tags stay). */
  older_than_days?: number;
  /** expire: keep at least this many snapshots however old. */
  retain_last?: number;
};

/** The defaults the panel offers, the same the advice quotes. */
export const EXPIRE_DEFAULTS = { older_than_days: 7, retain_last: 20 } as const;

/** Where a Spark session finds one Iceberg table: the catalog row and the names in it. */
export type IcebergSparkTarget = {
  catalog_id: string;
  namespace: string;
  table: string;
  /** The snapshot the plan pinned; null for a table with none yet, or for maintenance. */
  snapshot_id: string | null;
  /** The table's location, for a credential scoped to it ("lakehouse" storage). */
  location: string | null;
};

/** The session catalog's name: the same one the lakehouse engine attaches it as. */
export function icebergSparkCatalog(catalogId: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(catalogId)) throw new Error("Not a catalog id");
  return `ice_${catalogId.replace(/-/g, "").toLowerCase()}`;
}

/**
 * One table as Spark SQL names it: catalog.`namespace`.`table`. The name rules
 * (ICEBERG_NAMESPACE, ICEBERG_TABLE) admit letters, digits, underscores and
 * hyphens only, so a backtick cannot occur; checked again here because this
 * text is pasted into a statement.
 */
export function icebergSparkTableRef(catalog: string, namespace: string, table: string): string {
  if (!ICEBERG_NAMESPACE.test(namespace)) throw new Error(`"${namespace}" is not a namespace name`);
  if (!ICEBERG_TABLE.test(table)) throw new Error(`"${table}" is not a table name`);
  return `${catalog}.\`${namespace}\`.\`${table}\``;
}

/** An env-variable name for one of a job's catalogs; n keeps two catalogs apart. */
export function icebergEnvKey(n: number, field: string): string {
  return `ETL_ICEBERG_${n}_${field}`;
}

/**
 * The session settings for a catalog, as [key, python expression] pairs: a
 * literal for what is not secret, an os.environ read for what is. The env the
 * server builds (icebergSparkEnv) must name the same variables.
 */
export function icebergSparkConf(
  catalog: string,
  cfg: IcebergCatalogConfig,
  n: number,
): [string, string][] {
  const py = (s: string) => JSON.stringify(s);
  // Python that reads the job's own environment (ETL_ICEBERG_<n>_<field>), not this process's.
  const sandboxEnv = (field: string) => `os.environ[${py(icebergEnvKey(n, field))}]`;
  const p = `spark.sql.catalog.${catalog}`;
  const endpoint = cfg.endpoint.trim().replace(/\/+$/, "");
  const out: [string, string][] = [
    [p, py("org.apache.iceberg.spark.SparkCatalog")],
    [`${p}.type`, py("rest")],
    [`${p}.uri`, py(endpoint)],
    [`${p}.warehouse`, py(cfg.warehouse.trim())],
    [`${p}.io-impl`, py("org.apache.iceberg.aws.s3.S3FileIO")],
    // A job reads the table as the catalog has it now, not as an earlier job
    // on the same cluster cached it.
    [`${p}.cache-enabled`, py("false")],
  ];
  if (cfg.auth_type === "bearer") out.push([`${p}.token`, sandboxEnv("TOKEN")]);
  if (cfg.auth_type === "oauth2") {
    out.push([`${p}.credential`, sandboxEnv("CREDENTIAL")]);
    // The same token URL the lakehouse engine asks (iceberg.ts, R458): the
    // catalog's own /v1/oauth/tokens when the row names no server.
    out.push([
      `${p}.oauth2-server-uri`,
      py(cfg.oauth2_server_uri.trim() || `${endpoint}/v1/oauth/tokens`),
    ]);
    // The scope the lakehouse engine's secret asks for, so the two engines are
    // granted the same principal roles. Iceberg's own default, "catalog", is
    // refused by Apache Polaris.
    out.push([`${p}.scope`, py("PRINCIPAL_ROLE:ALL")]);
  }
  if (cfg.storage === "vended") {
    out.push([`${p}.header.X-Iceberg-Access-Delegation`, py("vended-credentials")]);
  } else {
    out.push(
      [`${p}.s3.access-key-id`, sandboxEnv("S3_KEY_ID")],
      [`${p}.s3.secret-access-key`, sandboxEnv("S3_SECRET")],
      [`${p}.client.region`, `os.environ.get(${py(icebergEnvKey(n, "S3_REGION"))}, 'us-east-1')`],
    );
  }
  return out;
}

/** Python that applies a catalog's settings, plus the optional ones the env decides. */
export function icebergSparkConfLines(catalog: string, cfg: IcebergCatalogConfig, n: number) {
  const py = (s: string) => JSON.stringify(s);
  const p = `spark.sql.catalog.${catalog}`;
  const lines = icebergSparkConf(catalog, cfg, n).map(
    ([k, v]) => `    spark.conf.set(${py(k)}, ${v})`,
  );
  if (cfg.storage === "lakehouse") {
    const k = (f: string) => py(icebergEnvKey(n, f));
    lines.push(
      `    if os.environ.get(${k("S3_SESSION_TOKEN")}):`,
      `        spark.conf.set(${py(`${p}.s3.session-token`)}, os.environ[${k("S3_SESSION_TOKEN")}])`,
      `    if os.environ.get(${k("S3_ENDPOINT")}):`,
      `        spark.conf.set(${py(`${p}.s3.endpoint`)}, os.environ[${k("S3_ENDPOINT")}])`,
      `        spark.conf.set(${py(`${p}.s3.path-style-access`)}, 'true' if os.environ.get(${k("S3_URL_STYLE")}, 'path') == 'path' else 'false')`,
    );
  }
  return lines;
}

const TIMESTAMP = (d: Date) =>
  d
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d+Z$/, "");

/** The arguments the server accepts for a maintenance run, bounded. */
export function maintenanceError(m: IcebergMaintenance): string | null {
  if (!ICEBERG_MAINTENANCE.includes(m.action)) return "Unknown maintenance.";
  if (m.action === "expire") {
    const days = m.older_than_days ?? EXPIRE_DEFAULTS.older_than_days;
    const keep = m.retain_last ?? EXPIRE_DEFAULTS.retain_last;
    if (!Number.isInteger(days) || days < 1 || days > 3650)
      return "Expire snapshots older than 1 to 3,650 days.";
    if (!Number.isInteger(keep) || keep < 1 || keep > 10_000)
      return "Keep between 1 and 10,000 snapshots.";
  }
  return null;
}

/**
 * The Spark statement a maintenance run is. `now` fixes the cutoff so the
 * statement recorded is the statement run.
 */
export function icebergMaintenanceSql(
  catalog: string,
  namespace: string,
  table: string,
  m: IcebergMaintenance,
  now: Date,
): string {
  const ref = icebergSparkTableRef(catalog, namespace, table).slice(catalog.length + 1);
  const call = (proc: string, extra = "") =>
    `CALL ${catalog}.system.${proc}(table => '${ref}'${extra})`;
  // FOUND IN R459, measured: a rewrite applies the deletes to the files it
  // writes but leaves the delete files themselves in the table's metadata.
  // 832 data files rewritten into 1, and all 520 delete files still listed
  // (removed_delete_files_count 0), so every read kept opening them; the
  // upkeep item a run was meant to clear stayed. Iceberg's
  // remove-dangling-deletes drops a delete file once no live data file needs it.
  switch (m.action) {
    case "compact":
      return call("rewrite_data_files", ", options => map('remove-dangling-deletes', 'true')");
    case "deletes":
      // A file with even one delete applied to it is rewritten without it.
      return call(
        "rewrite_data_files",
        ", options => map('delete-file-threshold', '1', 'remove-dangling-deletes', 'true')",
      );
    case "expire": {
      const days = m.older_than_days ?? EXPIRE_DEFAULTS.older_than_days;
      const keep = m.retain_last ?? EXPIRE_DEFAULTS.retain_last;
      const cutoff = new Date(now.getTime() - days * 86_400_000);
      return call(
        "expire_snapshots",
        `, older_than => TIMESTAMP '${TIMESTAMP(cutoff)}', retain_last => ${keep}`,
      );
    }
  }
}

/** What the panel says a maintenance run will do, before it is confirmed. */
export function maintenanceSummary(m: IcebergMaintenance): string {
  switch (m.action) {
    case "compact":
      return "Rewrite the table's small data files into files near the target size. The rows do not change; the table gets a new snapshot that replaces the files, and earlier snapshots still read the old ones until they expire.";
    case "deletes":
      return "Rewrite every data file that has deletes applied to it, without the deleted rows, so reads stop filtering them. The rows do not change; the table gets a new snapshot.";
    case "expire": {
      const days = m.older_than_days ?? EXPIRE_DEFAULTS.older_than_days;
      const keep = m.retain_last ?? EXPIRE_DEFAULTS.retain_last;
      return `Remove snapshots older than ${days} day${days === 1 ? "" : "s"}, keeping at least the newest ${keep}, and delete the files only they reference. Time travel to a removed snapshot is no longer possible; branches and tags are kept. This cannot be undone.`;
    }
  }
}

/** The maintenance job's program. The server prepends the shared prelude. */
export function compileIcebergMaintenance(args: {
  jobId: string;
  catalog: string;
  cfg: IcebergCatalogConfig;
  sql: string;
}): string {
  const py = (s: string) => JSON.stringify(s);
  return (
    [
      `# Iceberg maintenance on Spark — generated for job ${args.jobId}`,
      `import datetime as _dt, decimal as _dec, json, math, os, time`,
      `from pyspark.sql import SparkSession, Row`,
      ``,
      ...sparkConnectClientFragment().split("\n"),
      `_url = os.environ.get('ETL_SPARK_CONNECT_URL', '')`,
      `if not _url:`,
      `    raise RuntimeError('No Spark Connect endpoint is configured (Admin -> Developer runtime -> Spark engine).')`,
      `_t0 = time.time()`,
      `spark = ${SPARK_CONNECT_FN}(_url)`,
      `print('[iceberg] connected to ' + _url.split(';')[0] + ' (' + spark.version + ')')`,
      ``,
      `def _j(v):`,
      `    if v is None or isinstance(v, (bool, int, str)):`,
      `        return v`,
      `    if isinstance(v, float):`,
      `        return v if math.isfinite(v) else str(v)`,
      `    if isinstance(v, (_dt.datetime, _dt.date)):`,
      `        return v.isoformat()`,
      `    if isinstance(v, _dec.Decimal):`,
      `        return str(v)`,
      `    return str(v)`,
      ``,
      `def entrypoint(inputs):`,
      // No statement here is user text, but a credential is now in the session's
      // settings, and ${...} substitution is how SQL would read one back.
      `    spark.conf.set('spark.sql.variable.substitute', 'false')`,
      // The expiry cutoff is written in UTC; the session reads it in UTC too.
      `    spark.conf.set('spark.sql.session.timeZone', 'UTC')`,
      ...icebergSparkConfLines(args.catalog, args.cfg, 0),
      `    _q = ${py(args.sql)}`,
      `    print('[iceberg] ' + _q)`,
      `    _df = spark.sql(_q)`,
      `    _rows = _df.collect()`,
      `    _cols = [{'name': f.name, 'type': f.dataType.simpleString()} for f in _df.schema.fields]`,
      `    _out = [[_j(v) for v in list(r)] for r in _rows]`,
      `    _ms = int((time.time() - _t0) * 1000)`,
      `    print('[iceberg] ' + json.dumps({'columns': [c['name'] for c in _cols], 'rows': _out, 'ms': _ms}))`,
      `    return {`,
      `        'columns': _cols,`,
      `        'rows': _out,`,
      `        'row_count': len(_out),`,
      `        'truncated': False,`,
      `        'duration_ms': _ms,`,
      `        'spark_version': spark.version,`,
      `        'snapshot': None,`,
      `    }`,
    ].join("\n") + "\n"
  );
}

/** A maintenance result, in words: the procedure's own counters, the non-zero ones. */
export function describeMaintenanceResult(
  action: IcebergMaintenanceAction,
  columns: { name: string }[],
  rows: unknown[][],
): string {
  const row = rows[0] ?? [];
  const v = (name: string) => {
    const i = columns.findIndex((c) => c.name === name);
    const n = i < 0 ? 0 : Number(row[i] ?? 0);
    return Number.isFinite(n) ? n : 0;
  };
  const plural = (n: number, w: string) => `${n.toLocaleString()} ${w}${n === 1 ? "" : "s"}`;
  if (action === "expire") {
    const files =
      v("deleted_data_files_count") +
      v("deleted_position_delete_files_count") +
      v("deleted_equality_delete_files_count");
    const meta =
      v("deleted_manifest_files_count") +
      v("deleted_manifest_lists_count") +
      v("deleted_statistics_files_count");
    if (!files && !meta) return "No snapshot was old enough to expire.";
    return `Expired snapshots: deleted ${plural(files, "data or delete file")} and ${plural(meta, "metadata file")}.`;
  }
  const rewritten = v("rewritten_data_files_count");
  const added = v("added_data_files_count");
  const removedDeletes = v("removed_delete_files_count");
  const failed = v("failed_data_files_count");
  if (!rewritten && !removedDeletes) return "Nothing needed rewriting.";
  return (
    `Rewrote ${plural(rewritten, "data file")} into ${plural(added, "file")}` +
    (removedDeletes ? `, removing ${plural(removedDeletes, "delete file")}` : "") +
    (failed ? `; ${plural(failed, "file")} could not be rewritten` : "") +
    "."
  );
}
