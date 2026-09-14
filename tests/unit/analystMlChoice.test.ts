// An analyst's predictive models are its own choice.
//
// Until now the planner was shown every trained model its owner could use and
// picked among them by the question. The user asked for the choice to sit
// where the reasoning model and the data are chosen: any model it can use,
// or exactly the ones ticked. The rule is the one an agent's ML tool already
// follows (null = every model, a list = exactly those, [] = none) and, like
// there, it is ENFORCED when a step scores — the planner can be shown one
// thing and name another, and the server is the one that says no.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { analystModelsAllowed, describeModelChoice, runAnalystTurn } from "@/lib/aiAnalyst";

const rd = (p: string) => readFileSync(p, "utf8");

const models = [{ name: "plan classifier" }, { name: "anomalies" }, { name: "net_usd forecast" }];

describe("analystModelsAllowed", () => {
  it("null or absent is every model", () => {
    expect(analystModelsAllowed(models, null)).toEqual(models);
    expect(analystModelsAllowed(models, undefined)).toEqual(models);
  });
  it("a list is exactly those, by name, blanks ignored", () => {
    expect(analystModelsAllowed(models, ["anomalies", " ", "nope"])).toEqual([
      { name: "anomalies" },
    ]);
  });
  it("an empty list is none", () => {
    expect(analystModelsAllowed(models, [])).toEqual([]);
  });
});

describe("describeModelChoice", () => {
  it("says what the choice means, in the card's words", () => {
    expect(describeModelChoice(null, 7)).toBe("Any predictive model (7)");
    expect(describeModelChoice(null, 0)).toBe("No predictive models trained yet");
    expect(describeModelChoice(["a", "b"], 7)).toBe("2 of 7 predictive models");
    expect(describeModelChoice(["a"], 1)).toBe("1 of 1 predictive model");
    expect(describeModelChoice([], 7)).toBe("No predictive models — steps are never scored");
  });
});

describe("a question naming a model outside the analyst's list", () => {
  const classifier = {
    name: "revenue_facts plan classifier",
    task: "classification",
    target: "plan",
    version: 7,
    algorithm: null,
    metric: null,
    keyColumns: ["order_id"],
    features: [],
    health: null,
  };
  const world = (plan: Record<string, unknown>) => {
    let executions = 0;
    const llm = async <T>(a: { systemPrompt: string; userPrompt: string }): Promise<T> => {
      const p = a.systemPrompt + a.userPrompt;
      if (/"approach"/.test(p) && /"steps"/.test(p)) return plan as T;
      if (/"sql"/.test(p)) return { sql: "SELECT order_id FROM t" } as T;
      if (/checks/i.test(p)) return { checks: [{ verdict: "pass", note: "ok" }], headline: 0 } as T;
      return { answer: "done", follow_ups: [] } as T;
    };
    return {
      executions: () => executions,
      args: (question: string) => ({
        question,
        datasets: [],
        semantics: new Map(),
        metrics: [],
        priorTurns: [],
        execute: async () => {
          executions += 1;
          return { columns: ["order_id"], rows: [{ order_id: 1 }] };
        },
        dialect: "test",
        llm,
        models: [classifier],
        modelsOutsideScope: ["revenue_facts · anomalies", "revenue_facts model"],
        onUpdate: () => {},
      }),
    };
  };
  const q = "Which 10 orders look most anomalous according to the revenue_facts · anomalies model?";

  it("says the model exists but is not enabled, and points at the setting — when the plan substituted", async () => {
    const w = world({
      approach: "s",
      steps: [{ goal: "anomalous", score: { model: classifier.name } }],
    });
    const turn = await runAnalystTurn(w.args(q));
    expect(turn.status).toBe("clarifying");
    expect(turn.clarify).toContain(
      '"revenue_facts · anomalies" exists but is not enabled for this analyst',
    );
    expect(turn.clarify).toContain('its predictive models are "revenue_facts plan classifier"');
    expect(turn.clarify).toContain("the pencil on its card");
    expect(w.executions()).toBe(0);
  });

  it("…and when the planner asked on its own", async () => {
    const w = world({
      clarify: "What is the name of the anomalies model?",
      assumption: "there is one",
    });
    const turn = await runAnalystTurn(w.args(q));
    expect(turn.status).toBe("clarifying");
    expect(turn.clarify).toContain("exists but is not enabled for this analyst");
  });

  it("a model nobody has is still 'no trained model named'", async () => {
    const w = world({
      approach: "s",
      steps: [{ goal: "risk", score: { model: classifier.name } }],
    });
    const turn = await runAnalystTurn(w.args("Score customers with the churn model"));
    expect(turn.clarify).toContain('No trained model named "churn"');
  });

  it("the route hands the loop the models outside the analyst's list", () => {
    const route = rd("src/routes/_authenticated/ai-analyst.tsx");
    expect(route).toContain("modelsOutsideScope: allModels");
    expect(route).toContain(".filter((m) => !scorable.some((s) => s.name === m.name))");
  });
});

describe("the choice is stored, offered, and enforced", () => {
  const migration = rd("supabase/migrations/20260920000000_ai_analyst_ml_models.sql");
  const types = rd("src/integrations/supabase/types.ts");
  const route = rd("src/routes/_authenticated/ai-analyst.tsx");
  const fns = rd("src/utils/analystScore.functions.ts");
  const scoring = rd("src/utils/ml/scoreRows.server.ts");
  const embed = rd("src/utils/analyst/run.server.ts");

  it("lives on the analyst row, nullable, so existing analysts keep every model", () => {
    expect(migration).toContain(
      "ALTER TABLE public.ai_analysts\n  ADD COLUMN IF NOT EXISTS ml_model_names text[] NULL;",
    );
    expect(types).toContain("ml_model_names: string[] | null;");
    expect(route).toContain(
      '.select("id, name, model, source, ml_model_names, created_at, user_id")',
    );
  });

  it("is chosen in the same dialog as the reasoning model and the data, and saved with them", () => {
    expect(route).toContain("Predictive models</Label>");
    expect(route).toContain("Any model it can use ({allModels.length})");
    expect(route).toContain("Only these");
    expect(route).toContain("ml_model_names: draftMlModels,");
    expect(route).toContain("setDraftMlModels(a.ml_model_names ?? null);");
  });

  it("scopes what the planner is shown to the selected analyst's choice", () => {
    expect(route).toContain("analystModelsAllowed(allModels, selected?.ml_model_names)");
    expect(route).toContain("models: scorable,");
  });

  it("names the analyst on every scoring call, and the server reads the choice under the caller's session", () => {
    expect(route.match(/analystId: selected\.id,/g) ?? []).toHaveLength(2);
    expect(fns).toContain("async function analystAllowList(");
    expect(fns).toContain('.select("ml_model_names")');
    expect(
      fns.match(/await analystAllowList\(data\.accessToken, data\.analystId\)/g) ?? [],
    ).toHaveLength(3);
  });

  it("refuses a model outside the list when a step scores or forecasts, whatever the planner was shown", () => {
    expect(scoring).toContain(
      "if (mlModelsAllowed([model], args.allow ?? undefined).length === 0) {",
    );
    expect(scoring.match(/is not enabled for this analyst\./g) ?? []).toHaveLength(2);
    expect(scoring).toContain('args.allow ?? undefined,\n    "ai_analyst",');
    expect(scoring).toContain(
      'runMlPredict(ctx, { model: model.name }, args.allow ?? undefined, "ai_analyst")',
    );
  });

  it("the embed runner applies the same choice as the owner", () => {
    expect(embed).toContain('.select("id, user_id, name, model, source, ml_model_names")');
    expect(embed).toContain("scorableModelsForUser(args.ownerId, analyst.ml_model_names)");
    expect(embed).toContain("allow: analyst.ml_model_names, ...req");
  });

  it("the docs say an analyst is three choices", () => {
    expect(rd("docs/BUSINESS_INTELLIGENCE.md")).toContain("three choices and nothing else");
    expect(rd("src/routes/docs.bi.tsx")).toContain("analyst is three choices");
    expect(rd("docs/ML.md")).toContain("Which models an analyst\nmay use is its own setting");
  });
});
