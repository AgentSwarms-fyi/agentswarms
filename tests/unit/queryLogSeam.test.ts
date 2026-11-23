// Every warehouse query passes executeWarehouseQuery; that is where it is
// recorded (R531), with what the engine itself said about it. Driven here
// through the real seam and drivers, with only the network faked.
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { QueryRun } from "@/lib/queryLog";

const recorded: QueryRun[] = [];
vi.mock("@/utils/queryLog/record.server", async () => {
  const lib = await import("@/lib/queryLog");
  return {
    recordQueryRun: (r: QueryRun) => recorded.push(r),
    scanCostHere: (engine: string, bytes: number | null | undefined) =>
      lib.estimateScanCost(engine, bytes),
  };
});

/** The answers the fake network gives, by request. */
let answer: (url: string, init: RequestInit) => unknown;
vi.mock("@/utils/http/connectorFetch.server", () => ({
  connectorFetch: vi.fn(async (url: string, init: RequestInit = {}) => {
    const body = answer(url, init);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
}));
vi.mock("@/utils/warehouse/network.server", async (orig) => ({
  ...(await orig<typeof import("@/utils/warehouse/network.server")>()),
  assertWarehouseNetwork: vi.fn(async () => {}),
}));
const lakehouseRuns: { userId: string; opts: Record<string, unknown> }[] = [];
vi.mock("@/utils/lakehouse/core.server", () => ({
  runLakehouseStatement: vi.fn(
    async (userId: string, _sql: string, opts: Record<string, unknown>) => {
      lakehouseRuns.push({ userId, opts });
      return {
        columns: [{ name: "n", type: "INTEGER" }],
        rows: [[1]],
        row_count: 1,
        truncated: false,
      };
    },
  ),
}));

const { executeWarehouseQuery } = await import("@/utils/warehouse/drivers.server");
type Cfg = Parameters<typeof executeWarehouseQuery>[0];

const TRINO = { provider: "trino", host: "trino.example.test", username: "analyst" } as Cfg;
const ATHENA = {
  provider: "athena",
  region: "us-east-1",
  access_key_id: "test-key",
  secret_access_key: "test-secret",
  output_location: "s3://results/",
} as Cfg;

beforeEach(() => {
  recorded.length = 0;
  lakehouseRuns.length = 0;
});

describe("a warehouse query is recorded where it passes", () => {
  it("with what it was for, whose it was, and what Trino said it read", async () => {
    answer = () => ({
      id: "20261124_q1",
      columns: [{ name: "n", type: "integer" }],
      data: [[1], [2]],
      stats: { state: "FINISHED", processedBytes: 2048 },
    });
    const res = await executeWarehouseQuery(TRINO, "SELECT n FROM t", 10, {
      userId: "owner",
      log: { via: "dashboard", connection: { id: "c1", name: "Sales" }, actorUserId: "viewer" },
    });
    expect(res.row_count).toBe(2);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      userId: "owner",
      actorUserId: "viewer",
      via: "dashboard",
      engine: "trino",
      connectionId: "c1",
      connectionName: "Sales",
      sql: "SELECT n FROM t",
      ok: true,
      rowCount: 2,
      bytesScanned: 2048,
      engineQueryId: "20261124_q1",
    });
    // Trino is not billed by the query: no amount is made up for it.
    expect(recorded[0].costUsd).toBeUndefined();
    expect(recorded[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it("records a query that failed, with why, and still fails it", async () => {
    answer = () => ({ id: "q2", error: { message: "Table 'x' does not exist" } });
    await expect(
      executeWarehouseQuery(TRINO, "SELECT * FROM x", 10, {
        userId: "owner",
        log: { via: "workbench" },
      }),
    ).rejects.toThrow(/does not exist/);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ ok: false, via: "workbench" });
    expect(recorded[0].error).toMatch(/does not exist/);
  });

  it("prices an Athena query from the bytes Athena says it scanned", async () => {
    const GiB = 1024 ** 3;
    answer = (_url, init) => {
      const target = JSON.stringify(init.headers ?? {});
      if (target.includes("StartQueryExecution")) return { QueryExecutionId: "athena-1" };
      if (target.includes("GetQueryExecution")) {
        return {
          QueryExecution: {
            Status: { State: "SUCCEEDED" },
            Statistics: { DataScannedInBytes: 50 * GiB },
          },
        };
      }
      return {
        ResultSet: {
          ResultSetMetadata: { ColumnInfo: [{ Name: "n", Type: "integer" }] },
          Rows: [{ Data: [{ VarCharValue: "n" }] }, { Data: [{ VarCharValue: "7" }] }],
        },
      };
    };
    await executeWarehouseQuery(ATHENA, "SELECT n FROM big", 10, {
      userId: "owner",
      log: { via: "agent", connection: { id: "c2", name: "Lake (Athena)" } },
    });
    expect(recorded[0]).toMatchObject({
      engine: "athena",
      via: "agent",
      bytesScanned: 50 * GiB,
      engineQueryId: "athena-1",
      rowCount: 1,
    });
    // 50 GiB at $5 per TB.
    expect(recorded[0].costUsd).toBeCloseTo((50 / 1024) * 5, 6);
    expect(recorded[0].costBasis).toMatch(/\$5 per TB scanned/);
  });

  it("records nothing for a query with no person attached (a crawl, a connection test)", async () => {
    answer = () => ({ id: "q3", columns: [{ name: "n", type: "integer" }], data: [[1]] });
    await executeWarehouseQuery(TRINO, "SELECT 1", 1);
    expect(recorded).toEqual([]);
  });

  it("leaves a lakehouse query to the lakehouse, telling it what the query was for", async () => {
    const LAKE = { provider: "lakehouse", user_id: "owner" } as Cfg;
    await executeWarehouseQuery(LAKE, "SELECT 1", 1, {
      userId: "owner",
      log: { via: "dashboard", actorUserId: "viewer" },
    });
    // Recorded once, there, where its ai_* cost is known; not twice.
    expect(recorded).toEqual([]);
    expect(lakehouseRuns[0].opts.log).toEqual({ via: "dashboard", actorUserId: "viewer" });
  });
});
