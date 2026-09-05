// Forecasting: the period is the user's choice and is said out loud.
//
// Found from Agent Chat: "the net revenue forecast for the next 3 periods"
// came back as the same number three times, well below every month the
// user had in mind. The trainer had inferred a DAILY series from dated
// orders, "naive last value" had won the holdout on that noisy series and
// projected the last (low) day flat, and nothing - not the page, not the
// tool, not the answer - said that a period was a day. What is pinned here
// is that a period is chosen, an incomplete last period is dropped, a flat
// baseline has a less brittle rival, and every surface names the period.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { TRAIN_PY } from "@/utils/ml/pyTrain";
import { ML_PERIODS, ML_PERIOD_LABEL, ML_PERIOD_PLURAL } from "@/utils/ml/types";
import { forecastNotes } from "@/utils/tools/registry.server";

const REPO = path.resolve(__dirname, "../..");
const rd = (p: string) => readFileSync(path.join(REPO, p), "utf8");

describe("the period is a choice", () => {
  it("is offered in the wizard, accepted by the schema, stored and handed to the trainer", () => {
    expect([...ML_PERIODS]).toEqual(["auto", "hour", "day", "week", "month", "quarter"]);
    for (const p of ML_PERIODS) expect(ML_PERIOD_LABEL[p]).toBeTruthy();
    const sql = rd("supabase/migrations/20260860000000_ml_forecast_period.sql");
    expect(sql).toContain("CHECK (period IN ('auto', 'hour', 'day', 'week', 'month', 'quarter'))");
    expect(rd("src/utils/ml.functions.ts")).toContain("period: z.enum(ML_PERIODS).optional(),");
    expect(rd("src/utils/ml.functions.ts")).toContain(
      'period: data.task === "forecast" ? (data.period ?? "auto") : "auto",',
    );
    expect(rd("src/utils/ml/train.server.ts")).toContain("period: b.model.period,");
    const wizard = rd("src/routes/_authenticated/ml_.new.tsx");
    expect(wizard).toContain("value={period}");
    expect(wizard).toContain('period: task === "forecast" ? period : undefined,');
    expect(wizard).toContain('<Row k="Period" v={ML_PERIOD_LABEL[period]} />');
  });

  it("overrides the inference in the trainer and records the period it used", () => {
    expect(TRAIN_PY).toContain(
      "_FREQ_BY_PERIOD = {'hour': 'h', 'day': 'D', 'week': 'W', 'month': 'MS', 'quarter': 'QS'}",
    );
    expect(TRAIN_PY).toContain(
      "freq = _FREQ_BY_PERIOD.get(cfg.get('period') or 'auto') or _infer_freq(s[tcol])",
    );
    expect(TRAIN_PY).toContain("'period': _PERIOD_NAME.get(freq, freq)");
    expect(TRAIN_PY).toContain("'periods': int(len(y))");
  });
});

describe("the series is honest", () => {
  it("drops a last period the data only partly covers, and says so", () => {
    expect(TRAIN_PY).toContain(
      "if typical > 0 and counts.iloc[-1] > 0 and counts.iloc[-1] < 0.5 * typical:",
    );
    expect(TRAIN_PY).toContain(
      "if typical > 0 and counts.iloc[0] > 0 and counts.iloc[0] < 0.5 * typical:",
    );
    expect(TRAIN_PY).toContain("was left out as incomplete.");
    expect(TRAIN_PY).toContain("y = y.iloc[:-1]");
  });

  it("gives the flat baseline a less brittle rival", () => {
    expect(TRAIN_PY).toContain("def moving_average(tr, steps):");
    expect(TRAIN_PY).toContain("return np.repeat(float(tr.iloc[-k:].mean()), steps)");
    expect(TRAIN_PY).toContain("consider('moving_average', moving_average)");
  });
});

describe("every surface names the period", () => {
  it("the agent tool and the API return the period, aggregation, last observed period and method", () => {
    const registry = rd("src/utils/tools/registry.server.ts");
    for (const f of [
      "period: meta?.period ?? null,",
      "aggregation: meta?.aggregation ?? null,",
      "last_observed_period: meta?.last_period ?? null,",
      "...forecastNotes(version.algorithm, meta),",
      "...versionCaveats(version.warnings),",
    ]) {
      expect(registry).toContain(f);
    }
    const route = rd("src/routes/api/ml.predict.ts");
    expect(route).toContain('if (auth.model.task === "forecast") {');
    expect(route).toContain("notes: forecastNotes(version.algorithm, stored?.meta ?? null),");
    const notes = forecastNotes("naive_last_value", {
      period: "day",
      aggregation: "sum",
      last_period: "2026-03-22",
      periods: 78,
    });
    expect(notes[0]).toContain("Each period is one day");
    expect(notes[0]).toContain("projected total");
    expect(notes[0]).toContain("ended with 2026-03-22 after 78 days");
    expect(notes[1]).toContain("repeats the last observed one, so the line is flat");
    expect(forecastNotes("moving_average", { period: "week", aggregation: "mean" })[1]).toContain(
      "mean of the most recent periods",
    );
    expect(forecastNotes("unknown_algo", null)).toHaveLength(1);
  });

  it("the model page says the granularity above the chart", () => {
    const page = rd("src/routes/_authenticated/ml_.$modelId.tsx");
    expect(page).toContain("ML_PERIOD_PLURAL[forecast.meta.period]");
    expect(page).toContain("projected ${forecast.points.length}");
    expect(ML_PERIOD_PLURAL.day).toBe("days");
  });

  it("the docs explain automatic periods, the dropped last period and the flat baselines", () => {
    for (const f of ["docs/ML.md", "src/routes/docs.ml.tsx"]) {
      // Prose wraps, so a phrase may straddle a line break.
      const doc = rd(f).toLowerCase().replace(/\s+/g, " ");
      expect(doc, f).toContain("moving average");
      expect(doc, f).toContain("left out");
      expect(doc, f).toContain("flat line");
    }
  });
});
