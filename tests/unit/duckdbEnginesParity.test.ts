// The browser's DuckDB and the server's are the same line, and type a
// query's results alike (R209).
//
// FOUND IN R209, the leftover R197 queued: on the Workbench, one query,
// `SELECT typeof(date_trunc('month', TIMESTAMP '2026-01-15 10:00:00')), …`,
// answered DATE · 2026-01-01 · v1.4.3 on "Local (in-browser)" and
// TIMESTAMP · 2026-01-01 00:00:00 · v1.5.5 on "Lakehouse". The browser ran
// @duckdb/duckdb-wasm 1.32.0, which bundles DuckDB 1.4.3, and the server
// @duckdb/node-api 1.5.5. The type a column comes back as decides how the
// charts read it (R197), so the same chart drew two axes.
//
// This runs the wasm build the browser loads (its Node build, the same
// engine) beside the server's, and holds them to one minor version and to
// the same result types.
import path from "node:path";
import { createRequire } from "node:module";

import { DuckDBInstance } from "@duckdb/node-api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

type WasmConn = {
  query: (sql: string) => { toArray: () => { toJSON: () => Record<string, unknown> }[] };
  close: () => void;
};

let wasm: WasmConn;
let server: Awaited<ReturnType<DuckDBInstance["connect"]>>;

beforeAll(async () => {
  const entry = require.resolve("@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs");
  const dist = path.dirname(entry);
  const duckdb = require(entry);
  const db = await duckdb.createDuckDB(
    {
      mvp: {
        mainModule: path.join(dist, "duckdb-mvp.wasm"),
        mainWorker: path.join(dist, "duckdb-node-mvp.worker.cjs"),
      },
      eh: {
        mainModule: path.join(dist, "duckdb-eh.wasm"),
        mainWorker: path.join(dist, "duckdb-node-eh.worker.cjs"),
      },
    },
    new duckdb.VoidLogger(),
    duckdb.NODE_RUNTIME,
  );
  await db.instantiate(() => {});
  wasm = db.connect();
  server = await (await DuckDBInstance.create(":memory:")).connect();
}, 120_000);

afterAll(() => {
  wasm?.close();
  server?.closeSync();
});

async function both(sql: string): Promise<[Record<string, unknown>, Record<string, unknown>]> {
  const a = wasm.query(sql).toArray()[0].toJSON();
  const b = (await server.runAndReadAll(sql)).getRowObjectsJson()[0] as Record<string, unknown>;
  return [a, b];
}

// The first time-zone query loads its data in the wasm engine (about 4 s
// alone), so a loaded suite gets room.
describe("the browser's DuckDB and the server's", { timeout: 60_000 }, () => {
  it("are the same minor version", async () => {
    const [a, b] = await both("SELECT version() AS v");
    const minor = (v: unknown) => String(v).split(".").slice(0, 2).join(".");
    expect(minor(a.v)).toBe(minor(b.v));
  });

  it.each([
    "date_trunc('month', TIMESTAMP '2026-01-15 10:00:00')",
    "date_trunc('year', DATE '2026-05-05')",
    "date_trunc('day', TIMESTAMPTZ '2026-01-15 10:00:00+00')",
    "DATE '2026-01-15' + INTERVAL 1 MONTH",
    "DATE '2026-01-15' - DATE '2026-01-01'",
    "1 / 2",
    "7 // 2",
    "round(2.675, 2)",
    "sum(x) FROM (VALUES (1), (2)) v(x)",
    "avg(x) FROM (VALUES (1), (2)) v(x)",
    "strftime(TIMESTAMP '2026-01-15 10:00:00', '%Y-%m')",
  ])("type %s alike", async (expr) => {
    const [a, b] = await both(
      `SELECT typeof(${expr.split(" FROM ")[0]}) AS t${expr.includes(" FROM ") ? ` FROM ${expr.split(" FROM ")[1]}` : ""}`,
    );
    expect(a.t).toBe(b.t);
  });
});
