// A browser query waits for the loads in flight (R210).
//
// FOUND IN R210, smoking the real image 5330adc25b2f: the Workbench's first
// `SELECT count(*) FROM saas_sales` answered 6000 while the explorer said
// 9,994 rows (and 9994 a minute later): 12 of the 20 batches of 500 that fill
// the table were in. Run earlier still, the query said the table did not
// exist. A table is filled with an await between batches, and a query could
// come in between.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { heldLoads, holdQueriesUntil, waitForLoads } from "@/lib/queryGate";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("waitForLoads", () => {
  it("lets a query read only a table filled to the end", async () => {
    const table: number[] = [];
    // 20 batches of 500, an await between each, as materialise does.
    const fill = (async () => {
      for (let b = 0; b < 20; b++) {
        for (let i = 0; i < 500; i++) table.push(i);
        await tick();
      }
    })();
    holdQueriesUntil(fill);
    await tick();
    await tick();
    // Without the gate this is what a query saw: part of the table.
    expect(table.length).toBeGreaterThan(0);
    expect(table.length).toBeLessThan(10_000);
    await waitForLoads();
    expect(table.length).toBe(10_000);
    expect(heldLoads()).toBe(0);
  });

  it("is released by a load that fails, so a query does not wait for ever", async () => {
    const failing = Promise.reject(new Error("rows could not be read"));
    failing.catch(() => undefined);
    holdQueriesUntil(failing);
    await expect(waitForLoads()).resolves.toBeUndefined();
    expect(heldLoads()).toBe(0);
  });

  it("returns at once when nothing is loading", async () => {
    expect(heldLoads()).toBe(0);
    await expect(waitForLoads()).resolves.toBeUndefined();
  });
});

describe("the engine", () => {
  const engine = readFileSync("src/lib/browserDuckdb.ts", "utf8");
  const sqlEngine = readFileSync("src/lib/sqlEngine.ts", "utf8");

  it("waits for loads before every query", () => {
    const run = engine.slice(engine.indexOf("export async function runBrowserSql"));
    expect(run.indexOf("await waitForLoads();")).toBeGreaterThan(0);
    expect(run.indexOf("await waitForLoads();")).toBeLessThan(run.indexOf("conn.query(safe)"));
  });

  it("holds queries for each table load and for the whole hydration", () => {
    const reg = engine.slice(engine.indexOf("export function registerBrowserTables"));
    expect(reg.slice(0, reg.indexOf("return load;"))).toContain("holdQueriesUntil(load);");
    expect(sqlEngine).toMatch(
      /hydrationInFlight = hydrateFromSupabaseUncoordinated\(\)[\s\S]*?holdQueriesUntil\(hydrationInFlight\);\s*return hydrationInFlight;/,
    );
  });
});
