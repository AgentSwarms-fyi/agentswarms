// R458: a materialized view refreshes only what changed, against a real
// DuckLake catalog (an in-memory DuckDB with a scratch file catalog attached as
// `lake`, as the app attaches its own), so what is asserted is what the engine
// did. Only the app's own database, the audit log and Sheets are stood in for.
//
// Every refresh is checked against the view's own query run fresh: an
// incremental refresh that is faster but wrong would be worse than none.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/utils/sheets/owned.server", () => ({ sheetOwnedRefusal: async () => null }));
vi.mock("@/utils/audit.server", () => ({ auditEvent: () => {} }));
vi.mock("@/integrations/supabase/client.server", () => {
  const chain: Record<string, unknown> = {};
  Object.assign(chain, {
    select: () => chain,
    eq: () => chain,
    update: () => chain,
    then: (ok: (v: unknown) => unknown) => ok({ data: null, error: null }),
  });
  return { supabaseAdmin: { from: () => chain } };
});

const db = vi.hoisted(() => ({ instance: null as unknown as DuckDBInstance }));
vi.mock("@/utils/lakehouse/core.server", () => ({
  accessibleSchemas: async () => [
    { name: "s", user_id: "owner", lake_source_id: null, iceberg_catalog_id: null },
  ],
  classifyStatement: () => ({ kind: "select" }),
  // The owner reads their own tables: no policy, the SQL passes through.
  governSelect: async (_c: unknown, _uid: string, sql: string) => ({ sql, policyTables: [] }),
  lakehouseEnabled: () => true,
  lakehouseTableExists: async () => false,
  stripSqlComments: (s: string) => s,
  lakehouseConnection: async () => {
    const c = await db.instance.connect();
    await c.run("USE lake");
    return c;
  },
}));

const { refreshMaterializedView } = await import("@/utils/lakehouse/matviews.server");

let dir = "";
let c: DuckDBConnection;
const rows = async (sql: string) => (await c.runAndReadAll(sql)).getRowsJson();
const snapshots = async () => Number((await rows("SELECT count(*) FROM lake.snapshots()"))[0]![0]);

function view(id: string, table: string, sql: string) {
  return {
    id,
    user_id: "owner",
    schema_name: "s",
    table_name: table,
    sql,
    schedule: "manual" as const,
    is_active: true,
    next_run_at: null,
    last_refreshed_at: null,
    last_status: null,
    last_error: null,
    last_duration_ms: null,
    last_row_count: null,
  };
}

/** Refresh, then check the table holds exactly what the query answers now. */
async function refresh(v: ReturnType<typeof view>, full = false) {
  const res = await refreshMaterializedView(v, "test", { full });
  expect(res.error).toBeUndefined();
  const held = await rows(`SELECT * FROM s.${v.table_name} ORDER BY ALL`);
  const fresh = await rows(`SELECT * FROM (${v.sql}) ORDER BY ALL`);
  expect(held).toEqual(fresh);
  return res;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "mv-incr-")).replace(/\\/g, "/");
  db.instance = await DuckDBInstance.create(":memory:");
  c = await db.instance.connect();
  await c.run(
    `LOAD ducklake; ATTACH 'ducklake:${dir}/cat.ducklake' AS lake (DATA_PATH '${dir}/data/', DATA_INLINING_ROW_LIMIT 10); USE lake;`,
  );
  await c.run("CREATE SCHEMA s");
  await c.run("CREATE TABLE s.orders (id INT, region VARCHAR, amount DECIMAL(10,2))");
  await c.run(
    "INSERT INTO s.orders SELECT i, ['eu','us','apac'][i % 3 + 1], i * 1.5 FROM range(1, 101) r(i)",
  );
  await c.run("CREATE TABLE s.regions (region VARCHAR, manager VARCHAR)");
  await c.run("INSERT INTO s.regions VALUES ('eu', 'Ana'), ('us', 'Bo'), ('apac', 'Cy')");
}, 60_000);

afterAll(() => {
  c?.closeSync();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe("a filtered view over one table", () => {
  const v = view(
    "11111111-1111-1111-1111-111111111111",
    "big_eu",
    "SELECT o.id, upper(o.region) AS region, o.amount FROM s.orders AS o WHERE o.region = 'eu' AND o.amount > 10",
  );

  it("is built the first time", async () => {
    const res = await refresh(v);
    expect(res.mode).toBe("rebuild");
    expect(res.why).toBe("this is its first tracked refresh");
  });

  it("is left as it is when nothing it reads changed, and writes no snapshot", async () => {
    const before = await snapshots();
    const res = await refresh(v);
    expect(res.mode).toBe("skip");
    expect(await snapshots()).toBe(before);
  });

  it("appends only the new rows when its table only gained rows", async () => {
    // Large enough to land in files, then small enough to be inlined.
    await c.run("INSERT INTO s.orders SELECT i, 'eu', 99 FROM range(101, 131) r(i)");
    await c.run("INSERT INTO s.orders VALUES (131, 'eu', 50), (132, 'us', 50)");
    const res = await refresh(v);
    expect(res.mode).toBe("append");
    expect(res.appended).toBe(31);
  });

  it("is still current after the maintenance pass flushes and compacts", async () => {
    await c.run("CALL ducklake_flush_inlined_data('lake')");
    await c.run("CALL ducklake_merge_adjacent_files('lake')");
    expect((await refresh(v)).mode).toBe("skip");
  });

  it("is rebuilt when a row it read was changed or removed", async () => {
    await c.run("UPDATE s.orders SET amount = 1 WHERE id = 4");
    const res = await refresh(v);
    expect(res.mode).toBe("rebuild");
    expect(res.why).toMatch(/had rows changed or removed/);
    await c.run("DELETE FROM s.orders WHERE id = 7");
    expect((await refresh(v)).mode).toBe("rebuild");
    // And appends again afterwards, from the new floor.
    await c.run("INSERT INTO s.orders VALUES (200, 'eu', 77)");
    expect((await refresh(v)).mode).toBe("append");
  });

  it("is rebuilt when someone wrote its table, rather than trusting it", async () => {
    await c.run("INSERT INTO s.big_eu VALUES (-1, 'NOT MINE', 0)");
    const res = await refresh(v);
    expect(res.mode).toBe("rebuild");
    expect(res.why).toMatch(/its table was written/);
  });

  it("is rebuilt when its definition changes, and when a full rebuild is asked for", async () => {
    const changed = { ...v, sql: v.sql.replace("> 10", "> 20") };
    expect((await refresh(changed)).why).toMatch(/query or a policy/);
    expect((await refresh(changed, true)).mode).toBe("rebuild");
    expect((await refresh(changed)).mode).toBe("skip");
  });
});

describe("a view whose literals are past what a double holds", () => {
  it("appends against the exact number, not its rounding", async () => {
    // 9007199254740993 rounds to ...992 as a double: printed back from a
    // rounded tree, the appended rows would be the wrong ones.
    await c.run("CREATE TABLE s.bigs (k BIGINT, note VARCHAR)");
    await c.run(
      "INSERT INTO s.bigs VALUES (9007199254740993, 'mine'), (9007199254740992, 'not mine')",
    );
    const v = view(
      "77777777-7777-7777-7777-777777777777",
      "exact",
      "SELECT k, note FROM s.bigs WHERE k = 9007199254740993",
    );
    await refresh(v);
    await c.run(
      "INSERT INTO s.bigs VALUES (9007199254740993, 'mine too'), (9007199254740992, 'nope')",
    );
    const res = await refresh(v);
    expect(res.mode).toBe("append");
    expect(res.appended).toBe(1);
    expect(await rows("SELECT note FROM s.exact ORDER BY note")).toEqual([["mine"], ["mine too"]]);
  });
});

describe("a view that aggregates or joins", () => {
  const agg = view(
    "22222222-2222-2222-2222-222222222222",
    "by_region",
    "SELECT region, count(*) AS n, sum(amount) AS total FROM s.orders GROUP BY region",
  );
  const joined = view(
    "33333333-3333-3333-3333-333333333333",
    "with_manager",
    "SELECT o.id, r.manager FROM s.orders o JOIN s.regions r USING (region)",
  );

  it("is rebuilt when its table gains rows, since old groups change", async () => {
    await refresh(agg);
    expect((await refresh(agg)).mode).toBe("skip");
    await c.run("INSERT INTO s.orders VALUES (300, 'us', 10)");
    const res = await refresh(agg);
    expect(res.mode).toBe("rebuild");
    expect(res.why).toMatch(/rows cannot be appended: it groups/);
  });

  it("is left as it is when neither joined table changed, and rebuilt when one did", async () => {
    await refresh(joined);
    expect((await refresh(joined)).mode).toBe("skip");
    await c.run("UPDATE s.regions SET manager = 'Dee' WHERE region = 'us'");
    expect((await refresh(joined)).mode).toBe("rebuild");
  });
});

describe("a view whose answer can change by itself", () => {
  it("is rebuilt every time when it calls now() or random()", async () => {
    for (const [id, sql] of [
      [
        "44444444-4444-4444-4444-444444444444",
        "SELECT id FROM s.orders WHERE now() > TIMESTAMP '2000-01-01'",
      ],
      ["55555555-5555-5555-5555-555555555555", "SELECT id, random() < 2 AS r FROM s.orders"],
    ]) {
      const v = view(id!, `vol_${id!.slice(0, 4)}`, sql!);
      await refresh(v);
      const res = await refresh(v);
      expect(res.mode).toBe("rebuild");
      expect(res.why).toMatch(/whose answer can change between runs/);
    }
  });

  it("is rebuilt every time when it reads a table function", async () => {
    const v = view("66666666-6666-6666-6666-666666666666", "ranged", "SELECT * FROM range(3) t(i)");
    await refresh(v);
    const res = await refresh(v);
    expect(res.mode).toBe("rebuild");
    expect(res.why).toMatch(/range\(\)/);
  });
});
