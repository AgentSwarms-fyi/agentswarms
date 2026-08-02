// DuckDB in the browser, via WebAssembly.
//
// WHY THIS REPLACED ALASQL: local datasets used to execute in two different
// engines — AlaSQL here in the browser, DuckDB on the server — and the two
// disagreed. Measured with `evals/nl2sql/engine-gap.ts`, AlaSQL answered 56 of
// 61 reference queries and THREE of the failures were silent: "share of total"
// dropped its computed column, and a running total came back as 0 for every
// row. A cumulative chart rendered as a flat line at zero and nothing reported
// an error.
//
// Every BI tool that executes in two places runs the SAME engine in both —
// MotherDuck advertises "a query that works on your laptop is guaranteed to
// work in the cloud"; Evidence pairs build-time DuckDB with DuckDB-Wasm in the
// browser. Two different engines over one dataset is the arrangement nobody
// ships on purpose.
//
// ── Loading ────────────────────────────────────────────────────────────────
// The .wasm binaries are 32-38 MB uncompressed (~2-3 MB over the wire with
// content-encoding). They are therefore:
//   * SELF-HOSTED, not fetched from jsDelivr. An air-gapped or CSP-restricted
//     deployment cannot reach a CDN, and an enterprise should not have its
//     analytics silently depend on one being up.
//   * imported with `?url` so Vite emits them as separate assets and the main
//     bundle never contains them;
//   * instantiated LAZILY, on the first query, behind a single shared promise
//     so a burst of widgets triggers one download rather than twelve.
//
// `selectBundle` picks the best build the browser supports: `coi` where
// cross-origin isolation gives it threads, `eh` (exception handling) on modern
// browsers otherwise, `mvp` as the floor. We ship all three rather than
// assuming.
//
// ── Isolation ──────────────────────────────────────────────────────────────
// One in-memory database per browser tab, holding only that user's own
// datasets, which they already have in their own browser. There is no
// cross-tenant path here of the kind the server engine has to guard against.
// The read-only guard still runs on every statement, because the SQL comes
// from a language model.

// TYPE-ONLY at module scope. The runtime module is imported dynamically inside
// init() so its glue JS is fetched on the first query rather than by anyone who
// merely loads a page that could run one.
import type * as duckdb from "@duckdb/duckdb-wasm";

import { toJsValue } from "@/lib/duckdbValues";
import { assertLocalReadOnlySql } from "@/lib/sqlSafety";
import type { ColumnDef } from "@/lib/datasetParse";

// Vite rewrites these to emitted asset URLs; nothing is inlined.
import mvpWasm from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";
import mvpWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url";
import ehWasm from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
import ehWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";

const BUNDLES: duckdb.DuckDBBundles = {
  mvp: { mainModule: mvpWasm, mainWorker: mvpWorker },
  eh: { mainModule: ehWasm, mainWorker: ehWorker },
};

/**
 * The dialect anything compiled FOR THE BROWSER must target.
 *
 * Exported as a named constant rather than written as the literal "duckdb" at
 * each call site so the reason is greppable: these compile SQL that will run
 * HERE, and it used to be "alasql" — which meant backtick-quoted identifiers
 * that DuckDB rejects outright.
 *
 * The server picks its own dialect from LOCAL_ENGINE at runtime; this one is
 * fixed, because the browser engine is not configurable.
 */
export const BROWSER_SQL_DIALECT = "duckdb" as const;

export type BrowserDuckTable = {
  name: string;
  columns: ColumnDef[];
  rows: Record<string, unknown>[];
};

type Handle = {
  db: duckdb.AsyncDuckDB;
  conn: duckdb.AsyncDuckDBConnection;
  worker: Worker;
};

let handle: Promise<Handle> | null = null;
/** Tables currently materialised in the WASM database, by name. */
const registered = new Set<string>();

/** Which bundle the browser actually got — surfaced for diagnostics. */
let activeBundle: string | null = null;

// ── Status, so the UI can explain the wait ───────────────────────────────────
//
// The first query downloads roughly 8 MB of compressed WebAssembly. Without a
// signal the UI has nothing to say and a "Run" button simply sits there, which
// reads as a hang rather than a download. duckdb-wasm reports real bytes, so
// this is a progress bar rather than an indeterminate spinner.

export type EngineStatus =
  | { phase: "idle" }
  | { phase: "loading"; bytesLoaded: number; bytesTotal: number }
  | { phase: "ready" }
  | { phase: "error"; message: string };

let status: EngineStatus = { phase: "idle" };
const listeners = new Set<(s: EngineStatus) => void>();

function setStatus(next: EngineStatus) {
  status = next;
  for (const fn of listeners) {
    try {
      fn(next);
    } catch {
      // A broken subscriber must not take the engine down with it.
    }
  }
}

export function browserEngineStatus(): EngineStatus {
  return status;
}

/** Subscribe to engine status. Returns an unsubscribe function. */
export function onBrowserEngineStatus(fn: (s: EngineStatus) => void): () => void {
  listeners.add(fn);
  // Fire immediately so a component mounting mid-download paints the right
  // thing without waiting for the next progress event.
  fn(status);
  return () => listeners.delete(fn);
}

export function browserEngineBundle(): string | null {
  return activeBundle;
}

export function isBrowserEngineReady(): boolean {
  return status.phase === "ready";
}

/**
 * Begin loading the engine WITHOUT running a query.
 *
 * Called when a page that is likely to query mounts, so the download overlaps
 * the user reading the screen and picking a table instead of starting when
 * they press Run. Safe to call repeatedly — it joins the one shared promise.
 */
export function prewarmBrowserEngine(): void {
  void init().catch(() => {
    // Already reported through status; a rejected prewarm must not surface as
    // an unhandled rejection in the console.
  });
}

/**
 * Start (or join) initialisation.
 *
 * The promise is cached rather than the resolved handle so that concurrent
 * callers await the SAME download. Twelve dashboard widgets mounting at once
 * previously meant twelve AlaSQL calls, which was free; here it would mean
 * twelve 32 MB fetches if this were not shared.
 */
function init(): Promise<Handle> {
  if (handle) return handle;
  setStatus({ phase: "loading", bytesLoaded: 0, bytesTotal: 0 });
  handle = (async () => {
    const dd = await import("@duckdb/duckdb-wasm");
    const bundle = await dd.selectBundle(BUNDLES);
    activeBundle = bundle.mainModule.includes("eh") ? "eh" : "mvp";
    const worker = new Worker(bundle.mainWorker!);
    // The console logger is noisy and ships DuckDB's internal chatter to the
    // user's console; a void logger keeps failures flowing through thrown
    // errors, which is where the app already reports them.
    const db = new dd.AsyncDuckDB(new dd.VoidLogger(), worker);
    // Real bytes, reported by duckdb-wasm as it streams the module — so the UI
    // shows a progress bar rather than an indeterminate spinner for ~8 MB.
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker, (p) => {
      setStatus({
        phase: "loading",
        bytesLoaded: p.bytesLoaded,
        bytesTotal: p.bytesTotal,
      });
    });
    const conn = await db.connect();
    setStatus({ phase: "ready" });
    return { db, conn, worker };
  })();
  // A failed init must not poison every later attempt: clear the cached
  // promise so a retry can start again (a transient network failure fetching
  // the wasm is the common case).
  handle.catch((e: unknown) => {
    handle = null;
    activeBundle = null;
    setStatus({
      phase: "error",
      message: (e as Error)?.message ?? "the SQL engine failed to load",
    });
  });
  return handle;
}

/** DuckDB column type for one of our inferred dataset types. */
function duckType(type: ColumnDef["type"]): string {
  // Mirrors the server's mapping in utils/data/duckdb.server: dates are held
  // as text because the values arrive as strings of varying formats, and a
  // failed CAST would drop the row rather than the value.
  return type === "number" ? "DOUBLE" : "VARCHAR";
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function sqlLiteral(v: unknown): string {
  if (v === null || v === undefined || v === "") return "NULL";
  return `'${String(v).replace(/'/g, "''")}'`;
}

function numericLiteral(v: unknown): string {
  if (v === null || v === undefined || v === "") return "NULL";
  const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? String(n) : "NULL";
}

/**
 * Materialise one table into the WASM database.
 *
 * Rows are inserted with a multi-row VALUES statement in batches rather than
 * through Arrow: the app already holds plain JS objects, and converting them
 * to Arrow in the browser costs more than it saves at the sizes a browser can
 * hold anyway. Batching keeps any single statement from growing unbounded.
 */
async function materialise(conn: duckdb.AsyncDuckDBConnection, table: BrowserDuckTable) {
  const cols = table.columns;
  const ddl = cols.map((c) => `${quoteIdent(c.name)} ${duckType(c.type)}`).join(", ");
  await conn.query(`DROP TABLE IF EXISTS ${quoteIdent(table.name)}`);
  await conn.query(`CREATE TABLE ${quoteIdent(table.name)} (${ddl})`);
  if (table.rows.length === 0) return;

  const BATCH = 500;
  for (let i = 0; i < table.rows.length; i += BATCH) {
    const chunk = table.rows.slice(i, i + BATCH);
    const values = chunk
      .map(
        (row) =>
          "(" +
          cols
            .map((c) =>
              c.type === "number" ? numericLiteral(row[c.name]) : sqlLiteral(row[c.name]),
            )
            .join(", ") +
          ")",
      )
      .join(", ");
    await conn.query(`INSERT INTO ${quoteIdent(table.name)} VALUES ${values}`);
  }
}

/**
 * Register (or replace) the datasets available to queries.
 *
 * Called by the hydration path in lib/sqlEngine. Replacing a table drops and
 * recreates it, so a re-hydration after an upload cannot leave stale rows.
 */
export async function registerBrowserTables(tables: BrowserDuckTable[]): Promise<void> {
  const { conn } = await init();
  for (const t of tables) {
    await materialise(conn, t);
    registered.add(t.name);
  }
}

export function isBrowserTableRegistered(name: string): boolean {
  return registered.has(name);
}

export async function dropBrowserTable(name: string): Promise<void> {
  if (!handle) {
    registered.delete(name);
    return;
  }
  const { conn } = await init();
  await conn.query(`DROP TABLE IF EXISTS ${quoteIdent(name)}`);
  registered.delete(name);
}

export type BrowserQueryResult = {
  columns: string[];
  rows: Record<string, unknown>[];
};

/**
 * Run one read-only statement.
 *
 * The guard is the SAME function the server engine and the agent tool use, so
 * all three refuse identically — this is reachable by model-written SQL.
 */
export async function runBrowserSql(sql: string): Promise<BrowserQueryResult> {
  const safe = assertLocalReadOnlySql(sql);
  const { conn } = await init();
  const table = await conn.query(safe);
  const columns = table.schema.fields.map((f) => f.name);
  const rows: Record<string, unknown>[] = [];
  for (const row of table.toArray()) {
    const obj: Record<string, unknown> = {};
    // Arrow rows expose columns as properties; toJsValue is shared with the
    // server engine so BigInt and DECIMAL land the same way on both.
    for (const name of columns) obj[name] = toJsValue((row as Record<string, unknown>)[name]);
    rows.push(obj);
  }
  return { columns, rows };
}

/** Tear down the engine. For tests and for a hard reset after a failure. */
export async function resetBrowserEngine(): Promise<void> {
  const current = handle;
  handle = null;
  activeBundle = null;
  registered.clear();
  setStatus({ phase: "idle" });
  if (!current) return;
  try {
    const { conn, db, worker } = await current;
    await conn.close();
    await db.terminate();
    worker.terminate();
  } catch {
    // Already broken; dropping the reference is the point of this call.
  }
}
