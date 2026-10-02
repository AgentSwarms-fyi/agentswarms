// One forecaster for the chart overlay, the Analyst and the alert engine.
//
// docs/BUSINESS_INTELLIGENCE.md promises the chart and the Analyst "cannot
// disagree"; two independent linear fits kept that promise only because both
// were the same straight line. This pins the shared module's behaviour and
// that every caller goes through it.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  detectSeason,
  forecastCaveat,
  forecastModelPoints,
  forecastPeriods,
  forecastValues,
  forecastVersionId,
  seasonForLabel,
} from "@/lib/mlForecast";
import { forecastRows } from "@/lib/biChartMath";
import { forecastSeries } from "@/lib/analystSeries";

const REPO = path.resolve(__dirname, "../..");
const rd = (p: string) => readFileSync(path.join(REPO, p), "utf8");

const seasonal = (n: number, period = 12) =>
  Array.from({ length: n }, (_, i) => 100 + 2 * i + 30 * Math.sin((2 * Math.PI * i) / period));

describe("method selection", () => {
  it("keeps exact least squares for a short or perfectly linear series", () => {
    const r = forecastValues([10, 20, 30, 40, 50, 60, 70, 80], 3)!;
    expect(r.fit.method).toBe("linear trend");
    expect(r.points.map((p) => p.value)).toEqual([90, 100, 110]);
    expect(r.fit.fitError).toBeCloseTo(0, 9);
  });

  it("switches to seasonal smoothing when a season is there and beats the line", () => {
    const ys = seasonal(48);
    const r = forecastValues(ys, 12)!;
    expect(r.fit.method).toBe("seasonal smoothing");
    expect(r.fit.seasonLength).toBe(12);
    // The projection follows the cycle: it must be closer to the true next
    // year than a straight line would be.
    const truth = seasonal(60).slice(48);
    const seasonalMae =
      r.points.reduce((a, p, i) => a + Math.abs(p.value - truth[i]), 0) / r.points.length;
    const lin = forecastValues(ys, 12, { seasonLength: null })!;
    // Forcing the season off is not possible through the public API by
    // design; compare against a hand-made line instead.
    const n = ys.length;
    const sx = (n * (n - 1)) / 2;
    const sy = ys.reduce((a, b) => a + b, 0);
    const sxx = ys.reduce((a, _y, i) => a + i * i, 0);
    const sxy = ys.reduce((a, y, i) => a + i * y, 0);
    const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
    const intercept = (sy - slope * sx) / n;
    const lineMae =
      truth.reduce((a, t, i) => a + Math.abs(slope * (n + i) + intercept - t), 0) / truth.length;
    expect(seasonalMae).toBeLessThan(lineMae / 2);
    expect(lin.points).toHaveLength(12);
  });

  it("refuses when there is nothing to fit", () => {
    expect(forecastValues([5], 3)).toBeNull();
    expect(forecastValues([1, 2, 3], 0)).toBeNull();
    expect(forecastValues([Number.NaN, Number.NaN], 3)).toBeNull();
  });

  it("is deterministic and its band widens with distance", () => {
    const ys = seasonal(36).map((y, i) => y + (i % 3) * 4);
    const a = forecastValues(ys, 6)!;
    const b = forecastValues(ys, 6)!;
    expect(a).toEqual(b);
    const widths = a.points.map((p) => p.hi - p.lo);
    for (let i = 1; i < widths.length; i++) expect(widths[i]).toBeGreaterThanOrEqual(widths[i - 1]);
  });
});

describe("season hints", () => {
  it("reads the season off a bucket label's format", () => {
    expect(seasonForLabel("2026-07")).toBe(12);
    expect(seasonForLabel("2026-Q3")).toBe(4);
    expect(seasonForLabel("2026-W31")).toBe(52);
    expect(seasonForLabel("2026-07-14")).toBe(7);
    expect(seasonForLabel("2026")).toBeNull();
    expect(seasonForLabel("+3")).toBeNull();
  });

  it("trusts a hint only with two full cycles of history, else screens by autocorrelation", () => {
    expect(detectSeason(seasonal(20), 12)).toBeNull(); // 20 < 2*12+2
    expect(detectSeason(seasonal(26), 12)).toBe(12);
    expect(detectSeason(seasonal(40, 7))).toBe(7);
    expect(detectSeason([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])).toBeNull();
  });
});

describe("the chart overlay and the Analyst use the same forecaster", () => {
  it("chart rows keep the old numbers for a short series and carry a band", () => {
    const out = forecastRows(
      [
        { x: "2026-01", y: 10 },
        { x: "2026-02", y: 20 },
        { x: "2026-03", y: 30 },
      ],
      "x",
      "y",
      2,
    )!;
    expect(out.rows.map((r) => r.x)).toEqual(["2026-04", "2026-05"]);
    expect(out.rows.map((r) => r.__forecast)).toEqual([40, 50]);
    expect(out.rows[0].__band).toEqual([out.rows[0].__lo, out.rows[0].__hi]);
  });

  it("chart rows use an attached model's points verbatim", () => {
    const out = forecastRows(
      [
        { x: "2026-01", y: 1 },
        { x: "2026-02", y: 2 },
      ],
      "x",
      "y",
      {
        periods: 2,
        versionId: "v1",
        points: [
          { period: "2026-03", yhat: 7, lo: 5, hi: 9 },
          { period: "2026-04", yhat: 8, lo: 5, hi: 11 },
          { period: "2026-05", yhat: 9, lo: 5, hi: 13 },
        ],
      },
    )!;
    expect(out.fit.method).toBe("registry model");
    expect(out.rows.map((r) => r.x)).toEqual(["2026-03", "2026-04"]);
    expect(out.rows.map((r) => r.__forecast)).toEqual([7, 8]);
  });

  it("the Analyst projects with the same module and says which method it used", () => {
    const pts = (vals: number[]) =>
      vals.map((value, i) => ({ label: `2026-${String((i % 12) + 1).padStart(2, "0")}`, value }));
    const f = forecastSeries(pts([10, 20, 30, 40, 50, 60, 70, 80]), 3)!;
    expect(f.method).toBe("linear trend");
    expect(f.points[0].value).toBeCloseTo(90, 6);
    const s = forecastSeries(pts(seasonal(48)), 6)!;
    expect(s.method).toBe("seasonal smoothing");
    expect(s.caveat).toContain("12-period season");
  });

  it("neither caller fits its own line for forecasting any more", () => {
    const chart = rd("src/lib/biChartMath.ts");
    const fc = chart.slice(
      chart.indexOf("export function forecastRows"),
      chart.indexOf("export function nextBucketLabel"),
    );
    expect(fc).toContain("forecastValues(");
    expect(fc).not.toContain("linearFit(");
    const analyst = rd("src/lib/analystSeries.ts");
    const fs = analyst.slice(
      analyst.indexOf("export function forecastSeries"),
      analyst.indexOf("export function describeSeries"),
    );
    expect(fs).toContain("forecastValues(");
    expect(fs).not.toContain("fitLine(");
    expect(
      forecastCaveat({ method: "linear trend", seasonLength: null, sigma: 1, fitError: 2 }, 8),
    ).toMatch(/seasonality/);
  });
});

describe("the forecast setting, old and new shape", () => {
  it("reads periods and version from either form", () => {
    expect(forecastPeriods(3)).toBe(3);
    expect(forecastPeriods({ periods: 4, versionId: "v" })).toBe(4);
    expect(forecastPeriods(undefined)).toBe(0);
    expect(forecastVersionId(3)).toBeNull();
    expect(forecastVersionId({ periods: 1, versionId: "v" })).toBe("v");
    expect(forecastModelPoints({ periods: 1, versionId: "v" })).toBeNull();
    expect(
      forecastModelPoints({
        periods: 1,
        versionId: "v",
        points: [{ period: "p", yhat: 1, lo: 0, hi: 2 }],
      }),
    ).toHaveLength(1);
  });
});

describe("alerts on a forecast", () => {
  it("has a basis column, an evaluator branch and a dialog control", () => {
    const mig = rd("supabase/migrations/20260856000000_bi_alert_basis.sql");
    expect(mig).toContain("CHECK (basis IN ('actual', 'forecast'))");
    expect(mig).toContain("ADD COLUMN IF NOT EXISTS horizon integer");
    const refresh = rd("src/utils/bi/refresh.server.ts");
    expect(refresh).toContain("export function forecastAlertValue(");
    expect(refresh).toContain('basis === "forecast"');
    expect(refresh).toContain("syncForecastVersions(");
    const dialog = rd("src/components/bi/ScheduleDialog.tsx");
    expect(dialog).toContain("basis: aBasis");
    expect(dialog).toContain('aBasis === "forecast"');
  });

  it("the render draws the band and the docs no longer call it a straight line", () => {
    const render = rd("src/components/bi/BiChartRender.tsx");
    expect(render).toContain('dataKey="__band"');
    expect(render).toContain("forecastPeriods(chart.forecast)");
    const docs = rd("src/routes/docs.bi.tsx");
    expect(docs).not.toContain("A forecast is a straight-line projection");
    expect(docs).toContain("seasonal");
    expect(rd("docs/BUSINESS_INTELLIGENCE.md")).toContain("seasonal");
  });
});
