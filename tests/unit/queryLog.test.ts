// The query log's rules (R531): what a query cost, what one row holds, and
// how both read.
import { describe, expect, it } from "vitest";

import {
  DEFAULT_SCAN_PRICES,
  estimateScanCost,
  formatBytes,
  formatMs,
  formatUsd,
  queryLogRow,
  scanPricesFrom,
  viaFromAuditLabel,
  workbenchSourceFor,
} from "@/lib/queryLog";

const MiB = 1024 * 1024;
const TiB = 1024 ** 4;

describe("estimateScanCost", () => {
  it("prices Athena by what it scanned, by the megabyte, with a 10 MB minimum", () => {
    expect(estimateScanCost("athena", TiB)).toEqual({
      usd: 5,
      basis: "Athena at $5 per TB scanned, 10 MB minimum",
    });
    // 1 KB is billed as the 10 MB minimum...
    expect(estimateScanCost("athena", 1024)!.usd).toBeCloseTo((10 * MiB * 5) / TiB, 6);
    // ...10.5 MB as 11 MB...
    expect(estimateScanCost("athena", 10.5 * MiB)!.usd).toBeCloseTo((11 * MiB * 5) / TiB, 6);
    // ...and a query that read nothing costs nothing.
    expect(estimateScanCost("athena", 0)!.usd).toBe(0);
  });

  it("prices BigQuery by the bytes it billed, its minimums already applied", () => {
    expect(estimateScanCost("bigquery", TiB)).toEqual({
      usd: 6.25,
      basis: "BigQuery on demand at $6.25 per TiB billed",
    });
    expect(estimateScanCost("bigquery", 0)!.usd).toBe(0);
  });

  it("puts no price on an engine that does not charge by the query, or did not say", () => {
    expect(estimateScanCost("trino", TiB)).toBeNull();
    expect(estimateScanCost("postgres", TiB)).toBeNull();
    expect(estimateScanCost("athena", null)).toBeNull();
    expect(estimateScanCost("athena", -1)).toBeNull();
  });

  it("uses the server's prices, and list price for anything unset or unusable", () => {
    expect(scanPricesFrom({})).toEqual(DEFAULT_SCAN_PRICES);
    const p = scanPricesFrom({
      QUERY_COST_ATHENA_USD_PER_TB: "4.5",
      QUERY_COST_BIGQUERY_USD_PER_TIB: "not a number",
    });
    expect(p).toEqual({ athenaPerTB: 4.5, bigqueryPerTiB: 6.25 });
    expect(scanPricesFrom({ QUERY_COST_ATHENA_USD_PER_TB: "-1" }).athenaPerTB).toBe(5);
    expect(scanPricesFrom({ QUERY_COST_ATHENA_USD_PER_TB: "" }).athenaPerTB).toBe(5);
    expect(estimateScanCost("athena", TiB, p)).toEqual({
      usd: 4.5,
      basis: "Athena at $4.5 per TB scanned, 10 MB minimum",
    });
  });
});

describe("queryLogRow", () => {
  const base = { userId: "u1", engine: "athena", sql: "SELECT 1", ok: true };

  it("keeps inside every limit the table checks", () => {
    const row = queryLogRow({
      ...base,
      sql: "x".repeat(30_000),
      connectionName: "n".repeat(300),
      engineQueryId: "q".repeat(300),
      ok: false,
      error: "e".repeat(900),
      rowCount: -3,
      durationMs: 12.6,
      costUsd: 0.1234567,
    });
    expect(row.sql).toHaveLength(20_000);
    expect(row.connection_name).toHaveLength(200);
    expect(row.engine_query_id).toHaveLength(200);
    expect(row.error).toHaveLength(500);
    expect(row.row_count).toBeNull();
    expect(row.duration_ms).toBe(13);
    // Every digit kept: a cost below a millionth of a dollar must not round away.
    expect(row.cost_usd).toBe(0.1234567);
    expect(queryLogRow({ ...base, costUsd: 0.0000000463 }).cost_usd).toBe(0.0000000463);
    expect(row.status).toBe("error");
  });

  it("files an unknown purpose as app, and makes any engine name one the table takes", () => {
    expect(queryLogRow({ ...base, via: "something-else" }).via).toBe("app");
    expect(queryLogRow({ ...base, via: undefined }).via).toBe("app");
    expect(queryLogRow({ ...base, via: "dashboard" }).via).toBe("dashboard");
    expect(queryLogRow({ ...base, engine: "Azure-SQL" }).engine).toBe("azure_sql");
    expect(queryLogRow({ ...base, engine: "9lives" }).engine).toBe("lives");
    expect(queryLogRow({ ...base, engine: "" }).engine).toBe("unknown");
  });

  it("names a different person who caused it, and no one when it was the owner", () => {
    expect(queryLogRow({ ...base, actorUserId: "viewer" }).actor_user_id).toBe("viewer");
    expect(queryLogRow({ ...base, actorUserId: "u1" }).actor_user_id).toBeNull();
  });

  it("says why a failed query failed, and keeps no error on a success", () => {
    expect(queryLogRow({ ...base, ok: false }).error).toBe("failed");
    expect(queryLogRow({ ...base, ok: true, error: "stale" }).error).toBeNull();
  });
});

describe("what a lakehouse statement was for", () => {
  it("reads the label its caller gives the audit trail", () => {
    expect(viaFromAuditLabel(undefined)).toBe("lakehouse");
    expect(viaFromAuditLabel("ui")).toBe("lakehouse");
    expect(viaFromAuditLabel("ui-create-table")).toBe("lakehouse");
    expect(viaFromAuditLabel("sheets")).toBe("sheet");
    expect(viaFromAuditLabel("prep")).toBe("data_prep");
    expect(viaFromAuditLabel("workflow")).toBe("pipeline");
    expect(viaFromAuditLabel("replay-determinism-check")).toBe("replay");
    expect(viaFromAuditLabel("sql-model-preview")).toBe("sql_model");
    expect(viaFromAuditLabel("ml.evaluate")).toBe("ml");
    expect(viaFromAuditLabel("feature-view-check")).toBe("ml");
    expect(viaFromAuditLabel("warehouse-connection")).toBe("lakehouse");
  });
});

describe("showing it", () => {
  it("writes bytes, money and time as people read them", () => {
    expect(formatBytes(null)).toBe("—");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 ** 3)).toBe("5.0 GB");
    expect(formatUsd(null)).toBe("—");
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(0.004)).toBe("<$0.01");
    expect(formatUsd(1.236)).toBe("$1.24");
    expect(formatMs(84)).toBe("84 ms");
    expect(formatMs(2_400)).toBe("2.4 s");
    expect(formatMs(185_000)).toBe("3 min 05 s");
  });

  it("opens a query in the workbench only where the workbench can run it", () => {
    expect(workbenchSourceFor({ engine: "browser", connection_id: null })).toBe("local");
    expect(workbenchSourceFor({ engine: "local", connection_id: null })).toBe("local");
    expect(workbenchSourceFor({ engine: "athena", connection_id: "c1" })).toBe("c1");
    expect(workbenchSourceFor({ engine: "objectstore", connection_id: "storage:s1" })).toBe(
      "storage:s1",
    );
    expect(workbenchSourceFor({ engine: "lakehouse", connection_id: null })).toBeNull();
    expect(workbenchSourceFor({ engine: "athena", connection_id: null })).toBeNull();
  });
});
