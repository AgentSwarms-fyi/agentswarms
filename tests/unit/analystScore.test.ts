// The AI Analyst can score a step's rows with a trained model.
//
// Before this, an analysis could describe the past and forecast a series
// (the BI forecaster, a deterministic method — not a registry model), but it
// could not ask "which of these customers are likely to churn" of a model
// somebody trained for exactly that. Asked anyway, the analyst either said it
// could not, or — worse — estimated. Now a plan step may name a model; the
// SQL selects the entities, the model supplies the prediction columns, and
// the write-up is told it is looking at estimates.
//
// The rules pinned here mirror the governed step's, on purpose: a name that
// is not in scope is not a scored step; a scoring that fails says so and
// leaves the rows unscored; a refined or hand-run step loses its predictions
// with its badge, because they belonged to the old rows.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  ANALYST_SCORE_CAP,
  buildAnalysisPlanPrompt,
  buildSynthesisPrompt,
  describeScorableModels,
  joinPredictions,
  parseAnalysisPlan,
  parseSynthesisReply,
  rerunStep,
  runAnalystTurn,
  scoringSqlGoal,
  type ScorableModel,
  type ScoreRowsResult,
} from "@/lib/aiAnalyst";

const rd = (p: string) => readFileSync(p, "utf8");
const LIB = rd("src/lib/aiAnalyst.ts");
const ROUTE = rd("src/routes/_authenticated/ai-analyst.tsx");
const RUNNER = rd("src/utils/analyst/run.server.ts");
const SCORE = rd("src/utils/ml/scoreRows.server.ts");
const FNS = rd("src/utils/analystScore.functions.ts");
const REGISTRY = rd("src/utils/tools/registry.server.ts");
const DOCS = [
  rd("docs/BUSINESS_INTELLIGENCE.md"),
  rd("src/routes/docs.bi.tsx"),
  rd("docs/ML.md"),
  rd("src/routes/docs.ml.tsx"),
];

const codeOnly = (s: string) => s.replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const plan: ScorableModel = {
  name: "revenue_facts plan classifier",
  task: "classification",
  target: "plan",
  version: 7,
  algorithm: "logistic_regression",
  metric: "accuracy 0.94",
  keyColumns: ["order_id"],
  features: ["region", "net_usd"],
  health: "Health: open drift alert (PSI 3.291 on 2026-09-14).",
};
const reg: ScorableModel = {
  name: "revenue_facts model",
  task: "regression",
  target: "net_usd",
  version: 3,
  algorithm: "hist_gradient_boosting",
  metric: "r2 0.81",
  keyColumns: null,
  features: ["region", "seats"],
  health: null,
};

describe("what the planner is told", () => {
  it("says nothing about scoring when no model is in scope", () => {
    expect(describeScorableModels([])).toBe("");
    const p = buildAnalysisPlanPrompt({ schema: "S", question: "q", prior: "", models: [] });
    expect(p.systemPrompt).not.toMatch(/SCORED STEP/);
    expect(p.userPrompt).not.toMatch(/"score"/);
  });

  it("names each model, what a step must return, and the rule to add a scored step", () => {
    const v = describeScorableModels([plan, reg]);
    expect(v).toContain(
      "MODEL revenue_facts plan classifier — classification → plan, v7, accuracy 0.94",
    );
    expect(v).toContain('score by key — the step\'s SQL must return "order_id"');
    expect(v).toContain("the step's SQL must return the feature columns: region, seats");
    expect(v).toContain("an estimate, never an observed value");
    // The owner's warning rides beside the model, where the planner decides
    // whether to lean on it; a model with nothing measured carries no line.
    expect(v).toContain("\n  Health: open drift alert (PSI 3.291 on 2026-09-14).");
    expect(v.split("Health:").length - 1).toBe(1);
    const p = buildAnalysisPlanPrompt({ schema: "S", question: "q", prior: "", models: [plan] });
    expect(p.systemPrompt).toContain("ADD A SCORED STEP");
    expect(p.systemPrompt).toContain('"score": { "model": "<model name>" }');
    expect(p.systemPrompt).toContain("Never estimate a prediction yourself");
    expect(p.userPrompt).toContain('"score": { "model": "<model name>" } (optional)');
  });
});

describe("parsing a scored step", () => {
  const raw = {
    approach: "score them",
    steps: [
      { goal: "likely plan per order", score: { model: "revenue_facts plan classifier" } },
      { goal: "made up", score: { model: "a model that does not exist" } },
      { goal: "bare name", score: "revenue_facts model" },
    ],
  };

  it("keeps a score only for a model in scope, and accepts a bare name", () => {
    const out = parseAnalysisPlan(raw, [], [plan, reg]);
    expect(out.steps[0].score).toEqual({ model: "revenue_facts plan classifier" });
    expect(out.steps[1].score).toBeUndefined();
    expect(out.steps[2].score).toEqual({ model: "revenue_facts model" });
  });

  it("drops every score when no model is in scope", () => {
    const out = parseAnalysisPlan(raw);
    expect(out.steps.every((s) => s.score === undefined)).toBe(true);
  });
});

// ── The loop, with a fake world ─────────────────────────────────────────
function fakeWorld(opts: {
  scoring?: (req: { model: string; rows: Record<string, unknown>[] }) => Promise<ScoreRowsResult>;
  refine?: boolean;
}) {
  const calls: string[] = [];
  const llm = async <T>(a: { systemPrompt: string; userPrompt: string }): Promise<T> => {
    const p = a.systemPrompt + a.userPrompt;
    if (/"approach"/.test(p) && /"steps"/.test(p)) {
      calls.push("plan");
      return {
        approach: "score",
        steps: [{ goal: "likely plan per order", score: { model: plan.name } }],
      } as T;
    }
    if (/"sql"/.test(p)) {
      // The SQL writer sees only the step's goal; a scored step's goal must
      // carry what the query has to return, or the writer reaches for
      // whatever the schema offers — live, a stored predictions table.
      calls.push("sql:" + (/will be scored by the trained model/.test(p) ? "hinted" : "plain"));
      return { sql: "SELECT order_id FROM revenue_facts LIMIT 3" } as T;
    }
    if (/checks/i.test(p) && /verdict/i.test(p)) {
      // The check reads the FACTS of each step. When scoring joined the
      // predictions onto the result the check sees, they show up here as
      // "prediction=pro"; when only the step's display rows were updated,
      // the check (and the write-up after it) would be judging unscored rows.
      calls.push("check:" + (/prediction=pro/.test(p) ? "scored" : "plain"));
      // And it is TOLD which columns the model added — live, a correction
      // it wrote selected `prediction` and died on a binder error, because
      // that column exists in no table.
      if (
        /SCORED AFTER THE QUERY by the trained model "revenue_facts plan classifier": the column\(s\) prediction, probability are the model's estimates/.test(
          p,
        ) &&
        /A STEP MARKED SCORED AFTER THE QUERY/.test(p) &&
        /columns: order_id, prediction \(model estimate\), probability \(model estimate\)/.test(p)
      )
        calls.push("check:told");
      return {
        checks: [
          opts.refine
            ? { verdict: "refined", note: "narrowed", refined_sql: "SELECT order_id FROM t2" }
            : { verdict: "pass", note: "ok" },
        ],
        headline: 0,
      } as T;
    }
    calls.push("synthesis:" + (/SCORED BY/.test(p) ? "scored" : "plain"));
    return { answer: "done", follow_ups: [] } as T;
  };
  const execute = async () => ({
    columns: ["order_id"],
    rows: [{ order_id: 1000 }, { order_id: 1001 }, { order_id: 999999 }],
  });
  const scoreRows =
    opts.scoring ??
    (async (req: { model: string; rows: Record<string, unknown>[] }): Promise<ScoreRowsResult> => {
      calls.push(`score:${req.model}:${req.rows.length}`);
      return {
        ok: true,
        columns: ["order_id", "prediction", "probability"],
        rows: req.rows.map((r) => ({
          ...r,
          prediction: r.order_id === 999999 ? null : "pro",
          probability: r.order_id === 999999 ? null : 0.9,
        })),
        scored: {
          model: req.model,
          version: 7,
          task: "classification",
          algorithm: "logistic_regression",
          metric: "accuracy 0.94",
          keys: true,
          featuresServedFrom: "online",
          rowsScored: 2,
          keysNotFound: ["order_id=999999"],
          columns: ["prediction", "probability"],
          health: null,
        },
      };
    });
  return { llm, execute, scoreRows, calls };
}

const loopArgs = (w: ReturnType<typeof fakeWorld>, extra: Record<string, unknown> = {}) => ({
  question: "which orders are likely enterprise plans",
  datasets: [],
  semantics: new Map(),
  metrics: [],
  priorTurns: [],
  execute: w.execute,
  dialect: "test-engine",
  llm: w.llm,
  models: [plan],
  scoreRows: w.scoreRows,
  onUpdate: () => {},
  ...extra,
});

describe("the loop", () => {
  it("scores the step's rows, joins the predictions on, and tells the write-up", async () => {
    const w = fakeWorld({});
    const turn = await runAnalystTurn(loopArgs(w));
    const step = turn.steps[0];
    expect(w.calls).toContain(`score:${plan.name}:3`);
    expect(step.columns).toEqual(["order_id", "prediction", "probability"]);
    expect(step.rows?.[0]).toEqual({ order_id: 1000, prediction: "pro", probability: 0.9 });
    expect(step.scored?.model).toBe(plan.name);
    expect(step.scored?.keysNotFound).toEqual(["order_id=999999"]);
    expect(step.status).toBe("done");
    expect(w.calls).toContain("synthesis:scored");
    // The self-check judged the SCORED rows, not the pre-scoring ones.
    expect(w.calls).toContain("check:scored");
    // And was told which columns the model added, in the step block, in
    // the rule, and on the columns line of the facts.
    expect(w.calls).toContain("check:told");
    // And the SQL writer was told what a scored step must return.
    expect(w.calls).toContain("sql:hinted");
  });

  it("leaves the rows unscored and says so when scoring fails", async () => {
    const w = fakeWorld({
      scoring: async () => ({ ok: false, error: "The scorer did not become ready" }),
    });
    const turn = await runAnalystTurn(loopArgs(w));
    const step = turn.steps[0];
    expect(step.scored).toBeUndefined();
    expect(step.score).toBeUndefined();
    expect(step.columns).toEqual(["order_id"]);
    expect(step.check?.verdict).toBe("suspect");
    expect(step.check?.note).toContain("Could not score with revenue_facts plan classifier");
    expect(step.check?.note).toContain("The scorer did not become ready");
    expect(step.status).toBe("done");
    expect(w.calls).toContain("synthesis:plain");
    // The self-check ran after the failure and passed the SQL. Its verdict
    // used to REPLACE the note — "could not score" vanished behind a green
    // pass, exactly as a governed compile that fell back to written SQL had
    // been vanishing all along. Both facts stay, and the step stays suspect.
    expect(step.check?.note).toContain("Self-check: pass — ok.");
  });

  it("says when scoring is not available at all, rather than pretending", async () => {
    const w = fakeWorld({});
    const turn = await runAnalystTurn(loopArgs(w, { scoreRows: undefined }));
    const step = turn.steps[0];
    expect(step.scored).toBeUndefined();
    expect(step.check?.note).toContain("scoring is not available here");
    expect(w.calls.some((c) => c.startsWith("score:"))).toBe(false);
  });

  it("scores the corrected rows again when the self-check rewrites the SQL, and says so", async () => {
    // The first live round: the check narrowed a scored step and the reader
    // was left with "the predictions are gone; ask again". Scoring can run
    // again on whatever the correction returned, so it does.
    const w = fakeWorld({ refine: true });
    const turn = await runAnalystTurn(loopArgs(w));
    const step = turn.steps[0];
    expect(step.sql).toBe("SELECT order_id FROM t2");
    expect(w.calls.filter((c) => c.startsWith("score:"))).toHaveLength(2);
    expect(step.scored?.model).toBe(plan.name);
    expect(step.columns).toEqual(["order_id", "prediction", "probability"]);
    expect(step.check?.verdict).toBe("refined");
    expect(step.check?.note).toContain("narrowed");
    expect(step.check?.note).toContain(
      "The corrected rows were scored again with revenue_facts plan classifier.",
    );
  });

  it("a hand re-run drops them too", async () => {
    const w = fakeWorld({});
    const turn = await runAnalystTurn(loopArgs(w));
    const rerun = await rerunStep({
      step: turn.steps[0],
      sql: "SELECT order_id FROM t3",
      execute: w.execute,
    });
    expect(rerun.scored).toBeUndefined();
    expect(rerun.score).toBeUndefined();
  });

  it("scores at most the cap, which is the tool's cap", () => {
    expect(ANALYST_SCORE_CAP).toBe(50);
    expect(codeOnly(LIB)).toContain("rows: res.rows.slice(0, ANALYST_SCORE_CAP),");
  });
});

describe("the write-up is told", () => {
  it("marks a scored step and adds the estimates rule only then", () => {
    const scored = buildSynthesisPrompt({
      question: "q",
      approach: "a",
      prior: "",
      steps: [
        { goal: "g", facts: "f", scored: "revenue_facts plan classifier v7 (accuracy 0.94)" },
      ],
    });
    expect(scored.userPrompt).toContain(
      "SCORED BY: revenue_facts plan classifier v7 (accuracy 0.94)",
    );
    expect(scored.systemPrompt).toContain(
      "never present a predicted value as something that was observed",
    );
    const plain = buildSynthesisPrompt({
      question: "q",
      approach: "a",
      prior: "",
      steps: [{ goal: "g", facts: "f" }],
    });
    expect(plain.systemPrompt).not.toContain("SCORED BY");
  });
});

describe("the server side", () => {
  it("scores through the one implementation, as the analyst, with rows or keys", () => {
    const code = codeOnly(SCORE);
    expect(code).toContain(
      'import { runMlPredict, type AgentToolContext } from "@/utils/tools/registry.server";',
    );
    expect(code).toContain('"ai_analyst",');
    expect(code).toContain("scopeUserId: args.userId,");
    // By key only when EVERY row carries the key column(s); otherwise rows.
    expect(code).toContain(
      "rows.every((r) => keyColumns.every((k) => r[k] !== undefined && r[k] !== null))",
    );
    expect(code).toContain("const rows = args.rows.slice(0, ANALYST_SCORE_CAP);");
    // The join is the pure rule in the lib — by key identity when keyed,
    // never by position — and the server hands it the key columns only when
    // the rows were actually scored by key.
    expect(code).toContain("joinPredictions(rows, predictions, byKey ? keyColumns : null)");
    // The disclosure records which columns the model added, so the check
    // and the write-up can be told which are estimates.
    expect(code).toContain("columns: joined.added,");
    expect(codeOnly(LIB)).toContain(
      "const byPrint = keyed ? new Map(predictions.map((p) => [print(p), p])) : null;",
    );
    expect(code).toContain('(m) => m.production_version_id && m.task !== "forecast"');
    // The runner names the third caller and refuses for "this analyst".
    expect(REGISTRY).toContain(
      'via: "agent_tool" | "swarm_tool_node" | "ai_analyst" = "agent_tool"',
    );
    expect(REGISTRY).toContain('via === "ai_analyst" ? "this analyst"');
  });

  it("is reachable from the browser under the session, and from the embed runner as the owner", () => {
    expect(FNS).toContain("export const analystScorableModels = createServerFn");
    expect(FNS).toContain("export const analystScoreRows = createServerFn");
    expect(FNS).toContain("await requireUserId(data.accessToken)");
    expect(codeOnly(ROUTE)).toContain("models: scorable,");
    // Rows cross the wire as primitives (cellRow), the way semantic rows do.
    expect(codeOnly(ROUTE)).toContain("rows: req.rows.map(cellRow)");
    expect(codeOnly(RUNNER)).toContain(
      "models: await scorableModelsForUser(args.ownerId).catch(() => []),",
    );
    expect(codeOnly(RUNNER)).toContain(
      "scoreRows: (req) => scoreRowsForAnalyst({ userId: args.ownerId, ...req }),",
    );
  });

  it("the route shows the badge and the disclosure", () => {
    const code = codeOnly(ROUTE);
    expect(code).toContain("{s.scored && (");
    expect(code).toContain("Scored by the trained model");
    expect(code).toContain("model&apos;s estimates, not observed values.");
    expect(code).toContain("Not found in the feature view:");
  });
});

describe("docs", () => {
  it("say the same thing in the repo and in the app", () => {
    for (const d of DOCS) {
      expect(d).toMatch(/scored/);
      expect(d).toMatch(
        // Whitespace-tolerant: prettier wraps Markdown prose mid-phrase.
        /never\s+as\s+(observed\s+values|something\s+observed)/,
      );
    }
    expect(DOCS[0]).toContain("Scored steps predict; the analyst never estimates.");
    expect(DOCS[1]).toContain("Scored steps predict; the analyst never estimates.");
  });
});

describe("joinPredictions", () => {
  const rows = [{ order_id: 1000 }, { order_id: 1001 }, { order_id: 999999 }];

  it("joins by key identity, so a missing key gets nulls and never a neighbour's answer", () => {
    // Predictions come back in a DIFFERENT order than asked, and one is missing.
    const preds = [
      { order_id: 1001, prediction: "enterprise", probability: 0.97 },
      { order_id: 1000, prediction: "pro", probability: 0.95 },
    ];
    const out = joinPredictions(rows, preds, ["order_id"]);
    expect(out.columns).toEqual(["order_id", "prediction", "probability"]);
    expect(out.added).toEqual(["prediction", "probability"]);
    expect(out.rows).toEqual([
      { order_id: 1000, prediction: "pro", probability: 0.95 },
      { order_id: 1001, prediction: "enterprise", probability: 0.97 },
      { order_id: 999999, prediction: null, probability: null },
    ]);
  });

  it("joins by position when the rows were not scored by key", () => {
    const preds = [{ prediction: "a" }, { prediction: "b" }];
    const out = joinPredictions([{ x: 1 }, { x: 2 }, { x: 3 }], preds, null);
    expect(out.rows.map((r) => r.prediction)).toEqual(["a", "b", null]);
  });

  it("keeps a colliding prediction column under a prefix rather than replacing or dropping it", () => {
    // The first live round: the SQL had read a stored predictions table, so
    // the rows already carried `prediction`; the model's own answer must not
    // vanish behind it while the badge says the model scored these rows.
    const stored = [{ order_id: 1000, prediction: "free", probability: 0.5 }];
    const preds = [{ order_id: 1000, prediction: "pro", probability: 0.95 }];
    const out = joinPredictions(stored, preds, ["order_id"]);
    expect(out.columns).toEqual([
      "order_id",
      "prediction",
      "probability",
      "predicted_prediction",
      "predicted_probability",
    ]);
    // The added columns are named as they land on the table — prefixed.
    expect(out.added).toEqual(["predicted_prediction", "predicted_probability"]);
    expect(out.rows[0]).toEqual({
      order_id: 1000,
      prediction: "free",
      probability: 0.5,
      predicted_prediction: "pro",
      predicted_probability: 0.95,
    });
  });
});

describe("scoringSqlGoal", () => {
  it("tells the SQL writer to return the key column from the source table, and nothing predicted", () => {
    const g = scoringSqlGoal({ goal: "likely plan per order", score: { model: plan.name } }, [
      plan,
    ]);
    expect(g).toContain("likely plan per order");
    expect(g).toContain('will be scored by the trained model "revenue_facts plan classifier"');
    expect(g).toContain('the column(s) "order_id" of the entities to score, one row per entity');
    expect(g).toContain("do NOT read any stored predictions table");
    expect(g).toContain("do NOT compute a prediction yourself");
  });

  it("names the feature columns for a model without a feature view", () => {
    const g = scoringSqlGoal({ goal: "g", score: { model: reg.name } }, [plan, reg]);
    expect(g).toContain("with the feature columns region, seats");
  });

  it("leaves an unscored step's goal alone", () => {
    expect(scoringSqlGoal({ goal: "just a query" }, [plan])).toBe("just a query");
  });
});

describe("a write-up that came back as data", () => {
  it("is rendered as a table with its caveats, not reported as no write-up", () => {
    // Measured live with gpt-4o-mini on a scored step, twice.
    const { answer, followUps } = parseSynthesisReply({
      answer: {
        orders: [
          { order_id: 1000, predicted_plan: "pro", probability: 0.9479 },
          { order_id: 1001, predicted_plan: "enterprise", probability: 0.9678 },
        ],
      },
      caveats: ["The predictions are model estimates."],
      follow_ups: ["Which features drive the enterprise predictions?"],
    });
    expect(answer).toContain("**orders**");
    expect(answer).toContain("| order_id | predicted_plan | probability |");
    expect(answer).toContain("| 1001 | enterprise | 0.9678 |");
    expect(answer).toContain("**Caveats**\n\n- The predictions are model estimates.");
    expect(followUps).toEqual(["Which features drive the enterprise predictions?"]);
  });

  it("keeps a prose answer as it was, with caveats appended", () => {
    expect(
      parseSynthesisReply({ answer: "Two orders look enterprise.", caveats: "Estimates." }).answer,
    ).toBe("Two orders look enterprise.\n\n**Caveats**\n\n- Estimates.");
    expect(parseSynthesisReply({ answer: "Plain." }).answer).toBe("Plain.");
  });
});
