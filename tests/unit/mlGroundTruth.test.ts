// The wiring around ground-truth evaluation.
//
// src/lib/mlEvaluation.ts is checked against sklearn in mlEvaluation.test.ts.
// This file checks the things that are not arithmetic and that fail SILENTLY
// when they are wrong: which user the lake is read as, whether an empty join
// becomes a score of zero, whether the sweep is actually called, and whether
// the admin setting reaches the code that reads it.
//
// That last one was nearly shipped broken. `getPlatformResources` selects an
// explicit column list; a knob added to the type, the form, the zod schema and
// the table — but not to that list — reads as "not set" for ever, so the admin
// page saves a value that never applies and says nothing.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const rd = (p: string) => readFileSync(p, "utf8");
const EVALUATE = rd("src/utils/ml/evaluate.server.ts");
const CONFIG = rd("src/utils/notebookRuntime/config.server.ts");
const CRON = rd("src/utils/bi/refresh.server.ts");
const FUNCTIONS = rd("src/utils/ml.functions.ts");
const MIGRATION = rd("supabase/migrations/20260903000000_ml_ground_truth.sql");

describe("the lake is read as the model's owner", () => {
  it("passes the owner's id to every statement, never the caller's", () => {
    // A grantee may trigger an evaluation. If the read ran as THEM it would
    // fail on a schema they cannot see; if it ran as them with the owner's
    // table name it would be a way to read a schema through someone else's
    // model. Both are avoided by the same line.
    expect(EVALUATE).toMatch(/const owner = model\.user_id;/);
    const reads = [...EVALUATE.matchAll(/runLakehouseStatement\(\s*([A-Za-z_.]+)/g)].map(
      (m) => m[1],
    );
    expect(reads.length, "statements are run at all").toBeGreaterThanOrEqual(2);
    for (const who of reads) expect(who, "read as the owner").toBe("owner");
  });

  it("checks the configured table as the owner when it is saved", () => {
    // The probe that catches a typo at save time has the same rule.
    const fn = FUNCTIONS.slice(FUNCTIONS.indexOf("mlSetOutcomeSource"));
    const probe = fn.slice(0, fn.indexOf("mlListEvaluations"));
    expect(probe).toMatch(/runLakehouseStatement\(\s*model\.user_id/);
    expect(probe).toContain("LIMIT 0");
  });

  it("demands ownership to configure, and accepts a grant to read", () => {
    const set = FUNCTIONS.slice(FUNCTIONS.indexOf("mlSetOutcomeSource"));
    expect(set.slice(0, set.indexOf("mlListEvaluations"))).toMatch(
      /loadModelForUser\([^)]*\{ write: true \}/s,
    );
    const list = FUNCTIONS.slice(FUNCTIONS.indexOf("mlListEvaluations"));
    const listBody = list.slice(0, list.indexOf("mlEvaluatePrediction"));
    expect(listBody).toMatch(/loadModelForUser\(data\.model_id, userId\)/);
    // A grantee sees what they caused; the owner sees everything.
    expect(listBody).toMatch(/if \(shared\) q = q\.eq\("user_id", userId\)/);
  });
});

describe("an empty join is an error, not a score", () => {
  it("refuses to record a metric when nothing matched", () => {
    // Zero matched rows means the keys do not line up. Recording it as a
    // metric would draw a point on the chart meaning "nobody answered", which
    // is indistinguishable from "the model got everything wrong".
    expect(EVALUATE).toMatch(/if \(metrics\.matched === 0\)/);
    const at = EVALUATE.indexOf("if (metrics.matched === 0)");
    const block = EVALUATE.slice(at, at + 600);
    expect(block).toMatch(/ok: false/);
    expect(block).toMatch(/No scored row found an outcome/);
    // And it names the columns to check, rather than saying "no data".
    expect(block).toMatch(/key_columns\.join/);
  });

  it("refuses a confusion matrix that is really free text", () => {
    expect(EVALUATE).toContain("MAX_CONFUSION_PAIRS");
    const at = EVALUATE.indexOf("measured.row_count > MAX_CONFUSION_PAIRS");
    expect(at).toBeGreaterThan(-1);
    expect(EVALUATE.slice(at, at + 400)).toMatch(/free text rather than a label/);
  });

  it("only measures a run that succeeded and wrote a table", () => {
    expect(EVALUATE).toMatch(/prediction\.status !== "succeeded"/);
    expect(EVALUATE).toMatch(/output\?\.schema \|\| !output\?\.table/);
  });

  it("will not measure a task that has no outcome", () => {
    // Clustering has no truth to be right about.
    expect(EVALUATE).toMatch(
      /EVALUABLE = new Set\(\["classification", "regression", "forecast"\]\)/,
    );
    expect(EVALUATE).toMatch(/!EVALUABLE\.has\(model\.task\)/);
  });
});

describe("the threshold reaches the code that reads it", () => {
  it("is selected from the settings row, not only declared", () => {
    // The silent failure this whole describe exists for.
    const select = CONFIG.slice(CONFIG.indexOf("lakehouse_memory_limit"));
    expect(
      select.slice(0, select.indexOf('"')),
      "ml_decay_alert_ratio missing from the settings SELECT — the admin value would never apply",
    ).toContain("ml_decay_alert_ratio");
  });

  it("falls back through the row, then the env, then a default", () => {
    expect(CONFIG).toMatch(
      /mlDecayAlertRatio:\s*positiveNum\(data\?\.ml_decay_alert_ratio\) \?\? envNum\("ML_DECAY_ALERT_RATIO"\) \?\? 0\.1/s,
    );
  });

  it("is editable in the admin page and validated on the way in", () => {
    expect(rd("src/components/admin/RuntimeTab.tsx")).toContain("ml_decay_alert_ratio");
    expect(rd("src/utils/notebookRuntimeAdmin.functions.ts")).toMatch(
      /ml_decay_alert_ratio: z\.number\(\)/,
    );
  });

  it("is what the verdict is measured against", () => {
    expect(EVALUATE).toMatch(/evaluationVerdict\(decay, limits\.mlDecayAlertRatio\)/);
  });
});

describe("the sweep", () => {
  it("runs on the platform clock", () => {
    // A feature nothing calls is a feature that does not exist.
    expect(CRON).toContain("@/utils/ml/evaluate.server");
    expect(CRON).toMatch(/runDueEvaluations\(\)/);
    expect(CRON).toMatch(/ml_evaluations: number;/);
    expect(CRON).toMatch(/\n {6}ml_evaluations,/);
  });

  it("survives its own failure without taking the pass down", () => {
    const at = CRON.indexOf("@/utils/ml/evaluate.server");
    expect(CRON.slice(at, at + 400)).toMatch(/\.catch\(/);
  });

  it("is driven from the predictions, with a bound and a cooling-off", () => {
    expect(EVALUATE).toMatch(/EVALUATE_WITHIN_DAYS = 30/);
    expect(EVALUATE).toMatch(/REEVALUATE_AFTER_HOURS = 24/);
    expect(EVALUATE).toMatch(/ML_EVALUATIONS_PER_SWEEP/);
    // Only successful batch runs have a table to measure.
    expect(EVALUATE).toMatch(/\.eq\("kind", "batch"\)/);
    expect(EVALUATE).toMatch(/\.eq\("status", "succeeded"\)/);
  });

  it("does not re-measure what it measured today", () => {
    expect(EVALUATE).toMatch(/measuredLately\.has\(c\.id\)/);
  });
});

describe("what gets recorded", () => {
  it("audits every evaluation and alerts only on decay", () => {
    expect(EVALUATE).toMatch(/action: "ml\.evaluate"/);
    expect(EVALUATE).toMatch(/action: "ml\.decay\.alert"/);
    const at = EVALUATE.indexOf('action: "ml.decay.alert"');
    // The alert is inside the degraded branch, not fired for every run.
    expect(EVALUATE.slice(Math.max(0, at - 200), at)).toMatch(/verdict === "degraded"/);
  });

  it("keeps coverage beside the metric, in the row itself", () => {
    expect(EVALUATE).toMatch(/matched_rows: metrics\.matched/);
    expect(EVALUATE).toMatch(/scored_rows: scoredRows/);
    expect(EVALUATE).toMatch(/coverage: coverage\(metrics\.matched, scoredRows\)/);
  });

  it("stores the metric's NAME, so an old row stays readable", () => {
    expect(MIGRATION).toMatch(/metric_name text NOT NULL/);
    expect(EVALUATE).toMatch(/metric_name: metrics\.primary_name/);
  });
});

describe("the table it writes to", () => {
  it("is row-level secured both ways", () => {
    expect(MIGRATION).toMatch(/ALTER TABLE public\.ml_evaluations ENABLE ROW LEVEL SECURITY/);
    expect(MIGRATION).toMatch(/Users manage their own ML evaluations/);
    // And the model's owner sees evaluations someone else triggered.
    expect(MIGRATION).toMatch(/Model owners read evaluations of their models/);
  });

  it("keeps a verdict inside its own vocabulary", () => {
    expect(MIGRATION).toMatch(
      /verdict text CHECK \(verdict IS NULL OR verdict IN \('stable', 'degraded', 'improved'\)\)/,
    );
  });

  it("goes away with the model, the version and the run", () => {
    const cascades = MIGRATION.match(/ON DELETE CASCADE/g) ?? [];
    expect(cascades.length).toBeGreaterThanOrEqual(4);
  });
});
