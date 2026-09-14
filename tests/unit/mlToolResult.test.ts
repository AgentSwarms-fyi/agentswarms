// What an ML tool result looks like to a PERSON in the Playground.
//
// The tool loop gives the model the full JSON and the panel a 400-character
// preview. For a prediction that preview is the model name, the version and
// the first row's probabilities cut off mid-number — a screenshot of the
// result, not the result. The loop now also attaches `data`: the prediction
// table (key columns first), the model list, or the error, parsed from the
// full result at the one place it exists, and the panel renders that.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  ML_RESULT_MAX_POINTS,
  ML_RESULT_MAX_ROWS,
  formatNumber,
  headlineMetric,
  mlToolData,
} from "@/lib/mlToolResult";

const rd = (p: string) => readFileSync(p, "utf8");
const LOOP = rd("src/utils/tools/loop.server.ts");
const PANEL = rd("src/routes/_authenticated/playground.tsx");
const DOCS = [
  rd("docs/AGENT_CHAT.md"),
  rd("docs/ML.md"),
  rd("src/routes/docs.ml.tsx"),
  rd("src/routes/docs.playground.tsx"),
];

/** Code with its line and JSX comments removed — guards read code, not prose. */
const codeOnly = (s: string) => s.replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const PREDICT = JSON.stringify({
  model: "revenue_facts plan classifier",
  version: 7,
  task: "classification",
  algorithm: "logistic_regression",
  predictions: [
    { order_id: 1000, prediction: "pro", probability: 0.9479445, proba_pro: 0.9479445 },
    { order_id: 1001, prediction: "enterprise", probability: 0.9677846, proba_pro: 0.0171 },
  ],
  row_count: 2,
  feature_view: "order_features",
  keys_not_found: ["order_id=999999"],
  features_served_from: "online",
  warnings: [],
  notes: ["prediction is the predicted class"],
});

describe("mlToolData", () => {
  it("is null for every other tool and for a result that is not JSON", () => {
    expect(mlToolData("sql_query", PREDICT)).toBeNull();
    expect(mlToolData("ml_predict", "not json")).toBeNull();
    expect(mlToolData("ml_predict", "[1,2]")).toBeNull();
  });

  it("turns a prediction into a table with the key column first and the misses named", () => {
    const d = mlToolData("ml_predict", PREDICT);
    expect(d?.kind).toBe("predict");
    if (d?.kind !== "predict") return;
    expect(d.model).toBe("revenue_facts plan classifier");
    expect(d.version).toBe(7);
    expect(d.columns).toEqual(["order_id", "prediction", "probability", "proba_pro"]);
    expect(d.rows).toHaveLength(2);
    expect(d.row_count).toBe(2);
    expect(d.keys_not_found).toEqual(["order_id=999999"]);
    expect(d.features_served_from).toBe("online");
    expect(d.feature_view).toBe("order_features");
    expect(d.notes).toEqual(["prediction is the predicted class"]);
    expect(d.forecast).toEqual([]);
  });

  it("carries an error as the error, never as an empty table", () => {
    expect(
      mlToolData("ml_predict", JSON.stringify({ error: "Send rows or keys, not both." })),
    ).toEqual({
      kind: "error",
      error: "Send rows or keys, not both.",
    });
  });

  it("bounds what reaches the browser", () => {
    const many = {
      ...JSON.parse(PREDICT),
      predictions: Array.from({ length: 500 }, (_, i) => ({ id: i })),
    };
    const d = mlToolData("ml_predict", JSON.stringify(many));
    expect(d?.kind === "predict" && d.rows.length).toBe(ML_RESULT_MAX_ROWS);
    const points = Array.from({ length: 1000 }, (_, i) => ({
      period: `p${i}`,
      yhat: i,
      lo: null,
      hi: null,
    }));
    const f = mlToolData(
      "ml_predict",
      JSON.stringify({ model: "m", task: "forecast", forecast: points }),
    );
    expect(f?.kind === "predict" && f.forecast.length).toBe(ML_RESULT_MAX_POINTS);
  });

  it("lists models with their task, version, headline metric and key columns", () => {
    const d = mlToolData(
      "ml_list_models",
      JSON.stringify({
        models: [
          {
            name: "plan",
            task: "classification",
            target: "plan",
            version: 7,
            algorithm: "logistic_regression",
            metrics: { log_loss: 0.06, accuracy: 0.94 },
            features: [{ name: "a" }, { name: "b" }],
            feature_view: { name: "order_features", key_columns: ["order_id"] },
          },
          {
            name: "reg",
            task: "regression",
            target: "net_usd",
            version: 3,
            metrics: { r2: 0.81 },
            feature_view: null,
          },
        ],
      }),
    );
    expect(d?.kind).toBe("models");
    if (d?.kind !== "models") return;
    expect(d.models[0]).toEqual({
      name: "plan",
      task: "classification",
      target: "plan",
      version: 7,
      algorithm: "logistic_regression",
      feature_view: { name: "order_features", key_columns: ["order_id"] },
      features: 2,
      metric: "accuracy 0.94",
      health: null,
    });
    expect(d.models[1].metric).toBe("r2 0.81");
    // The tool's health block becomes the one-line summary the list shows.
    const h = mlToolData(
      "ml_list_models",
      JSON.stringify({
        models: [
          {
            name: "plan",
            task: "classification",
            health: { alerts: ["Drift: …"], summary: "open drift alert (PSI 3.291 on 2026-09-14)" },
          },
        ],
      }),
    );
    expect(h?.kind === "models" && h.models[0].health).toBe(
      "open drift alert (PSI 3.291 on 2026-09-14)",
    );
    expect(d.models[1].feature_view).toBeNull();
  });

  it("quotes the metric a person would, per task, and falls back to the first number", () => {
    // accuracy before log_loss for a classifier even though log_loss is listed first.
    expect(headlineMetric("classification", { log_loss: 0.06, accuracy: 0.94 })).toBe(
      "accuracy 0.94",
    );
    expect(headlineMetric("regression", { mae: 12.34, r2: 0.5 })).toBe("r2 0.5");
    expect(headlineMetric("clustering", { silhouette: 0.42 })).toBe("silhouette 0.42");
    expect(headlineMetric("anomaly", { something_else: 3 })).toBe("something_else 3");
    expect(headlineMetric("regression", null)).toBeNull();
  });

  it("formats probabilities to three places and leaves ids alone", () => {
    expect(formatNumber(0.9479445)).toBe("0.948");
    expect(formatNumber(1000)).toBe("1000");
    expect(formatNumber(0.5)).toBe("0.5");
    expect(formatNumber(12345.678)).toBe("12345.7");
  });
});

describe("the loop attaches it at the point of execution", () => {
  it("on the tool_result event, for the ML tools only, beside sources", () => {
    const code = codeOnly(LOOP);
    expect(code).toContain('import { mlToolData, type MlToolData } from "@/lib/mlToolResult";');
    expect(code).toContain("data?: MlToolData;");
    expect(code).toContain("const data = mlToolData(tc.function.name, result) ?? undefined;");
    expect(code).toContain("          data,\n        });");
    // An ML tool answers an error as JSON rather than throwing, so the call
    // "succeeded" while its result says it did not; the badge says error.
    expect(code).toContain('ok: ok && data?.kind !== "error",');
    // The preview stays what it was — other tools still show it.
    expect(code).toContain("preview: result.slice(0, 400),");
  });
});

describe("the panel renders it", () => {
  it("prefers the table over the preview when data is present, and keeps the preview otherwise", () => {
    const code = codeOnly(PANEL);
    expect(code).toContain("data?: MlToolData;");
    expect(code).toContain("{r?.data ? (");
    expect(code).toContain("<MlToolResultView data={r.data} />");
    expect(code).toContain("Result preview");
  });

  it("shows the model, the rows, the misses and where the features came from", () => {
    const from = PANEL.indexOf("function MlToolResultView(");
    const to = PANEL.indexOf("function ToolEventsPanel(", from);
    expect(from).toBeGreaterThan(0);
    const view = codeOnly(PANEL.slice(from, to));
    expect(view).toContain('data.kind === "error"');
    expect(view).toContain('data.kind === "models"');
    expect(view).toContain("{data.columns.map((c) => (");
    expect(view).toContain("features from {data.features_served_from}");
    expect(view).toContain("not found");
    expect(view).toContain("Not found: {data.keys_not_found.join(");
    expect(view).toContain("data.forecast.length > 0");
    // A forecast has periods, not rows — "0 rows" over a table of periods
    // was the first thing the UI round showed.
    expect(view).toContain("`${data.forecast.length} period${");
    expect(view).toContain("No rows scored.");
    expect(view).toContain("formatNumber(");
  });
});

describe("docs", () => {
  it("say what the panel shows, in the repo and in the app", () => {
    for (const d of DOCS) {
      expect(d).toMatch(/prediction\s+(as a )?table|prediction table/);
      expect(d).toMatch(/key columns first/);
      expect(d).toMatch(/error(?: is shown| shows)? as the error/);
    }
  });
});
