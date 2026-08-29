// The cron engine schedules unattended data loads; a wrong "next occurrence"
// is a silently missed load or a double one. Every case here uses a fixed
// `from` instant so the assertions are exact, not "roughly an hour later".
import { describe, expect, it } from "vitest";

import { nextCronOccurrence, parseCron, validateCron } from "@/lib/cron";

const at = (iso: string) => new Date(iso);
const next = (expr: string, from: string, tz?: string) =>
  nextCronOccurrence(expr, tz ?? null, at(from))?.toISOString() ?? null;

describe("parseCron", () => {
  it("accepts the full field syntax", () => {
    const spec = parseCron("*/15 9-17 1,15 * 1-5");
    expect([...spec.minute.values]).toEqual([0, 15, 30, 45]);
    expect(spec.hour.values.has(9)).toBe(true);
    expect(spec.hour.values.has(18)).toBe(false);
    expect([...spec.dom.values]).toEqual([1, 15]);
    expect(spec.month.any).toBe(true);
    expect([...spec.dow.values]).toEqual([1, 2, 3, 4, 5]);
  });

  it("treats weekday 7 as Sunday, same as 0", () => {
    expect(parseCron("0 0 * * 7").dow.values.has(0)).toBe(true);
    expect(parseCron("0 0 * * 0").dow.values.has(0)).toBe(true);
  });

  it("supports open-ended steps like 5/10", () => {
    expect([...parseCron("5/10 * * * *").minute.values]).toEqual([5, 15, 25, 35, 45, 55]);
  });

  it("rejects the shapes that hide typos", () => {
    expect(() => parseCron("0 0 * *")).toThrow(/5 fields/);
    expect(() => parseCron("60 * * * *")).toThrow(/out of range/);
    expect(() => parseCron("* 24 * * *")).toThrow(/out of range/);
    expect(() => parseCron("* * 0 * *")).toThrow(/out of range/);
    expect(() => parseCron("* * * * MON")).toThrow(/Invalid cron/);
    expect(() => parseCron("*/0 * * * *")).toThrow(/step/);
  });
});

describe("validateCron", () => {
  it("checks the timezone against Intl", () => {
    expect(() => validateCron("0 6 * * *", "Europe/Berlin")).not.toThrow();
    expect(() => validateCron("0 6 * * *", "Mars/Olympus")).toThrow(/Unknown timezone/);
  });
});

describe("nextCronOccurrence", () => {
  it("every minute: the very next minute", () => {
    expect(next("* * * * *", "2026-08-29T10:15:30Z")).toBe("2026-08-29T10:16:00.000Z");
  });

  it("daily at 06:00 UTC, from before and after", () => {
    expect(next("0 6 * * *", "2026-08-29T05:00:00Z")).toBe("2026-08-29T06:00:00.000Z");
    expect(next("0 6 * * *", "2026-08-29T06:00:00Z")).toBe("2026-08-30T06:00:00.000Z");
  });

  it("weekdays only: a Friday evening rolls to Monday", () => {
    // 2026-08-28 is a Friday.
    expect(next("0 6 * * 1-5", "2026-08-28T07:00:00Z")).toBe("2026-08-31T06:00:00.000Z");
  });

  it("evaluates in the requested timezone", () => {
    // 06:00 Berlin in August is 04:00 UTC (CEST, +02:00).
    expect(next("0 6 * * *", "2026-08-29T00:00:00Z", "Europe/Berlin")).toBe(
      "2026-08-29T04:00:00.000Z",
    );
    // A half-hour zone: 09:00 in Kolkata (+05:30) is 03:30 UTC.
    expect(next("0 9 * * *", "2026-08-29T00:00:00Z", "Asia/Kolkata")).toBe(
      "2026-08-29T03:30:00.000Z",
    );
  });

  it("first of the month", () => {
    expect(next("30 0 1 * *", "2026-08-29T10:00:00Z")).toBe("2026-09-01T00:30:00.000Z");
  });

  it("applies the Vixie OR rule when both day fields are restricted", () => {
    // "on the 15th OR on a Monday" — from the 10th (a Monday is the 14th? no:
    // 2026-09-14 is a Monday). Next match after Sep 10 is Monday Sep 14, not
    // the 15th.
    expect(next("0 0 15 * 1", "2026-09-10T00:00:00Z")).toBe("2026-09-14T00:00:00.000Z");
  });

  it("returns null for a date that never exists", () => {
    expect(next("0 0 31 2 *", "2026-08-29T00:00:00Z")).toBeNull();
  });

  it("every 15 minutes across an hour boundary", () => {
    expect(next("*/15 * * * *", "2026-08-29T10:46:00Z")).toBe("2026-08-29T11:00:00.000Z");
  });
});
