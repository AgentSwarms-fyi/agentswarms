// Experiment tracking: what was tried, with what settings, and how it scored.
//
// Two things are worth pinning here. The first is the split between a metric
// and a point on its curve — `loss` and `loss@7` live in the same flat map,
// and every comparison, column and promotion has to keep them apart or a
// leaderboard starts ranking one run's seventh epoch against another's final
// score. The second is that a run only becomes a model version through the
// same door an external registration uses, with both artifact fields present.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  MAX_KEYS_PER_RUN,
  algorithmOf,
  asScalarMap,
  checkRegistrable,
  curveOf,
  isStepKey,
  mergeCapped,
  metricColumns,
  promotableMetrics,
  scoreKeys,
  varyingParams,
} from "@/lib/experiments";

const REPO = path.resolve(__dirname, "../..");
const rd = (p: string) => readFileSync(path.join(REPO, p), "utf8");

describe("a run is a flat map of scalars", () => {
  it("keeps scalars and drops anything that would need a schema", () => {
    // A run whose params need a schema is a run nobody will compare with
    // another one, and comparing runs is the whole point.
    expect(asScalarMap({ lr: 0.01, name: "a", ok: true, none: null })).toEqual({
      lr: 0.01,
      name: "a",
      ok: true,
      none: null,
    });
    expect(asScalarMap({ nested: { a: 1 }, list: [1, 2] })).toEqual({});
    expect(asScalarMap(null)).toEqual({});
    expect(asScalarMap([1, 2])).toEqual({});
  });
});

describe("a score and a point on a curve", () => {
  const metrics = { loss: 0.2, "loss@0": 0.9, "loss@1": 0.5, "loss@2": 0.2, auc: 0.91, note: "x" };

  it("tells them apart", () => {
    expect(isStepKey("loss@7")).toBe(true);
    expect(isStepKey("loss")).toBe(false);
    // Only the numeric scores are what a run is compared on.
    expect(scoreKeys(metrics).sort()).toEqual(["auc", "loss"]);
  });

  it("reads a curve in step order, and only that metric's points", () => {
    expect(curveOf(metrics, "loss")).toEqual([
      { step: 0, value: 0.9 },
      { step: 1, value: 0.5 },
      { step: 2, value: 0.2 },
    ]);
    expect(curveOf(metrics, "auc")).toEqual([]);
    // Out-of-order keys still come back in step order — jsonb promises nothing.
    expect(curveOf({ "l@10": 1, "l@2": 2 }, "l").map((p) => p.step)).toEqual([2, 10]);
  });

  it("columns a table by how many runs recorded each metric", () => {
    // The metric most runs have is the one they are being compared on.
    const runs = [
      { metrics: { auc: 0.9, "auc@1": 0.1 } },
      { metrics: { auc: 0.8, rmse: 2 } },
      { metrics: { auc: 0.7 } },
    ];
    expect(metricColumns(runs)).toEqual(["auc", "rmse"]);
    // A curve point is never a column.
    expect(metricColumns(runs)).not.toContain("auc@1");
    expect(metricColumns(runs, 1)).toEqual(["auc"]);
  });
});

describe("which parameters actually differed", () => {
  it("marks the one that moved and ignores the ones held constant", () => {
    // In a list of twenty runs the constants are noise; the one that varied is
    // the experiment.
    const runs = [
      { params: { lr: 0.01, depth: 6, seed: 42 } },
      { params: { lr: 0.05, depth: 6, seed: 42 } },
    ];
    const varied = varyingParams(runs);
    expect([...varied]).toEqual(["lr"]);
    // Mutation check: hold lr constant too and nothing is marked.
    expect([...varyingParams([{ params: { lr: 1 } }, { params: { lr: 1 } }])]).toEqual([]);
  });

  it("counts a parameter only some runs recorded as having differed", () => {
    // Absent is a value: one run tuned something the other never set.
    const varied = varyingParams([{ params: { lr: 1, warmup: 5 } }, { params: { lr: 1 } }]);
    expect([...varied]).toEqual(["warmup"]);
  });
});

describe("merging a log call into a run", () => {
  it("adds rather than replaces, so a loop's earlier epochs survive", () => {
    const first = mergeCapped({ "loss@0": 0.9 }, { "loss@1": 0.5, loss: 0.5 }, "metrics");
    expect("value" in first && first.value).toEqual({ "loss@0": 0.9, "loss@1": 0.5, loss: 0.5 });
  });

  it("lets a later value win for the same name", () => {
    const m = mergeCapped({ loss: 0.9 }, { loss: 0.2 }, "metrics");
    expect("value" in m && m.value.loss).toBe(0.2);
  });

  it("refuses to grow a row past what anything can render", () => {
    const many: Record<string, number> = {};
    for (let i = 0; i <= MAX_KEYS_PER_RUN; i++) many[`m@${i}`] = i;
    const over = mergeCapped({}, many, "metrics");
    expect("error" in over && over.error).toMatch(/may hold 2000 metrics/);
    // Mutation check: one fewer key is fine.
    delete many[`m@${MAX_KEYS_PER_RUN}`];
    expect("value" in mergeCapped({}, many, "metrics")).toBe(true);
  });
});

describe("promoting a run into the registry", () => {
  it("carries the scores and never a step", () => {
    // A leaderboard holding `loss@7` would rank one run's seventh epoch
    // against another run's final score.
    expect(promotableMetrics({ auc: 0.9, "auc@3": 0.4, note: "x", nan: NaN })).toEqual({
      auc: 0.9,
    });
  });

  it("needs BOTH the artifact and its digest", () => {
    // A version whose artifact nobody can verify is not a version.
    const base = {
      status: "finished",
      artifact_uri: "s3://lake/m.joblib",
      artifact_sha256: "a".repeat(64),
      registered_version_id: null,
    };
    expect(checkRegistrable(base)).toEqual({
      ok: true,
      artifactUri: "s3://lake/m.joblib",
      artifactSha256: "a".repeat(64),
    });
    const noDigest = checkRegistrable({ ...base, artifact_sha256: null });
    expect(noDigest.ok).toBe(false);
    expect(!noDigest.ok && noDigest.error).toMatch(/did not record an artifact/);
    const noUri = checkRegistrable({ ...base, artifact_uri: null });
    expect(noUri.ok).toBe(false);
  });

  it("refuses a run that is still going, or one already registered", () => {
    const base = {
      artifact_uri: "s3://lake/m.joblib",
      artifact_sha256: "a".repeat(64),
      registered_version_id: null,
    };
    const running = checkRegistrable({ ...base, status: "running" });
    expect(!running.ok && running.error).toMatch(/has not finished/);
    const done = checkRegistrable({ ...base, status: "finished", registered_version_id: "v1" });
    expect(!done.ok && done.error).toMatch(/already registered/);
  });

  it("labels the algorithm from the run, or says external", () => {
    expect(algorithmOf({ algorithm: "  xgboost  " })).toBe("xgboost");
    expect(algorithmOf({ lr: 0.1 })).toBe("external");
    expect(algorithmOf({ algorithm: 7 })).toBe("external");
  });
});

describe("the wiring", () => {
  const migration = rd("supabase/migrations/20260876000000_ml_experiments.sql");
  const route = rd("src/routes/api/ml.experiments.ts");
  const fns = rd("src/utils/mlExperiments.functions.ts");
  const client = rd("docker/notebook-runtime/agentswarms_helper.py");

  it("owns both tables, owner-only", () => {
    for (const t of ["ml_experiments", "ml_experiment_runs"]) {
      expect(migration, t).toContain(`CREATE TABLE IF NOT EXISTS public.${t}`);
      expect(migration, t).toContain(`ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY`);
    }
    expect(migration).toContain("auth.uid() = user_id");
  });

  it("audits the experiment but not every metric", () => {
    // A training loop logging per epoch would otherwise write more audit rows
    // than the audit log is for.
    expect(migration).toContain("audit_row_change('ml_experiment')");
    expect(migration).toContain("CREATE TRIGGER audit_ml_experiments");
    expect(migration).not.toContain("audit_ml_experiment_runs");
  });

  it("audits the promotion, because that is when something becomes servable", () => {
    expect(fns).toContain('action: "ml.experiment.promote"');
  });

  it("lets a kernel log with its session token, never a key of its own", () => {
    expect(route).toContain("resolvePythonCaller");
    expect(route).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
    // Which sandbox logged it is recorded rather than asked for.
    expect(route).toContain("session_id: caller.sessionId");
    expect(route).toContain('source: caller.scopeUserId ? "notebook" : "api"');
  });

  it("treats a run id as an id and not as a capability", () => {
    // Both write operations re-check ownership rather than trusting the uuid.
    const writes = route.slice(route.indexOf("Both remaining operations"));
    expect(writes).toContain('.eq("user_id", caller.userId)');
    expect(fns).toContain('.eq("user_id", userId)');
  });

  it("refuses to rewrite a run that already finished", () => {
    expect(route).toContain('if (run.status !== "running")');
    expect(route).toContain("409");
  });

  it("registers through the same path an external version takes", () => {
    // Not a shortcut around the registry: same digest check, same audit, same
    // promotion rules.
    expect(fns).toContain("registerExternalVersion");
    expect(fns).toContain("checkRegistrable");
    // It arrives as a candidate; promoting it is a separate, deliberate step.
    expect(fns).toContain("promote: data.promote");
    expect(rd("src/components/ml/ExperimentsPanel.tsx")).toContain("promote: false");
  });

  it("only the model's owner may add a version to it", () => {
    expect(fns).toContain("Only the model's owner can register a version");
  });

  it("fails loudly at the start and quietly afterwards", () => {
    // start_run raises: a run you believe is recording and is not is worse
    // than one that never began. A later log warns: losing an epoch's metrics
    // is not worth losing the epoch.
    const send = client.slice(client.indexOf("    def _send(self"));
    expect(send).toContain("except Exception as exc");
    expect(send).toContain("[agentswarms] could not");
    const start = client.slice(client.indexOf("def start_run("));
    expect(start).toContain("data = _post_sync(");
    expect(start).not.toContain("except Exception");
  });

  it("closes the run whichever way the cell ends", () => {
    const exit = client.slice(client.indexOf("    def __exit__(self"));
    expect(exit).toContain('self.finish(status="failed"');
    expect(exit).toContain("return False"); // never swallow the traceback
  });

  it("keeps the curve and the score from one call", () => {
    expect(client).toContain('return self.log_metrics({key: value, f"{key}@{int(step)}": value})');
  });

  it("is reachable where the models are, without another sidebar item", () => {
    const page = rd("src/routes/_authenticated/ml.tsx");
    expect(page).toContain("ExperimentsPanel");
    expect(page).toContain('["experiments", "Experiments"]');
  });

  it("is documented in both doc sets", () => {
    expect(rd("docs/ML.md")).toContain("## Experiments");
    expect(rd("src/routes/docs.ml.tsx")).toContain('id="experiments"');
  });
});
