// DuckDB as a local SQL engine — the candidate replacement for AlaSQL and the
// hand-written interpreter.
//
// Opt in with LOCAL_ENGINE=duckdb. Off by default: this is proven against the
// existing engines by tests/differential before it becomes the default, not
// after.
//
// Why bother: AlaSQL is a JS interpreter over plain objects with no real type
// system, no window functions, no CTEs, and semantics that drift from SQL in
// ways the differential harness has already caught. DuckDB is a vectorised
// columnar engine that speaks actual SQL.
//
// Invariants worth protecting:
//
//   * **A fresh in-memory database per call.** Never share a connection across
//     users or requests. Datasets are loaded per query, so there is no path by
//     which one tenant's rows can be visible to another's query.
//   * **Nothing is written anywhere.** ":memory:" only — no file, no attach.
//     The read-only guard runs first regardless, so the engine, the workbench
//     and the agent tool all refuse the same statements.
//   * **Values crossing back into JS are normalised.** DuckDB returns BigInt
//     for COUNT and a decimal object for DECIMAL; handing those to
//     JSON.stringify throws or renders "[object Object]". See toJsValue.

import { assertLocalReadOnlySql } from "@/lib/sqlSafety";
import type { ColumnDef } from "@/lib/datasetParse";

export type DuckRow = Record<string, unknown>;
export type DuckTable = {
  name: string;
  columns: ColumnDef[];
  rows: DuckRow[];
  /**
   * Local Parquet file holding this dataset's rows.
   *
   * When set, `rows` is ignored and DuckDB reads the file directly — the whole
   * point of the columnar mirror, since it can project and filter without
   * materialising anything. Callers set this only for a mirror they have
   * already verified is current (see parquet.server).
   */
  parquetPath?: string;
};

/** True when this deployment has opted into DuckDB for local SQL. */
export function duckdbEnabled(): boolean {
  return (process.env.LOCAL_ENGINE ?? "").trim().toLowerCase() === "duckdb";
}

/**
 * One DuckDB instance for the process, created on first use.
 *
 * It used to be one instance PER QUERY, which cost ~2100 ms against ~3 ms for
 * AlaSQL on a small aggregate — a ten-widget dashboard would have spent
 * twenty seconds starting databases. That is why DuckDB could not become the
 * default engine.
 *
 * WHERE THE TIME WENT, measured on a 5,000-row aggregate:
 *
 *     in-memory rows   2152 ms      parquet mirror   8 ms
 *
 * Pooling was not what fixed that (2115 -> 2083 ms); the cost was ~0.42 ms per
 * row spent binding parameterised INSERTs, one awaited round trip each. The
 * MIRROR skipped that path entirely by reading the file, which is why it was
 * already fast. The in-memory path now uses the APPENDER (see loadTable) and
 * costs ~17 ms on the same 5,000 rows, so both paths are fast and the engine
 * no longer has a slow case to route around. Pooling remains a correctness
 * win, not a speed one.
 *
 * ISOLATION IS NOT FREE HERE, and it is the reason this was left per-query in
 * the first place. Tables are registered with CREATE TEMP TABLE, which DuckDB
 * scopes to the CONNECTION — two connections can each hold a different `t` and
 * neither sees the other's. The same applies to the VIEW that fronts a
 * Parquet mirror. A plain CREATE lands in the shared catalog
 * and IS visible to every other connection, so with a shared instance it would
 * expose one caller's rows to another's concurrent query. Verified, not
 * assumed. Never register a table here without TEMP.
 */
let sharedInstance: Promise<
  Awaited<ReturnType<typeof import("@duckdb/node-api").DuckDBInstance.create>>
> | null = null;

async function getInstance() {
  if (!sharedInstance) {
    sharedInstance = import("@duckdb/node-api").then(({ DuckDBInstance }) =>
      DuckDBInstance.create(":memory:"),
    );
    // A failed create must not poison every later call with the same rejection.
    sharedInstance.catch(() => {
      sharedInstance = null;
    });
  }
  return sharedInstance;
}

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

/** Memory ceiling for one query. Without it a careless join can take the process down. */
function memoryLimitMb(): number {
  return envInt("LOCAL_ENGINE_MEMORY_MB", 512);
}

function threadCount(): number {
  return envInt("LOCAL_ENGINE_THREADS", 2);
}

/** Wall-clock budget for one query, after which the connection is interrupted. */
function queryTimeoutMs(): number {
  return envInt("LOCAL_ENGINE_TIMEOUT_MS", 30_000);
}

/**
 * Rows appended between flushes.
 *
 * The appender buffers into column vectors and flushes on its own, but an
 * unbounded buffer on a very wide table is memory we have already promised to
 * cap (LOCAL_ENGINE_MEMORY_MB). Flushing periodically bounds it without
 * measurably costing anything: at 100k rows the difference is in the noise.
 */
const APPEND_FLUSH_ROWS = 10_000;

/** Only these identifiers may be interpolated; everything else is rejected. */
const SAFE_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Quote an identifier for DuckDB.
 *
 * Column names come from user file headers and legitimately contain spaces,
 * punctuation and non-ASCII ("Order ID", "Größe"). Doubling embedded quotes is
 * what makes that safe; refusing them outright would break real uploads.
 */
function quoteIdent(name: string): string {
  return `"${String(name).replace(/"/g, '""')}"`;
}

/**
 * A single-quoted SQL string literal.
 *
 * DuckDB is ANSI — backslash is a literal character, so doubling the quote is
 * the whole escape (asserted against the real engine in duckdbDialect.test).
 * Used for filesystem paths, which on Windows are full of backslashes.
 */
function sqlLiteral(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

/** SQL type for a declared column type. */
function sqlTypeFor(type: ColumnDef["type"]): string {
  // `date` maps to VARCHAR deliberately. Every date in this app is stored and
  // compared as an ISO string — dashboard filters emit `day >= '2026-03-01'`,
  // and ISO text sorts chronologically. Mapping to DATE would change
  // comparison and ordering semantics across the whole product for no gain
  // here; that is a migration of its own, not a side effect of this one.
  return type === "number" ? "DOUBLE" : "VARCHAR";
}

export type DuckResult = {
  columns: string[];
  rows: DuckRow[];
  /** Values that could not be coerced to their column's declared type. */
  coercionFailures: number;
};

/**
 * Convert a DuckDB value into something JSON-serialisable.
 *
 * This is not cosmetic. COUNT(*) comes back as a BigInt, which JSON.stringify
 * throws on outright, and DECIMAL comes back as an object that stringifies to
 * "[object Object]" — either would surface as a broken widget or a 500 rather
 * than a wrong number, but both are failures.
 */
export function toJsValue(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === "bigint") {
    // Beyond 2^53 a Number silently loses precision. A string is ugly but
    // honest; a wrong total is neither.
    return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(v)
      : v.toString();
  }
  if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") return v;
  if (v instanceof Date) return v.toISOString();
  // DECIMAL / HUGEINT / DATE / TIMESTAMP arrive as objects with a faithful
  // toString(). Prefer the numeric reading when there is one.
  const s = String(v);
  const n = Number(s);
  return s !== "" && Number.isFinite(n) ? n : s;
}

/**
 * What one raw JS cell becomes in a typed DuckDB column.
 *
 * `ok: false` marks a value the schema calls numeric but which holds no number
 * — it still lands as NULL, but it is counted so the caller can report it.
 */
type Coerced =
  | { kind: "null"; ok: boolean }
  | { kind: "number"; value: number; ok: true }
  | { kind: "string"; value: string; ok: true };

/**
 * Decide what a raw JS value means in a typed column.
 *
 * Kept separate from the code that writes it so the rules have exactly ONE
 * definition. They are subtle enough to be worth stating: an empty string is
 * NOT null — it is an empty string, in every column except a numeric one,
 * where it is a cell with no number in it. Getting this wrong caused 4 of the
 * 9 divergences the differential harness found the first time round.
 */
function coerceValue(raw: unknown, type: ColumnDef["type"]): Coerced {
  if (raw === null || raw === undefined) return { kind: "null", ok: true };
  if (type === "number") {
    // An empty cell in a numeric column has no number in it; NULL is the only
    // honest reading.
    if (raw === "") return { kind: "null", ok: true };
    const n = typeof raw === "number" ? raw : Number(String(raw).replace(/,/g, "").trim());
    // A non-numeric value in a column the schema calls numeric. Storing NULL
    // keeps the column usable for SUM/AVG; the count is reported so this is
    // never silent.
    if (!Number.isFinite(n)) return { kind: "null", ok: false };
    return { kind: "number", value: n, ok: true };
  }
  if (typeof raw === "object") return { kind: "string", value: JSON.stringify(raw), ok: true };
  return { kind: "string", value: String(raw), ok: true };
}

/**
 * Run one read-only statement against a throwaway DuckDB database loaded with
 * `tables`.
 */
export async function runLocalSqlDuckDB(
  sql: string,
  tables: DuckTable[],
  opts: { rowCap?: number } = {},
): Promise<DuckResult> {
  // Same guard as every other local engine — DuckDB would happily run DDL.
  const safeSql = assertLocalReadOnlySql(sql);

  const instance = await getInstance();
  const connection = await instance.connect();

  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;
  try {
    await connection.run(`SET memory_limit='${memoryLimitMb()}MB'`);
    await connection.run(`SET threads=${threadCount()}`);

    let coercionFailures = 0;
    for (const table of tables) {
      coercionFailures += await loadTable(connection, table);
    }

    timer = setTimeout(() => {
      timedOut = true;
      try {
        connection.interrupt();
      } catch {
        /* the query may already have finished */
      }
    }, queryTimeoutMs());

    const result = await connection.run(safeSql);
    const columns = result.columnNames();
    const raw = await result.getRowObjects();
    const cap = opts.rowCap;
    const limited = typeof cap === "number" && cap >= 0 ? raw.slice(0, cap) : raw;

    const rows = limited.map((row) => {
      const out: DuckRow = {};
      for (const [k, v] of Object.entries(row)) out[k] = toJsValue(v);
      return out;
    });

    return { columns, rows, coercionFailures };
  } catch (e) {
    if (timedOut) {
      throw new Error(
        `The query exceeded the ${Math.round(queryTimeoutMs() / 1000)}s local-engine time limit. ` +
          `Narrow it, or raise LOCAL_ENGINE_TIMEOUT_MS.`,
      );
    }
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
    // Closing matters: these hold native memory that GC will not reclaim
    // promptly, and this runs once per query.
    try {
      connection.closeSync();
    } catch {
      /* already closed */
    }
    // The INSTANCE is shared and deliberately not closed — other queries are
    // using it. Only the connection, and with it this query's temp tables, goes.
  }
}

/**
 * Write a dataset to a Parquet file.
 *
 * Uses the same load path as a query, so the mirror's types are exactly the
 * types a query would have seen — a mirror written through a different
 * conversion would answer differently from the rows it mirrors, which is the
 * one thing a cache must never do.
 */
export async function writeTableToParquet(table: DuckTable, filePath: string): Promise<void> {
  const instance = await getInstance();
  const connection = await instance.connect();
  try {
    await connection.run(`SET memory_limit='${memoryLimitMb()}MB'`);
    await loadTable(connection, { ...table, parquetPath: undefined });
    await connection.run(
      `COPY (SELECT * FROM ${quoteIdent(table.name)}) TO ${sqlLiteral(filePath)} ` +
        `(FORMAT PARQUET, COMPRESSION ZSTD)`,
    );
  } finally {
    try {
      connection.closeSync();
    } catch {
      /* already closed */
    }
    // The INSTANCE is shared and deliberately not closed — other queries are
    // using it. Only the connection, and with it this query's temp tables, goes.
  }
}

/** Create one table and insert its rows. Returns the coercion-failure count. */
async function loadTable(
  connection: Awaited<
    ReturnType<
      Awaited<ReturnType<typeof import("@duckdb/node-api").DuckDBInstance.create>>["connect"]
    >
  >,
  table: DuckTable,
): Promise<number> {
  if (!SAFE_IDENT_RE.test(table.name)) {
    // Dataset names are sanitised by safeTableName on every write path, so
    // this should be unreachable — which is exactly why it must throw rather
    // than be interpolated hopefully.
    throw new Error(`Unsafe table name: ${table.name}`);
  }

  // A dataset with no declared schema still has rows; derive the column list
  // from the data so the table is at least queryable.
  // A mirrored dataset is read straight off disk. A VIEW rather than a table
  // so nothing is copied into memory up front — DuckDB pushes the query's
  // projections and filters into the Parquet scan.
  if (table.parquetPath) {
    await connection.run(
      `CREATE TEMP VIEW ${quoteIdent(table.name)} AS SELECT * FROM read_parquet(${sqlLiteral(table.parquetPath)})`,
    );
    return 0;
  }

  const columns: ColumnDef[] =
    table.columns.length > 0
      ? table.columns
      : Object.keys(table.rows[0] ?? {}).map((name) => ({ name, type: "string" as const }));

  if (columns.length === 0) {
    await connection.run(`CREATE TEMP TABLE ${quoteIdent(table.name)} (placeholder VARCHAR)`);
    return 0;
  }

  const ddl = columns.map((c) => `${quoteIdent(c.name)} ${sqlTypeFor(c.type)}`).join(", ");
  await connection.run(`CREATE TEMP TABLE ${quoteIdent(table.name)} (${ddl})`);
  if (table.rows.length === 0) return 0;

  // THE APPENDER, NOT PARAMETERISED INSERTs. This is the difference between
  // DuckDB being usable as the default engine and not:
  //
  //     rows     INSERT $1..$n      appender
  //     1,000        816 ms           22 ms
  //     5,000       4176 ms           17 ms
  //    20,000      14185 ms           39 ms
  //   100,000            —           195 ms
  //
  // An `INSERT ... VALUES ($1,$2,...)` costs one awaited round trip PER ROW,
  // so the load was linear in rows at ~0.42 ms each and dominated everything
  // else by two orders of magnitude. The appender writes into DuckDB's column
  // vectors directly and synchronously, and flushes in batches.
  //
  // The catalog argument is "temp" ON PURPOSE. The table above was created
  // with CREATE TEMP TABLE, which lives in the `temp` catalog; naming it
  // explicitly means this can only ever append to the connection-scoped table
  // and never to a same-named object in the shared catalog. (Verified: the
  // appender resolves a TEMP table with or without the catalog. Explicit is
  // still correct — the isolation guarantee should not rest on name
  // resolution order.)
  const appender = await connection.createAppender(table.name, "main", "temp");
  let failures = 0;
  try {
    let sinceFlush = 0;
    for (const row of table.rows) {
      for (const column of columns) {
        const cell = coerceValue(row[column.name], column.type);
        if (!cell.ok) failures++;
        if (cell.kind === "null") appender.appendNull();
        else if (cell.kind === "number") appender.appendDouble(cell.value);
        else appender.appendVarchar(cell.value);
      }
      appender.endRow();
      if (++sinceFlush >= APPEND_FLUSH_ROWS) {
        appender.flushSync();
        sinceFlush = 0;
      }
    }
    appender.flushSync();
  } finally {
    // Holds native memory and a write handle on the table; a throw mid-append
    // must not leak either.
    try {
      appender.closeSync();
    } catch {
      /* already closed */
    }
  }
  return failures;
}
