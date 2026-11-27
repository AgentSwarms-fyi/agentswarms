// Inputs that stop arriving (R549).
//
// Drift measures the values that arrived, so a feed that stopped sending a
// field read as stable while every row was scored on a filled-in value. The
// missing share is now counted in three places — training, a batch run, an
// online request — and the fixture generated in the sandbox image holds the
// three to one count. Then the rule, the words, and where it travels.
//
// The finished batch run is driven for real over an in-memory table in
// mlMissingInputsBatch.test.ts; the hourly check in mlTraffic.test.ts.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  MISSING_MIN_ROWS,
  MISSING_RISE,
  MISSING_UNKNOWN_FLOOR,
  missingFromProfile,
  missingInputs,
  missingLine,
  missingRatesOf,
  sharePct,
  type MissingRates,
} from "@/lib/mlMissingInputs";
import { MISSING_INPUTS_ALERT, describeModelHealth, healthLine } from "@/lib/mlHealth";
import { attentionItems } from "@/lib/mlConsole";
import {
  featureStatsOf,
  mergeProfiles,
  profileRows,
  trafficDrift,
  type FeatureStats,
} from "@/lib/mlTraffic";

const rd = (p: string) => readFileSync(p, "utf8");
const codeOnly = (s: string) => s.replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const fixture = JSON.parse(rd("tests/fixtures/trafficDriftParity.json")) as {
  cases: { stats: unknown; rows: Record<string, unknown>[]; expected_missing: MissingRates }[];
  training: { rows: Record<string, unknown>[]; stats: Record<string, { missing: number }> };
};

function expectRates(got: MissingRates, want: MissingRates) {
  expect(got.rows).toBe(want.rows);
  expect(Object.keys(got.rates).sort()).toEqual(Object.keys(want.rates).sort());
  for (const [k, v] of Object.entries(want.rates)) expect(got.rates[k], k).toBeCloseTo(v, 4);
}

describe("one count, in all three places", () => {
  for (const [i, c] of fixture.cases.entries()) {
    const stats = featureStatsOf(c.stats) as FeatureStats;

    it(`case ${i + 1}: an online request's counts give _missing_rates on the same rows`, () => {
      expectRates(missingFromProfile(stats, profileRows(stats, c.rows)), c.expected_missing);
    });

    it(`case ${i + 1}: a request at a time, summed, gives the same`, () => {
      const summed = c.rows
        .map((r) => profileRows(stats, [r]))
        .reduce((a, b) => mergeProfiles(a, b));
      expectRates(missingFromProfile(stats, summed), c.expected_missing);
    });
  }

  it("the awkward rows are what they claim: absent, never sent, text that is not a number", () => {
    const rates = fixture.cases[0].expected_missing.rates;
    expect(rates.absent).toBe(1);
    expect(rates.sparse).toBeCloseTo(1 - 6 / 260, 4);
    // "n/a" in a number column counts as empty, as the pipeline then fills it.
    expect(rates.amount).toBeGreaterThan(0);
    // Every value sent in case 2 was usable: nothing listed.
    expect(fixture.cases[1].expected_missing.rates).toEqual({});
  });

  it("an empty category is a missing input, not drift (FOUND IN THE UI TEST)", () => {
    // A batch whose region arrived empty read as PSI 17 — all "other" — and
    // raised a drift alert that could start a retrain. A category now needs
    // ten values to be compared, as a number always did.
    const c = fixture.cases[2] as (typeof fixture.cases)[number] & {
      expected: { features: Record<string, number> };
    };
    expect(Object.keys(c.expected.features)).toEqual(["plan"]);
    expect(c.expected_missing.rates).toEqual({ region: 1, channel: 0.7 });
    const stats = featureStatsOf(c.stats) as FeatureStats;
    expect(trafficDrift(stats, profileRows(stats, c.rows))?.features).toEqual(c.expected.features);
  });

  it("training records the share it counted, and the same rows counted online agree", () => {
    const stats = featureStatsOf(fixture.training.stats) as FeatureStats;
    // 30 nulls and 6 "n/a" in 120 rows; 12 null segments; age always there.
    expect(stats.income.missing).toBe(0.3);
    expect(stats.segment.missing).toBe(0.1);
    expect(stats.age.missing).toBe(0);
    const online = missingFromProfile(stats, profileRows(stats, fixture.training.rows));
    expect(online.rates).toEqual({ income: 0.3, segment: 0.1 });
  });

  it("was generated from the program the sandbox runs, not written by hand", () => {
    const gen = rd("tests/fixtures/trafficDriftParity.gen.py");
    expect(gen).toContain(
      '_missing_rates = cut("def _missing_rates(stats, df):")["_missing_rates"]',
    );
    expect(gen).toContain(
      '_feature_stats = cut("def _feature_stats(df, schema, features):")["_feature_stats"]',
    );
    const py = rd("src/utils/ml/pyTrain.ts");
    // Scoring counts and returns them; training records them beside the bins.
    expect(py).toContain(
      "missing_rates = _missing_rates(art.get('feature_stats'), df) if art.get('feature_stats') else None",
    );
    expect(py).toContain("'drift': drift, 'missing': missing_rates,");
    expect(py).toContain("'missing': round(1.0 - len(v) / rows, 4)}");
    expect(py).toContain("'missing': round(float(s.isna().sum()) / rows, 4)}");
    // And _drift's category floor, which the fixture's third case was cut from.
    const drift = py.slice(py.indexOf("def _drift(stats, df):"), py.indexOf("def _missing_rates("));
    expect(drift).toContain("if int(s.notna().sum()) < 10:");
  });
});

describe("the rule", () => {
  const stats: FeatureStats = {
    income: { kind: "numeric", edges: [0, 1, 2], props: [0.5, 0.5], missing: 0.05 },
    plan: { kind: "categorical", props: { a: 1 }, other: 0, missing: 0 },
    legacy: { kind: "numeric", edges: [0, 1, 2], props: [0.5, 0.5] },
  };
  const at = (rates: Record<string, number>, rows = 500) => missingInputs(stats, { rows, rates });

  it("names a feature ten points above its training share, and not a hair below", () => {
    expect(MISSING_RISE).toBe(0.1);
    expect(at({ income: 0.15 })).toEqual([{ feature: "income", rate: 0.15, training: 0.05 }]);
    expect(at({ income: 0.1499 })).toEqual([]);
    // A share as high as training's is not news, however high.
    expect(at({ plan: 0.0999 })).toEqual([]);
  });

  it("a version trained before shares were recorded: only when it all but stopped", () => {
    expect(MISSING_UNKNOWN_FLOOR).toBe(0.95);
    expect(at({ legacy: 0.94 })).toEqual([]);
    expect(at({ legacy: 0.95 })).toEqual([{ feature: "legacy", rate: 0.95, training: null }]);
  });

  it("says nothing below its minimum rows, and [] when nothing rose", () => {
    expect(at({ income: 1 }, MISSING_MIN_ROWS - 1)).toBeNull();
    expect(at({ income: 1 }, MISSING_MIN_ROWS)).toHaveLength(1);
    expect(at({})).toEqual([]);
  });

  it("largest rise first, then by name", () => {
    expect(at({ income: 0.55, plan: 0.5, legacy: 1 })?.map((m) => m.feature)).toEqual([
      "legacy",
      "income",
      "plan",
    ]);
    // The same rise: by name.
    expect(at({ plan: 1, legacy: 1 })?.map((m) => m.feature)).toEqual(["legacy", "plan"]);
  });

  it("reads only the trainer's shape back", () => {
    for (const bad of [null, {}, { rows: -1, rates: {} }, { rows: 5, rates: [] }, { rows: "5" }]) {
      expect(missingRatesOf(bad), JSON.stringify(bad)).toBeNull();
    }
    expect(missingRatesOf({ rows: 9, rates: { a: 0.5, b: 2, c: "x", d: -1 } })).toEqual({
      rows: 9,
      rates: { a: 0.5 },
    });
  });

  it("keeps a training share only when it is one", () => {
    const st = featureStatsOf({
      a: { kind: "numeric", edges: [0, 1], props: [1], missing: 0.2 },
      b: { kind: "numeric", edges: [0, 1], props: [1], missing: 1.5 },
      c: { kind: "categorical", props: { x: 1 }, missing: "0.1" },
    }) as FeatureStats;
    expect(st.a.missing).toBe(0.2);
    expect(st.b).not.toHaveProperty("missing");
    expect(st.c).not.toHaveProperty("missing");
  });
});

describe("the words", () => {
  it("shares as a person reads them", () => {
    expect([0, 0.004, 0.38, 0.996, 1].map(sharePct)).toEqual([
      "0%",
      "under 1%",
      "38%",
      "over 99%",
      "100%",
    ]);
  });

  it("names three, then counts the rest", () => {
    expect(
      missingLine([
        { feature: "income", rate: 0.38, training: 0.02 },
        { feature: "region", rate: 1, training: null },
        { feature: "plan", rate: 0.5, training: 0 },
        { feature: "age", rate: 0.4, training: 0 },
      ]),
    ).toBe(
      "income empty in 38% of rows (2% in training), region in 100% (not recorded at training), plan in 50% (0% in training), and 1 more",
    );
  });
});

describe("in the model's health", () => {
  const traffic = { source: "traffic" as const, count: 2, at: "2026-11-27T13:00:00Z" };
  const batch = { source: "batch" as const, count: 1, at: "2026-11-26T08:00:00Z" };

  it("an alert per source, the count and not the names", () => {
    const h = describeModelHealth(null, null, null, [traffic, batch]);
    expect(h.alerts).toEqual([
      "Missing inputs: in the last day of online requests, checked on 2026-11-27, 2 features the model uses arrived empty far more often than in training, so those rows were scored on filled-in values; check what sends the data before trusting those predictions (retraining will not fix it).",
      "Missing inputs: in the rows scored on 2026-11-26, 1 feature the model uses arrived empty far more often than in training, so those rows were scored on filled-in values; check what sends the data before trusting those predictions (retraining will not fix it).",
    ]);
    expect(h.summary).toBe(
      "missing inputs (2 features the model uses, live traffic on 2026-11-27); missing inputs (1 feature the model uses, a batch run on 2026-11-26)",
    );
    expect(healthLine(h)?.startsWith("Health: Missing inputs:")).toBe(true);
    expect(Object.keys(traffic)).toEqual(["source", "count", "at"]);
  });

  it("stays quiet with nothing missing, and stands after drift and decay", () => {
    expect(describeModelHealth(null, null, null, []).alerts).toEqual([]);
    expect(describeModelHealth(null, null, null, [{ ...batch, count: 0 }]).summary).toBeNull();
    const both = describeModelHealth(
      { score: 1, threshold: 0.25, at: "2026-11-26T00:00:00Z" },
      null,
      null,
      [batch],
    );
    expect(both.alerts.map((a) => a.split(":")[0])).toEqual(["Drift", "Missing inputs"]);
  });

  it("is sent to the Predictions tab in ML operations, where the card and the runs are", () => {
    const a = describeModelHealth(null, null, null, [traffic]).alerts[0];
    expect(a.startsWith(MISSING_INPUTS_ALERT)).toBe(true);
    const items = attentionItems({
      names: new Map([["m1", "churn"]]),
      failedJobs: [],
      failedPredictions: [],
      endpoints: [],
      schedules: [],
      health: new Map([["m1", [a]]]),
    });
    expect(items.map((i) => i.tab)).toEqual(["predictions"]);
  });

  it("is read from the hourly check and the newest counted run, and never fails health", () => {
    const code = codeOnly(rd("src/utils/ml/health.server.ts"));
    expect(code).toContain('const full = await read("version_id, score, checked_at, missing");');
    expect(code).toContain('const plain = await read("version_id, score, checked_at");');
    expect(code).toContain("if (plain.error) return [];");
    expect(code).toMatch(
      /\.select\("version_id, created_at, missing:result->missing"\)[\s\S]{0,200}\.not\("result->>missing", "is", null\)/,
    );
    // FOUND IN REVIEW: a run that could not count stores a JSON null, which
    // `->` passes as a value; it hid an older run that had named a feature.
    expect(code).toContain(
      "if (!p.version_id || seen.has(p.version_id) || !Array.isArray(p.missing)) continue;",
    );
    expect(code).toMatch(/missing\.get\(v\) \?\? \[\],\s*\)/);
  });
});

describe("where it shows", () => {
  it("the run keeps its verdict in the stored result, which is a whitelist", () => {
    const code = codeOnly(rd("src/utils/ml/predict.server.ts"));
    expect(code).toContain("missing: missing as unknown as Json,");
    expect(code).toContain('.select("version, feature_stats")');
  });

  it("the live card names the features, and the runs table marks a run", () => {
    expect(rd("src/components/ml/LiveTrafficCard.tsx")).toContain("Arriving empty:");
    const panel = rd("src/components/ml/PredictionsPanel.tsx");
    expect(panel).toContain("<MissingBadge row={r} />");
    expect(panel).toContain('{list.length} input{list.length === 1 ? "" : "s"} empty');
  });

  it("its migration only adds, and the hourly check claims its own alert", () => {
    const sql = rd("supabase/migrations/20261209000000_ml_missing_inputs.sql");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS missing jsonb");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS missing_alerted_at timestamptz");
    expect(sql).not.toMatch(/\bDROP\b|\bRENAME\b/i);
    const traffic = codeOnly(rd("src/utils/ml/traffic.server.ts"));
    expect(traffic).toContain('claimAlert(t.versionId, now, "missing_alerted_at")');
    // It starts nothing: the only workflow start is the drift alert's.
    expect(traffic.match(/alertStarts\(/g)).toHaveLength(1);
  });
});
