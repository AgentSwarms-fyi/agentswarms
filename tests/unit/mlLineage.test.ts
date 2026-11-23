// Where a model's data comes from and where its answers go (R527), read from
// facts each object already records; and the catalog entry of each table.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { addMlLineage, lookupLineage, type LineageIndex } from "@/lib/dataCatalog";
import {
  agentsUsing,
  dashboardsDrawing,
  mlTableUses,
  modelReads,
  pipelinesStarting,
  predictionWrites,
  type PredictionRow,
} from "@/lib/mlLineage";

const MODEL = {
  id: "m-1",
  name: "Churn",
  source: { kind: "lakehouse", schema: "crm", table: "customers" },
  prep: { sql: "SELECT c.*, p.plan FROM crm.customers c JOIN plans p ON p.id = c.plan_id" },
};

const pred = (over: Partial<PredictionRow> = {}): PredictionRow => ({
  model_id: "m-1",
  status: "succeeded",
  input: { kind: "lakehouse", schema: "crm", table: "new_signups" },
  output: { schema: "scores", table: "churn_scores" },
  finished_at: "2026-11-20T10:00:00.000Z",
  ...over,
});

describe("what a model reads", () => {
  it("its source, and a table its preparation joins in (a bare name in the source's schema)", () => {
    expect(modelReads(MODEL)).toEqual([
      { table: "crm.customers", via: "source" },
      { table: "crm.plans", via: "preparation" },
    ]);
    expect(modelReads({ source: MODEL.source })).toEqual([
      { table: "crm.customers", via: "source" },
    ]);
  });
});

describe("what its answers feed", () => {
  it("the tables batch predictions wrote, newest first, counted, failed runs left out", () => {
    const writes = predictionWrites([
      pred(),
      pred({ finished_at: "2026-11-22T10:00:00.000Z" }),
      pred({ status: "failed", output: { schema: "scores", table: "broken" } }),
      pred({ output: null }),
      pred({
        output: { schema: "scores", table: "older" },
        finished_at: "2026-11-01T00:00:00.000Z",
      }),
    ]);
    expect(writes).toEqual([
      {
        table: "scores.churn_scores",
        from: "crm.new_signups",
        runs: 2,
        last_at: "2026-11-22T10:00:00.000Z",
      },
      {
        table: "scores.older",
        from: "crm.new_signups",
        runs: 1,
        last_at: "2026-11-01T00:00:00.000Z",
      },
    ]);
  });

  it("dashboards whose charts draw one of its versions, on any page", () => {
    const chart = (title: string, versionId: string) => ({
      kind: "chart",
      title,
      chart: { forecast: { periods: 6, versionId } },
    });
    const found = dashboardsDrawing(
      [
        {
          id: "d-1",
          name: "Revenue",
          widgets: [],
          pages: [{ widgets: [chart("By week", "v-2")] }],
        },
        { id: "d-2", name: "Other", widgets: [chart("Theirs", "v-9")] },
        { id: "d-3", name: "Built-in", widgets: [{ kind: "chart", chart: { forecast: 6 } }] },
      ],
      new Set(["v-1", "v-2"]),
    );
    expect(found).toEqual([{ id: "d-1", name: "Revenue", charts: ["By week"] }]);
  });

  it("agents with the prediction tool that name it, or name no list (every model)", () => {
    const agent = (id: string, tools: unknown) => ({ id, name: id, tools });
    expect(
      agentsUsing(
        [
          agent("named", {
            builtInTools: { ml_predict: true },
            toolConfigs: { ml_predict: { model_names: ["Churn"] } },
          }),
          agent("any", { builtInTools: { ml_predict: true } }),
          agent("other", {
            builtInTools: { ml_predict: true },
            toolConfigs: { ml_predict: { model_names: ["X"] } },
          }),
          agent("none", {
            builtInTools: { ml_predict: true },
            toolConfigs: { ml_predict: { model_names: [] } },
          }),
          agent("off", { builtInTools: { ml_predict: false } }),
        ],
        "Churn",
      ),
    ).toEqual([
      { id: "named", name: "named", anyModel: false },
      { id: "any", name: "any", anyModel: true },
    ]);
  });

  it("pipelines that start one of its schedules", () => {
    expect(
      pipelinesStarting(
        [
          { id: "p-1", name: "nightly", chain_ml_schedules: ["s-1"] },
          { id: "p-2", name: "other", chain_ml_schedules: ["s-9"] },
          { id: "p-3", name: "none", chain_ml_schedules: null },
        ],
        new Set(["s-1"]),
      ),
    ).toEqual([{ id: "p-1", name: "nightly" }]);
  });
});

describe("in the catalog", () => {
  it("each table says which model uses it, and how", () => {
    const uses = mlTableUses([MODEL], [pred()]);
    expect(uses.get("crm.customers")).toEqual([
      { modelId: "m-1", modelName: "Churn", detail: "trains on it" },
    ]);
    expect(uses.get("crm.new_signups")).toEqual([
      { modelId: "m-1", modelName: "Churn", detail: "scored by it" },
    ]);
    expect(uses.get("scores.churn_scores")).toEqual([
      {
        modelId: "m-1",
        modelName: "Churn",
        detail: "predictions written here",
        derivedFrom: "crm.new_signups",
      },
    ]);
    // A prediction by a model the reader cannot see says nothing.
    expect(mlTableUses([], [pred()]).size).toBe(0);
  });

  it("is keyed like any lakehouse asset, and the written table is derived from the scored one", () => {
    const index: LineageIndex = new Map();
    addMlLineage(index, ["lake-1"], [MODEL], [pred()]);
    const out = lookupLineage(index, ["wh:lake-1:scores.churn_scores"]);
    expect(out.usedBy).toEqual([
      { kind: "ml_model", id: "m-1", name: "Churn", detail: "predictions written here" },
    ]);
    expect(out.derivedFrom).toEqual(["crm.new_signups"]);
    expect(lookupLineage(index, ["wh:lake-1:crm.customers"]).usedBy[0].detail).toBe("trains on it");
    const none: LineageIndex = new Map();
    addMlLineage(none, [], [MODEL], [pred()]);
    expect(none.size).toBe(0);
  });
});

describe("the wiring", () => {
  const rd = (p: string) => readFileSync(p, "utf8");

  it("the model page reads the caller's own objects downstream, with read access to the model", () => {
    const fns = rd("src/utils/ml.functions.ts");
    const at = fns.indexOf("export const mlModelLineage");
    const body = fns.slice(at, fns.indexOf("export const mlGetJob", at));
    expect(body).toContain("await loadModelForUser(data.model_id, userId);");
    for (const t of [
      "ml_predictions",
      "agents",
      "ml_schedules",
      "bi_dashboards",
      "etl_pipelines",
    ]) {
      const i = body.indexOf(`.from("${t}")`);
      expect(i, t).toBeGreaterThan(0);
      expect(body.slice(i, i + 260), t).toContain('.eq("user_id", userId)');
    }
    expect(rd("src/routes/_authenticated/ml_.$modelId.tsx")).toContain(
      "<ModelLineageCard modelId={modelId} token={token} />",
    );
  });

  it("the catalog links a model to its page", () => {
    const view = rd("src/components/catalog/CatalogView.tsx");
    expect(view).toContain(') : r.kind === "ml_model" ? (');
    expect(view).toContain('to="/ml/$modelId"');
    expect(rd("src/lib/dataCatalog.ts")).toContain(
      'supabase.from("data_warehouse_connections").select("id").eq("provider", "lakehouse"),',
    );
  });
});
