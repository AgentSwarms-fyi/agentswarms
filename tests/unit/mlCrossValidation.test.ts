// Reading how the winner was chosen.
//
// src/lib/mlCrossValidation.ts computes no metric of its own — it reads what
// _train_tabular wrote. So the failure worth testing is the SHAPE: a strategy
// renamed in Python, a fold list that arrives empty, a mean that turns up as a
// string. A fixture written by hand would encode my idea of the shape and keep
// passing straight through exactly that break.
//
// tests/fixtures/crossValidationMetrics.json is therefore produced by
// crossValidationMetrics.gen.py, which drives the REAL trainer over four
// configurations reaching four different branches of _cv_plan, and records
// beside each block the figures a reader may derive — recomputed there with
// numpy from the fold scores, by a different route than this module takes.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  deviationsFromFolds,
  holdoutGap,
  readCrossValidation,
  relativeSpread,
  selectionTouchedHoldout,
  spreadBand,
  strategyLabel,
  type MlCvStrategy,
} from "@/lib/mlCrossValidation";

const ORACLE = JSON.parse(readFileSync("tests/fixtures/crossValidationMetrics.json", "utf8")) as {
  cases: {
    name: string;
    metrics: unknown;
    algorithm: string;
    expected: {
      strategy: MlCvStrategy;
      folds: number;
      n_scores: number;
      mean: number | null;
      std: number;
      relative_spread: number | null;
      holdout_gap: number | null;
      higher_is_better: boolean;
      holdout_rows: number;
    };
  }[];
};

const caseNamed = (n: string) => {
  const c = ORACLE.cases.find((x) => x.name === n);
  if (!c) throw new Error(`fixture is missing the ${n} case`);
  return c;
};

describe("reading a real selection record", () => {
  it("the fixture reaches every branch the planner can take", () => {
    // Without this the loop below could be exercising one branch four times
    // and nobody would notice.
    expect([...new Set(ORACLE.cases.map((c) => c.expected.strategy))].sort()).toEqual([
      "inner_split",
      "kfold",
      "stratified",
      "timeseries",
    ]);
  });

  for (const c of ORACLE.cases) {
    describe(c.name, () => {
      it("finds the block the trainer wrote", () => {
        const cv = readCrossValidation(c.metrics);
        expect(cv).not.toBeNull();
        expect(cv!.strategy).toBe(c.expected.strategy);
        expect(cv!.folds).toBe(c.expected.folds);
      });

      it("keeps one score per fold", () => {
        const cv = readCrossValidation(c.metrics)!;
        expect(cv.scores).toHaveLength(c.expected.n_scores);
        expect(cv.scores.length).toBe(cv.folds);
      });

      it("agrees with an independent mean and spread", () => {
        const cv = readCrossValidation(c.metrics)!;
        expect(cv.mean).toBeCloseTo(c.expected.mean!, 5);
        expect(cv.std).toBeCloseTo(c.expected.std, 5);
      });

      it("knows which direction is better for its metric", () => {
        const cv = readCrossValidation(c.metrics)!;
        expect(cv.higher_is_better).toBe(c.expected.higher_is_better);
        expect(cv.metric).toBe(c.expected.higher_is_better ? "f1_macro" : "rmse");
      });

      it("reports the holdout separately from what selection saw", () => {
        // The whole change: these are two different numbers measured on two
        // different sets of rows, and collapsing them is what used to happen.
        const cv = readCrossValidation(c.metrics)!;
        expect(cv.holdout_value).not.toBeNull();
        expect(cv.holdout_rows).toBe(c.expected.holdout_rows);
        expect(cv.holdout_rows).toBeGreaterThan(0);
      });

      it("computes the holdout gap in the metric's own direction", () => {
        const cv = readCrossValidation(c.metrics)!;
        expect(holdoutGap(cv)).toBeCloseTo(c.expected.holdout_gap!, 5);
      });

      it("reports a relative spread only when folds disagree", () => {
        const cv = readCrossValidation(c.metrics)!;
        const rel = relativeSpread(cv);
        if (c.expected.relative_spread === null) expect(rel).toBeNull();
        else expect(rel).toBeCloseTo(c.expected.relative_spread, 5);
      });

      it("carries the trainer's reason for choosing this scheme", () => {
        expect(readCrossValidation(c.metrics)!.reason.length).toBeGreaterThan(10);
      });
    });
  }
});

describe("a single split has no spread, and does not pretend to", () => {
  const inner = caseNamed("inner_split");

  it("one score, zero spread, no band", () => {
    const cv = readCrossValidation(inner.metrics)!;
    expect(cv.scores).toHaveLength(1);
    expect(relativeSpread(cv)).toBeNull();
    expect(spreadBand(cv)).toBe("unmeasured");
  });

  it("and no deviation can be computed from it", () => {
    const cv = readCrossValidation(inner.metrics)!;
    expect(deviationsFromFolds(cv, 0.1)).toBeNull();
  });
});

describe("judging a later measurement against the folds", () => {
  const cls = caseNamed("classification_folds");
  const reg = caseNamed("regression_folds");

  it("a score at the fold mean is zero deviations away", () => {
    const cv = readCrossValidation(cls.metrics)!;
    expect(deviationsFromFolds(cv, cv.mean!)).toBeCloseTo(0, 9);
  });

  it("worse counts positive whichever way the metric runs", () => {
    // f1_macro: lower is worse. rmse: higher is worse. Both must report a
    // POSITIVE number of deviations when the model has got worse, or the sign
    // means something different depending on the task — which is exactly the
    // confusion the decay ratio was designed to avoid.
    const up = readCrossValidation(cls.metrics)!;
    const down = readCrossValidation(reg.metrics)!;
    expect(deviationsFromFolds(up, up.mean! - 2 * up.std!)).toBeCloseTo(2, 6);
    expect(deviationsFromFolds(down, down.mean! + 2 * down.std!)).toBeCloseTo(2, 6);
    expect(deviationsFromFolds(up, up.mean! + up.std!)).toBeCloseTo(-1, 6);
    expect(deviationsFromFolds(down, down.mean! - down.std!)).toBeCloseTo(-1, 6);
  });

  it("scales with the spread, so a wobbly model is judged more leniently", () => {
    const cv = readCrossValidation(cls.metrics)!;
    const drop = 0.05;
    const tight = { ...cv, std: 0.01 };
    const wide = { ...cv, std: 0.05 };
    expect(deviationsFromFolds(tight, cv.mean! - drop)!).toBeGreaterThan(
      deviationsFromFolds(wide, cv.mean! - drop)!,
    );
  });
});

describe("bands for how much a single number is worth", () => {
  const base = readCrossValidation(caseNamed("classification_folds").metrics)!;

  it("names the spread without pretending to precision", () => {
    expect(spreadBand({ ...base, mean: 0.6, std: 0.03 })).toBe("tight");
    expect(spreadBand({ ...base, mean: 0.6, std: 0.0301 })).toBe("moderate");
    expect(spreadBand({ ...base, mean: 0.6, std: 0.09 })).toBe("moderate");
    expect(spreadBand({ ...base, mean: 0.6, std: 0.0901 })).toBe("wide");
  });

  it("relative to the score, not absolute", () => {
    // 0.02 of spread is small on 0.95 and large on 0.05. A band that ignored
    // the scale would call both the same.
    expect(spreadBand({ ...base, mean: 0.95, std: 0.02 })).toBe("tight");
    expect(spreadBand({ ...base, mean: 0.05, std: 0.02 })).toBe("wide");
  });

  it("a mean of zero has no meaningful relative spread", () => {
    expect(relativeSpread({ ...base, mean: 0 })).toBeNull();
    expect(spreadBand({ ...base, mean: 0 })).toBe("unmeasured");
  });
});

describe("saying nothing rather than something wrong", () => {
  it("a version trained before this existed reads as unrecorded", () => {
    expect(readCrossValidation({ accuracy: 0.9 })).toBeNull();
    expect(selectionTouchedHoldout(null)).toBe(true);
  });

  it("and one trained after it is known not to have peeked", () => {
    for (const c of ORACLE.cases) {
      expect(selectionTouchedHoldout(readCrossValidation(c.metrics))).toBe(false);
    }
  });

  it("survives junk without inventing a fold count", () => {
    for (const junk of [null, undefined, 7, "metrics", [], { cross_validation: "yes" }]) {
      expect(readCrossValidation(junk)).toBeNull();
    }
  });

  it("an unknown strategy is not quietly accepted", () => {
    // A renamed strategy in Python must surface as "not recorded", not as a
    // block the panel renders with a blank label.
    expect(
      readCrossValidation({ cross_validation: { strategy: "bootstrap", folds: 5 } }),
    ).toBeNull();
  });

  it("drops fold scores that are not numbers", () => {
    const cv = readCrossValidation({
      cross_validation: { strategy: "kfold", folds: 3, scores: [0.5, "x", null, 0.7] },
    })!;
    expect(cv.scores).toEqual([0.5, 0.7]);
  });

  it("NaN is not a mean a reader should see", () => {
    const cv = readCrossValidation({
      cross_validation: { strategy: "kfold", folds: 3, mean: NaN, std: 0.1 },
    })!;
    expect(cv.mean).toBeNull();
    expect(relativeSpread(cv)).toBeNull();
    expect(holdoutGap(cv)).toBeNull();
  });

  it("a missing holdout value yields no gap rather than a reassuring zero", () => {
    const cv = readCrossValidation({
      cross_validation: { strategy: "kfold", folds: 3, mean: 0.5, scores: [0.4, 0.5, 0.6] },
    })!;
    expect(holdoutGap(cv)).toBeNull();
  });
});

describe("labels", () => {
  it("every strategy has plain words", () => {
    const seen = new Set<string>();
    for (const s of ["stratified", "kfold", "timeseries", "inner_split"] as MlCvStrategy[]) {
      const label = strategyLabel(s);
      expect(label.length).toBeGreaterThan(3);
      expect(seen.has(label)).toBe(false);
      seen.add(label);
    }
  });
});
