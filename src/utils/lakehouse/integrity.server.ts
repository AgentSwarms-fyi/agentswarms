// Does the catalog still describe data that exists?
//
// THE GAP THIS FILLS. A DuckLake table is two things: rows of metadata in the
// catalog database, and Parquet objects in the store. Nothing keeps them
// together. Replace the object store, empty a bucket, restore a catalog backup
// from a different day — and the catalog keeps confidently describing files
// that are gone.
//
// The Lakehouse page does not notice, and the reason is specific: `count(*)`
// on a DuckLake table is answered from `ducklake_data_file.record_count`
// WITHOUT reading a single Parquet. So a table whose data has vanished still
// reports its full row count and looks perfectly healthy in the table list. The
// first symptom is a 404 when somebody opens it — which is exactly how this was
// found, on an instance whose MinIO had been replaced while the catalog Postgres
// survived on its own volume.
//
// That is the worst shape a data platform failure can take: the UI says the
// rows are there, and it is reading a source that genuinely believes it.
import { lakehouseConfig, lakehouseConnection } from "./core.server";

export type LakehouseIntegrityIssue = {
  schema: string;
  table: string;
  /** Object keys the catalog lists that the store does not have. */
  missing: string[];
  /** Rows the catalog attributes to those files — unreadable, not merely at risk. */
  missing_rows: number;
  /** Live data files for this table, so "3 of 4" reads correctly. */
  total_files: number;
};

export type LakehouseIntegrityReport = {
  ok: boolean;
  /** Live data files examined. */
  checked: number;
  issues: LakehouseIntegrityIssue[];
  /** Set when the object listing hit its ceiling — see MAX_OBJECTS. */
  truncated: boolean;
  /** Populated when the check itself could not run. */
  error?: string;
};

// A listing ceiling, because a real lake can hold millions of objects and this
// runs behind a page load. If it is hit the report says so rather than
// reporting phantom "missing" files for everything past the cut — a check that
// cries wolf is worse than no check.
const MAX_OBJECTS = 200_000;

/** Strip the scheme and any trailing slash so two paths can be compared. */
function normalizeKey(uri: string): string {
  return uri
    .replace(/^[a-z0-9]+:\/\//i, "")
    .replace(/\/+$/, "")
    .replace(/^\/+/, "");
}

export async function lakehouseIntegrity(): Promise<LakehouseIntegrityReport> {
  const cfg = lakehouseConfig();
  if (!cfg) {
    return { ok: true, checked: 0, issues: [], truncated: false };
  }
  const root = cfg.dataUrl.replace(/\/+$/, "");
  const c = await lakehouseConnection();
  try {
    // What the catalog claims. `path_is_relative` is honoured because a table
    // may have been created with an absolute location.
    const rows = await (
      await c.run(
        `SELECT sc.schema_name, t.table_name, sc.path, t.path, df.path, df.path_is_relative,
                df.record_count::BIGINT
           FROM __ducklake_metadata_lake.ducklake_data_file df
           JOIN __ducklake_metadata_lake.ducklake_table t  ON t.table_id  = df.table_id
           JOIN __ducklake_metadata_lake.ducklake_schema sc ON sc.schema_id = t.schema_id
          WHERE df.end_snapshot IS NULL AND t.end_snapshot IS NULL`,
      )
    ).getRows();

    if (!rows.length) return { ok: true, checked: 0, issues: [], truncated: false };

    // What the store actually has. One listing, compared in memory — cheaper
    // and far kinder to the object store than a HEAD per file.
    const present = new Set<string>();
    let truncated = false;
    const listed = await (
      await c.run(`SELECT file FROM glob(${sqlStr(`${root}/**`)}) LIMIT ${MAX_OBJECTS + 1}`)
    ).getRows();
    if (listed.length > MAX_OBJECTS) truncated = true;
    for (const r of listed.slice(0, MAX_OBJECTS)) present.add(normalizeKey(String(r[0])));

    const byTable = new Map<string, LakehouseIntegrityIssue>();
    for (const r of rows) {
      const schema = String(r[0]);
      const table = String(r[1]);
      const relative = r[5] !== false;
      const uri = relative ? `${root}/${String(r[2])}${String(r[3])}${String(r[4])}` : String(r[4]);
      const key = `${schema}.${table}`;
      const entry = byTable.get(key) ?? {
        schema,
        table,
        missing: [],
        missing_rows: 0,
        total_files: 0,
      };
      entry.total_files += 1;
      if (!present.has(normalizeKey(uri))) {
        entry.missing.push(String(r[4]));
        entry.missing_rows += Number(r[6] ?? 0);
      }
      byTable.set(key, entry);
    }

    const issues = [...byTable.values()]
      .filter((t) => t.missing.length > 0)
      // Worst first: a table that lost everything is a different problem from
      // one that lost a partition.
      .sort((a, b) => b.missing_rows - a.missing_rows);

    // A truncated listing cannot prove absence, so it cannot report issues.
    return {
      ok: truncated ? true : issues.length === 0,
      checked: rows.length,
      issues: truncated ? [] : issues,
      truncated,
    };
  } catch (e) {
    // Never throw into a page load: an integrity check that takes the Lakehouse
    // down is worse than the divergence it looks for.
    return {
      ok: true,
      checked: 0,
      issues: [],
      truncated: false,
      error: (e as Error).message.slice(0, 300),
    };
  } finally {
    c.closeSync();
  }
}

function sqlStr(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}
