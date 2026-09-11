// Recomputing a model's own metric on rows that now have an answer.
//
// The numbers here are NOT of my own making. tests/fixtures/sklearnMetrics.json
// was produced by tests/fixtures/sklearnMetrics.gen.py running inside
// agentswarms/notebook-runtime — the same image the trainer uses — so every
// expectation below is sklearn's answer to the same input. Testing my formula
// against my own arithmetic would have proved that it equals itself, which is
// the failure this whole file exists to avoid: the baseline a decay alert
// compares against came out of sklearn, so a second, defensible definition of
// "macro F1" would fire a false alert on day one and teach everyone to ignore
// the alerts.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  MAX_OUTCOME_KEY_COLUMNS,
  classificationMetrics,
  coverage,
  coverageSql,
  decayRatio,
  evaluationSql,
  evaluationVerdict,
  higherIsBetter,
  regressionMetrics,
  validateOutcomeSource,
  type MlClassCount,
  type MlOutcomeSource,
  type MlRegressionAgg,
} from "@/lib/mlEvaluation";

const ORACLE = JSON.parse(readFileSync("tests/fixtures/sklearnMetrics.json", "utf8")) as {
  classification: {
    counts: MlClassCount[];
    f1_macro: number;
    accuracy: number;
    classes: number;
  }[];
  regression: { agg: MlRegressionAgg; rmse: number; mae: number; r2: number | null }[];
};

const src = (over: Partial<MlOutcomeSource> = {}): MlOutcomeSource => ({
  schema: "analytics",
  table: "plan_outcomes",
  key_columns: ["customer_id"],
  outcome_column: "actual_plan",
  ...over,
});

describe("the metrics agree with sklearn, case for case", () => {
  it("has fixtures to compare against, so an empty file cannot pass", () => {
    // Mutation-checked: emptying the fixture made every assertion below
    // vacuous. This is the tripwire.
    expect(ORACLE.classification.length).toBeGreaterThanOrEqual(5);
    expect(ORACLE.regression.length).toBeGreaterThanOrEqual(3);
  });

  it.each(ORACLE.classification.map((c, i) => [i, c] as const))(
    "classification case %i matches f1_macro and accuracy",
    (_i, c) => {
      const got = classificationMetrics(c.counts);
      expect(got.primary_name).toBe("f1_macro");
      expect(got.primary).toBeCloseTo(c.f1_macro, 10);
      expect(got.extra.accuracy).toBeCloseTo(c.accuracy, 10);
      expect(got.extra.classes).toBe(c.classes);
      expect(got.matched).toBe(c.counts.reduce((s, x) => s + x.n, 0));
    },
  );

  it.each(ORACLE.regression.map((r, i) => [i, r] as const))(
    "regression case %i matches rmse, mae and r2",
    (_i, r) => {
      const got = regressionMetrics(r.agg);
      expect(got.primary_name).toBe("rmse");
      expect(got.primary).toBeCloseTo(r.rmse, 9);
      expect(got.extra.mae).toBeCloseTo(r.mae, 9);
      if (r.r2 === null) {
        // Every actual identical: there is no variance to explain, so the
        // ratio is undefined. Reporting 0 would read as "explains nothing".
        expect(got.extra.r2).toBeNull();
      } else {
        expect(got.extra.r2).toBeCloseTo(r.r2, 9);
      }
    },
  );

  it("averages over classes the model never predicted", () => {
    // The case macro F1 exists for, called out by name because it is the one
    // an accuracy-shaped intuition gets wrong: predicting "a" for everything
    // when a third of the rows are "a" scores 0.5 accuracy and 0.22 macro F1.
    const c = ORACLE.classification[1]!;
    expect(c.accuracy).toBeCloseTo(0.5, 6);
    expect(classificationMetrics(c.counts).primary).toBeCloseTo(0.2222222, 6);
  });
});

describe("the statement that measures a scored table", () => {
  it("inner-joins, so a prediction with no answer yet is not a wrong one", () => {
    const sql = evaluationSql("classification", { schema: "ml", table: "scored" }, src());
    expect(sql).toContain(" JOIN ");
    expect(sql).not.toMatch(/LEFT\s+JOIN/i);
    // A pending answer counted as wrong would make every model look worse the
    // fresher its predictions are.
  });

  it("compares labels as text and keys as they are", () => {
    const sql = evaluationSql("classification", { schema: "ml", table: "scored" }, src());
    expect(sql).toContain('CAST(p."prediction" AS VARCHAR) AS predicted');
    expect(sql).toContain('CAST(a."actual_plan" AS VARCHAR) AS actual');
    // Casting the KEY to text is how an integer key silently stops matching a
    // key stored as a decimal — so it is compared as it is.
    expect(sql).toContain('p."customer_id" = a."customer_id"');
    expect(sql).not.toMatch(/CAST\(p\."customer_id"/);
  });

  it("joins on every key column of a composite key", () => {
    const sql = evaluationSql(
      "classification",
      { schema: "ml", table: "scored" },
      src({ key_columns: ["tenant", "customer_id"] }),
    );
    expect(sql).toContain('p."tenant" = a."tenant" AND p."customer_id" = a."customer_id"');
  });

  it("drops rows whose outcome is still null", () => {
    // An outcome table often carries the row before the answer, with the
    // column null until it arrives. Scoring those as wrong is the same bug as
    // counting unmatched rows.
    for (const task of ["classification", "regression"] as const) {
      expect(evaluationSql(task, { schema: "ml", table: "s" }, src())).toContain(
        'a."actual_plan" IS NOT NULL',
      );
    }
  });

  it("returns the five sums for a regression, not a metric", () => {
    const sql = evaluationSql("regression", { schema: "ml", table: "scored" }, src());
    for (const part of ["AS n", "AS sse", "AS sae", "AS sy", "AS syy"]) {
      expect(sql, part).toContain(part);
    }
    // The formula lives in TypeScript, where it can be compared to sklearn.
    expect(sql).not.toMatch(/sqrt/i);
  });

  it("treats a forecast like a regression", () => {
    const f = evaluationSql("forecast", { schema: "ml", table: "s" }, src());
    const r = evaluationSql("regression", { schema: "ml", table: "s" }, src());
    expect(f).toBe(r);
  });

  it("quotes identifiers, and doubles a quote inside one", () => {
    const sql = evaluationSql(
      "classification",
      { schema: "ml", table: 'we"ird' },
      src({ schema: "an alytics" }),
    );
    expect(sql).toContain('"we""ird"');
    expect(sql).toContain('"an alytics"');
  });

  it("counts the scored rows separately, for coverage", () => {
    expect(coverageSql({ schema: "ml", table: "scored" })).toBe(
      'SELECT count(*) AS n FROM "ml"."scored"',
    );
  });
});

describe("what a configuration may be", () => {
  it("accepts a plain one", () => {
    expect(validateOutcomeSource(src())).toBeNull();
  });

  it.each([
    [src({ key_columns: [] }), /at least one key/i],
    [
      src({
        key_columns: Array(MAX_OUTCOME_KEY_COLUMNS + 1)
          .fill(0)
          .map((_, i) => `k${i}`),
      }),
      /at most/i,
    ],
    [src({ key_columns: ["a", "a"] }), /named twice/i],
    [src({ key_columns: ["actual_plan"] }), /cannot also be a key/i],
    [src({ table: "" }), /table holding the outcomes/i],
    [src({ outcome_column: "drop table x" }), /not a column or table name/i],
    [src({ schema: "a;b" }), /not a column or table name/i],
  ])("refuses %#", (bad, why) => {
    expect(validateOutcomeSource(bad)).toMatch(why);
  });

  it("refuses anything that is not an identifier, which is what makes quoting safe", () => {
    // The SQL builder quotes; this is what stops a name needing more than
    // quoting. Both halves, or neither works.
    expect(validateOutcomeSource(src({ outcome_column: 'x" OR "1"="1' }))).toMatch(/not a column/i);
  });
});

describe("decay, and the word attached to it", () => {
  it("reads the same way for a metric of either direction", () => {
    // 10% worse is 0.10 whether bigger is better or smaller is.
    expect(decayRatio(0.72, 0.8, "f1_macro")).toBeCloseTo(0.1, 10);
    expect(decayRatio(11, 10, "rmse")).toBeCloseTo(0.1, 10);
    // And 10% better is -0.10 in both.
    expect(decayRatio(0.88, 0.8, "f1_macro")).toBeCloseTo(-0.1, 10);
    expect(decayRatio(9, 10, "rmse")).toBeCloseTo(-0.1, 10);
  });

  it("knows which way each metric points", () => {
    expect(higherIsBetter("f1_macro")).toBe(true);
    expect(higherIsBetter("accuracy")).toBe(true);
    expect(higherIsBetter("rmse")).toBe(false);
    expect(higherIsBetter("mae")).toBe(false);
  });

  it("has no answer rather than a wrong one when there is no baseline", () => {
    expect(decayRatio(0.7, null, "f1_macro")).toBeNull();
    expect(decayRatio(0.7, undefined, "f1_macro")).toBeNull();
    expect(decayRatio(0.7, Number.NaN, "f1_macro")).toBeNull();
    // A relative change from zero is not a number.
    expect(decayRatio(0.7, 0, "f1_macro")).toBeNull();
    expect(evaluationVerdict(null, 0.1)).toBeNull();
  });

  it("calls a big improvement out instead of celebrating it", () => {
    // A model markedly BETTER than its own validation score is usually the
    // outcome column leaking into the features, or a join matching the wrong
    // rows. It earns a look, not a green tick.
    expect(evaluationVerdict(-0.4, 0.1)).toBe("improved");
    expect(evaluationVerdict(0.4, 0.1)).toBe("degraded");
    expect(evaluationVerdict(0.05, 0.1)).toBe("stable");
    expect(evaluationVerdict(-0.05, 0.1)).toBe("stable");
    // Exactly at the threshold is over it, in both directions.
    expect(evaluationVerdict(0.1, 0.1)).toBe("degraded");
    expect(evaluationVerdict(-0.1, 0.1)).toBe("improved");
  });

  it("reports coverage, because a metric over 6% of the rows is not the metric", () => {
    expect(coverage(60, 1000)).toBeCloseTo(0.06, 10);
    expect(coverage(0, 0)).toBe(0);
  });
});
