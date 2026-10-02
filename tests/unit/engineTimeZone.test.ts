// Every DuckDB engine in the app runs in one time zone (R195).
//
// FOUND IN R195, sweep 4 ("two surfaces, two answers"). In the Data Catalog
// Workbench, one query run on the two engines the editor offers —
//   SELECT current_setting('TimeZone'), current_date,
//          CAST(TIMESTAMPTZ '2026-09-30 22:30:00+00' AS DATE), DATE '2026-09-30'
// — answered "Etc/GMT-4 | 2026-10-01 | 2026-10-01 | 2026-09-30" on "Local
// (in-browser)" and "Etc/UTC | 2026-09-30 | 2026-09-30 | 2026-09-30" on the
// lakehouse, at 01:40 in a UTC+4 browser. The browser engine had taken the
// viewer's zone and the server engines the container's; a scheduled refresh
// or an agent's sql_query over the same data landed on another day.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";

import { ENGINE_TIME_ZONE } from "@/lib/duckdbValues";

let runLocalSqlDuckDB: typeof import("@/utils/data/duckdb.server").runLocalSqlDuckDB;

beforeAll(async () => {
  // A zone that is not UTC, set before the engine exists, as a host's would
  // be: the engine must not inherit it.
  process.env.TZ = "Asia/Dubai";
  runLocalSqlDuckDB = (await import("@/utils/data/duckdb.server")).runLocalSqlDuckDB;
}, 60_000);

describe("the zone", () => {
  it("is UTC, one constant for every engine", () => {
    expect(ENGINE_TIME_ZONE).toBe("UTC");
  });
});

describe("the server's local-dataset engine", () => {
  it("runs in UTC whatever the host's zone, so a day is the same day everywhere", async () => {
    const r = await runLocalSqlDuckDB(
      "SELECT current_setting('TimeZone') AS tz, " +
        "CAST(TIMESTAMPTZ '2026-09-30 22:30:00+00' AS DATE) AS d, " +
        "strftime(TIMESTAMPTZ '2026-09-30 22:30:00+00', '%Y-%m-%d %H:%M') AS t",
      [],
    );
    expect(r.rows[0]).toEqual({ tz: "UTC", d: "2026-09-30", t: "2026-09-30 22:30" });
  }, 60_000);
});

describe("the browser engine", () => {
  const SRC = readFileSync("src/lib/browserDuckdb.ts", "utf8");

  it("sets the zone on its connection before it says it is ready", () => {
    const init = SRC.slice(SRC.indexOf("function init()"), SRC.indexOf("function duckType("));
    const set = init.indexOf("await conn.query(`SET TimeZone = '${ENGINE_TIME_ZONE}'`)");
    expect(set).toBeGreaterThan(0);
    expect(init.indexOf('setStatus({ phase: "ready" })')).toBeGreaterThan(set);
  });
});

describe("the lakehouse engine", () => {
  const SRC = readFileSync("src/utils/lakehouse/core.server.ts", "utf8");

  it("sets the zone for the whole instance", () => {
    expect(SRC).toContain("await c.run(`SET GLOBAL TimeZone='${ENGINE_TIME_ZONE}'`)");
  });
});
