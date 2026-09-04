// ML platform, milestone 6: every popular problem shape. Clustering, anomaly
// detection and recommendation join classification, regression and
// forecasting. What is pinned here is the agreement between the layers that
// would otherwise drift apart silently: the database CHECK and the TypeScript
// task list, the trainer's dispatch and the primary metric the UI labels, the
// wizard's payload and the schema the server validates, the program fields
// the sandbox reads, and the docs that promise all of it.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  ML_LOWER_IS_BETTER,
  ML_METRIC_LABEL,
  ML_PRIMARY_METRIC,
  ML_TARGET_TASKS,
  ML_TASKS,
  ML_TASK_LABEL,
} from "@/utils/ml/types";
import { TRAIN_PY } from "@/utils/ml/pyTrain";

const REPO = path.resolve(__dirname, "../..");
const rd = (p: string) => readFileSync(path.join(REPO, p), "utf8");
const MIGRATION = "supabase/migrations/20260857000000_ml_more_tasks.sql";
const NEW_TASKS = ["clustering", "anomaly", "recommendation"] as const;

describe("the task vocabulary", () => {
  it("names six tasks, three of which predict a column", () => {
    expect([...ML_TASKS]).toEqual([
      "classification",
      "regression",
      "forecast",
      "clustering",
      "anomaly",
      "recommendation",
    ]);
    expect([...ML_TARGET_TASKS]).toEqual(["classification", "regression", "forecast"]);
    for (const t of ML_TASKS) {
      expect(ML_TASK_LABEL[t]).toBeTruthy();
      expect(ML_PRIMARY_METRIC[t]).toBeTruthy();
      expect(ML_METRIC_LABEL[ML_PRIMARY_METRIC[t]]).toBeTruthy();
    }
  });

  it("scores the new tasks by metrics whose direction the UI knows", () => {
    expect(ML_PRIMARY_METRIC.clustering).toBe("silhouette");
    expect(ML_PRIMARY_METRIC.anomaly).toBe("anomaly_rate");
    expect(ML_PRIMARY_METRIC.recommendation).toBe("hit_rate_10");
    // Higher silhouette and hit rate are better; inertia is the one new lower-is-better.
    expect(ML_LOWER_IS_BETTER.has("silhouette")).toBe(false);
    expect(ML_LOWER_IS_BETTER.has("hit_rate_10")).toBe(false);
    expect(ML_LOWER_IS_BETTER.has("inertia")).toBe(true);
  });

  it("is the same list the database accepts", () => {
    const sql = rd(MIGRATION);
    const m = sql.match(/CHECK \(task IN \(([^)]+)\)\)/);
    expect(m).not.toBeNull();
    const inDb = m![1].split(",").map((s) => s.trim().replace(/'/g, ""));
    expect(inDb).toEqual([...ML_TASKS]);
    // Target-less tasks are allowed a NULL target, and only those.
    expect(sql).toContain("ALTER COLUMN target_column DROP NOT NULL");
    expect(sql).toContain(
      "(task IN ('classification', 'regression', 'forecast') AND target_column IS NOT NULL)",
    );
    expect(sql).toContain("(task IN ('clustering', 'anomaly'))");
    expect(sql).toContain(
      "(task = 'recommendation' AND user_column IS NOT NULL AND item_column IS NOT NULL)",
    );
    for (const col of [
      "user_column",
      "item_column",
      "rating_column",
      "n_clusters",
      "contamination",
    ]) {
      expect(sql).toContain(`ADD COLUMN IF NOT EXISTS ${col}`);
    }
  });
});

describe("the trainer program", () => {
  it("dispatches every task to its own trainer", () => {
    for (const fn of [
      "def _train_clustering(df, cfg, warnings_):",
      "def _train_anomaly(df, cfg, warnings_):",
      "def _train_recommendation(df, cfg, warnings_):",
      "def _predict_recommendation(art, cfg, warnings_):",
      "def _cluster_profiles(df, labels, schema, features):",
      "def _recommend_for(art, user, n=10):",
    ]) {
      expect(TRAIN_PY).toContain(fn);
    }
    for (const t of NEW_TASKS) {
      expect(TRAIN_PY).toContain(`elif cfg['task'] == '${t}':`);
      expect(TRAIN_PY).toContain(`'${ML_PRIMARY_METRIC[t]}'`);
    }
    // The template-literal rules of the earlier milestones still hold.
    expect(TRAIN_PY).not.toContain("`");
    expect(TRAIN_PY).not.toContain("$" + "{");
    expect(TRAIN_PY).not.toMatch(/^class /m);
  });

  it("chooses k by silhouette unless a fixed k is given, and profiles every group", () => {
    expect(TRAIN_PY).toContain("fixed = cfg.get('n_clusters')");
    expect(TRAIN_PY).toContain(
      "ks = [int(fixed)] if fixed else list(range(2, min(10, max(2, n // 10)) + 1))",
    );
    expect(TRAIN_PY).toContain("silhouette_score(");
    expect(TRAIN_PY).toContain("'clusters': profiles");
    // Silhouette is sampled on large tables so the choice of k stays affordable.
    expect(TRAIN_PY).toContain("rng.choice(n, size=5000, replace=False) if n > 5000 else None");
  });

  it("runs an isolation forest with automatic or given contamination", () => {
    expect(TRAIN_PY).toContain(
      "IsolationForest(n_estimators=200, contamination=cont, random_state=42, n_jobs=-1)",
    );
    expect(TRAIN_PY).toContain("cont = float(cfg.get('contamination') or 0.02)");
    expect(TRAIN_PY).toContain(
      "'note': 'contamination=%.3f%s' % (cont, '' if cfg.get('contamination') else ' (default)')",
    );
    expect(TRAIN_PY).toContain("scores = -pipe.decision_function(X)");
    expect(TRAIN_PY).toContain("'anomaly_rate': rate");
  });

  it("recommends by item similarity, evaluated on one held-out interaction per user", () => {
    expect(TRAIN_PY).toContain(
      "ucol, icol, rcol = cfg['user_column'], cfg['item_column'], cfg.get('rating_column')",
    );
    expect(TRAIN_PY).toContain("S = (Mn.T @ Mn).tocsr()");
    expect(TRAIN_PY).toContain("S.setdiag(0.0)");
    expect(TRAIN_PY).toContain("eligible = set(counts[counts >= 2].index)");
    expect(TRAIN_PY).toContain("'hit_rate_10': _safe_float(hit_rate)");
    // A user without history gets the popular list and says so.
    expect(TRAIN_PY).toContain("return [(it, 0.0) for it in art['popular'][:n]], True");
    expect(TRAIN_PY).toContain("'cold_start': cold");
    // The try-it form can offer real users: the user column is emitted as a categorical feature.
    expect(TRAIN_PY).toContain(
      "{'name': ucol, 'dtype': 'categorical', 'role': 'feature', 'categories': users[:200]}",
    );
  });

  it("turns free text into TF-IDF features instead of dropping it", () => {
    expect(TRAIN_PY).toContain("if d == 'text' and avg_len >= 20 and not _ID_NAME.search(str(c)):");
    expect(TRAIN_PY).toContain(
      "TfidfVectorizer(max_features=1000, ngram_range=(1, 2), min_df=2, sublinear_tf=True)",
    );
    expect(TRAIN_PY).toContain("def _prepare_x(df, features, dt_cols, num_all, cat, text=None):");
    expect(TRAIN_PY).toContain("return prepro, dt_cols, num_all, cat, text");
    // Distance-based tasks get the text compressed to a few dense components.
    expect(TRAIN_PY).toContain("_build_preprocessor(schema, features, prep, df=df, compact=True)");
    expect(TRAIN_PY).toContain("TruncatedSVD(n_components=min(20, vocab - 1), random_state=42)");
    // The artifact carries the text column list so inference prepares the same frame.
    expect(TRAIN_PY).toContain("'cat': cat, 'text': text,");
    expect(TRAIN_PY).toContain("art.get('text') or []");
  });

  it("predicts a group with its distance and an anomaly with its score", () => {
    expect(TRAIN_PY).toContain(
      "if task == 'clustering':\n        out['prediction'] = np.asarray(pred, dtype='int64')",
    );
    expect(TRAIN_PY).toContain(
      "out['distance'] = np.min(pipe.named_steps['model'].transform(Xt), axis=1)",
    );
    expect(TRAIN_PY).toContain("out['prediction'] = (np.asarray(pred) == -1).astype('int64')");
    expect(TRAIN_PY).toContain("out['anomaly_score'] = -pipe.decision_function(X)");
    expect(TRAIN_PY).toContain(
      "[c for c in ('probability', 'anomaly_score', 'distance') if c in out.columns]",
    );
    expect(TRAIN_PY).toContain(
      "if art.get('task') == 'recommendation':\n        return _predict_recommendation(art, cfg, warnings_)",
    );
  });

  it("never treats the recommendation key columns as features", () => {
    expect(TRAIN_PY).toContain(
      "reserved = set([c for c in (cfg.get('user_column'), cfg.get('item_column'), cfg.get('rating_column')) if c])",
    );
    expect(TRAIN_PY).toContain("'reason': 'recommendation key column'");
  });
});

describe("the server functions and the pinned program", () => {
  const fns = rd("src/utils/ml.functions.ts");
  const server = rd("src/utils/ml/train.server.ts");

  it("accepts the new fields and validates each task's needs", () => {
    expect(fns).toContain("target_column: IDENT.optional(),");
    for (const f of [
      "user_column: IDENT.optional()",
      "item_column: IDENT.optional()",
      "rating_column: IDENT.optional()",
    ]) {
      expect(fns).toContain(f);
    }
    expect(fns).toContain("n_clusters: z.number().int().min(2).max(50).optional()");
    expect(fns).toContain("contamination: z.number().min(0.001).max(0.5).optional()");
    expect(fns).toContain("if (ML_TARGET_TASKS.includes(data.task) && !data.target_column) {");
    expect(fns).toContain(
      'if (data.task === "recommendation" && (!data.user_column || !data.item_column)) {',
    );
  });

  it("stores each field only for the task that uses it", () => {
    expect(fns).toContain(
      'user_column: data.task === "recommendation" ? (data.user_column ?? null) : null,',
    );
    expect(fns).toContain(
      'n_clusters: data.task === "clustering" ? (data.n_clusters ?? null) : null,',
    );
    expect(fns).toContain(
      'contamination: data.task === "anomaly" ? (data.contamination ?? null) : null,',
    );
    expect(fns).toContain(
      "target_column: ML_TARGET_TASKS.includes(data.task) ? (data.target_column ?? null) : null,",
    );
  });

  it("checks a prepared SELECT for the target only when there is one", () => {
    expect(fns).toContain("target: string | null | undefined,");
    expect(fns).toContain("if (target && !head.columns.some((c) => c.name === target)) {");
  });

  it("hands every new field to the sandbox program", () => {
    for (const f of [
      "user_column: b.model.user_column,",
      "item_column: b.model.item_column,",
      "rating_column: b.model.rating_column,",
      "n_clusters: b.model.n_clusters,",
      "contamination: b.model.contamination,",
    ]) {
      expect(server).toContain(f);
    }
  });
});

describe("the wizard and the pages", () => {
  const wizard = rd("src/routes/_authenticated/ml_.new.tsx");
  const ui = rd("src/components/ml/mlUi.tsx");

  it("offers the four goals and sends what each needs", () => {
    for (const label of ["Predict a column", "Find groups", "Find anomalies", "Recommend items"]) {
      expect(wizard).toContain(label);
    }
    expect(wizard).toContain("target_column: needsTarget ? target : undefined,");
    expect(wizard).toContain('user_column: task === "recommendation" ? userColumn : undefined,');
    expect(wizard).toContain(
      'n_clusters: task === "clustering" && nClusters !== "" ? Number(nClusters) : undefined,',
    );
    // The form takes a percentage; the schema takes a fraction.
    expect(wizard).toContain(
      'task === "anomaly" && contamination !== "" ? Number(contamination) / 100 : undefined,',
    );
    // A recommendation needs two different columns before the wizard moves on.
    expect(wizard).toContain("Boolean(userColumn && itemColumn && userColumn !== itemColumn)");
  });

  it("styles and formats every task and its metrics", () => {
    for (const t of NEW_TASKS) expect(ui).toContain(`  ${t}: "border-`);
    for (const m of ["hit_rate_10", "coverage", "anomaly_rate"]) expect(ui).toContain(`"${m}"`);
    expect(ui).toContain('if (name === "silhouette") return value >= 0.5 ? "good"');
  });

  it("shows group profiles and recommendation lists", () => {
    expect(rd("src/routes/_authenticated/ml_.$modelId.tsx")).toContain("function ClusterProfiles(");
    expect(rd("src/components/ml/PredictionsPanel.tsx")).toContain("function RecList(");
  });
});

describe("the docs", () => {
  it("describe every task in the guide and on the page", () => {
    const md = rd("docs/ML.md");
    const page = rd("src/routes/docs.ml.tsx");
    for (const t of ML_TASKS) {
      expect(md).toContain(ML_TASK_LABEL[t]);
      expect(page).toContain(ML_TASK_LABEL[t]);
    }
    for (const phrase of [
      "silhouette",
      "isolation forest",
      "TF-IDF",
      "cold start",
      "Hit rate @10",
    ]) {
      expect(md.toLowerCase()).toContain(phrase.toLowerCase());
      expect(page.toLowerCase()).toContain(phrase.toLowerCase());
    }
    // The batch output columns of the new tasks are named.
    for (const col of ["`distance`", "`anomaly_score`", "`cold_start`"]) expect(md).toContain(col);
  });
});
