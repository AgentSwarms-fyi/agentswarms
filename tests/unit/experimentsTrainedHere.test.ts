// One place to compare (R527): a model's own training, read as runs beside
// the runs logged from notebooks, at read time from the versions themselves.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  isModelExperiment,
  metricColumns,
  MODEL_EXPERIMENT,
  versionAsRun,
  withVersionRuns,
  type TrainedVersion,
} from "@/lib/experiments";

const version = (over: Partial<TrainedVersion> = {}): TrainedVersion => ({
  id: "v-3",
  model_id: "m-1",
  version: 3,
  status: "ready",
  stage: "production",
  algorithm: "lightgbm",
  metrics: {
    accuracy: 0.91,
    f1_macro: 0.88,
    backtest_windows: 3,
    // Found in the UI test: a count offered as a score column.
    holdout_periods: 13,
    cross_validation: { folds: 5 },
    note: "text",
  },
  config: { tuning: "quick", max_rows: 200000, time_budget_minutes: 10, prep: { scale: true } },
  training_rows: 18000,
  warnings: [],
  external: false,
  created_at: "2026-11-20T10:00:00.000Z",
  trained_at: "2026-11-20T10:04:30.000Z",
  ...over,
});

describe("a version, read as a run", () => {
  it("carries its settings, its scores and how long it took", () => {
    const r = versionAsRun(version());
    expect(r).toMatchObject({
      id: "version:v-3",
      name: "v3 · lightgbm",
      status: "finished",
      source: "platform",
      registered_version_id: "v-3",
      duration_ms: 270_000,
      tags: ["production"],
      version: { id: "v-3", model_id: "m-1", number: 3, stage: "production" },
    });
    expect(r.params).toEqual({
      algorithm: "lightgbm",
      tuning: "quick",
      max_rows: 200000,
      time_budget_minutes: 10,
      training_rows: 18000,
    });
    // Scores only: counts (windows, holdout periods), a nested object and text are not columns.
    expect(r.metrics).toEqual({ accuracy: 0.91, f1_macro: 0.88 });
  });

  it("says how it ended", () => {
    expect(versionAsRun(version({ status: "training", trained_at: null })).status).toBe("running");
    const failed = versionAsRun(version({ status: "failed", warnings: ["Out of memory"] }));
    expect(failed).toMatchObject({ status: "failed", error: "Out of memory" });
    expect(versionAsRun(version({ status: "cancelled" })).error).toBe(
      "Cancelled before it finished.",
    );
    expect(versionAsRun(version({ external: true })).source).toBe("registered");
    // Found in the UI test: the job held the reason, the version did not.
    expect(
      versionAsRun(
        version({
          status: "failed",
          warnings: [],
          job: { trigger: "manual", error: "The sandbox ran out of memory at 1.9 GB" },
        }),
      ).error,
    ).toBe("The sandbox ran out of memory at 1.9 GB");
    expect(versionAsRun(version({ status: "failed", warnings: [] })).error).toBe(
      "Training failed.",
    );
    expect(versionAsRun(version({ job: { trigger: "approval", error: null } })).tags).toEqual([
      "production",
      "proposed in chat",
    ]);
    expect(versionAsRun(version({ job: { trigger: "manual", error: null } })).tags).toEqual([
      "production",
    ]);
    expect(versionAsRun(version({ trained_at: null })).duration_ms).toBeNull();
  });
});

describe("beside the runs", () => {
  const run = (id: string, at: string, registered: string | null = null) => ({
    id,
    started_at: at,
    registered_version_id: registered,
    metrics: { accuracy: 0.8 },
  });

  it("are listed newest first, and a version a run became is not shown twice", () => {
    const merged = withVersionRuns(
      [run("r-1", "2026-11-21T00:00:00.000Z", "v-3"), run("r-2", "2026-11-19T00:00:00.000Z")],
      [version(), version({ id: "v-2", version: 2, created_at: "2026-11-20T09:00:00.000Z" })],
    );
    expect(merged.map((r) => r.id)).toEqual(["r-1", "version:v-2", "r-2"]);
  });

  it("compare on the same metric columns", () => {
    const merged = withVersionRuns([run("r-1", "2026-11-21T00:00:00.000Z")], [version()]);
    expect(metricColumns(merged)).toContain("accuracy");
  });

  it("a model's own experiment has its own id space", () => {
    expect(isModelExperiment(`${MODEL_EXPERIMENT}m-1`)).toBe(true);
    expect(isModelExperiment("2f1c…")).toBe(false);
  });
});

describe("the wiring", () => {
  const rd = (p: string) => readFileSync(p, "utf8");

  it("the list adds models that trained, and an experiment about a model holds its versions", () => {
    const fns = rd("src/utils/mlExperiments.functions.ts");
    expect(fns).toContain(".filter((m) => !linked.has(m.id) && byModel.has(m.id))");
    expect(fns).toContain("from_model: true,");
    expect(fns).toContain(
      "const versions = exp?.model_id ? await versionsOf(userId, [exp.model_id]) : [];",
    );
    // The caller's own versions only, for a model of theirs.
    expect(fns).toMatch(
      /\.from\("ml_model_versions"\)\s+\.select\(VERSION_FIELDS\)\s+\.eq\("user_id", userId\)/,
    );
    expect(fns).toMatch(
      /\.from\("ml_models"\)\s+\.select\("id"\)\s+\.eq\("id", modelId\)\s+\.eq\("user_id", userId\)/,
    );
  });

  it("the panel opens a version on its model's page and never deletes one", () => {
    const panel = rd("src/components/ml/ExperimentsPanel.tsx");
    expect(panel).toContain("{r.version ? (");
    expect(panel).toContain("aria-label={`Open version ${r.version.number} on its model's page`}");
    expect(panel).toContain("{current && !current.from_model ? (");
    // A failed version is not offered for promotion.
    expect(panel).toContain('{r.version && r.status === "failed" ? (');
    expect(panel).toContain('? "Trained here · "');
  });

  it("the tab can be linked to", () => {
    const page = rd("src/routes/_authenticated/ml.tsx");
    expect(page).toContain('s.tab === "experiments" || s.tab === "features" ? { tab: s.tab } : {}');
    expect(page).toContain('const tab: MlTab = search.tab ?? "models";');
  });
});
