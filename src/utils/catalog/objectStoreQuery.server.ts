// Querying an object-store bucket from the Workbench.
//
// TWO ENGINES, ON PURPOSE.
//
//   objectStoreRead.server  reaches s3://, so it must have network access, so
//                           it can also read the server's own disk. It only
//                           ever runs statements it composes itself.
//   data/duckdb.server      sandboxed (enable_external_access=false), which is
//                           what makes it safe for SQL a user or a model wrote.
//
// The user's query runs in the SECOND one, over rows the first one fetched.
// That split is forced: measured against DuckDB v1.5.5 there is no setting
// that keeps the network open while closing the local filesystem, so any
// engine that can read a bucket can also read `.env`. Materialising is the
// only boundary that holds.
//
// The cost is honest and worth stating: no predicate push-down into Parquet.
// A query reads up to OBJECT_ROWS_CAP rows per referenced object and filters
// locally. When that bound bites, `truncated` says so rather than presenting a
// prefix as the whole table.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { safeTableName } from "@/lib/datasetParse";
import { objectSqlName } from "@/lib/objectSqlName";
import { extractTableRefs } from "@/lib/sqlRefs";
import { assertLocalReadOnlySql } from "@/lib/sqlSafety";
import { runLocalSqlDuckDB } from "@/utils/data/duckdb.server";
import { loadStorageConfig } from "./crawler.server";
import { fileFormat } from "./objectStore.server";
import {
  duckReadableFormat,
  readObjectRows,
  OBJECT_ROWS_CAP,
  type ReadableFormat,
} from "./objectStoreRead.server";

export type ObjectStoreTable = {
  /** The name to write in SQL. */
  table: string;
  /** Object key, or the group's glob when the asset is a partitioned folder. */
  key: string;
  format: ReadableFormat;
  columns: { name: string; type: string }[];
  row_count: number | null;
};

export type ObjectStoreQueryResult = {
  columns: string[];
  rows: Record<string, unknown>[];
  /** Objects whose read stopped at the cap, so the answer is over a prefix. */
  truncated: string[];
  duration_ms: number;
};

/**
 * A SQL identifier for a crawled asset.
 *
 * `data/orders.parquet` becomes `orders`, because that is what somebody types.
 * Collisions are resolved by falling back to the fuller path — two files
 * called `orders.parquet` in different folders are ordinary, and silently
 * pointing both at one of them would answer the wrong question.
 */
export function sqlNameFor(fqn: string, taken: Set<string>): string {
  // The base name comes from lib/objectSqlName, which the Catalog also uses to
  // seed "Query in Workbench". If the two disagreed the seeded query would
  // name a table the server cannot resolve.
  const name = objectSqlName(fqn);
  if (!taken.has(name)) return name;
  // Two files called orders.parquet in different folders are ordinary, and
  // silently pointing both at one of them would answer the wrong question.
  const withDir = safeTableName(fqn.replace(/\.[a-z0-9]+$/i, ""));
  if (!taken.has(withDir)) return withDir;
  let i = 2;
  while (taken.has(`${name}_${i}`)) i++;
  return `${name}_${i}`;
}

/**
 * The queryable tables in one object-store source, from what the crawl found.
 *
 * Reads `catalog_assets` rather than re-listing the bucket: the crawl is the
 * inventory, and a picker that hits S3 on every keystroke is its own problem.
 */
export async function listObjectStoreTables(
  userId: string,
  sourceId: string,
): Promise<ObjectStoreTable[]> {
  const { data, error } = await supabaseAdmin
    .from("catalog_assets")
    .select("fqn, name, format, columns, row_count")
    .eq("source_id", sourceId)
    .eq("user_id", userId)
    .order("fqn");
  if (error) throw new Error(error.message);

  const taken = new Set<string>();
  const tables: ObjectStoreTable[] = [];
  for (const a of data ?? []) {
    // The crawler records the group's format; fall back to the extension for
    // rows written before it did.
    const fmt = duckReadableFormat(a.format ?? fileFormat(a.fqn));
    if (!fmt) continue; // ORC, Avro, images — listed in the catalog, not queryable
    const table = sqlNameFor(a.fqn, taken);
    taken.add(table);
    tables.push({
      table,
      key: a.fqn,
      format: fmt,
      columns: Array.isArray(a.columns) ? (a.columns as { name: string; type: string }[]) : [],
      row_count: a.row_count,
    });
  }
  return tables;
}

/**
 * Run one read-only query against a bucket.
 *
 * Only the objects the SQL actually names are fetched. A source with two
 * hundred files should not cost two hundred S3 reads because someone selected
 * from one of them.
 */
export async function runObjectStoreQuery(args: {
  userId: string;
  sourceId: string;
  sql: string;
  /** Rows returned to the caller. The per-object read cap is separate. */
  maxRows?: number;
}): Promise<ObjectStoreQueryResult> {
  // Guard FIRST, before any credential is decrypted or any object is fetched.
  const safeSql = assertLocalReadOnlySql(args.sql);
  const started = Date.now();

  const { data: source, error } = await supabaseAdmin
    .from("catalog_sources")
    .select("id, name, credentials, kind, user_id")
    .eq("id", args.sourceId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!source) throw new Error("That data source no longer exists");
  // Ownership is checked here and not left to RLS: this runs with the service
  // role, where RLS is off, and the whole point is decrypting credentials.
  if (source.user_id !== args.userId) {
    throw new Error("You do not have access to that data source");
  }
  if (source.kind !== "object_storage") {
    throw new Error(`"${source.name}" is not an object-store source`);
  }

  const available = await listObjectStoreTables(args.userId, args.sourceId);
  if (available.length === 0) {
    throw new Error(
      `No queryable files in "${source.name}". Crawl the source first, or it holds only formats ` +
        `this engine cannot open (Parquet, CSV, JSON and NDJSON are supported).`,
    );
  }

  // Only what the query names. extractTableRefs is the same parser the lineage
  // index uses, so the Workbench and the catalog agree on what a query touches.
  // It reads quoted identifiers (`FROM "orders"`) as well as bare ones — a
  // parser that skipped them would fetch nothing and fail the query below.
  const referenced = new Set(
    extractTableRefs(safeSql).map((t) => t.split(".").pop()!.toLowerCase()),
  );
  const needed = available.filter((t) => referenced.has(t.table.toLowerCase()));
  if (needed.length === 0) {
    throw new Error(
      `That query does not reference any file in "${source.name}". Available: ` +
        available
          .slice(0, 12)
          .map((t) => t.table)
          .join(", "),
    );
  }

  const cfg = await loadStorageConfig(args.userId, source);
  const truncated: string[] = [];
  const tables = [];
  for (const t of needed) {
    const read = await readObjectRows(cfg, t.key, t.format, OBJECT_ROWS_CAP);
    if (read.capped) truncated.push(t.table);
    tables.push({
      name: t.table,
      // The catalog's own vocabulary, which is what the local engine loads.
      columns: read.columns.map((c) => ({
        name: c.name,
        type: /INT|DEC|NUM|DOUBLE|FLOAT|REAL/i.test(c.type)
          ? ("number" as const)
          : /DATE|TIME/i.test(c.type)
            ? ("date" as const)
            : ("string" as const),
      })),
      rows: read.rows,
    });
  }

  const res = await runLocalSqlDuckDB(safeSql, tables, { rowCap: args.maxRows });
  return {
    columns: res.columns,
    rows: res.rows,
    truncated,
    duration_ms: Date.now() - started,
  };
}
