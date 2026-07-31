// Engine adapters for the differential harness.
//
// Each adapter runs the SAME SQL against the SAME rows and returns a
// normalised result. Adding an engine means adding one adapter here — the
// corpus and the comparison logic stay untouched.
//
// Adapters must mirror how production CALLS the engine, not just which engine
// it is: the read-only guard and the prep-function registration below are both
// applied because production applies them. An adapter that tests a
// configuration which does not ship manufactures false alarms — this suite has
// caught itself doing exactly that twice.
import { createRequire } from "node:module";

import { registerPrepFns } from "@/lib/alasqlPrepFns";
import { checkLocalReadOnlySql } from "@/lib/sqlSafety";
import type { LoadedTable, Row } from "@/utils/tools/sql.server";
import { freshTables } from "./fixtures";

// AlaSQL is a UMD bundle that misbehaves under ESM/Vite module runners, which
// is why the server loads it through Node's CJS loader too (see
// utils/bi/refresh.server.ts). Same trick here, for the same reason.
const nodeRequire = createRequire(import.meta.url);

export type EngineResult = { ok: true; rows: Row[] } | { ok: false; error: string };

export type Engine = {
  id: string;
  label: string;
  run: (sql: string, tables: LoadedTable[]) => EngineResult;
};

/** AlaSQL — what the Data & SQL workbench and the server refresh path use. */
export const alasqlEngine: Engine = {
  id: "alasql",
  label: "AlaSQL (workbench + scheduled refresh)",
  run: (sql, tables) => {
    // AlaSQL itself happily executes DDL and DML. Production never calls it
    // without this guard (workbench + refresh path both apply it), so the
    // adapter must too — otherwise the harness would be testing a
    // configuration that does not exist and would report a false alarm.
    const verdict = checkLocalReadOnlySql(sql);
    if (!verdict.ok) return { ok: false, error: verdict.reason };

    try {
      // A fresh Database per call keeps runs isolated from each other.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const alasql = nodeRequire("alasql") as any;
      // Production always registers these before running prep SQL. Skipping
      // them here would report SPLIT_PART as broken when it works in the app.
      registerPrepFns(alasql);
      const db = new alasql.Database();
      for (const t of tables) {
        db.exec(`CREATE TABLE \`${t.name}\``);
        db.tables[t.name].data = t.rows;
      }
      const out = db.exec(sql) as unknown;
      return { ok: true, rows: Array.isArray(out) ? (out as Row[]) : [] };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },
};

export const ENGINES: Engine[] = [alasqlEngine];

/** Run one statement on every synchronous engine, each on its own data copy. */
export function runAll(sql: string): Record<string, EngineResult> {
  const out: Record<string, EngineResult> = {};
  for (const engine of ENGINES) out[engine.id] = engine.run(sql, freshTables());
  return out;
}

// ── DuckDB (candidate) ───────────────────────────────────────────────────
//
// Async, so it sits outside the synchronous ENGINES list rather than
// contorting that interface. It is compared against the incumbents in
// duckdb.test.ts.

export type AsyncEngine = {
  id: string;
  label: string;
  run: (sql: string, tables: LoadedTable[]) => Promise<EngineResult>;
};

export const duckdbEngine: AsyncEngine = {
  id: "duckdb",
  label: "DuckDB (candidate local engine)",
  run: async (sql, tables) => {
    try {
      const { runLocalSqlDuckDB } = await import("@/utils/data/duckdb.server");
      const res = await runLocalSqlDuckDB(sql, tables);
      return { ok: true, rows: res.rows };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },
};

// ── Normalisation ────────────────────────────────────────────────────────
//
// Engines disagree about representation in ways that are not semantic bugs:
// one returns 100 where another returns "100", one omits a null key where
// another includes it. Comparing raw output would drown the real differences
// in noise, so values are canonicalised before comparison — but ONLY in ways
// that preserve meaning. 100 and "100" compare equal; 100 and 101 never do.

export function canonValue(v: unknown): string {
  if (v === null || v === undefined) return "∅";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(6);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "string") {
    const trimmed = v.trim();
    // The empty string is NOT null. This codebase distinguishes them
    // deliberately (quality checks assert it), so collapsing them here would
    // hide exactly the class of difference the harness is for.
    if (trimmed === "") return "‹empty›";
    // A numeric string and the number it denotes mean the same thing to a
    // reader of a chart; treat them as equal so type-affinity differences
    // don't masquerade as wrong answers.
    const n = Number(trimmed);
    if (Number.isFinite(n) && trimmed !== "") {
      return Number.isInteger(n) ? String(n) : n.toFixed(6);
    }
    return trimmed;
  }
  if (v instanceof Date) return v.toISOString();
  return JSON.stringify(v);
}

export function canonRow(row: Row): string {
  // Keys with a NULL value are dropped so "absent key" and "explicit null"
  // compare equal — AlaSQL omits a NULL aggregate entirely while DuckDB
  // returns null for it, and that is a representation difference, not a
  // different answer. A NULL-vs-value difference still shows, because the
  // engine returning a value keeps its key.
  return Object.keys(row)
    .sort()
    .filter((k) => canonValue(row[k]) !== "∅")
    .map((k) => `${k.toLowerCase()}=${canonValue(row[k])}`)
    .join("|");
}

/**
 * Canonical form of a result set.
 *
 * `ordered` must be true only when the query has an ORDER BY — otherwise SQL
 * makes no promise about row order and sorting is the correct comparison.
 * Sorting an ordered query's output would hide a real ordering bug.
 */
export function canonRows(rows: Row[], ordered: boolean): string {
  const canon = rows.map(canonRow);
  return (ordered ? canon : [...canon].sort()).join("\n");
}
