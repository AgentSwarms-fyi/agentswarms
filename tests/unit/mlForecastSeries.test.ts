// Forecasts per series, and a horizon a retrain can change (R526).
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { forecastSeriesOf, pickForecastSeries } from "@/utils/ml/types";

const rd = (p: string) => readFileSync(p, "utf8");
const pt = (period: string, yhat: number) => ({ period, yhat, lo: yhat - 1, hi: yhat + 1 });
const STORED = {
  points: [pt("2026-01-01", 300)],
  history: [],
  meta: { period: "day" },
  series: [
    {
      key: "North",
      algorithm: "holt_winters",
      rmse: 4,
      periods: 120,
      forecast: [pt("2026-01-01", 200)],
      history: [],
    },
    {
      key: "South",
      algorithm: "seasonal_naive",
      rmse: 2,
      periods: 120,
      forecast: [pt("2026-01-01", 90)],
      history: [],
    },
  ],
};

describe("picking the total or one series", () => {
  it("the total when no series is named, with the series there are", () => {
    const r = pickForecastSeries(STORED);
    expect(r).toMatchObject({ ok: true, series: null, available: ["North", "South"] });
    expect(r.ok && r.points[0].yhat).toBe(300);
  });

  it("one series by name, any case", () => {
    const r = pickForecastSeries(STORED, "south");
    expect(r).toMatchObject({ ok: true, series: "South" });
    expect(r.ok && r.points[0].yhat).toBe(90);
  });

  it("an unknown series is an error that lists the ones there are", () => {
    expect(pickForecastSeries(STORED, "West")).toEqual({
      ok: false,
      available: ["North", "South"],
      error:
        'No series named "West". Forecast one by one: North, South. Leave out series for the total.',
    });
  });

  it("a one-series model says it has no series", () => {
    const r = pickForecastSeries({ points: [pt("2026-01-01", 5)] }, "North");
    expect(r).toMatchObject({ ok: false, available: [] });
    expect(r.ok ? "" : r.error).toMatch(/forecasts one series/);
    expect(pickForecastSeries({ points: [pt("2026-01-01", 5)] })).toMatchObject({
      ok: true,
      available: [],
    });
  });

  it("reads a stored forecast defensively", () => {
    expect(forecastSeriesOf(null)).toEqual([]);
    expect(forecastSeriesOf({ series: [{ key: 1 }, { key: "x", forecast: [] }, null] })).toEqual([
      { key: "x", forecast: [] },
    ]);
  });
});

describe("the series reach every surface", () => {
  it("the trainer is given the series column and stores each series", () => {
    expect(rd("src/utils/ml/train.server.ts")).toContain("series_column:");
    expect(rd("src/utils/ml/train.server.ts")).toContain("series: r.series_forecasts");
    expect(rd("src/utils/ml/pyTrain.ts")).toContain("scol = cfg.get('series_column') or None");
  });

  it("REST and the agent tool take a series and say which ones there are", () => {
    const route = rd("src/routes/api/ml.predict.ts");
    expect(route).toContain("pickForecastSeries(");
    expect(route).toContain("series_available: picked.available");
    const tools = rd("src/utils/tools/registry.server.ts");
    expect(tools).toMatch(/series: \{\s+type: "string",/);
    expect(tools).toContain("series_available: picked.available");
  });

  it("a chart keeps the series it attached when its points are refreshed", () => {
    const sync = rd("src/utils/ml/forecast.server.ts");
    expect(sync).toContain(
      "forecastPointsForUser(versionId, ownerId, chart.forecast.series ?? null)",
    );
    expect(rd("src/lib/mlForecast.ts")).toContain("series?: string;");
    expect(rd("src/components/bi/BiBuilderPane.tsx")).toContain('forecastSource.split("::")');
  });

  it("a series column is stored only when set, so an older database keeps working", () => {
    const fns = rd("src/utils/ml/create.server.ts");
    expect(fns).toMatch(
      /data\.task === "forecast" && data\.series_column\s+\? \{ series_column: data\.series_column \}\s+: \{\}/,
    );
    const sql = rd("supabase/migrations/20261124000000_ml_forecast_series.sql");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS series_column text");
    expect(sql).toContain("task = 'forecast'");
  });
});

describe("a retrain can change a forecast's horizon", () => {
  it("only for a forecast model, and the model keeps it", () => {
    const fns = rd("src/utils/ml.functions.ts");
    expect(fns).toContain("horizon: z.number().int().min(1).max(1000).optional(),\n      })");
    expect(fns).toContain(
      'model.task === "forecast" && data.horizon && data.horizon !== model.horizon',
    );
    expect(fns).toContain(".update({ horizon: data.horizon })");
  });
});
