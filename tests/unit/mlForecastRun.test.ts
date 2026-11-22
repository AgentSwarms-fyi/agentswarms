// The forecasting trainer, run for real (R526).
//
// Until R526 the forecast Python was only checked as text: a typo in a branch
// no test reached would have shipped. This loads TRAIN_PY into Python and
// calls _train_forecast on series whose shape is known, then reads back what
// it chose and projected.
//
// It needs pandas, numpy, scikit-learn, statsmodels and joblib. It uses the
// local `python` when those import; with ML_FORECAST_PY_IMAGE set to an image
// name (the sandbox image, e.g. ghcr.io/agentswarms-fyi/notebook-runtime:local)
// it runs there through Docker instead. Neither: the tests are SKIPPED, and
// say so, rather than passing.
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { TRAIN_PY } from "@/utils/ml/pyTrain";

const DRIVER = String.raw`
import json, sys, math
import numpy as np
import pandas as pd
src = open(sys.argv[1], encoding='utf-8').read()
g = {'__name__': 'trainer'}
exec(compile(src, 'train.py', 'exec'), g)
case = sys.argv[2]
rng = np.random.default_rng(7)

def daily(n, base, weekly, trend, noise):
    days = pd.date_range('2025-01-01', periods=n, freq='D')
    dow = np.array([weekly[d.dayofweek] for d in days])
    y = base + trend * np.arange(n) + dow + rng.normal(0, noise, n)
    return days, np.maximum(y, 0)

warnings_ = []
if case == 'single':
    days, y = daily(210, 100.0, [0, 5, 10, 15, 20, 60, 70], 0.2, 2.0)
    df = pd.DataFrame({'day': days, 'sales': y})
    cfg = {'time_column': 'day', 'target_column': 'sales', 'horizon': 14, 'aggregation': 'sum', 'period': 'day', 'time_budget_minutes': 5}
elif case == 'series':
    frames = []
    for region, base, weekly in [('North', 200.0, [0, 0, 0, 0, 0, 80, 90]), ('South', 50.0, [30, 0, 0, 0, 0, 0, 0]), ('East', 5.0, [0] * 7)]:
        days, y = daily(120, base, weekly, 0.0, 1.0)
        frames.append(pd.DataFrame({'day': days, 'sales': y, 'region': region}))
    df = pd.concat(frames, ignore_index=True)
    cfg = {'time_column': 'day', 'target_column': 'sales', 'series_column': 'region', 'horizon': 7, 'aggregation': 'sum', 'period': 'day', 'time_budget_minutes': 5}
elif case == 'calendar':
    # A month pattern only the calendar can see: every December is high.
    months = pd.date_range('2016-01-01', periods=96, freq='MS')
    y = np.array([100.0 + (80.0 if m.month == 12 else 0.0) + rng.normal(0, 1) for m in months])
    from sklearn.ensemble import HistGradientBoostingRegressor
    X = g['_lag_frame'](pd.Series(y, index=months), 2, 'MS')
    print(json.dumps({'columns': list(X.columns)}))
    sys.exit(0)
r = g['_train_forecast'](df, cfg, warnings_)
r.pop('_artifact')
out = {
    'algorithm': r['algorithm'], 'metrics': r['metrics'], 'forecast': r['forecast'],
    'leaderboard': r['leaderboard'], 'meta': r['series_meta'], 'warnings': warnings_,
    'series': [{'key': x['key'], 'algorithm': x['algorithm'], 'n': len(x['forecast']), 'first': x['forecast'][0]['yhat'], 'history': len(x['history'])} for x in r['series_forecasts']],
}
print(json.dumps(out))
`;

function runner(): ((dir: string, args: string[]) => ReturnType<typeof spawnSync>) | null {
  const image = process.env.ML_FORECAST_PY_IMAGE;
  if (image) {
    return (dir, args) =>
      spawnSync(
        "docker",
        [
          "run",
          "--rm",
          "-v",
          `${dir}:/w`,
          "--entrypoint",
          "python",
          image,
          "/w/driver.py",
          ...args.map((a) => a.replace(dir, "/w").replace(/\\/g, "/")),
        ],
        { encoding: "utf8", timeout: 240_000 },
      );
  }
  const probe = spawnSync("python", ["-c", "import pandas, numpy, sklearn, statsmodels, joblib"], {
    encoding: "utf8",
  });
  if (probe.status !== 0) return null;
  return (dir, args) =>
    spawnSync("python", [join(dir, "driver.py"), ...args], { encoding: "utf8", timeout: 240_000 });
}

const run = runner();
if (!run) {
  console.warn(
    "[mlForecastRun] no Python with pandas, scikit-learn and statsmodels, and ML_FORECAST_PY_IMAGE is not set: these tests are SKIPPED, not passed.",
  );
}

/** What the driver prints back about a training run. */
type Trained = {
  algorithm: string;
  metrics: Record<string, number | null>;
  forecast: Array<{ period: string; yhat: number; lo: number; hi: number }>;
  leaderboard: Array<{ algorithm: string; status: string; windows?: number }>;
  meta: {
    backtest_windows?: number;
    series_column?: string | null;
    series_count?: number | null;
  };
  series: Array<{ key: string; algorithm: string; n: number; first: number; history: number }>;
  columns?: string[];
};

function train(kind: string): Trained {
  const dir = mkdtempSync(join(tmpdir(), "fc-"));
  writeFileSync(join(dir, "train.py"), TRAIN_PY);
  writeFileSync(join(dir, "driver.py"), DRIVER);
  const res = run!(dir, [join(dir, "train.py"), kind]);
  if (res.status !== 0) throw new Error(`python failed: ${String(res.stderr).slice(-2000)}`);
  const line = String(res.stdout).trim().split("\n").pop()!;
  return JSON.parse(line);
}

describe.skipIf(!run)("the forecasting trainer, run", () => {
  it("one series: chooses over three backtest windows and projects the horizon", () => {
    const r = train("single");
    expect(r.meta.backtest_windows).toBe(3);
    expect(r.metrics.backtest_windows).toBe(3);
    expect(r.forecast).toHaveLength(14);
    for (const row of r.leaderboard.filter((x: { status: string }) => x.status === "ok")) {
      expect(row.windows).toBe(3);
    }
    // A strong weekly pattern: a baseline that ignores it must not win.
    expect(["naive_last_value", "moving_average"]).not.toContain(r.algorithm);
    // The projection keeps the weekend high.
    const byDow = new Map<number, number>();
    for (const p of r.forecast) byDow.set(new Date(p.period).getUTCDay(), p.yhat);
    expect(byDow.get(6)! - byDow.get(1)!).toBeGreaterThan(20);
  }, 300_000);

  it("many series: one forecast per series beside the total, each with its own winner", () => {
    const r = train("series");
    expect(r.meta.series_column).toBe("region");
    expect(r.meta.series_count).toBe(3);
    expect(r.series.map((s: { key: string }) => s.key)).toEqual(["North", "South", "East"]);
    for (const s of r.series) {
      expect(s.n).toBe(7);
      expect(s.history).toBeGreaterThan(100);
    }
    // Each projects its own level, not the total's.
    const level = Object.fromEntries(
      r.series.map((s: { key: string; first: number }) => [s.key, s.first]),
    );
    expect(level.North).toBeGreaterThan(150);
    expect(level.East).toBeLessThan(20);
    expect(r.forecast).toHaveLength(7);
  }, 300_000);

  it("the lag model sees the calendar", () => {
    const r = train("calendar");
    expect(r.columns).toEqual(["lag_1", "lag_2", "t", "cal_month"]);
  }, 300_000);
});
