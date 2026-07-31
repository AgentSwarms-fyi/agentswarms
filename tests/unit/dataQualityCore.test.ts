// Data quality assertions. Ported from the one-off verification script that
// proved these when the feature shipped — the point of moving them here is
// that they now run on every change instead of once.
import { describe, expect, it } from "vitest";

import {
  evaluateQualityTest,
  rollupQuality,
  validateQualityTest,
  type QualityTest,
} from "@/lib/dataQualityCore";

const NOW = Date.parse("2026-07-31T12:00:00Z");
const ROWS = [
  { id: 1, region: "EMEA", amount: 10, day: "2026-07-31" },
  { id: 2, region: "APAC", amount: 20, day: "2026-07-30" },
  { id: 3, region: null, amount: 30, day: "2026-07-29" },
  { id: 3, region: "", amount: -5, day: "2026-07-28" },
];
const ctx = (extra: Record<string, unknown> = {}) => ({
  rows: ROWS,
  totalRows: ROWS.length,
  now: NOW,
  ...extra,
});

describe("row-scoped checks", () => {
  it("not_null counts NULL and empty string alike", () => {
    const r = evaluateQualityTest({ kind: "not_null", column_name: "region", config: {} }, ctx());
    expect(r.status).toBe("fail");
    expect(r.failingRows).toBe(2);
  });

  it("unique flags every row of a duplicate pair", () => {
    const r = evaluateQualityTest({ kind: "unique", column_name: "id", config: {} }, ctx());
    expect(r.status).toBe("fail");
    expect(r.failingRows).toBe(2);
  });

  it("unique ignores NULLs, matching SQL UNIQUE and dbt", () => {
    expect(
      evaluateQualityTest({ kind: "unique", column_name: "region", config: {} }, ctx()).status,
    ).toBe("pass");
  });

  it("accepted_values ignores NULLs but catches real strays", () => {
    expect(
      evaluateQualityTest(
        { kind: "accepted_values", column_name: "region", config: { values: ["EMEA", "APAC"] } },
        ctx(),
      ).status,
    ).toBe("pass");
    const bad = evaluateQualityTest(
      { kind: "accepted_values", column_name: "region", config: { values: ["EMEA"] } },
      ctx(),
    );
    expect(bad.status).toBe("fail");
    expect(bad.failingRows).toBe(1);
  });

  it("range flags out-of-bounds and non-numeric values", () => {
    expect(
      evaluateQualityTest(
        { kind: "range", column_name: "amount", config: { min: 0, max: 100 } },
        ctx(),
      ).failingRows,
    ).toBe(1);
    const text = evaluateQualityTest(
      { kind: "range", column_name: "region", config: { min: 0 } },
      ctx(),
    );
    expect(text.status).toBe("fail");
    expect(text.detail).toMatch(/not numeric/);
  });

  it("reports when only a capped prefix was read", () => {
    const r = evaluateQualityTest(
      { kind: "not_null", column_name: "region", config: {} },
      ctx({ totalRows: 999_999, capped: true }),
    );
    expect(r.detail).toMatch(/checked the first/);
  });
});

describe("table-scoped checks", () => {
  it("row_count_min passes at exactly the floor", () => {
    expect(
      evaluateQualityTest({ kind: "row_count_min", column_name: null, config: { count: 4 } }, ctx())
        .status,
    ).toBe("pass");
    expect(
      evaluateQualityTest({ kind: "row_count_min", column_name: null, config: { count: 5 } }, ctx())
        .status,
    ).toBe("fail");
  });

  it("freshness measures a watermark column", () => {
    expect(
      evaluateQualityTest(
        { kind: "freshness", column_name: "day", config: { max_age_hours: 48 } },
        ctx(),
      ).status,
    ).toBe("pass");
    expect(
      evaluateQualityTest(
        { kind: "freshness", column_name: "day", config: { max_age_hours: 2 } },
        ctx(),
      ).status,
    ).toBe("fail");
  });

  it("freshness falls back to the dataset load time", () => {
    expect(
      evaluateQualityTest(
        { kind: "freshness", column_name: null, config: { max_age_hours: 1 } },
        ctx({ lastLoadedAt: "2026-07-31T11:30:00Z" }),
      ).status,
    ).toBe("pass");
  });

  it("clamps a future timestamp rather than reporting a negative age", () => {
    expect(
      evaluateQualityTest(
        { kind: "freshness", column_name: null, config: { max_age_hours: 1 } },
        ctx({ lastLoadedAt: "2026-08-05T00:00:00Z" }),
      ).status,
    ).toBe("pass");
  });
});

describe("unrunnable checks report error, never pass", () => {
  it("unparseable dates", () => {
    expect(
      evaluateQualityTest(
        { kind: "freshness", column_name: "region", config: { max_age_hours: 24 } },
        ctx(),
      ).status,
    ).toBe("error");
  });

  it("a column that does not exist", () => {
    expect(
      evaluateQualityTest({ kind: "not_null", column_name: "nope", config: {} }, ctx()).status,
    ).toBe("error");
  });

  it("no recorded load time", () => {
    expect(
      evaluateQualityTest(
        { kind: "freshness", column_name: null, config: { max_age_hours: 1 } },
        ctx({ lastLoadedAt: null }),
      ).status,
    ).toBe("error");
  });
});

describe("validation refuses unrunnable definitions", () => {
  it.each([
    ["not_null without a column", { kind: "not_null" as const, column_name: "", config: {} }],
    [
      "accepted_values with no values",
      { kind: "accepted_values" as const, column_name: "a", config: { values: [] } },
    ],
    ["range with no bound", { kind: "range" as const, column_name: "a", config: {} }],
    [
      "range with min > max",
      { kind: "range" as const, column_name: "a", config: { min: 5, max: 1 } },
    ],
    [
      "freshness with a non-positive age",
      { kind: "freshness" as const, column_name: null, config: { max_age_hours: 0 } },
    ],
  ])("rejects %s", (_label, test) => {
    expect(validateQualityTest(test)).not.toBeNull();
  });

  it("accepts a valid definition", () => {
    expect(
      validateQualityTest({ kind: "freshness", column_name: null, config: { max_age_hours: 24 } }),
    ).toBeNull();
  });
});

describe("roll-up severity", () => {
  const t = (id: string, severity: "error" | "warn", enabled = true) =>
    ({ id, severity, enabled }) as Pick<QualityTest, "id" | "severity" | "enabled">;
  const r = (status: string) => ({ status: status as never, ran_at: "2026-07-31T00:00:00Z" });

  it("a failing warn test degrades to warn, not fail", () => {
    expect(rollupQuality([t("a", "warn")], new Map([["a", r("fail")]])).status).toBe("warn");
  });

  it("one failing error test fails the dataset", () => {
    expect(
      rollupQuality(
        [t("a", "warn"), t("b", "error")],
        new Map([
          ["a", r("fail")],
          ["b", r("fail")],
        ]),
      ).status,
    ).toBe("fail");
  });

  it("a test that never ran is unknown, not pass", () => {
    expect(rollupQuality([t("a", "error")], new Map()).status).toBe("unknown");
  });

  it("a disabled test cannot drag the verdict down", () => {
    expect(rollupQuality([t("a", "error", false)], new Map([["a", r("fail")]])).status).toBe(
      "unknown",
    );
  });
});
