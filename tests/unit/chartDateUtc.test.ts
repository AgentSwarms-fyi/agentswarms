// A date string with no offset is the engines' wall-clock time (R196).
//
// FOUND IN R196, sweep 4 ("two surfaces, two answers"). A BI line chart over
// the lakehouse — SELECT date_trunc('month', CAST(placed_on AS TIMESTAMP)) AS
// month, count(*) … FROM analytics.stg_revenue — labelled its three months
// "2025-12, 2026-01, 2026-02" at month grain for a viewer at UTC+4; the
// lakehouse returns 2026-01-01, 2026-02-01 and 2026-03-01. The server engine
// writes a naive TIMESTAMP as "2026-01-01 00:00:00", and `new Date` reads
// that as the viewer's local midnight, 20:00 UTC the day before. The same
// query run in the browser hands over an epoch and was right.
import { describe, expect, it } from "vitest";

// A zone east of UTC, set before any Date is made. Node applies a TZ change
// at runtime, so this holds on a UTC CI runner too.
process.env.TZ = "Asia/Dubai";

import { bucketDate, parseDateValue } from "@/lib/biChartMath";

const iso = (v: unknown) => parseDateValue(v)?.toISOString() ?? null;

describe("the test's zone", () => {
  it("is not UTC, or this file proves nothing", () => {
    expect(new Date(2026, 0, 1).getTimezoneOffset()).toBe(-240);
  });
});

describe("parseDateValue", () => {
  it("reads the server engine's naive TIMESTAMP text as UTC", () => {
    expect(iso("2026-01-01 00:00:00")).toBe("2026-01-01T00:00:00.000Z");
    expect(iso("2026-01-01T09:30:15")).toBe("2026-01-01T09:30:15.000Z");
    expect(iso("2026-01-01 00:00:00.25")).toBe("2026-01-01T00:00:00.250Z");
  });

  it("reads a date in any other written form as that calendar day", () => {
    expect(iso("11/9/2024")).toBe("2024-11-09T00:00:00.000Z");
    expect(iso("Nov 9, 2024")).toBe("2024-11-09T00:00:00.000Z");
  });

  it("leaves what was already UTC, and what carries an offset, as it was", () => {
    expect(iso("2026-01-01")).toBe("2026-01-01T00:00:00.000Z");
    expect(iso("2026-01")).toBe("2026-01-01T00:00:00.000Z");
    expect(iso("2026")).toBe("2026-01-01T00:00:00.000Z");
    expect(iso("2026-01-01 00:00:00+00")).toBe("2026-01-01T00:00:00.000Z");
    expect(iso("2026-01-01T00:00:00Z")).toBe("2026-01-01T00:00:00.000Z");
    expect(iso("2026-01-01 04:00:00+04:00")).toBe("2026-01-01T00:00:00.000Z");
    expect(iso("2026-01-01 04:00:00+0400")).toBe("2026-01-01T00:00:00.000Z");
    expect(iso("2026-01-01 00:00:00 UTC")).toBe("2026-01-01T00:00:00.000Z");
    expect(iso(1767225600000)).toBe("2026-01-01T00:00:00.000Z");
  });

  it("still refuses what is not a date", () => {
    expect(parseDateValue("42")).toBeNull();
    expect(parseDateValue("not a date")).toBeNull();
  });
});

describe("a month axis over the lakehouse rows", () => {
  it("names the months the query returned, text or epoch alike", () => {
    const server = ["2026-01-01 00:00:00", "2026-02-01 00:00:00", "2026-03-01 00:00:00"];
    const browser = [Date.UTC(2026, 0, 1), Date.UTC(2026, 1, 1), Date.UTC(2026, 2, 1)];
    const want = ["2026-01", "2026-02", "2026-03"];
    expect(server.map((v) => bucketDate(v, "month"))).toEqual(want);
    expect(browser.map((v) => bucketDate(v, "month"))).toEqual(want);
    expect(server.map((v) => bucketDate(v, "day"))).toEqual([
      "2026-01-01",
      "2026-02-01",
      "2026-03-01",
    ]);
  });
});
