// The one way to run SQL over locally-stored datasets.
//
// There used to be three engines: AlaSQL in the browser workbench, AlaSQL on
// the server refresh path, and a hand-written AST interpreter behind the
// sql_query agent tool. Three engines meant the same question could get three
// answers depending on which surface asked it — and the differential harness
// proved that was not hypothetical, finding three cases where the interpreter
// returned wrong data.
//
// Everything server-side now goes through here. One read-only guard, one
// choice of engine, one output shape.
//
// The interpreter is gone. It only ever existed because the app targeted
// Cloudflare Workers, which forbids the `new Function()` that AlaSQL uses to
// compile queries; with Workers no longer a deploy target, the fallback for
// "DuckDB is off" is simply AlaSQL — the same engine the rest of the server
// already used.

import { createRequire } from "node:module";

import { registerPrepFns } from "@/lib/alasqlPrepFns";
import { explainEngineFailure } from "@/lib/engineErrors";
import { assertLocalReadOnlySql } from "@/lib/sqlSafety";
import type { ColumnDef } from "@/lib/datasetParse";

export type LocalRow = Record<string, unknown>;

export type LocalEngineTable = {
  name: string;
  columns: ColumnDef[];
  rows: LocalRow[];
  /** A current Parquet mirror; when set, `rows` is ignored. */
  parquetPath?: string;
};

export type LocalEngineResult = {
  columns: string[];
  rows: LocalRow[];
  engine: "duckdb" | "alasql";
};

/** Which engine this deployment runs local SQL on. */
export async function localEngineName(): Promise<"duckdb" | "alasql"> {
  const { duckdbEnabled } = await import("@/utils/data/duckdb.server");
  return duckdbEnabled() ? "duckdb" : "alasql";
}

/**
 * Execute one read-only SELECT against in-memory (or mirrored) datasets.
 *
 * Callers are responsible for the tenant boundary: whatever tables are passed
 * in are exactly what the query can see. This function applies no filtering of
 * its own, by design — putting access control here would hide it from the
 * places that must get it right.
 */
export async function runLocalSelect(
  sql: string,
  tables: LocalEngineTable[],
  opts: { rowCap?: number } = {},
): Promise<LocalEngineResult> {
  const safeSql = assertLocalReadOnlySql(sql);
  const { duckdbEnabled } = await import("@/utils/data/duckdb.server");

  // Engine diagnostics are translated HERE, at the one entry point, so every
  // surface that runs local SQL SERVER-SIDE — scheduled BI refreshes, prep
  // flows, the semantic runner, the agents' sql_query tool — reports a failure
  // the same way. Doing it per caller would mean each one gets it right
  // separately, and the raw text ("Scalar Function with name `__postfix does
  // not exist!") reaching a user is what this is for.
  //
  // NOT the SQL workbench or the BI "Ask AI" turn: those execute local
  // datasets in the BROWSER via lib/sqlEngine `runQuery`, which is AlaSQL and
  // never reaches this file. An earlier version of this comment claimed the
  // workbench came through here; it does not, and the difference is
  // load-bearing — the two engines disagree on window functions. See
  // docs/TESTING.md and `evals/nl2sql/engine-gap.ts`.
  if (duckdbEnabled()) {
    const { runLocalSqlDuckDB } = await import("@/utils/data/duckdb.server");
    try {
      const res = await runLocalSqlDuckDB(safeSql, tables, { rowCap: opts.rowCap });
      return { columns: res.columns, rows: res.rows, engine: "duckdb" };
    } catch (e) {
      throw explainEngineFailure(e, "duckdb");
    }
  }

  try {
    const rows = runAlasql(safeSql, tables, opts.rowCap);
    return {
      columns: rows.length > 0 ? Object.keys(rows[0]) : [],
      rows,
      engine: "alasql",
    };
  } catch (e) {
    throw explainEngineFailure(e, "alasql");
  }
}

/**
 * AlaSQL over a fresh per-call database.
 *
 * A Parquet mirror is useless to AlaSQL, so a caller that supplied one must
 * also have supplied rows — `loadLocalTables` only sets `parquetPath` when
 * DuckDB is the active engine, which keeps that invariant local to one place.
 */
function runAlasql(sql: string, tables: LocalEngineTable[], rowCap?: number): LocalRow[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const alasql = loadAlasql() as any;
  // Prep SQL emits SPLIT_PART and friends, which AlaSQL does not ship.
  // Registering unconditionally is idempotent and means a caller can never
  // forget — the differential harness already caught that mistake once.
  registerPrepFns(alasql);

  const db = new alasql.Database();
  for (const t of tables) {
    db.exec(`CREATE TABLE \`${t.name}\``);
    db.tables[t.name].data = t.rows;
  }
  const out = db.exec(sql) as LocalRow[];
  const all = Array.isArray(out) ? out : [];
  return typeof rowCap === "number" ? all.slice(0, rowCap) : all;
}

// AlaSQL ships a UMD build whose global-object dance breaks inside Vite's SSR
// module runner. Node's own CJS loader sidesteps it, and keeps server boot
// free of the dependency.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let alasqlModule: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadAlasql(): any {
  if (!alasqlModule) {
    alasqlModule = createRequire(import.meta.url)("alasql");
  }
  return alasqlModule;
}
