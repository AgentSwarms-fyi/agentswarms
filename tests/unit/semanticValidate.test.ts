// Semantic-model validation: the dialect it compiles for, and how often it
// loads the data.
//
// BOTH BUGS HERE WERE FOUND BY CLICKING THE VALIDATE BUTTON, not by reading.
// Neither is visible to a type checker and neither had a test.
//
// 1. WRONG DIALECT. `dialect` is initialised to "alasql" and the WAREHOUSE
//    branch overwrites it. The local branch never did — so once the local
//    engine became DuckDB, every local model was compiled as AlaSQL and run on
//    DuckDB. All 23 fields of the sample model failed with parser errors like
//
//        SELECT 'Order ID' AS 'order_id' FROM saas_sales LIMIT 1
//
//    where AlaSQL's quoting turns a column name into a string literal and the
//    alias into a syntax error. Validation was broken for EVERY local semantic
//    model from the moment the engine changed. The query path
//    (semantic/query.server) resolved this correctly all along; only
//    validation was left behind — the same one-path-updated-not-the-other
//    shape as the warehouse read-only guard and the PII mirror.
//
// 2. RELOADING PER PROBE. Validation runs one query per dimension and per
//    metric, sequentially, and each went through runLocalSqlForUser — which
//    reloads every dataset the caller can see, every row, on every call. A
//    19-field model meant nineteen full reloads. In the browser the button
//    simply never came back.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const validateSrc = readFileSync("src/utils/semantic.functions.ts", "utf8");
const querySrc = readFileSync("src/utils/semantic/query.server.ts", "utf8");
const refreshSrc = readFileSync("src/utils/bi/refresh.server.ts", "utf8");

/** Source with comments stripped — assertions must read code, not prose. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("validation compiles for the engine that will run the SQL", () => {
  it("resolves the local dialect instead of leaving it at the default", () => {
    // The default is "alasql"; the local branch must override it.
    expect(code(validateSrc), "the local branch does not resolve a dialect").toMatch(
      /dialect = await localEngineName\(\)/,
    );
  });

  it("agrees with the query path, which had it right", () => {
    // Both must derive the local dialect from the same helper. Two paths that
    // answer "which engine is this?" differently is how this broke.
    for (const [name, src] of [
      ["validate", validateSrc],
      ["query", querySrc],
    ] as const) {
      expect(code(src), `${name} does not use localEngineName`).toMatch(/localEngineName/);
    }
  });

  it("still lets a warehouse model use its own provider dialect", () => {
    // The fix must not flatten warehouses to the local engine.
    expect(code(validateSrc)).toMatch(/dialect = conn\.config\.provider as SqlDialect/);
  });
});

describe("validation loads the caller's datasets once, not per field", () => {
  it("uses the batching runner", () => {
    expect(code(validateSrc), "validate still reloads per probe").toMatch(
      /localSqlRunnerForUser\(userId\)/,
    );
  });

  it("does not call the per-query loader in the probe path", () => {
    // runLocalSqlForUser is correct for ONE query and quadratic for a batch.
    expect(code(validateSrc)).not.toMatch(/runLocalSqlForUser/);
  });

  it("the runner loads tables outside the returned closure", () => {
    // If the load moved inside, the batching would silently be undone and
    // every test above would still pass.
    const fn = refreshSrc.slice(
      refreshSrc.indexOf("export async function localSqlRunnerForUser"),
      refreshSrc.indexOf("async function runLocalSqlOnTables"),
    );
    expect(fn).toMatch(/const tables = await loadLocalTables\(userId\);/);
    // The returned function must reference the captured tables, not reload.
    expect(fn).toMatch(/return \(sql: string\) => runLocalSqlOnTables\(sql, tables\)/);
    expect(fn.slice(fn.indexOf("return (sql"))).not.toMatch(/loadLocalTables/);
  });

  it("still re-checks the read-only guard on every statement", () => {
    // The tables are reusable; the guard is not. Each SQL string is
    // separately untrusted, so hoisting it out with the load would be a hole.
    const exec = refreshSrc.slice(refreshSrc.indexOf("async function runLocalSqlOnTables"));
    expect(exec).toMatch(/assertLocalReadOnlySql\(sql\)/);
  });
});
