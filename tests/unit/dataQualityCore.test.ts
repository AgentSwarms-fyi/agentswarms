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

describe("freshness over a capped read, where the newest row may be past the cap", () => {
  // The evaluator reads at most DATA_QUALITY_ROW_CAP rows (200,000 by default)
  // and a column-based freshness test takes the newest value it can SEE. On a
  // table larger than the cap that prefix need not contain the newest row at
  // all — and if the source is ordered oldest-first it certainly does not.
  const DAY = 86_400_000;
  const now = Date.UTC(2026, 0, 30);
  const test = { kind: "freshness" as const, column_name: "day", config: { max_age_hours: 24 } };

  const rows = (isoDays: string[]) => isoDays.map((day) => ({ day }));

  it("still passes on a prefix, because the true newest can only be newer", () => {
    // The whole table's maximum is >= the maximum of any prefix of it. So a
    // prefix that is inside the limit proves the dataset is inside it too —
    // this verdict survives capping and is not downgraded.
    const out = evaluateQualityTest(test, {
      rows: rows(["2026-01-30"]),
      totalRows: 1_000_000,
      capped: true,
      now,
    });
    expect(out.status).toBe("pass");
    expect(out.detail).toContain("checked the first 1 rows");
  });

  it("refuses to call the data stale on evidence that cannot support it", () => {
    // The row that would refute "stale" is exactly the row the cap did not
    // read. Reporting `fail` here names a cause the test cannot establish.
    const out = evaluateQualityTest(test, {
      rows: rows(["2020-01-01"]),
      totalRows: 1_000_000,
      capped: true,
      now,
    });
    expect(out.status).toBe("error");
    expect(out.status).not.toBe("fail");
    // Node here resolves en-IN and writes "10,00,000" — assert what the code
    // actually promises (the same formatter) rather than a literal.
    expect(out.detail).toContain(`Checked the first 1 of ${(1_000_000).toLocaleString()} rows`);
    expect(out.detail).toContain("may lie beyond that cap");
    // And it names the way out rather than leaving the reader stuck.
    expect(out.detail).toContain("DATA_QUALITY_ROW_CAP");
  });

  it("still calls stale data stale when the whole table was read", () => {
    const out = evaluateQualityTest(test, {
      rows: rows(["2020-01-01"]),
      totalRows: 1,
      capped: false,
      now,
    });
    expect(out.status).toBe("fail");
    expect(out.detail).toContain("Stale:");
  });

  it("does not blame the column when a prefix simply holds no dates", () => {
    const out = evaluateQualityTest(test, {
      rows: [{ day: "not a date" }],
      totalRows: 1_000_000,
      capped: true,
      now,
    });
    expect(out.status).toBe("error");
    expect(out.detail).toContain(`among the first 1 of ${(1_000_000).toLocaleString()} rows`);
  });

  it("leaves the load-time fallback alone, which no cap can affect", () => {
    // With no watermark column the stamp comes from the dataset's recorded
    // load time, not from the rows — so capping is irrelevant and a stale
    // verdict is still sound.
    const out = evaluateQualityTest(
      { kind: "freshness", column_name: null, config: { max_age_hours: 1 } },
      {
        rows: [],
        totalRows: 1_000_000,
        capped: true,
        lastLoadedAt: new Date(now - 5 * DAY).toISOString(),
        now,
      },
    );
    expect(out.status).toBe("fail");
    expect(out.detail).toContain("Stale:");
  });
});
