// What a session of asking the AI Analyst about ML models found, pinned.
//
// Seven questions against seven trained models, read from the DOM and the
// rows (ADVERSARIAL_LOG R10). A scored step with fifteen rows had its
// write-up built from column totals; an id column's total was read as a
// wrong aggregation; a step that NAMED a model was not scored and its actual
// values were presented as the model's estimates; "the ten most anomalous"
// could not be ranked by the model's score; a correction that read a model
// column ran anyway and failed; a failed correction was reported as a failed
// step; the forecast models were invisible and a regression model was used
// to forecast; "the churn model" was silently replaced by the clustering
// model; rows missing six of seven features were scored; the write-up could
// not describe a group it was never told about. Each has a test here.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  ANALYST_SCORE_CAP,
  buildAnalysisPlanPrompt,
  buildCheckPrompt,
  buildSynthesisPrompt,
  describeScorableModels,
  type ForecastResult,
  modelOutputs,
  namedModelMissing,
  namesModel,
  parseAnalysisPlan,
  parseScoreRank,
  rankScoredRows,
  runAnalystTurn,
  type ScorableModel,
  type ScoreRowsResult,
  scoredLabel,
  stepFacts,
} from "@/lib/aiAnalyst";
import { describeResultFacts } from "@/lib/biAgent";

const rd = (p: string) => readFileSync(p, "utf8");

const classifier: ScorableModel = {
  name: "revenue_facts plan classifier",
  task: "classification",
  target: "plan",
  version: 7,
  algorithm: "logistic_regression",
  metric: "accuracy 1",
  keyColumns: ["order_id"],
  features: ["net_usd", "region"],
  health: null,
};
const anomalies: ScorableModel = {
  name: "revenue_facts · anomalies",
  task: "anomaly",
  target: null,
  version: 1,
  algorithm: "isolation_forest",
  metric: "anomaly_rate 0",
  keyColumns: null,
  features: ["net_usd", "region", "plan"],
  health: null,
};
const forecaster: ScorableModel = {
  name: "revenue_facts · net_usd",
  task: "forecast",
  target: "net_usd",
  version: 1,
  algorithm: "moving_average",
  metric: "mape 8.507",
  keyColumns: null,
  features: [],
  health: null,
};
const MODELS = [classifier, anomalies, forecaster];

// ── The planner's vocabulary and rules ─────────────────────────────────────
describe("what the planner is told about outputs, forecasts and missing models", () => {
  it("names each model's output columns, so a plan can rank by one", () => {
    expect(modelOutputs("anomaly")).toContain("anomaly_score (higher = more unusual)");
    expect(modelOutputs("classification")).toContain("proba_<class>");
    const text = describeScorableModels(MODELS);
    expect(text).toContain("outputs: prediction (1 = anomaly), anomaly_score");
  });

  it("lists forecast models in their own block, and not among the scorable ones", () => {
    const text = describeScorableModels(MODELS);
    expect(text).toContain("FORECAST MODELS");
    expect(text).toContain("MODEL revenue_facts · net_usd — forecast → net_usd, v1, mape 8.507");
    expect(text.indexOf("FORECAST MODELS")).toBeGreaterThan(
      text.indexOf("MODEL revenue_facts · anomalies"),
    );
    expect(describeScorableModels([classifier])).not.toContain("FORECAST MODELS");
    expect(describeScorableModels([forecaster])).toContain("FORECAST MODELS");
  });

  it("gives the rank, forecast and no-substitution rules", () => {
    const p = buildAnalysisPlanPrompt({ schema: "S", question: "q", prior: "", models: MODELS });
    expect(p.systemPrompt).toMatch(/MOST \/ LEAST \/ TOP-N BY THE MODEL'S OUTPUT/);
    expect(p.systemPrompt).toContain(
      '"rank": { "by": "<output column>", "desc": true, "limit": N }',
    );
    expect(p.systemPrompt).toContain("ADD A FORECAST STEP");
    expect(p.systemPrompt).toContain("Never use a regression model to forecast");
    expect(p.systemPrompt).toContain("do not substitute another model");
    expect(p.systemPrompt).toContain("to estimate, score or predict with a NAMED trained model");
    expect(p.userPrompt).toContain(
      '"forecast": { "model": "<forecast model name>", "horizon": N } (optional)',
    );
    // No forecast model in scope: no forecast rule, no forecast block in the shape.
    const q = buildAnalysisPlanPrompt({
      schema: "S",
      question: "q",
      prior: "",
      models: [classifier],
    });
    expect(q.systemPrompt).not.toContain("ADD A FORECAST STEP");
    expect(q.userPrompt).not.toContain('"forecast": {');
  });
});

describe("three more from the re-run", () => {
  it("rows-mode scoring asks the SQL for the entity's identifier beside the features", async () => {
    const { scoringSqlGoal } = await import("@/lib/aiAnalyst");
    const g = scoringSqlGoal({ goal: "most anomalous", score: { model: anomalies.name } }, MODELS);
    expect(g).toContain("plus the column(s) that identify the entity (its id or name)");
    // A ranked step samples up to the cap; the platform keeps the top N.
    const r = scoringSqlGoal(
      {
        goal: "10 most anomalous",
        score: { model: anomalies.name, rank: { by: "anomaly_score", desc: true, limit: 10 } },
      },
      MODELS,
    );
    expect(r).toContain(
      "up to 50 rows (the platform keeps the top 10 by anomaly_score after scoring, so do NOT limit to that number)",
    );
    expect(r).not.toContain("or the number the goal itself names");
  });

  it("the reviewer is told a forecast step's period and horizon, and to name a mismatch", () => {
    const p = buildCheckPrompt({
      question: "next 3 months",
      steps: [
        {
          goal: "next 3 months",
          facts: "f",
          forecast: { model: "fc", period: "week", periods: 3, lastObserved: "2026-03-29" },
        },
      ],
    });
    expect(p.userPrompt).toContain("3 of them, each one week, after 2026-03-29");
    expect(p.userPrompt).toContain("If the goal asks for a different period");
  });

  it("an accepted assumption is an answer: the planner is told so, and asked once more if it asks again", async () => {
    const p = buildAnalysisPlanPrompt({
      schema: "S",
      question: "the churn model\n\nProceed with this assumption: answer without a model",
      prior: "",
      models: MODELS,
    });
    expect(p.systemPrompt).toContain("THE USER HAS ANSWERED");
    expect(
      buildAnalysisPlanPrompt({ schema: "S", question: "plain", prior: "", models: MODELS })
        .systemPrompt,
    ).not.toContain("THE USER HAS ANSWERED");
    // The loop: the planner asks again despite the assumption, then plans.
    let planCalls = 0;
    const w = world({ plan: { approach: "x", steps: [{ goal: "count orders" }] } });
    const a = w.args("the churn model\n\nProceed with this assumption: answer without a model");
    const inner = a.llm;
    a.llm = async <T>(x: { systemPrompt: string; userPrompt: string }): Promise<T> => {
      if (/"approach"/.test(x.systemPrompt + x.userPrompt) && /"steps"/.test(x.userPrompt)) {
        planCalls += 1;
        if (planCalls === 1) return { clarify: "which model?", assumption: "none" } as T;
        expect(x.systemPrompt).toContain("a second clarify is a refusal to work");
      }
      return inner<T>(x);
    };
    const turn = await runAnalystTurn(a);
    expect(planCalls).toBe(2);
    expect(turn.status).toBe("done");
    expect(turn.steps[0].goal).toBe("count orders");
  });
});

// ── Parsing ────────────────────────────────────────────────────────────────
describe("parsing rank, forecast and a goal that names a model", () => {
  it("validates a rank block: a column, descending by default, a limit within the cap", () => {
    expect(parseScoreRank({ by: "anomaly_score", limit: 10 })).toEqual({
      by: "anomaly_score",
      desc: true,
      limit: 10,
    });
    expect(parseScoreRank({ by: "probability", desc: false })).toEqual({
      by: "probability",
      desc: false,
    });
    expect(parseScoreRank({ column: "prediction", dir: "asc", limit: 999 })).toEqual({
      by: "prediction",
      desc: false,
      limit: ANALYST_SCORE_CAP,
    });
    expect(parseScoreRank({ limit: 3 })).toBeUndefined();
    expect(parseScoreRank("anomaly_score")).toBeUndefined();
  });

  it("keeps a rank on a scored step, and refuses a scored step on a forecast model", () => {
    const out = parseAnalysisPlan(
      {
        approach: "a",
        steps: [
          {
            goal: "most anomalous orders",
            score: { model: anomalies.name, rank: { by: "anomaly_score", desc: true, limit: 10 } },
          },
          { goal: "score with the forecaster", score: { model: forecaster.name } },
        ],
      },
      [],
      MODELS,
    );
    expect(out.steps[0].score).toEqual({
      model: anomalies.name,
      rank: { by: "anomaly_score", desc: true, limit: 10 },
    });
    // Named as a scored model but a forecaster: not scored — and, because the
    // goal names it, it becomes a forecast step instead.
    expect(out.steps[1].score).toBeUndefined();
    expect(out.steps[1].forecast).toBeUndefined();
  });

  it("keeps a forecast step for a forecast model, with a bounded horizon", () => {
    const out = parseAnalysisPlan(
      {
        approach: "a",
        steps: [
          { goal: "next quarter", forecast: { model: forecaster.name, horizon: 3 } },
          { goal: "not a forecaster", forecast: { model: classifier.name, horizon: 3 } },
          { goal: "silly horizon", forecast: { model: forecaster.name, horizon: 9999 } },
        ],
      },
      [],
      MODELS,
    );
    expect(out.steps[0].forecast).toEqual({ model: forecaster.name, horizon: 3 });
    expect(out.steps[1].forecast).toBeUndefined();
    expect(out.steps[2].forecast).toEqual({ model: forecaster.name, horizon: 120 });
  });

  it("scores a step whose GOAL names a model in scope, even without a score block", () => {
    // Measured live: "estimate their net_usd with the revenue_facts model"
    // came back with no score block and was written as SQL over the actual
    // values, which the write-up then called the model's estimates.
    const out = parseAnalysisPlan(
      {
        approach: "a",
        steps: [
          { goal: "Estimate the plan of each order using the revenue_facts plan classifier" },
          { goal: "Project net_usd with the revenue_facts · net_usd model over 3 months" },
          { goal: "Total revenue by region" },
        ],
      },
      [],
      MODELS,
    );
    expect(out.steps[0].score).toEqual({ model: classifier.name });
    expect(out.steps[1].forecast).toEqual({ model: forecaster.name });
    expect(out.steps[2].score).toBeUndefined();
    expect(out.steps[2].forecast).toBeUndefined();
  });

  it("reads a plan the model collapsed into one bare step, with the question as its goal", () => {
    // Measured live, twice in one session: `{ "score": { "model": …, "rank": … } }`
    // and `{ "forecast": { "model": …, "horizon": 3 } }` with nothing else.
    const q = "Which 10 orders look most anomalous?";
    const scored = parseAnalysisPlan(
      { score: { model: anomalies.name, rank: { by: "anomaly_score", desc: true, limit: 10 } } },
      [],
      MODELS,
      q,
    );
    expect(scored.steps).toEqual([
      {
        goal: q,
        score: { model: anomalies.name, rank: { by: "anomaly_score", desc: true, limit: 10 } },
      },
    ]);
    const fc = parseAnalysisPlan(
      { forecast: { model: forecaster.name, horizon: 3 } },
      [],
      MODELS,
      q,
    );
    expect(fc.steps).toEqual([{ goal: q, forecast: { model: forecaster.name, horizon: 3 } }]);
    // `steps` as a single object rather than a list.
    const one = parseAnalysisPlan(
      { steps: { goal: "g", score: { model: classifier.name } } },
      [],
      MODELS,
      q,
    );
    expect(one.steps).toEqual([{ goal: "g", score: { model: classifier.name } }]);
    // A bare root with nothing step-like is still no plan.
    expect(() => parseAnalysisPlan({ approach: "x" }, [], MODELS, q)).toThrow(/no analysis steps/);
  });

  it("names a model only as a whole phrase", () => {
    expect(namesModel("use the revenue_facts plan classifier now", classifier.name)).toBe(true);
    expect(namesModel("USE THE REVENUE_FACTS PLAN CLASSIFIER", classifier.name)).toBe(true);
    expect(namesModel("revenue_facts plan classifiers", classifier.name)).toBe(false);
    expect(namesModel("from analytics.revenue_facts", "revenue_facts model")).toBe(false);
  });
});

// ── The model a question names that does not exist ─────────────────────────
describe("namedModelMissing", () => {
  const known = MODELS.map((m) => m.name);
  it("finds the churn model nobody has", () => {
    expect(namedModelMissing("Score the customers with the churn model and rank them", known)).toBe(
      "churn",
    );
  });
  it("accepts a model named by part of its name, in either case", () => {
    expect(namedModelMissing("use the plan classifier model", known)).toBeNull();
    expect(namedModelMissing("Use the Revenue_Facts · Anomalies model", known)).toBeNull();
  });
  it("ignores a kind of model, and a question that already carries the user's answer", () => {
    expect(namedModelMissing("Use a trained forecast model if one fits", known)).toBeNull();
    expect(namedModelMissing("use the ML model", known)).toBeNull();
    expect(namedModelMissing("no model named at all", known)).toBeNull();
    // The marker is the loop's business: the phrase is still found.
    expect(
      namedModelMissing("the churn model\n\nProceed with this assumption: answer without", known),
    ).toBe("churn");
  });
});

// ── Ranking the scored rows ────────────────────────────────────────────────
describe("rankScoredRows", () => {
  const rows = [
    { id: 1, anomaly_score: -0.12 },
    { id: 2, anomaly_score: 0.31 },
    { id: 3, anomaly_score: null },
    { id: 4, anomaly_score: 0.05 },
  ];
  it("orders by the model's column, nulls last, and keeps the top N", () => {
    const out = rankScoredRows(rows, { by: "anomaly_score", desc: true, limit: 2 }, [
      "id",
      "anomaly_score",
    ]);
    expect(out.rows.map((r) => r.id)).toEqual([2, 4]);
    expect(out.applied).toEqual({ by: "anomaly_score", desc: true, limit: 2, of: 4 });
    expect(out.note).toBeNull();
    const asc = rankScoredRows(rows, { by: "anomaly_score", desc: false }, ["id", "anomaly_score"]);
    expect(asc.rows.map((r) => r.id)).toEqual([1, 4, 2, 3]);
  });
  it("leaves the rows unranked, and says so, when the column is not there", () => {
    const out = rankScoredRows(rows, { by: "risk", desc: true, limit: 2 }, ["id", "anomaly_score"]);
    expect(out.rows).toHaveLength(4);
    expect(out.applied).toBeNull();
    expect(out.note).toContain('rank by "risk", which is not a column of the scored rows');
  });
});

// ── What the check and the write-up are told ───────────────────────────────
describe("the reviewer and the writer are told what a model did and did not do", () => {
  it("check: a ranked step, a forecast step, and the no-model-ran rule", () => {
    const p = buildCheckPrompt({
      question: "q",
      steps: [
        {
          goal: "most anomalous",
          sql: "SELECT id FROM t",
          facts: "f",
          scored: {
            model: "m",
            columns: ["anomaly_score"],
            ranked: "anomaly_score desc, top 10 of 50",
          },
        },
        { goal: "next 3 months", facts: "f", forecast: { model: "fc" } },
      ],
    });
    expect(p.userPrompt).toContain("RANKED BY anomaly_score desc, top 10 of 50.");
    expect(p.userPrompt).toContain(
      'FORECAST BY the trained model "fc": the rows are its projected periods',
    );
    expect(p.systemPrompt).toContain("never propose ORDER BY on one");
    expect(p.systemPrompt).toContain("did not run it: its numbers are observed values");
  });

  it("synthesis: model notes, forecast rows, and the two rules that keep observed values observed", () => {
    const p = buildSynthesisPrompt({
      question: "q",
      approach: "a",
      prior: "",
      steps: [
        {
          goal: "g",
          facts: "f",
          scored: "m v1",
          scoredNotes: ["Group 0: 752 training rows (89.9%); typical row: plan free."],
        },
        { goal: "h", facts: "f", scored: "fc v1 (3 months)", forecast: true },
      ],
    });
    expect(p.userPrompt).toContain("MODEL NOTES:\n- Group 0: 752 training rows");
    expect(p.userPrompt).toContain(
      "FORECAST BY: fc v1 (3 months) — the rows are the model's projected periods",
    );
    expect(p.systemPrompt).toContain("never turn it into a projection");
    expect(p.systemPrompt).toContain(
      "A step NOT marked SCORED BY or FORECAST BY holds observed values only",
    );
    expect(p.systemPrompt).toContain("the step did not fail, report its numbers");
  });

  it("scoredLabel carries the ranking and a forecast's periods", () => {
    expect(
      scoredLabel({
        model: "m",
        version: 1,
        task: "anomaly",
        algorithm: null,
        metric: "anomaly_rate 0",
        keys: false,
        featuresServedFrom: null,
        rowsScored: 50,
        keysNotFound: [],
        health: null,
        ranked: { by: "anomaly_score", desc: true, limit: 10, of: 50 },
      }),
    ).toBe("m v1 (anomaly_rate 0); ranked by anomaly_score desc, top 10 of 50 scored");
    expect(
      scoredLabel({
        model: "fc",
        version: 1,
        task: "forecast",
        algorithm: null,
        metric: "mape 8.5",
        keys: false,
        featuresServedFrom: null,
        rowsScored: 3,
        keysNotFound: [],
        health: "Health: no drift measured.",
        forecast: { period: "month", aggregation: "total", lastObserved: "2026-03" },
      }),
    ).toBe("fc v1 (mape 8.5) (3 months after 2026-03); Health: no drift measured.");
  });

  it("a scored step's rows are quoted in full, up to the scoring cap", () => {
    // Fifteen scored orders were summarised — "order_id total=22104" and
    // three per-class maxima — and the findings table was built from those.
    const rows = Array.from({ length: 15 }, (_, i) => ({
      order_id: 1000 + i,
      prediction: i % 2 ? "pro" : "enterprise",
      probability: 0.9,
    }));
    const result = {
      columns: ["order_id", "prediction", "probability"],
      rows,
      row_count: 15,
      total_matched: 15,
      capped: false,
      duration_ms: 1,
    };
    const facts = stepFacts(result, {
      scored: { columns: ["prediction", "probability"] } as never,
    });
    expect(facts).toContain(
      "15 rows, columns: order_id, prediction (model estimate), probability (model estimate)",
    );
    expect(facts).toContain("order_id=1014 | prediction=enterprise | probability=0.9");
    expect(facts).not.toContain("total=");
    // Unscored, the same table is summarised as before.
    expect(stepFacts(result, { scored: undefined })).not.toContain("order_id=1014");
  });

  it("an identifier column is never totalled in the facts", () => {
    const facts = describeResultFacts({
      columns: ["order_id", "net_usd"],
      rows: [
        { order_id: 1000, net_usd: 10 },
        { order_id: 1001, net_usd: 20 },
      ],
      row_count: 2,
      total_matched: 2,
      capped: false,
      duration_ms: 1,
    });
    expect(facts).toContain(
      "order_id: identifier column, 2 distinct values (not a quantity — no total)",
    );
    expect(facts).not.toContain("order_id: total=");
    expect(facts).toContain("net_usd: total=30");
  });
});

// ── The loop, with a fake world ─────────────────────────────────────────────
type PlanReply = Record<string, unknown>;
function world(opts: {
  plan: PlanReply;
  check?: Record<string, unknown>;
  scoring?: (req: { model: string; rows: Record<string, unknown>[] }) => Promise<ScoreRowsResult>;
  forecast?: (req: { model: string }) => Promise<ForecastResult>;
  rows?: Record<string, unknown>[];
}) {
  const prompts: { kind: string; text: string }[] = [];
  let executions = 0;
  const llm = async <T>(a: { systemPrompt: string; userPrompt: string }): Promise<T> => {
    const p = a.systemPrompt + a.userPrompt;
    if (/"approach"/.test(p) && /"steps"/.test(p)) {
      prompts.push({ kind: "plan", text: p });
      return opts.plan as T;
    }
    if (/"sql"/.test(p)) {
      prompts.push({ kind: "sql", text: p });
      return { sql: "SELECT order_id FROM revenue_facts LIMIT 3" } as T;
    }
    if (/checks/i.test(p) && /verdict/i.test(p)) {
      prompts.push({ kind: "check", text: p });
      return (opts.check ?? { checks: [{ verdict: "pass", note: "ok" }], headline: 0 }) as T;
    }
    prompts.push({ kind: "synthesis", text: p });
    return { answer: "done", follow_ups: [] } as T;
  };
  const execute = async () => {
    executions += 1;
    return {
      columns: ["order_id"],
      rows: opts.rows ?? [{ order_id: 1000 }, { order_id: 1001 }, { order_id: 1002 }],
    };
  };
  const scoreRows =
    opts.scoring ??
    (async (req: { model: string; rows: Record<string, unknown>[] }): Promise<ScoreRowsResult> => ({
      ok: true,
      columns: ["order_id", "prediction", "probability"],
      rows: req.rows.map((r, i) => ({
        ...r,
        prediction: "pro",
        probability: [0.5, 0.9, 0.7][i] ?? 0.1,
      })),
      scored: {
        model: req.model,
        version: 7,
        task: "classification",
        algorithm: "logistic_regression",
        metric: "accuracy 1",
        keys: true,
        featuresServedFrom: "lakehouse",
        rowsScored: req.rows.length,
        keysNotFound: [],
        columns: ["prediction", "probability"],
        health: null,
        notes: ["prediction is the predicted class; probability is the model's confidence in it."],
      },
    }));
  const forecast =
    opts.forecast ??
    (async (): Promise<ForecastResult> => ({
      ok: true,
      columns: ["period", "forecast", "lower", "upper"],
      rows: [
        { period: "2026-04", forecast: 100, lower: 90, upper: 110 },
        { period: "2026-05", forecast: 101, lower: 88, upper: 114 },
        { period: "2026-06", forecast: 102, lower: 86, upper: 118 },
      ],
      scored: {
        model: forecaster.name,
        version: 1,
        task: "forecast",
        algorithm: "moving_average",
        metric: "mape 8.507",
        keys: false,
        featuresServedFrom: null,
        rowsScored: 3,
        keysNotFound: [],
        columns: ["forecast", "lower", "upper"],
        health: null,
        notes: ["Each period is one month; yhat is the projected total."],
        forecast: { period: "month", aggregation: "total", lastObserved: "2026-03" },
      },
    }));
  const args = (question: string) => ({
    question,
    datasets: [],
    semantics: new Map(),
    metrics: [],
    priorTurns: [],
    execute,
    dialect: "test-engine",
    llm,
    models: MODELS,
    scoreRows,
    forecast,
    onUpdate: () => {},
  });
  return { prompts, args, executions: () => executions };
}

describe("the loop, on what the session found", () => {
  it("runs a plan the model collapsed into a bare score block, as one step named by the question", async () => {
    const w = world({
      plan: {
        score: { model: classifier.name, rank: { by: "probability", desc: true, limit: 1 } },
      },
    });
    const turn = await runAnalystTurn(w.args("which order is most likely pro"));
    expect(turn.status).toBe("done");
    expect(turn.steps).toHaveLength(1);
    expect(turn.steps[0].goal).toBe("which order is most likely pro");
    expect(turn.steps[0].rows?.map((r) => r.order_id)).toEqual([1001]);
  });

  it("ranks the scored rows by the model's output and tells the reviewer and the writer", async () => {
    const w = world({
      plan: {
        approach: "score",
        steps: [
          {
            goal: "the 2 most likely orders",
            score: { model: classifier.name, rank: { by: "probability", desc: true, limit: 2 } },
          },
        ],
      },
    });
    const turn = await runAnalystTurn(w.args("which 2 orders are most likely pro"));
    const step = turn.steps[0];
    expect(step.rows?.map((r) => r.order_id)).toEqual([1001, 1002]);
    expect(step.scored?.ranked).toEqual({ by: "probability", desc: true, limit: 2, of: 3 });
    expect(step.scored?.notes).toEqual([
      "prediction is the predicted class; probability is the model's confidence in it.",
    ]);
    const check = w.prompts.find((p) => p.kind === "check")!.text;
    expect(check).toContain("RANKED BY probability desc, top 2 of 3.");
    const synth = w.prompts.find((p) => p.kind === "synthesis")!.text;
    expect(synth).toContain("ranked by probability desc, top 2 of 3 scored");
    expect(synth).toContain("MODEL NOTES:\n- prediction is the predicted class");
  });

  it("runs a forecast step with no SQL, through the injected forecaster", async () => {
    const w = world({
      plan: {
        approach: "forecast",
        steps: [{ goal: "next 2 months", forecast: { model: forecaster.name, horizon: 2 } }],
      },
    });
    const turn = await runAnalystTurn(w.args("what will net_usd do over the next 2 months"));
    const step = turn.steps[0];
    expect(step.sql).toBeUndefined();
    expect(step.status).toBe("done");
    expect(step.columns).toEqual(["period", "forecast", "lower", "upper"]);
    expect(step.rows).toHaveLength(2);
    expect(step.scored?.task).toBe("forecast");
    expect(step.scored?.rowsScored).toBe(2);
    expect(w.executions()).toBe(0);
    expect(w.prompts.some((p) => p.kind === "sql")).toBe(false);
    const check = w.prompts.find((p) => p.kind === "check")!.text;
    expect(check).toContain(`FORECAST BY the trained model "${forecaster.name}"`);
    const synth = w.prompts.find((p) => p.kind === "synthesis")!.text;
    expect(synth).toContain(
      "FORECAST BY: revenue_facts · net_usd v1 (mape 8.507) (2 months after 2026-03)",
    );
  });

  it("a forecast step that cannot run is a failed step, not a table of nothing", async () => {
    const w = world({
      plan: { approach: "f", steps: [{ goal: "next", forecast: { model: forecaster.name } }] },
      forecast: async () => ({ ok: false, error: "no projected periods stored" }),
    });
    const turn = await runAnalystTurn(w.args("forecast"));
    // Every step failed, so the turn itself reports the failure.
    expect(turn.status).toBe("error");
    expect(turn.error).toContain(
      "Could not forecast with revenue_facts · net_usd: no projected periods stored",
    );
    expect(turn.steps[0].status).toBe("error");
    expect(w.executions()).toBe(0);
  });

  it("stops and asks when the question names a model that does not exist", async () => {
    const w = world({
      plan: {
        approach: "substitute",
        steps: [{ goal: "at risk", score: { model: classifier.name } }],
      },
    });
    const turn = await runAnalystTurn(w.args("Score the customers with the churn model"));
    expect(turn.status).toBe("clarifying");
    expect(turn.clarify).toContain('No trained model named "churn"');
    expect(turn.clarify).toContain(`"${classifier.name}"`);
    expect(turn.assumption).toContain("without a trained model");
    expect(turn.steps).toHaveLength(0);
    expect(w.executions()).toBe(0);
  });

  it("under an accepted assumption, a plan that still reaches for another model loses its scoring", async () => {
    const w = world({
      plan: {
        approach: "score with the classifier instead",
        steps: [{ goal: "at risk", score: { model: classifier.name } }],
      },
    });
    const turn = await runAnalystTurn(
      w.args(
        "Score the customers with the churn model\n\nProceed with this assumption: Answer from the data alone, without a trained model",
      ),
    );
    expect(turn.status).toBe("done");
    expect(turn.approach).toMatch(
      /^No trained model named "churn" exists; answered from the data alone\./,
    );
    expect(turn.steps[0].score).toBeUndefined();
    expect(turn.steps[0].scored).toBeUndefined();
    expect(w.prompts.some((p) => p.kind === "sql")).toBe(true);
  });

  it("refuses, in code, a correction that reads the model's columns — the original result stands", async () => {
    const w = world({
      plan: { approach: "s", steps: [{ goal: "likely", score: { model: classifier.name } }] },
      check: {
        checks: [
          {
            verdict: "suspect",
            note: "a random sample, not the most likely",
            refined_sql: "SELECT order_id FROM revenue_facts ORDER BY probability DESC LIMIT 10",
          },
        ],
        headline: 0,
      },
    });
    const turn = await runAnalystTurn(w.args("likely orders"));
    const step = turn.steps[0];
    expect(w.executions()).toBe(1); // the correction never ran
    expect(step.check?.verdict).toBe("suspect");
    expect(step.check?.note).toContain("reads the model's column probability, which no query can");
    expect(step.check?.note).toContain("the original result above stands");
    expect(step.rows).toHaveLength(3);
    expect(step.scored?.model).toBe(classifier.name);
  });

  it("a correction that fails says the original result stands, in words the writer is told to trust", async () => {
    const w = world({
      plan: { approach: "s", steps: [{ goal: "likely", score: { model: classifier.name } }] },
      check: {
        checks: [
          { verdict: "suspect", note: "narrow it", refined_sql: "SELECT boom FROM nowhere" },
        ],
        headline: 0,
      },
    });
    const failing = w.args("likely orders");
    let n = 0;
    failing.execute = async () => {
      n += 1;
      if (n > 1) throw new Error('Binder Error: Referenced column "boom" not found');
      return { columns: ["order_id"], rows: [{ order_id: 1 }] };
    };
    const turn = await runAnalystTurn(failing);
    expect(turn.steps[0].check?.note).toContain(
      "the proposed correction failed to run — Binder Error",
    );
    expect(turn.steps[0].check?.note).toContain("so the original result above stands");
    expect(turn.steps[0].status).toBe("done");
  });
});

// ── The server side and the surfaces, pinned ───────────────────────────────
describe("the server, the route and the embed runner carry the same pieces", () => {
  const scoring = rd("src/utils/ml/scoreRows.server.ts");
  const fns = rd("src/utils/analystScore.functions.ts");
  const route = rd("src/routes/_authenticated/ai-analyst.tsx");
  const embed = rd("src/utils/analyst/run.server.ts");

  it("rows-mode scoring refuses rows missing most of the model's features, and names an imputed one", () => {
    expect(scoring).toContain("if (missing.length * 2 >= features.length) {");
    expect(scoring).toContain(
      'feature columns (missing ${missing.join(", ")}); the SQL must select the feature columns',
    );
    expect(scoring).toContain("not in the rows and imputed by the scorer");
  });

  it("the tool's notes travel with the disclosure, minus the health line", () => {
    expect(scoring).toContain("notes: [...toolNotes, ...notes],");
    expect(scoring).toContain('typeof n === "string" && !/^Health:/.test(n)');
  });

  it("a forecast runs through the same runner as the agent tool, as the analyst", () => {
    expect(scoring).toContain("export async function forecastForAnalyst(");
    expect(scoring).toContain(
      'runMlPredict(ctx, { model: model.name }, args.allow ?? undefined, "ai_analyst")',
    );
    expect(scoring).toContain('columns: ["period", "forecast", "lower", "upper"],');
    expect(fns).toContain("export const analystForecast = createServerFn");
    expect(route).toContain("const forecastFn = useServerFn(analystForecast);");
    expect(route).toContain("forecast: token");
    expect(embed).toContain(
      "forecastForAnalyst({ userId: args.ownerId, allow: analyst.ml_model_names, ...req }),",
    );
  });

  it("the route shows a forecast step, a ranking and the model notes", () => {
    expect(route).toContain("forecast by the trained model {s.forecast.model}");
    expect(route).toContain("Ranked by ${s.scored.ranked.by}");
    expect(route).toContain("Model notes ({s.scored.notes.length})");
    expect(route).toContain(
      "the forecast, lower and upper columns are the model&apos;s projection",
    );
  });
});
