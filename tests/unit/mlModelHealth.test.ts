// A model's health travels with the model wherever it is offered.
//
// The platform noticed drift (a PSI on every prediction run, an alert past
// the operator's threshold) and decay (an evaluation against outcomes that
// arrived later) and told the OWNER — a notification, an audit row. An agent
// listing the model, an analyst scoring with it, a person reading the tool
// panel: none of them heard, so an answer could rest on a model whose owner
// had been warned about it that morning. Now the latest reading of each is
// one sentence that rides beside the model's name, everywhere.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { describeModelHealth, healthLine } from "@/lib/mlHealth";
import { docsFamily } from "./docsPages";

const rd = (p: string) => readFileSync(p, "utf8");
const codeOnly = (s: string) => s.replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const driftHigh = { score: 3.2906, threshold: 0.25, at: "2026-09-14T06:08:37Z" };
const driftLow = { score: 0.04, threshold: 0.25, at: "2026-09-14T06:08:37Z" };
const stable = {
  metric: "f1_macro",
  value: 1,
  baseline: 1,
  decayRatio: 0,
  verdict: "stable" as const,
  at: "2026-09-13T19:03:00Z",
};
const degraded = {
  metric: "accuracy",
  value: 0.71,
  baseline: 0.94,
  decayRatio: 0.2447,
  verdict: "degraded" as const,
  at: "2026-09-12T19:03:00Z",
};
const improved = {
  ...stable,
  value: 0.99,
  baseline: 0.8,
  decayRatio: -0.2375,
  verdict: "improved" as const,
};

describe("describeModelHealth", () => {
  it("raises a drift alert at the threshold, with the date and both numbers", () => {
    const h = describeModelHealth(driftHigh, null);
    expect(h.alerts).toEqual([
      "Drift: the rows scored on 2026-09-14 differ from the training data (PSI 3.291 against the alert threshold 0.25); consider retraining before trusting new predictions.",
    ]);
    expect(h.summary).toBe("open drift alert (PSI 3.291 on 2026-09-14)");
    expect(healthLine(h)).toBe(`Health: ${h.alerts[0]}`);
  });

  it("alerts AT the threshold, not only above it — the operator's bar is inclusive", () => {
    // The alert the owner receives fires at `score >= threshold`
    // (predict.server.ts); the sentence must agree with the notification.
    const h = describeModelHealth(
      { score: 0.25, threshold: 0.25, at: "2026-09-14T06:08:37Z" },
      null,
    );
    expect(h.alerts).toHaveLength(1);
    expect(h.summary).toBe("open drift alert (PSI 0.25 on 2026-09-14)");
  });

  it("says nothing is wrong below the threshold, and still says what was measured", () => {
    const h = describeModelHealth(driftLow, stable);
    expect(h.alerts).toEqual([]);
    expect(h.summary).toBe("evaluated stable on 2026-09-13 (f1_macro 1)");
    expect(healthLine(h)).toBe("Health: evaluated stable on 2026-09-13 (f1_macro 1).");
  });

  it("raises decay from a degraded evaluation, with how much worse", () => {
    const h = describeModelHealth(driftLow, degraded);
    expect(h.alerts).toEqual([
      "Decay: accuracy 0.71 against 0.94 at training (24% worse), measured on 2026-09-12; consider retraining.",
    ]);
    expect(h.summary).toBe("degraded (accuracy 0.71 on 2026-09-12)");
  });

  it("treats a marked improvement as something to check, not a compliment", () => {
    const h = describeModelHealth(null, improved);
    expect(h.alerts[0]).toContain("markedly better than at training (24% better than at training)");
    expect(h.alerts[0]).toContain("outcome leaking into the features");
    expect(h.summary).toContain("suspiciously improved");
  });

  it("carries both alerts when both are open, drift first", () => {
    const h = describeModelHealth(driftHigh, degraded);
    expect(h.alerts).toHaveLength(2);
    expect(h.alerts[0]).toMatch(/^Drift:/);
    expect(h.alerts[1]).toMatch(/^Decay:/);
    expect(h.summary).toBe(
      "open drift alert (PSI 3.291 on 2026-09-14); degraded (accuracy 0.71 on 2026-09-12)",
    );
  });

  it("is honest about nothing having been measured", () => {
    const h = describeModelHealth(null, null);
    expect(h).toEqual({ drift: null, evaluation: null, alerts: [], summary: null });
    expect(healthLine(h)).toBeNull();
    expect(healthLine(null)).toBeNull();
  });
});

describe("the server reads the latest of each, as the platform, against the live threshold", () => {
  const code = codeOnly(rd("src/utils/ml/health.server.ts"));

  it("one read per table for any number of models, newest first, first seen per version wins", () => {
    expect(code).toContain('.from("ml_predictions")');
    expect(code).toContain('.eq("status", "succeeded")');
    expect(code).toContain('.not("drift_score", "is", null)');
    expect(code).toContain('.from("ml_evaluations")');
    expect(code.match(/\.order\("created_at", \{ ascending: false \}\)/g)?.length).toBe(2);
    expect(code).toContain("if (!p.version_id || drift.has(p.version_id)");
    expect(code).toContain("if (evaluation.has(e.version_id)) continue;");
  });

  it("judges drift against the operator's threshold read at the same moment", () => {
    expect(code).toContain("getPlatformResources()");
    expect(code).toContain("threshold: limits.mlDriftAlertPsi,");
  });
});

describe("the sentence travels with the model", () => {
  const registry = codeOnly(rd("src/utils/tools/registry.server.ts"));
  const scoring = codeOnly(rd("src/utils/ml/scoreRows.server.ts"));
  const analyst = codeOnly(rd("src/lib/aiAnalyst.ts"));
  const route = codeOnly(rd("src/routes/_authenticated/ai-analyst.tsx"));
  const result = codeOnly(rd("src/lib/mlToolResult.ts"));
  const panel = codeOnly(rd("src/routes/_authenticated/playground.tsx"));

  it("ml_list_models carries health per model and tells the agent to repeat an open alert", () => {
    const list = registry.slice(
      registry.indexOf('handlers.set("ml_list_models"'),
      registry.indexOf('handlers.set("ml_predict"'),
    );
    expect(list).toContain("const health = await modelHealthFor(models);");
    expect(list).toContain("health: h ? { alerts: h.alerts, summary: h.summary } : null,");
    expect(list).toContain("Say so beside any prediction you report from this model.");
  });

  it("ml_predict never answers without it, rows or forecast", () => {
    const runner = registry.slice(
      registry.indexOf("export async function runMlPredict("),
      registry.indexOf("\nexport ", registry.indexOf("export async function runMlPredict(") + 10),
    );
    expect(runner).toContain("const healthNotes = healthNote ? [healthNote] : [];");
    expect(runner.match(/\.\.\.healthNotes,/g)?.length).toBe(2);
  });

  it("the analyst's planner sees it, and a scored step carries it into the badge and the write-up", () => {
    expect(scoring).toContain("health: healthLine(health.get(m.id)),");
    expect(scoring).toContain("health: healthLine(modelHealth.get(model.id)),");
    expect(analyst.match(/health: string \| null;/g)?.length).toBe(2);
    expect(analyst).toContain('const health = m.health ? `\\n  ${m.health}` : "";');
    // Both synthesis sites label a scored step through the one helper, which
    // carries the health line.
    expect(analyst.match(/scoredLabel\(s\.scored\)/g)?.length).toBe(2);
    expect(analyst).toContain('${s.health ? `; ${s.health}` : ""}');
    expect(route).toContain('(s.scored.health ? ` ${s.scored.health}` : "")');
    expect(route).toContain("{s.scored.health}");
  });

  it("the Playground's model list marks an alert", () => {
    expect(result).toContain("health: isObj(m.health) ? str(m.health.summary) : null,");
    expect(panel).toContain("{m.health && (");
    expect(panel).toContain('/alert|degraded|suspiciously/.test(m.health) ? "⚠ " : ""');
  });

  it("the docs say so, in the repo and in the app", () => {
    for (const d of [rd("docs/ML.md"), docsFamily("ml")]) {
      expect(d).toMatch(/health travels with it/);
      expect(d).toMatch(/never measured/);
    }
    for (const d of [rd("docs/BUSINESS_INTELLIGENCE.md"), rd("src/routes/docs.bi.tsx")]) {
      expect(d).toMatch(/health/);
      expect(d).toMatch(/open drift alert/);
    }
  });
});
