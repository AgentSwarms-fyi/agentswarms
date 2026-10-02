// Reading the trainer's calibration evidence.
//
// src/lib/mlCalibration.ts computes no metric of its own — it reads what the
// training program wrote. So the failure mode worth testing is the SHAPE: a
// key renamed in Python, a curve that arrives empty, a number that turns up as
// a string. A fixture I wrote by hand would encode my idea of the shape and
// would keep passing through exactly that break.
//
// tests/fixtures/calibrationMetrics.json is therefore produced by
// calibrationMetrics.gen.py, which execs the REAL functions out of TRAIN_PY on
// real sklearn models and writes the metrics block the trainer would store —
// together with the same figures recomputed a different way (numpy over the
// raw probabilities) so the reader cannot silently disagree with its source.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  balancedThreshold,
  calibrationBand,
  calibrationVerdict,
  effectiveScores,
  readCalibration,
  readThresholdSweep,
  sweepBounds,
  sweepRowAt,
  thresholdApplies,
  thresholdChange,
} from "@/lib/mlCalibration";

const ORACLE = JSON.parse(readFileSync("tests/fixtures/calibrationMetrics.json", "utf8")) as {
  cases: {
    name: string;
    metrics: unknown;
    expected: {
      calibrated: boolean;
      method: string | null;
      effective_brier: number;
      effective_calibration_error: number;
      at_070: { selected: number; precision: number; recall: number };
      best_f1_threshold: number;
      positive_label: string;
    };
  }[];
};

const caseNamed = (n: string) => {
  const c = ORACLE.cases.find((x) => x.name === n);
  if (!c) throw new Error(`fixture is missing the ${n} case`);
  return c;
};

describe("reading a real metrics block", () => {
  // Both branches of the acceptance rule have to be in the fixture or the
  // tests below are only ever exercising one of them.
  it("the fixture covers a kept calibration and a discarded one", () => {
    expect(ORACLE.cases.map((c) => c.expected.calibrated).sort()).toEqual([false, true]);
  });

  for (const c of ORACLE.cases) {
    describe(c.name, () => {
      it("finds the calibration block the trainer wrote", () => {
        const report = readCalibration(c.metrics);
        expect(report).not.toBeNull();
        expect(report!.calibrated).toBe(c.expected.calibrated);
        expect(report!.method).toBe(c.expected.method);
      });

      it("reports the scores of the model that was actually KEPT", () => {
        // The whole point of effectiveScores: when calibration was discarded,
        // the honest figure is the BEFORE one, and a reader shown the after
        // figure would be reading about a model that was thrown away.
        const report = readCalibration(c.metrics)!;
        const scores = effectiveScores(report);
        expect(scores.brier).toBeCloseTo(c.expected.effective_brier, 5);
        expect(scores.calibration_error).toBeCloseTo(c.expected.effective_calibration_error, 5);
      });

      it("keeps every bin of the curve", () => {
        const report = readCalibration(c.metrics)!;
        expect(report.before.curve.length).toBeGreaterThan(5);
        for (const bin of report.before.curve) {
          expect(bin.n).toBeGreaterThan(0);
          expect(bin.predicted).toBeGreaterThanOrEqual(0);
          expect(bin.predicted).toBeLessThanOrEqual(1);
          expect(bin.observed).toBeGreaterThanOrEqual(0);
          expect(bin.observed).toBeLessThanOrEqual(1);
        }
      });

      it("reads the sweep, and the row at 0.70 matches a hand count", () => {
        const sweep = readThresholdSweep(c.metrics)!;
        expect(sweep).not.toBeNull();
        expect(sweep.positive_label).toBe(c.expected.positive_label);
        const row = sweepRowAt(sweep, 0.7)!;
        expect(row.threshold).toBeCloseTo(0.7, 9);
        expect(row.selected).toBe(c.expected.at_070.selected);
        expect(row.precision).toBeCloseTo(c.expected.at_070.precision, 4);
        expect(row.recall).toBeCloseTo(c.expected.at_070.recall, 4);
      });

      it("agrees with the trainer about the balanced point", () => {
        const sweep = readThresholdSweep(c.metrics)!;
        expect(balancedThreshold(sweep)).toBeCloseTo(c.expected.best_f1_threshold, 9);
      });

      it("and the balanced point really is the best F1 in the table", () => {
        // Recomputed from the rows rather than trusting the field, because a
        // stale best_f1_threshold is exactly the sort of thing that survives a
        // change to the sweep and is never noticed.
        const sweep = readThresholdSweep(c.metrics)!;
        const best = sweep.rows.reduce((a, b) => (b.f1 > a.f1 ? b : a));
        expect(balancedThreshold(sweep)).toBeCloseTo(best.threshold, 9);
      });

      it("sorts the rows and reports the measured range", () => {
        const sweep = readThresholdSweep(c.metrics)!;
        const thresholds = sweep.rows.map((r) => r.threshold);
        expect([...thresholds].sort((a, b) => a - b)).toEqual(thresholds);
        const { min, max } = sweepBounds(sweep);
        expect(min).toBeCloseTo(0.05, 9);
        expect(max).toBeCloseTo(0.95, 9);
      });

      it("raising the line acts on fewer rows and catches less", () => {
        // Monotonicity is a property of the sweep, not of my arithmetic: if it
        // ever fails, the sweep is measuring something other than a threshold.
        const sweep = readThresholdSweep(c.metrics)!;
        for (let i = 1; i < sweep.rows.length; i++) {
          expect(sweep.rows[i].selected).toBeLessThanOrEqual(sweep.rows[i - 1].selected);
          expect(sweep.rows[i].recall).toBeLessThanOrEqual(sweep.rows[i - 1].recall + 1e-9);
        }
      });
    });
  }
});

describe("what changes when the line moves", () => {
  const noisy = caseNamed("noisy_forest");

  it("reports the difference between two measured rows", () => {
    const sweep = readThresholdSweep(noisy.metrics)!;
    const change = thresholdChange(sweep, 0.5, 0.7)!;
    const at50 = sweepRowAt(sweep, 0.5)!;
    const at70 = sweepRowAt(sweep, 0.7)!;
    expect(change.from.threshold).toBeCloseTo(0.5, 9);
    expect(change.to.threshold).toBeCloseTo(0.7, 9);
    expect(change.selected_delta).toBe(at70.selected - at50.selected);
    expect(change.precision_delta).toBeCloseTo(at70.precision - at50.precision, 9);
    expect(change.recall_delta).toBeCloseTo(at70.recall - at50.recall, 9);
  });

  it("raising it is fewer rows, and not an improvement everywhere", () => {
    const sweep = readThresholdSweep(noisy.metrics)!;
    const change = thresholdChange(sweep, 0.5, 0.8)!;
    expect(change.selected_delta).toBeLessThan(0);
    expect(change.recall_delta).toBeLessThan(0);
  });

  it("snaps to the nearest MEASURED point rather than interpolating", () => {
    // The trainer swept in steps of 0.05. Offering 0.437 would be a number the
    // platform never measured, presented with the same authority as one it did.
    const sweep = readThresholdSweep(noisy.metrics)!;
    expect(sweepRowAt(sweep, 0.437)!.threshold).toBeCloseTo(0.45, 9);
    expect(sweepRowAt(sweep, 0.0)!.threshold).toBeCloseTo(0.05, 9);
    expect(sweepRowAt(sweep, 1.0)!.threshold).toBeCloseTo(0.95, 9);
  });
});

describe("saying nothing rather than something wrong", () => {
  it("a version trained before this existed reads as unmeasured", () => {
    expect(readCalibration({ accuracy: 0.9 })).toBeNull();
    expect(readThresholdSweep({ accuracy: 0.9 })).toBeNull();
    expect(calibrationVerdict(null)).toBe("unmeasured");
  });

  it("survives junk without inventing numbers", () => {
    for (const junk of [null, undefined, 42, "metrics", [], { calibration: "yes" }]) {
      expect(readCalibration(junk)).toBeNull();
      expect(readThresholdSweep(junk)).toBeNull();
    }
  });

  it("a calibration block missing its scores is not half-read", () => {
    expect(readCalibration({ calibration: { calibrated: true, method: "isotonic" } })).toBeNull();
  });

  it("drops sweep rows that are not complete, and the sweep if none survive", () => {
    const partial = {
      threshold_sweep: {
        positive_label: "yes",
        rows: [
          { threshold: 0.5, precision: 0.8, recall: 0.7, f1: 0.74, selected: 10 },
          { threshold: 0.6, precision: 0.9, recall: 0.5 },
        ],
      },
    };
    expect(readThresholdSweep(partial)!.rows).toHaveLength(1);
    expect(readThresholdSweep({ threshold_sweep: { rows: [{ bad: 1 }] } })).toBeNull();
  });

  it("recomputes the balanced point when the trainer did not record one", () => {
    const noBest = {
      threshold_sweep: {
        positive_label: "yes",
        rows: [
          { threshold: 0.3, precision: 0.5, recall: 0.9, f1: 0.64, selected: 90 },
          { threshold: 0.6, precision: 0.9, recall: 0.6, f1: 0.72, selected: 60 },
          { threshold: 0.8, precision: 0.95, recall: 0.3, f1: 0.45, selected: 30 },
        ],
      },
    };
    expect(balancedThreshold(readThresholdSweep(noBest)!)).toBeCloseTo(0.6, 9);
  });

  it("NaN and Infinity are not numbers a reader should see", () => {
    const broken = {
      calibration: {
        calibrated: true,
        method: "isotonic",
        before: { brier: NaN, calibration_error: 0.1 },
      },
    };
    expect(readCalibration(broken)).toBeNull();
  });
});

describe("who gets a threshold at all", () => {
  it("only a two-class classifier", () => {
    expect(thresholdApplies("classification", 2)).toBe(true);
    expect(thresholdApplies("classification", 3)).toBe(false);
    expect(thresholdApplies("classification", null)).toBe(false);
    expect(thresholdApplies("regression", 2)).toBe(false);
    expect(thresholdApplies("forecast", 2)).toBe(false);
  });

  it("and the trainer agrees: no sweep is written for anything else", () => {
    // The panel gates on the sweep's presence, so the two rules have to say the
    // same thing. Both fixture cases are binary and both carry a sweep.
    for (const c of ORACLE.cases) {
      expect(readThresholdSweep(c.metrics)).not.toBeNull();
    }
  });
});

describe("how far off the confidence column can be", () => {
  it("bands the calibration error without pretending to precision", () => {
    expect(calibrationBand(0.0)).toBe("tight");
    expect(calibrationBand(0.05)).toBe("tight");
    expect(calibrationBand(0.0501)).toBe("usable");
    expect(calibrationBand(0.15)).toBe("usable");
    expect(calibrationBand(0.1501)).toBe("loose");
    expect(calibrationBand(0.9)).toBe("loose");
  });

  it("the real cases land where the numbers say they should", () => {
    for (const c of ORACLE.cases) {
      const report = readCalibration(c.metrics)!;
      const ece = effectiveScores(report).calibration_error;
      const band = calibrationBand(ece);
      if (ece <= 0.05) expect(band).toBe("tight");
      else if (ece <= 0.15) expect(band).toBe("usable");
      else expect(band).toBe("loose");
    }
  });

  it("a discarded calibration is still reported as measured, not as a failure", () => {
    const discarded = caseNamed("small_clean");
    expect(calibrationVerdict(readCalibration(discarded.metrics))).toBe("rejected");
    // And the figures are still there to read — "rejected" is a statement
    // about the remapping, not about whether anything was measured.
    expect(effectiveScores(readCalibration(discarded.metrics)!).calibration_error).toBeGreaterThan(
      0,
    );
  });
});
