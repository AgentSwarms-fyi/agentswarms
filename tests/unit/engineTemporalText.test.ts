// DATE and TIMESTAMP, written the same way by both engines (R197).
//
// FOUND IN R197, sweep 4 ("two surfaces, two answers"). The browser engine
// handed DATE and TIMESTAMP on as Arrow's epoch milliseconds: the Workbench
// grid showed `1640995200000 | 1641254400000` where the server engine shows
// `2022-01-01 00:00:00 | 2022-01-04`, a CSV export wrote the number, and a
// chart's auto axis labelled the browser's rows "2022-01-01, 2022-02-01" and
// the server's (a lakehouse tile) "2026-02-01 00:00:00, 2026-03-01 00:00:00".
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { autoDateGrain, hasRawDateValues, labelRowsX } from "@/lib/biChartMath";
import { arrowTemporalKind, formatTemporal } from "@/lib/duckdbValues";

describe("formatTemporal", () => {
  it("writes a DATE, a TIMESTAMP and a TIMESTAMPTZ as the server engine does", () => {
    const jan1 = Date.UTC(2022, 0, 1);
    expect(formatTemporal(jan1, "date")).toBe("2022-01-01");
    expect(formatTemporal(Date.UTC(2026, 8, 30, 22, 30), "timestamp")).toBe("2026-09-30 22:30:00");
    expect(formatTemporal(Date.UTC(2026, 8, 30), "timestamptz")).toBe("2026-09-30 00:00:00+00");
  });

  it("keeps milliseconds, without trailing zeros", () => {
    expect(formatTemporal(Date.UTC(2026, 0, 1, 0, 0, 0, 250), "timestamp")).toBe(
      "2026-01-01 00:00:00.25",
    );
    expect(formatTemporal(Date.UTC(2026, 0, 1, 0, 0, 0, 7), "timestamp")).toBe(
      "2026-01-01 00:00:00.007",
    );
  });
});

describe("arrowTemporalKind", () => {
  const type = (typeId: number, name: string, timezone?: string | null) => ({
    typeId,
    timezone,
    toString: () => name,
  });

  it("knows a date, a timestamp and a timestamp with a zone, by id or by name", () => {
    expect(arrowTemporalKind(type(8, "Date32<DAY>"))).toBe("date");
    expect(arrowTemporalKind(type(-13, "Date32<DAY>"))).toBe("date");
    expect(arrowTemporalKind(type(10, "Timestamp<MICROSECOND>", null))).toBe("timestamp");
    expect(arrowTemporalKind(type(-17, "Timestamp<MICROSECOND>", null))).toBe("timestamp");
    expect(arrowTemporalKind(type(10, "Timestamp<MICROSECOND, UTC>", "UTC"))).toBe("timestamptz");
    expect(arrowTemporalKind(type(999, "Date64<MILLISECOND>"))).toBe("date");
  });

  it("leaves every other column alone", () => {
    expect(arrowTemporalKind(type(2, "Int64"))).toBeNull();
    expect(arrowTemporalKind(type(3, "Float64"))).toBeNull();
    expect(arrowTemporalKind(type(5, "Utf8"))).toBeNull();
    expect(arrowTemporalKind(null)).toBeNull();
  });
});

describe("the chart's auto axis", () => {
  const server = [
    { month: "2026-01-01 00:00:00", orders: 272 },
    { month: "2026-02-01 00:00:00", orders: 273 },
    { month: "2026-03-01 00:00:00", orders: 291 },
  ];
  const epochs = [
    { month: Date.UTC(2026, 0, 1), orders: 272 },
    { month: Date.UTC(2026, 1, 1), orders: 273 },
    { month: Date.UTC(2026, 2, 1), orders: 291 },
  ];

  it("reads the engines' TIMESTAMP text as raw dates, the way it reads an epoch", () => {
    expect(hasRawDateValues(server, "month")).toBe(true);
    expect(hasRawDateValues(epochs, "month")).toBe(true);
    expect(hasRawDateValues([{ m: "2026-01-01 00:00:00+00" }], "m")).toBe(true);
    expect(hasRawDateValues([{ m: "2026-01-01T00:00:00.5Z" }], "m")).toBe(true);
  });

  it("labels one query's rows the same whichever engine answered", () => {
    const grain = autoDateGrain(server, "month");
    expect(grain).not.toBeNull();
    expect(autoDateGrain(epochs, "month")).toBe(grain);
    const labels = (rows: Record<string, unknown>[]) =>
      labelRowsX(rows, "month", grain!).map((r) => r.month);
    expect(labels(server)).toEqual(labels(epochs));
  });

  it("still leaves a label a person wrote as it is, a bare day included", () => {
    expect(hasRawDateValues([{ m: "2026-01" }, { m: "2026-02" }], "m")).toBe(false);
    expect(hasRawDateValues([{ m: "Q1 2026" }], "m")).toBe(false);
    // Text cannot tell a DATE from strftime(d, '%Y-%m-%d'); a label is kept.
    expect(hasRawDateValues([{ m: "2026-01-05" }], "m")).toBe(false);
  });
});

describe("the browser engine", () => {
  const SRC = readFileSync("src/lib/browserDuckdb.ts", "utf8");

  it("writes each temporal column through formatTemporal, by its Arrow type", () => {
    const run = SRC.slice(SRC.indexOf("export async function runBrowserSql"));
    expect(run).toContain("const kinds = fields.map((f) => arrowTemporalKind(f.type));");
    expect(run).toMatch(
      /kind && typeof raw === "number" \? formatTemporal\(raw, kind\) : toJsValue\(raw\)/,
    );
  });
});
