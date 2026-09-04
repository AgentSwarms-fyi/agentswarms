// ML platform, milestone 2: predictions, data preparation, tuning, the agent
// tool. Pinned here: the session stash now carries a kind and both routes
// dispatch on it; the program verifies the artifact digest before scoring;
// a prediction is a data read with a digest while a failure is not; the
// output table must be owned; the tool re-derives grants on headless runs.
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { ML_JOB_KEY, ML_TUNINGS, mlJobStashOf } from "@/utils/ml/types";
import { TRAIN_PY } from "@/utils/ml/pyTrain";
import { isDataRead } from "@/utils/provenance/actions";

const REPO = path.resolve(__dirname, "../..");
const rd = (p: string) => readFileSync(path.join(REPO, p), "utf8");
const MIGRATION = "supabase/migrations/20260855000000_ml_predictions_prep.sql";

describe("the job stash carries a kind", () => {
  it("defaults to train and recognises predict", () => {
    expect(mlJobStashOf({ [ML_JOB_KEY]: { job_id: "a" } })).toEqual({ job_id: "a", kind: "train" });
    expect(mlJobStashOf({ [ML_JOB_KEY]: { job_id: "b", kind: "predict" } })).toEqual({
      job_id: "b",
      kind: "predict",
    });
    expect(mlJobStashOf({ [ML_JOB_KEY]: { job_id: "c", kind: "other" } })).toEqual({
      job_id: "c",
      kind: "train",
    });
  });

  it("both runtime routes dispatch on it", () => {
    const source = rd("src/routes/api/notebook.runtime.source.ts");
    const result = rd("src/routes/api/notebook.runtime.result.ts");
    expect(source).toContain('stash.kind === "predict"');
    expect(source).toContain("mlPredictBundleFor(stash, claims.sub, session?.inputs)");
    expect(result).toContain("appendPredictionLogs(mlStash.job_id");
    expect(result).toContain("finalizePrediction(mlStash.job_id, outcome)");
    expect(result).toContain("finalizeMlJob(mlStash.job_id, outcome)");
    expect(result).not.toContain("if (false as boolean)");
  });
});

describe("the program: preparation, tuning, prediction", () => {
  it("still cannot break the template literal", () => {
    expect(TRAIN_PY).not.toContain("`");
    expect(TRAIN_PY).not.toContain("$" + "{");
  });

  it("applies the declared preparation", () => {
    expect(TRAIN_PY).toContain("def _source_sql(cfg):");
    expect(TRAIN_PY).toContain("' WHERE (' + prep['where'].strip() + ')'");
    expect(TRAIN_PY).toContain("') AS _prep'");
    expect(TRAIN_PY).toContain("class_weight=cw");
    expect(TRAIN_PY).toContain("prep.get('target_clip')");
    expect(TRAIN_PY).toContain(
      "OrdinalEncoder(handle_unknown='use_encoded_value', unknown_value=-1)",
    );
    expect(TRAIN_PY).toContain("(prep or {}).get('scale', True)");
  });

  it("tunes the best candidates under the budget and keeps a tuned model only when it wins", () => {
    expect(TRAIN_PY).toContain("RandomizedSearchCV(pipe, space, n_iter=n_iter, cv=cv");
    expect(TRAIN_PY).toContain("if _elapsed() > budget * 0.6:");
    expect(TRAIN_PY).toContain(
      "better_than_base = score > base_score if higher else score < base_score",
    );
    for (const t of ML_TUNINGS) expect(["none", "quick", "thorough"]).toContain(t);
    expect(TRAIN_PY).toContain("(6, 3) if mode == 'quick' else (20, 5)");
  });

  it("refuses an artifact whose bytes do not hash to the registry's digest", () => {
    expect(TRAIN_PY).toContain("def _download_artifact(cfg):");
    expect(TRAIN_PY).toContain("if sha != cfg['artifact_sha256']:");
    expect(TRAIN_PY).toContain("Refusing to predict with it");
  });

  it("prediction re-uses the training feature preparation and writes back through the catalog", () => {
    expect(TRAIN_PY).toContain(
      "X = _prepare_x(df, art['features'], art['dt_cols'], art['num_all'], art['cat'], art.get('text') or [])",
    );
    expect(TRAIN_PY).toContain(
      "con.execute('CREATE OR REPLACE TABLE ' + fq + ' AS SELECT * FROM _pred')",
    );
    expect(TRAIN_PY).toContain("if cfg.get('mode') == 'predict':");
    expect(TRAIN_PY).toContain("'digest_columns': digest_cols");
  });

  it("checks its imports before ever calling pip", () => {
    expect(TRAIN_PY).toContain("def _ensure_packages():");
    expect(rd("src/utils/ml/train.server.ts")).toContain("return { env, requirements: [] };");
    expect(rd("src/utils/ml/predict.server.ts")).toContain("return { env, requirements: [] };");
  });

  it("is valid Python (checked with the interpreter when available)", () => {
    const probe = spawnSync("python", ["--version"], { encoding: "utf8" });
    if (probe.status !== 0) return;
    const dir = mkdtempSync(path.join(tmpdir(), "ml-predict-"));
    const file = path.join(dir, "train.py");
    writeFileSync(file, TRAIN_PY + "\n_ML_CONFIG = {}\n");
    const r = spawnSync(
      "python",
      ["-c", "import ast, sys; ast.parse(open(sys.argv[1], encoding='utf-8').read())", file],
      { encoding: "utf8" },
    );
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });
});

describe("predictions are governed", () => {
  const migration = rd(MIGRATION);
  const predict = rd("src/utils/ml/predict.server.ts");
  const fns = rd("src/utils/ml.functions.ts");

  it("has a table with owner RLS and an owner-of-the-model read policy", () => {
    expect(migration).toContain("CREATE TABLE public.ml_predictions");
    expect(migration).toContain('CREATE POLICY "Users manage their own ML predictions"');
    expect(migration).toContain("m.id = model_id AND m.user_id = auth.uid()");
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS prep jsonb");
  });

  it("a successful prediction is a data read with a digest; a failure is not", () => {
    expect(isDataRead("ml.predict_query")).toBe(true);
    expect(isDataRead("ml.predict.failed")).toBe(false);
    expect(isDataRead("ml.predict.cancel")).toBe(false);
    expect(predict).toContain('action: "ml.predict_query"');
    expect(predict).toContain("result_digest: digest");
    expect(predict).toContain("row_cap:");
    expect(predict).toContain("resultDigest(r.digest_columns, r.digest_rows");
  });

  it("adopts the caller's decision for an agent turn, mints one otherwise", () => {
    expect(predict).toContain("const decisionId = args.decisionId ?? row.id;");
    expect(predict).toContain('const PREDICTION_DECISION_KIND: DecisionKind = "ml_prediction";');
  });

  it("writes only into a schema the caller owns, never a shared or mounted one", () => {
    expect(fns).toContain("out.user_id !== userId || out.lake_source_id");
    expect(fns).toContain("Predictions can only be written to a lakehouse schema you own");
  });

  it("enforces the operator's prediction row limit before starting a sandbox", () => {
    expect(fns).toContain("if (rows > lim.predict_max_rows)");
    expect(fns).toContain("ML_PREDICT_MAX_ROWS");
    expect(predict).toContain("export const ML_ROWS_PREDICT_CAP = 200;");
  });

  it("validates a preparation through the statement guard before training", () => {
    expect(fns).toContain("async function validatePrep(");
    expect(fns).toContain('auditVia: "ml-prep-check"');
    expect(fns).toContain("if (prep.sql || prep.where) {");
    expect(fns).toContain("export const mlValidatePrep");
  });

  it("orphaned prediction runs are swept", () => {
    expect(rd("src/utils/etl/schedule.server.ts")).toContain("reconcileOrphanedPredictions()");
  });
});

describe("the agent tool", () => {
  const registry = rd("src/utils/tools/registry.server.ts");

  it("is a toolable id, registered only when a model with a production version is usable", () => {
    expect(registry).toContain('"ml_predict",\n  "memory_remember",');
    expect(registry).toContain('if (allows("ml_predict")) {');
    expect(registry).toContain("(m) => m.production_version_id,");
    expect(registry).toContain('handlers.set("ml_list_models"');
    expect(registry).toContain('handlers.set("ml_predict"');
    expect(registry).toContain("enabled.ml = true;");
    expect(registry).toContain("ml: false,");
    expect(registry).toContain("ml: boolean;");
  });

  it("re-derives who may predict from scopeUserId on headless runs", () => {
    expect(registry).toContain("const mlOwner = ctx.scopeUserId ?? ctx.userId;");
    expect(registry).toContain("listModelsForUser(c.scopeUserId ?? c.userId)");
    const headless = rd("src/utils/swarmExecute.server.ts");
    expect(headless).toContain('"ml_predict",');
    expect(headless).toContain('"ml_list_models",');
  });

  it("audits through the prediction service with the turn's decision id", () => {
    expect(registry).toContain('via: "agent_tool"');
    expect(registry).toContain("decisionId: c.decisionId ?? null,");
    expect(registry).toContain("ml_predict scores rows with a trained model from the registry");
  });

  it("is offered in the agent form and the swarm node inspector", () => {
    expect(rd("src/components/agents/AgentForm.tsx")).toContain('id: "ml_predict"');
    expect(rd("src/components/swarms/NodeInspector.tsx")).toContain('id: "ml_predict"');
  });
});

describe("the UI carries the new controls", () => {
  it("the wizard offers preparation and tuning, and sends them", () => {
    const wizard = rd("src/routes/_authenticated/ml_.new.tsx");
    expect(wizard).toContain("<PrepOptions");
    expect(wizard).toContain("prep: Object.keys(prep).length ? prep : undefined,");
    expect(wizard).toContain("tuning,");
  });

  it("the model page has a Predictions tab and tuning on retrain", () => {
    const detail = rd("src/routes/_authenticated/ml_.$modelId.tsx");
    expect(detail).toContain('<TabsTrigger value="predictions">Predictions</TabsTrigger>');
    expect(detail).toContain(
      "<PredictionsPanel token={token} model={model} versions={versions} shared={shared} />",
    );
    expect(detail).toContain("tuning,\n        },");
  });

  it("the try-it form and batch dialog go through the app's own dialogs", () => {
    const panel = rd("src/components/ml/PredictionsPanel.tsx");
    expect(panel).toContain("await confirmAsk(");
    expect(panel).not.toMatch(/\bwindow\.confirm\(/);
  });
});
