// Reading columnar files out of an object store, with DuckDB.
//
// WHY THIS IS A SEPARATE ENGINE. The local engine in utils/data/duckdb.server
// is sandboxed with `enable_external_access=false`, which closes the disk AND
// the network. That is what makes it safe to run user- and model-authored SQL.
// This one has to reach s3://, so it cannot have that setting, and the
// consequence is the rule this whole file is built around:
//
//   USER SQL NEVER RUNS HERE. Only statements this module composes.
//
// That is not a stylistic preference. Measured against DuckDB v1.5.5, there is
// no configuration that keeps the network open while closing the local
// filesystem — `allowed_directories=[]` (with and without lock_configuration)
// still read local files, and `disabled_filesystems='LocalFileSystem'` blocked
// the remote read too. So a `SELECT` reaching this engine could do
// `read_text('/app/.env')` whatever the read-only guard says. The only
// defensible boundary is that user text never gets here at all.
//
// The Workbench path therefore materialises bounded rows through this module
// and runs the user's query against them in the SANDBOXED engine. The cost is
// no predicate push-down into Parquet; the same bounded-materialisation shape
// the warehouse and prep paths already use.
import { azureConnectionString } from "./azureBlob.server";
import type { ObjectStoreConfig } from "./objectStore.server";
import { toJsValue } from "@/lib/duckdbValues";
import { isBlockedAlways, isPrivateNetwork } from "@/utils/ssrfGuard.server";

/** Rows pulled per object when materialising for a query. */
export const OBJECT_ROWS_CAP = 50_000;

export type ObjectColumn = { name: string; type: string };
export type ObjectRead = {
  columns: ObjectColumn[];
  rows: Record<string, unknown>[];
  /** True when the read stopped at the cap and more rows exist. */
  capped: boolean;
};

export type ReadableFormat = "parquet" | "csv" | "ndjson" | "orc";

/** Formats this deployment can open from object storage. */
export function duckReadableFormat(format: string | null): ReadableFormat | null {
  if (format === "parquet") return "parquet";
  if (format === "csv") return "csv";
  if (format === "ndjson" || format === "json") return "ndjson";
  if (format === "orc") return "orc";
  // Avro is deliberately absent — see avroUnavailableReason().
  return null;
}

/**
 * Why Avro is listed but not readable.
 *
 * There is no built-in Avro reader; it is a DuckDB COMMUNITY extension, and no
 * build has been published since v1.1.3. Checked against the community
 * repository for this build (v1.5.5) on every platform this project targets —
 * windows_amd64, linux_amd64, linux_arm64, osx_arm64 — all 404. It is not a
 * platform gap and not a network problem: ORC downloads fine from the same
 * host for all four.
 *
 * The format is still RECOGNISED, so an .avro file appears in the catalog with
 * its name and size rather than vanishing, and the reason it cannot be opened
 * is stated instead of being a silent absence. If a build appears, adding
 * "avro" to duckReadableFormat and its reader below is the whole change.
 */
export function avroUnavailableReason(): string {
  return (
    "Avro needs the DuckDB `avro` community extension, which has no published build for this " +
    "DuckDB version (last released for v1.1.3). The file is cataloged but cannot be read. " +
    "Convert it to Parquet to query it."
  );
}

/** ORC is the one format that must not run in this process — see orcIsolated. */
export function needsIsolation(format: ReadableFormat): boolean {
  return format === "orc";
}

function readerFor(format: ReadableFormat): string {
  if (format === "parquet") return "read_parquet";
  if (format === "csv") return "read_csv_auto";
  if (format === "orc") return "read_orc";
  return "read_json_auto";
}

/**
 * Refuse an endpoint that points inside the deployment's own network.
 *
 * The endpoint is operator-supplied, and DuckDB's httpfs makes its own HTTP
 * calls — it does not go through safeFetch, so none of the redirect and
 * DNS-revalidation work in ssrfGuard applies to it. This is the one chance to
 * check, so link-local and cloud metadata are refused outright and private
 * ranges follow the same BLOCK_PRIVATE_NETWORK_FETCH switch as everything else
 * (a self-hosted MinIO on a private address is a normal deployment).
 */
export function assertEndpointAllowed(endpoint: string | undefined): void {
  if (!endpoint) return; // no endpoint = AWS, derived from the region
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("The object store endpoint is not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("The object store endpoint must be http or https");
  }
  if (isBlockedAlways(url.hostname)) {
    throw new Error(
      `Refusing to read from ${url.hostname}: link-local and instance-metadata addresses are never allowed`,
    );
  }
  if (/^(1|true|yes)$/i.test(process.env.BLOCK_PRIVATE_NETWORK_FETCH ?? "")) {
    if (isPrivateNetwork(url.hostname)) {
      throw new Error(`Refusing to read from ${url.hostname}: BLOCK_PRIVATE_NETWORK_FETCH is set`);
    }
  }
}

/** Single-quoted SQL literal. */
function lit(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

let instance: Promise<
  Awaited<ReturnType<typeof import("@duckdb/node-api").DuckDBInstance.create>>
> | null = null;

async function getInstance() {
  if (!instance) {
    instance = import("@duckdb/node-api").then(({ DuckDBInstance }) =>
      DuckDBInstance.create(":memory:"),
    );
    instance.catch(() => {
      instance = null;
    });
  }
  return instance;
}

/**
 * Point a connection at one bucket.
 *
 * Credentials are set per connection rather than globally: two sources with
 * different keys are read concurrently in the same process, and DuckDB's s3_*
 * settings applied to a shared instance would let one crawl pick up another's
 * credentials.
 */
async function configure(
  conn: { run: (sql: string) => Promise<unknown> },
  cfg: ObjectStoreConfig,
): Promise<void> {
  assertEndpointAllowed(cfg.endpoint);
  if (cfg.provider === "azure") {
    // Azure is read through DuckDB's azure extension, not httpfs. The secret
    // is per connection for the same reason the s3_* settings below are: two
    // sources with different credentials are read concurrently in one process.
    await conn.run("INSTALL azure");
    await conn.run("LOAD azure");
    await conn.run(
      `CREATE OR REPLACE SECRET azure_read (TYPE azure, CONNECTION_STRING ${lit(azureConnectionString(cfg))})`,
    );
    return;
  }
  await conn.run("INSTALL httpfs");
  await conn.run("LOAD httpfs");
  await conn.run(`SET s3_region=${lit(cfg.region || "us-east-1")}`);
  await conn.run(`SET s3_access_key_id=${lit(cfg.access_key_id)}`);
  await conn.run(`SET s3_secret_access_key=${lit(cfg.secret_access_key)}`);
  if (cfg.endpoint) {
    const url = new URL(cfg.endpoint);
    // DuckDB wants host[:port], not a scheme.
    await conn.run(`SET s3_endpoint=${lit(url.host)}`);
    await conn.run(`SET s3_use_ssl=${url.protocol === "https:" ? "true" : "false"}`);
  }
  // Path style is required by MinIO and most non-AWS endpoints; the config's
  // own default already encodes "on for custom endpoints".
  const pathStyle = cfg.path_style ?? Boolean(cfg.endpoint);
  await conn.run(`SET s3_url_style=${lit(pathStyle ? "path" : "vhost")}`);
}

/** `s3://bucket/key` — the only shape composed from a key. */
function objectUrl(cfg: ObjectStoreConfig, key: string): string {
  // The one place a URL is composed from a key. `az://` is what the azure
  // extension resolves; for Azure `bucket` holds the container name.
  return `${cfg.provider === "azure" ? "az" : "s3"}://${cfg.bucket}/${key}`;
}

async function withConnection<T>(
  cfg: ObjectStoreConfig,
  fn: (run: (sql: string) => Promise<Record<string, unknown>[]>) => Promise<T>,
): Promise<T> {
  const inst = await getInstance();
  const conn = await inst.connect();
  const run = async (sql: string) => {
    const r = await conn.run(sql);
    return (await r.getRowObjects()) as Record<string, unknown>[];
  };
  try {
    await configure(conn, cfg);
    return await fn(run);
  } finally {
    conn.closeSync();
  }
}

/**
 * Column names and types for one object, WITHOUT reading its data.
 *
 * For Parquet this reads the footer only, which is why it is cheap enough to
 * run during a crawl over a multi-gigabyte file. The head-of-file text
 * sampling the crawler uses for CSV cannot do this at all for Parquet — the
 * schema is at the END of the file — which is why `inferColumns` returned an
 * empty list and every Parquet asset was cataloged with no columns.
 */
export async function describeObject(
  cfg: ObjectStoreConfig,
  key: string,
  format: ReadableFormat,
): Promise<ObjectColumn[]> {
  const sql = `DESCRIBE SELECT * FROM ${readerFor(format)}('${objectUrl(cfg, key).replace(/'/g, "''")}')`;
  const toColumns = (rows: Record<string, unknown>[]) =>
    rows.map((r) => ({ name: String(r.column_name), type: String(r.column_type) }));

  if (needsIsolation(format)) {
    // DESCRIBE was reliable on every ORC sample tested, including the one that
    // panics on read — but "reliable on four files" is not a guarantee, and the
    // failure mode is a process abort, so it runs in the child regardless.
    const { runOrcIsolated } = await import("./orcIsolated.server");
    const res = await runOrcIsolated(
      cfg,
      key,
      (local) => `DESCRIBE SELECT * FROM read_orc('${local}')`,
    );
    if (!res.ok) throw new Error(res.error);
    return toColumns(res.rows);
  }
  return withConnection(cfg, async (run) => toColumns(await run(sql)));
}

/** Row count from Parquet metadata — no scan. Null when unavailable. */
export async function countObjectRows(
  cfg: ObjectStoreConfig,
  key: string,
  format: ReadableFormat,
): Promise<number | null> {
  try {
    if (needsIsolation(format)) {
      // No footer metadata function for ORC, so this is a scan — bounded by the
      // child's timeout, and a null count is an acceptable outcome.
      const { runOrcIsolated } = await import("./orcIsolated.server");
      const res = await runOrcIsolated(
        cfg,
        key,
        (local) => `SELECT count(*) AS n FROM read_orc('${local}')`,
      );
      return res.ok ? Number(res.rows[0]?.n ?? 0) : null;
    }
    return await withConnection(cfg, async (run) => {
      const url = lit(objectUrl(cfg, key));
      if (format === "parquet") {
        // parquet_file_metadata reads the footer; count(*) would scan.
        const rows = await run(`SELECT num_rows AS n FROM parquet_file_metadata(${url})`);
        const n = rows[0]?.n;
        return n === undefined || n === null ? null : Number(n);
      }
      const rows = await run(`SELECT count(*) AS n FROM ${readerFor(format)}(${url})`);
      return Number(rows[0]?.n ?? 0);
    });
  } catch {
    // A row count is a nicety; never fail a crawl for it.
    return null;
  }
}

/**
 * Read up to `rowCap` rows from one object.
 *
 * The caller runs the user's query against these rows in the SANDBOXED engine.
 * `capped` is returned rather than inferred so the caller can say so — a
 * silently truncated read that presents as a complete answer is the failure
 * mode this codebase keeps finding.
 */
export async function readObjectRows(
  cfg: ObjectStoreConfig,
  key: string,
  format: ReadableFormat,
  rowCap: number = OBJECT_ROWS_CAP,
): Promise<ObjectRead> {
  const cap = Math.max(1, Math.trunc(rowCap));

  if (needsIsolation(format)) {
    const { runOrcIsolated } = await import("./orcIsolated.server");
    // ONE child, not two: each call downloads the object again, and an ORC
    // read already pays a full download that Parquet does not. The schema and
    // the rows come back from a single statement.
    //
    // One row past the cap, so "there were more" is observed rather than
    // guessed — the same rule as the in-process path.
    const read = await runOrcIsolated(
      cfg,
      key,
      (local) => `SELECT * FROM read_orc('${local}') LIMIT ${cap + 1}`,
    );
    if (!read.ok) throw new Error(read.error);
    const capped = read.rows.length > cap;
    // Column names come from the rows themselves. DESCRIBE would mean a second
    // download for information the first read already carries, and an empty
    // file legitimately has no columns to report.
    const names = read.rows.length > 0 ? Object.keys(read.rows[0]) : [];
    return {
      columns: names.map((name) => ({ name, type: "" })),
      rows: (capped ? read.rows.slice(0, cap) : read.rows).map((row) => {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(row)) out[k] = toJsValue(v);
        return out;
      }),
      capped,
    };
  }

  return withConnection(cfg, async (run) => {
    const url = lit(objectUrl(cfg, key));
    const src = `${readerFor(format)}(${url})`;
    const described = await run(`DESCRIBE SELECT * FROM ${src}`);
    // One row over the cap, so "there were more" is observed and not guessed.
    const rows = await run(`SELECT * FROM ${src} LIMIT ${cap + 1}`);
    const capped = rows.length > cap;
    // Normalise through the SAME converter the local engine and the browser
    // engine use. Without it a DATE column reaches the results grid as the raw
    // DuckDB object and renders as `{"days":20468}` — caught by looking at the
    // actual screen, not by any of the type assertions, which were all happy.
    const clean = (capped ? rows.slice(0, cap) : rows).map((row) => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(row)) out[k] = toJsValue(v);
      return out;
    });
    return {
      columns: described.map((r) => ({
        name: String(r.column_name),
        type: String(r.column_type),
      })),
      rows: clean,
      capped,
    };
  });
}
