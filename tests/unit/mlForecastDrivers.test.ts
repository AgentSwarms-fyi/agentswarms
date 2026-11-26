// Forecasting with known-ahead drivers (R547).
//
// A driver is a number already planned for the periods ahead: a price, a
// promotion flag, a holiday count. The trainer is RUN here, as R526's test
// runs it: the local python when pandas, scikit-learn and statsmodels import,
// or the sandbox image through Docker with ML_FORECAST_PY_IMAGE set. Neither:
// the run tests are SKIPPED and say so. The words, the proposal checks and
// the wiring are tested either way.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { driversLine, invalidDrivers, MAX_FORECAST_DRIVERS } from "@/lib/mlForecastDrivers";
import { checkAgainstColumns, describeProposal, type MlTrainProposal } from "@/lib/mlProposals";
import { TRAIN_PY } from "@/utils/ml/pyTrain";

const rd = (p: string) => readFileSync(p, "utf8");

// ── The trainer, run ─────────────────────────────────────────────────────

const DRIVER = String.raw`
import json, sys
import numpy as np
import pandas as pd
src = open(sys.argv[1], encoding='utf-8').read()
g = {'__name__': 'trainer'}
exec(compile(src, 'train.py', 'exec'), g)
case = sys.argv[2]
rng = np.random.default_rng(7)
n, ahead = 180, 14
days = pd.date_range('2025-01-01', periods=n + ahead, freq='D')
promo = (rng.random(n + ahead) < 0.3).astype(int)
price = 10 + rng.normal(0, 0.5, n + ahead)
y = 100 + 60 * promo + rng.normal(0, 3, n + ahead)
df = pd.DataFrame({'day': days, 'sales': y, 'promo': promo, 'price': price})
df.loc[n:, 'sales'] = np.nan
cfg = {'time_column': 'day', 'target_column': 'sales', 'horizon': ahead, 'aggregation': 'sum',
       'period': 'day', 'time_budget_minutes': 5, 'feature_columns': ['promo', 'price']}
if case == 'partial':
    df = df.iloc[: n + 5]
elif case == 'unplanned':
    df = df.iloc[:n]
elif case == 'text':
    df['promo'] = 'yes'
    cfg['feature_columns'] = ['promo']
elif case == 'series_col':
    df['region'] = 'North'
    cfg['series_column'] = 'region'
    cfg['feature_columns'] = ['region']
elif case == 'none':
    cfg['feature_columns'] = []
elif case == 'noise':
    # A driver that has nothing to do with the target.
    df['promo'] = (rng.random(n + ahead) < 0.5).astype(int)
    df['sales'] = 100 + rng.normal(0, 3, n + ahead)
    df.loc[n:, 'sales'] = np.nan
    cfg['feature_columns'] = ['promo']
warnings_ = []
try:
    r = g['_train_forecast'](df, cfg, warnings_)
except Exception as e:
    print(json.dumps({'error': str(e)}))
    sys.exit(0)
r.pop('_artifact')
plan = df['promo'].to_numpy()[n:].tolist() if case != 'text' else []
fc = r['forecast']
on = [f['yhat'] for f, p in zip(fc, plan) if p == 1]
off = [f['yhat'] for f, p in zip(fc, plan) if p == 0]
print(json.dumps({
    'algorithm': r['algorithm'],
    'meta': r['series_meta'],
    'schema': r['feature_schema'],
    'on': float(np.mean(on)) if on else None,
    'off': float(np.mean(off)) if off else None,
    'leaderboard': [x['algorithm'] for x in r['leaderboard']],
    'warnings': warnings_,
}))
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
          "--network",
          "none",
          "-v",
          `${dir}:/w`,
          "--entrypoint",
          "python",
          image,
          "/w/driver.py",
          ...args.map((a) => a.replace(dir, "/w").replace(/\\/g, "/")),
        ],
        { encoding: "utf8", timeout: 300_000 },
      );
  }
  const probe = spawnSync("python", ["-c", "import pandas, numpy, sklearn, statsmodels, joblib"], {
    encoding: "utf8",
  });
  if (probe.status !== 0) return null;
  return (dir, args) =>
    spawnSync("python", [join(dir, "driver.py"), ...args], { encoding: "utf8", timeout: 300_000 });
}

const run = runner();
if (!run) {
  console.warn(
    "[mlForecastDrivers] no Python with pandas, scikit-learn and statsmodels, and ML_FORECAST_PY_IMAGE is not set: the trainer runs are SKIPPED, not passed.",
  );
}

type Trained = {
  error?: string;
  algorithm: string;
  meta: {
    drivers?: string[];
    drivers_effect?: { with: number | null; without: number | null; used: boolean } | null;
    drivers_assumed?: number;
    drivers_unplanned?: boolean;
  };
  schema: { name: string; role: string }[];
  on: number | null;
  off: number | null;
  leaderboard: string[];
  warnings: string[];
};

function train(kind: string): Trained {
  const dir = mkdtempSync(join(tmpdir(), "fcd-"));
  writeFileSync(join(dir, "train.py"), TRAIN_PY);
  writeFileSync(join(dir, "driver.py"), DRIVER);
  const res = run!(dir, [join(dir, "train.py"), kind]);
  if (res.status !== 0) throw new Error(`python failed: ${String(res.stderr).slice(-2000)}`);
  return JSON.parse(String(res.stdout).trim().split("\n").pop()!);
}

describe.skipIf(!run)("the forecasting trainer with drivers, run", () => {
  it("uses a driver that matters, and projects with the planned values", () => {
    const r = train("full");
    expect(["ridge_drivers", "gradient_boosting_drivers"]).toContain(r.algorithm);
    expect(r.meta.drivers).toEqual(["promo", "price"]);
    const e = r.meta.drivers_effect!;
    expect(e.used).toBe(true);
    // Built as 60 more on a promotion day: the backtest sees it…
    expect(e.with!).toBeLessThan(e.without! / 3);
    // …and so do the days ahead, where the plan says which days have one.
    expect(r.on! - r.off!).toBeGreaterThan(40);
    expect(r.meta.drivers_assumed).toBe(0);
    expect(r.schema.filter((c) => c.role === "driver").map((c) => c.name)).toEqual([
      "promo",
      "price",
    ]);
  }, 300_000);

  it("assumes the last known value for periods with no plan, and says how many", () => {
    const r = train("partial");
    expect(r.meta.drivers_assumed).toBe(9);
    expect(r.warnings).toContain(
      "9 of the 14 periods ahead had no value for a driver; the last known value was assumed for them. Add rows past the last actual, with the target empty, to say what is planned.",
    );
  }, 300_000);

  // FOUND FROM THE UI (R547): a real table with no rows past the last
  // actual. The drivers won a backtest they had the actual values for, and the
  // forecast then leaned on "the last value goes on" for every period ahead.
  it("does not use drivers when no period ahead is planned, and says what to add", () => {
    const r = train("unplanned");
    expect(r.meta.drivers_unplanned).toBe(true);
    expect(r.meta.drivers_assumed).toBe(14);
    expect(r.meta.drivers_effect).toBeNull();
    expect(["ridge_drivers", "gradient_boosting_drivers"]).not.toContain(r.algorithm);
    expect(r.leaderboard).not.toContain("ridge_drivers");
    expect(r.warnings).toContain(
      "None of the 14 periods ahead had a planned value for the drivers, so the forecast does not use them. Put the planned values in rows past the last actual, with the target empty.",
    );
    // Not also the "assumed for them" warning, which would contradict it.
    expect(r.warnings.some((w) => w.includes("the last known value was assumed"))).toBe(false);
  }, 300_000);

  it("does not use a driver that did not help, and says so", () => {
    const r = train("noise");
    expect(r.meta.drivers_effect!.used).toBe(false);
    expect(["ridge_drivers", "gradient_boosting_drivers"]).not.toContain(r.algorithm);
  }, 300_000);

  it("refuses a driver that is not a number, or is the series column", () => {
    expect(train("text").error).toBe(
      'The driver "promo" is not a number in any row: a driver must be numeric (a price, a count, a 0/1 flag).',
    );
    expect(train("series_col").error).toBe(
      '"region" is already the time, target or series column, so it cannot also be a driver.',
    );
  }, 300_000);

  it("is exactly the old trainer with no drivers", () => {
    const r = train("none");
    expect(r.meta.drivers).toEqual([]);
    expect(r.meta.drivers_effect).toBeNull();
    expect(r.leaderboard).not.toContain("ridge_drivers");
    expect(r.leaderboard).not.toContain("gradient_boosting_drivers");
    expect(r.schema.map((c) => c.role)).toEqual(["time", "target"]);
  }, 300_000);
});

// ── The words ────────────────────────────────────────────────────────────

describe("what the drivers were worth, in a sentence", () => {
  it("says when they helped, when they did not, and what was assumed", () => {
    expect(
      driversLine({
        drivers: ["promo", "price"],
        drivers_effect: { with: 2.1791, without: 24.5107, used: true },
        drivers_assumed: 0,
      }),
    ).toBe(
      "Known ahead: promo, price. With them the backtest error (RMSE) was 2.18, against 24.51 without, so the forecast uses them.",
    );
    expect(
      driversLine({
        drivers: ["promo"],
        drivers_effect: { with: 3.4, without: 3.1, used: false },
        drivers_assumed: 2,
      }),
    ).toBe(
      "Known ahead: promo. They did not help: the backtest error (RMSE) was 3.4 with them against 3.1 without, so the forecast does not use them. 2 periods ahead had no planned value, and the last known one was assumed.",
    );
    expect(
      driversLine({ drivers: ["promo"], drivers_effect: { with: null, without: 3, used: false } }),
    ).toBe(
      "Known ahead: promo. No method could use them on this history, so the forecast does not.",
    );
    expect(
      driversLine({
        drivers: ["payment_rows"],
        drivers_effect: null,
        drivers_assumed: 12,
        drivers_unplanned: true,
      }),
    ).toBe(
      "Known ahead: payment_rows. None of the 12 periods ahead had a planned value, so the forecast does not use them: put the planned values in rows past the last actual, with the target empty.",
    );
    expect(driversLine({ drivers: [] })).toBeNull();
    expect(driversLine(null)).toBeNull();
  });

  it("refuses what cannot be a driver", () => {
    const taken = { time: "day", target: "sales", series: "region" };
    expect(invalidDrivers(["promo"], taken)).toBeNull();
    for (const d of ["day", "sales", "region"]) {
      expect(invalidDrivers([d], taken), d).toContain("cannot also be known ahead");
    }
    expect(invalidDrivers(["a", "a"], taken)).toBe("A column was picked twice.");
    expect(
      invalidDrivers(
        Array.from({ length: MAX_FORECAST_DRIVERS + 1 }, (_, i) => `d${i}`),
        taken,
      ),
    ).toContain("At most 10");
  });
});

describe("a forecast proposed from chat", () => {
  const COLUMNS = [
    { name: "day", type: "DATE" },
    { name: "sales", type: "DOUBLE" },
    { name: "promo", type: "INTEGER" },
    { name: "region", type: "VARCHAR" },
  ];
  const base: MlTrainProposal = {
    name: "Sales",
    task: "forecast",
    source: { schema: "analytics", table: "sales" },
    target_column: "sales",
    time_column: "day",
  };

  it("takes number columns as known ahead, and says so in the approval", () => {
    const r = checkAgainstColumns({ ...base, feature_columns: ["promo"] }, COLUMNS);
    expect(r).toMatchObject({ ok: true, proposal: { feature_columns: ["promo"] } });
    if (r.ok) {
      expect(describeProposal(r.proposal).lines).toContain(
        "Known ahead: promo (kept only if they help the backtest).",
      );
    }
  });

  it("refuses a known-ahead column that is not a number", () => {
    expect(checkAgainstColumns({ ...base, feature_columns: ["region"] }, COLUMNS)).toMatchObject({
      ok: false,
      error: expect.stringContaining('"region" holds VARCHAR'),
    });
  });

  it("never takes the series column as a driver", () => {
    const r = checkAgainstColumns(
      { ...base, series_column: "region", feature_columns: ["region", "promo"] },
      COLUMNS,
    );
    expect(r.ok && r.proposal.feature_columns).toEqual(["promo"]);
  });
});

// ── The wiring ───────────────────────────────────────────────────────────

describe("the wiring", () => {
  it("the wizard sends a forecast's known-ahead columns as its feature columns", () => {
    const src = rd("src/routes/_authenticated/ml_.new.tsx");
    expect(src).toMatch(
      /feature_columns:\s*task === "forecast"\s*\?\s*forecastDrivers\.length\s*\?\s*forecastDrivers\s*:\s*undefined/,
    );
    expect(src).toContain('<Label className="text-xs">Known ahead (optional)</Label>');
  });

  it("creating a model refuses drivers that cannot be one", () => {
    const src = rd("src/utils/ml/create.server.ts");
    expect(src).toMatch(
      /if \(data\.task === "forecast" && data\.feature_columns\?\.length\) \{\s*const bad = invalidDrivers\(/,
    );
  });

  it("the model page says what the drivers were worth", () => {
    expect(rd("src/routes/_authenticated/ml_.$modelId.tsx")).toContain(
      "{!one && driversLine(meta) ? (",
    );
  });

  it("the trainer reads a forecast's feature columns as its drivers, and records it", () => {
    expect(TRAIN_PY).toContain("drivers = [c for c in (cfg.get('feature_columns') or []) if c]");
    expect(TRAIN_PY).toContain("'drivers': drivers, 'trainer_version': 4}");
    // String.raw: a backtick or a dollar-brace in the Python would end or
    // splice the template.
    expect(TRAIN_PY).not.toContain("`");
    expect(TRAIN_PY).not.toContain("${");
  });
});
