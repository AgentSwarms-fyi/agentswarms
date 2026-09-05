// ML platform, milestone 8: operations. Scheduled retraining and batch
// prediction on the platform's one clock, drift measured against the
// training distribution on every batch, side-by-side version comparison, a
// model card assembled from the registry, and GPUs requested through both
// orchestrators. What is pinned here is the agreement between the pieces
// that would otherwise drift silently: the migration and the code, the
// sweep's claim pattern, the trainer's statistics and inference's PSI, the
// settings' three-tier resolution, and the docs.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { TRAIN_PY } from "@/utils/ml/pyTrain";
import { beatsProduction, nextMlRunAt } from "@/utils/ml/schedule.server";
import { buildModelCard } from "@/utils/ml/modelCard.server";
import type { MlModelRow, MlVersionRow } from "@/utils/ml/access.server";

const REPO = path.resolve(__dirname, "../..");
const rd = (p: string) => readFileSync(path.join(REPO, p), "utf8");
const MIGRATION = "supabase/migrations/20260859000000_ml_ops.sql";

const version = (over: Partial<MlVersionRow>): MlVersionRow =>
  ({
    id: "v",
    model_id: "m",
    user_id: "u",
    version: 1,
    status: "ready",
    stage: "candidate",
    algorithm: "hist_gradient_boosting",
    metrics: { f1_macro: 0.8, accuracy: 0.85 },
    leaderboard: [],
    feature_importance: [],
    feature_schema: [],
    artifact_uri: "s3://lakehouse/ml-artifacts/m/v1/model.joblib",
    artifact_sha256: "ab".repeat(32),
    artifact_bytes: 10,
    training_rows: 100,
    training_total_rows: 100,
    training_sampled: false,
    training_snapshot_id: 1,
    decision_id: "v",
    config: { tuning: "quick" },
    warnings: [],
    forecast: null,
    trained_at: "2026-09-05T00:00:00Z",
    created_at: "2026-09-05T00:00:00Z",
    ...over,
  }) as MlVersionRow;

describe("the migration", () => {
  const sql = rd(MIGRATION);
  it("adds schedules, drift columns and two settings, all governed", () => {
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS public.ml_schedules (");
    expect(sql).toContain("CHECK (kind IN ('retrain', 'batch_predict'))");
    expect(sql).toContain("CHECK (schedule IN ('hourly', 'daily', 'weekly', 'cron'))");
    expect(sql).toContain("public.audit_row_change('ml_schedule')");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS feature_stats jsonb");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS drift_score double precision");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS ml_train_gpus integer");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS ml_drift_alert_psi double precision");
  });
});

describe("schedules", () => {
  const sched = rd("src/utils/ml/schedule.server.ts");

  it("use the ETL clock and claim a due row by advancing it", () => {
    expect(nextMlRunAt("hourly", null, null, new Date("2026-01-01T00:00:00Z"))).toBe(
      "2026-01-01T01:00:00.000Z",
    );
    expect(nextMlRunAt("cron", "0 6 * * *", "UTC", new Date("2026-01-01T00:00:00Z"))).toBe(
      "2026-01-01T06:00:00.000Z",
    );
    expect(nextMlRunAt("cron", "not a cron", "UTC")).toBeNull();
    // Formatting may wrap the claim; both halves of the compare-and-set must be there.
    expect(sched).toContain('claim.is("next_run_at", null)');
    expect(sched).toContain('claim.eq("next_run_at", s.next_run_at)');
    expect(sched).toContain("if (!won?.length) continue; // another replica claimed this tick");
    // One sweep for the platform: the ETL pass starts due ML schedules too.
    expect(rd("src/utils/etl/schedule.server.ts")).toContain(
      ".then((m) => m.processDueMlSchedules(force))",
    );
  });

  it("promote only a ready version that beats production on the primary metric", () => {
    const prod = version({ id: "p", metrics: { f1_macro: 0.8 } });
    expect(beatsProduction("classification", version({ metrics: { f1_macro: 0.9 } }), prod)).toBe(
      true,
    );
    expect(beatsProduction("classification", version({ metrics: { f1_macro: 0.7 } }), prod)).toBe(
      false,
    );
    // Lower is better for RMSE.
    expect(
      beatsProduction(
        "regression",
        version({ metrics: { rmse: 10 } }),
        version({ metrics: { rmse: 12 } }),
      ),
    ).toBe(true);
    expect(
      beatsProduction(
        "regression",
        version({ metrics: { rmse: 14 } }),
        version({ metrics: { rmse: 12 } }),
      ),
    ).toBe(false);
    // A failed candidate never wins; no incumbent means the first ready one does.
    expect(
      beatsProduction(
        "classification",
        version({ status: "failed", metrics: { f1_macro: 1 } }),
        prod,
      ),
    ).toBe(false);
    expect(beatsProduction("classification", version({ metrics: { f1_macro: 0.1 } }), null)).toBe(
      true,
    );
    expect(sched).toContain('if (candidate.status === "ready" && s.promote_if_better && better) {');
    expect(sched).toContain("evaluated_version_id: candidate.id,");
  });

  it("run as the owner through the shared service and audit each start", () => {
    expect(sched).toContain('.eq("user_id", s.user_id)');
    expect(sched).toContain("{ userId: s.user_id, trigger: via }");
    expect(sched).toContain("startBatchPrediction({");
    expect(sched).toContain('action: outcome.ok ? "ml.schedule.run" : "ml.schedule.failed"');
    const api = rd("src/utils/ml/api.server.ts");
    expect(api).toContain("startTrainingJob({ model, version: v, trigger: opts.trigger })");
  });

  it("have owner-only server functions and an Automation tab", () => {
    const fns = rd("src/utils/mlOps.functions.ts");
    expect(fns).toContain("loadModelForUser(data.model_id, userId, { write: true })");
    expect(fns).toContain("A batch prediction schedule needs an input and an output table");
    expect(fns).toContain("// Resuming: schedule from now, never from the missed past.");
    const page = rd("src/routes/_authenticated/ml_.$modelId.tsx");
    expect(page).toContain('<TabsTrigger value="automation">Automation</TabsTrigger>');
    expect(page).toContain(
      "<SchedulesPanel token={token} modelId={model.id} task={model.task} shared={shared} />",
    );
  });
});

describe("drift", () => {
  it("is measured in the trainer as PSI over the training bins", () => {
    expect(TRAIN_PY).toContain("def _feature_stats(df, schema, features):");
    expect(TRAIN_PY).toContain("def _drift(stats, df):");
    expect(TRAIN_PY).toContain("out[f] = float(np.sum((a - e) * np.log(a / e)))");
    expect(TRAIN_PY).toContain("edges = np.unique(np.quantile(v, np.linspace(0, 1, 11)))");
    // The three trainers with a prepared frame store their statistics in the artifact and the result.
    expect(
      TRAIN_PY.match(/'prep': prep, 'feature_stats': stats, 'trainer_version': 3/g)?.length,
    ).toBe(3);
    expect(TRAIN_PY.match(/'feature_schema': schema, 'feature_stats': stats,/g)?.length).toBe(3);
    // Inference measures it on ten rows or more and returns it.
    expect(TRAIN_PY).toContain(
      "drift = _drift(art.get('feature_stats'), df) if len(df) >= 10 else None",
    );
    expect(TRAIN_PY).toContain("'output': written, 'drift': drift,");
  });

  it("is stored per run, audited and notified above the operator's threshold", () => {
    const predict = rd("src/utils/ml/predict.server.ts");
    expect(predict).toContain("drift_score: r.drift?.score ?? null,");
    expect(predict).toContain("if (r.drift && r.drift.score >= limits.mlDriftAlertPsi) {");
    expect(predict).toContain('action: "ml.drift.alert"');
    expect(predict).toContain("void notifyUser(model.user_id, {");
    expect(rd("src/utils/ml/train.server.ts")).toContain(
      "feature_stats: (r.feature_stats ?? null) as Json,",
    );
    expect(rd("src/components/ml/PredictionsPanel.tsx")).toContain("function DriftBadge(");
    expect(rd("src/utils/ml/api.server.ts")).toContain("drift: result.drift ?? null,");
  });
});

describe("settings", () => {
  it("resolve settings row → env → default for GPUs and the drift threshold", () => {
    const cfg = rd("src/utils/notebookRuntime/config.server.ts");
    expect(cfg).toContain(
      'mlTrainGpus: nonNegative(data?.ml_train_gpus) ?? envInt("ML_TRAIN_GPUS") ?? 0,',
    );
    expect(cfg).toContain(
      'mlDriftAlertPsi: positiveNum(data?.ml_drift_alert_psi) ?? envNum("ML_DRIFT_ALERT_PSI") ?? 0.25,',
    );
    const admin = rd("src/utils/notebookRuntimeAdmin.functions.ts");
    expect(admin).toContain("ml_train_gpus: z.number().int().min(0).max(64).optional(),");
    expect(admin).toContain("ml_drift_alert_psi: z.number().min(0.01).max(5).optional(),");
    const tab = rd("src/components/admin/RuntimeTab.tsx");
    expect(tab).toContain('set("ml_train_gpus", n)');
    expect(tab).toContain('set("ml_drift_alert_psi", n)');
  });

  it("carry GPUs from the training job through both orchestrators", () => {
    expect(rd("src/utils/ml/train.server.ts")).toContain("gpus: limits.mlTrainGpus || undefined,");
    expect(rd("src/utils/notebookRuntime/service.server.ts")).toContain(
      "gpus: batch ? opts.gpus || 0 : 0,",
    );
    expect(rd("src/utils/notebookRuntime/orchestrator.ts")).toContain("gpus?: number;");
    expect(rd("src/utils/notebookRuntime/docker.server.ts")).toContain(
      '{ DeviceRequests: [{ Driver: "nvidia", Count: spec.gpus, Capabilities: [["gpu"]] }] }',
    );
    expect(rd("src/utils/notebookRuntime/k8s.server.ts")).toContain(
      '...(spec.gpus ? { "nvidia.com/gpu": String(spec.gpus) } : {}),',
    );
  });
});

describe("the model card", () => {
  it("is assembled from the rows and names what governs the model", () => {
    const model = {
      id: "m",
      user_id: "u",
      name: "plan classifier",
      description: "Which plan a customer lands on.",
      task: "classification",
      source: { kind: "lakehouse", schema: "analytics", table: "revenue_facts" },
      target_column: "plan",
      time_column: null,
      horizon: null,
      aggregation: null,
      feature_columns: null,
      production_version_id: "v",
      prep: { where: "region = 'EMEA'" },
      user_column: null,
      item_column: null,
      rating_column: null,
      n_clusters: null,
      contamination: null,
      created_at: "",
      updated_at: "",
    } as unknown as MlModelRow;
    const v = version({
      feature_schema: [
        { name: "region", dtype: "categorical", role: "feature", categories: ["EMEA", "APAC"] },
        { name: "net_usd", dtype: "numeric", role: "feature", min: 0, max: 100, median: 50 },
        { name: "order_id", dtype: "numeric", role: "dropped", reason: "identifier-like" },
      ] as never,
      leaderboard: [
        { algorithm: "lightgbm", metric: "f1_macro", value: 0.79, status: "ok", fit_seconds: 1.2 },
      ] as never,
      feature_importance: [{ feature: "region", importance: 0.3 }] as never,
      warnings: ["Dropped column order_id: identifier-like"] as never,
    });
    const md = buildModelCard({ model, version: v, origin: "https://x.test", sharedWith: 2 });
    for (const h of [
      "# Model card: plan classifier (v1)",
      "## Intended use",
      "## Training data",
      "## Preparation",
      "## Features",
      "## Evaluation",
      "## What the model relies on",
      "## Limitations and warnings",
      "## Governance",
      "## How to call it",
    ]) {
      expect(md).toContain(h);
    }
    expect(md).toContain("Which plan a customer lands on.");
    expect(md).toContain("| Row filter | `region = 'EMEA'` |");
    expect(md).toContain("| **F1 (macro)** (primary) | 0.8000 |");
    expect(md).toContain("- `order_id` — identifier-like");
    expect(md).toContain("| Shared with | 2 grantee(s) via IAM |");
    expect(md).toContain("sha256 " + "ab".repeat(32));
    expect(md).toContain("https://x.test/api/ml/predict");
    // Nothing a pipe would break.
    expect(md).not.toContain("undefined");
  });

  it("is reachable from the model page and the server function", () => {
    expect(rd("src/utils/mlOps.functions.ts")).toContain("export const mlModelCard");
    expect(rd("src/routes/_authenticated/ml_.$modelId.tsx")).toContain("<ModelCardDialog");
    expect(rd("src/components/ml/ModelCardDialog.tsx")).toContain("Download {fileName}");
  });
});

describe("compare and docs", () => {
  it("compares ticked versions with the best value marked per metric", () => {
    const page = rd("src/routes/_authenticated/ml_.$modelId.tsx");
    expect(page).toContain("function CompareVersions(");
    expect(page).toContain(
      'return metricDirection(k) === "lower" ? Math.min(...nums) : Math.max(...nums);',
    );
    expect(page).toContain("Tick two or more trained versions to compare them side by side.");
  });

  it("describe automation, drift, the card, GPUs and how this compares, with every knob", () => {
    const md = rd("docs/ML.md");
    const page = rd("src/routes/docs.ml.tsx");
    for (const phrase of [
      "## Automation",
      "## Drift",
      "## How this compares",
      "Model card",
      "promote when better",
      "population stability index",
    ]) {
      expect(md).toContain(phrase);
    }
    for (const id of ['id="automation"', 'id="drift"', 'id="how-this-compares"'])
      expect(page).toContain(id);
    for (const knob of ["ML_TRAIN_GPUS", "ML_DRIFT_ALERT_PSI"]) {
      for (const f of [
        ".env.example",
        "docs/SCALE_AND_LIMITS.md",
        "docs/ML.md",
        "src/routes/docs.ml.tsx",
      ]) {
        expect(rd(f), `${knob} in ${f}`).toContain(knob);
      }
    }
    // The comparison is honest about the gaps.
    expect(md).toContain("no warm autoscaled endpoint yet");
    expect(page).toContain("Feature store");
  });
});
