// The wiring around a fairness check, and the rule the agent layer obeys.
//
// src/lib/mlFairness.ts is checked against a pandas implementation in
// mlFairness.test.ts. What is checked here is everything that can be wrong
// without anyone noticing — and, because this is the first place a language
// model touches a compliance number, the boundary it is held to:
//
//   THE PLATFORM MEASURES. THE MODEL PROPOSES AND NARRATES. A NUMBER NEVER
//   COMES FROM THE LANGUAGE MODEL.
//
// Those are not decorative sentences. A model asked to "assess fairness" will
// happily produce a disparate-impact ratio that looks exactly like a measured
// one, and nobody downstream can tell which they are reading.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const rd = (p: string) => readFileSync(p, "utf8");
const SERVER = rd("src/utils/ml/fairness.server.ts");
const FUNCTIONS = rd("src/utils/ml.functions.ts");
const PANEL = rd("src/components/ml/FairnessPanel.tsx");
const CONFIG = rd("src/utils/notebookRuntime/config.server.ts");
const MIGRATION = rd("supabase/migrations/20260904000000_ml_fairness.sql");

describe("the measurement", () => {
  it("reads the lake as the model's owner, never the caller", () => {
    expect(SERVER).toMatch(/const owner = model\.user_id;/);
    const reads = [...SERVER.matchAll(/runLakehouseStatement\(\s*([A-Za-z_.]+)/g)].map((m) => m[1]);
    expect(reads.length).toBeGreaterThanOrEqual(2);
    for (const who of reads) expect(who, "read as the owner").toBe("owner");
  });

  it("only compares a decision, and only a run that made one", () => {
    expect(SERVER).toMatch(/CHECKABLE = new Set\(\["classification"\]\)/);
    expect(SERVER).toMatch(/prediction\.status !== "succeeded"/);
  });

  it("refuses an identifier instead of reporting ten thousand groups", () => {
    const at = SERVER.indexOf("counted.row_count > MAX_GROUPS");
    expect(at).toBeGreaterThan(-1);
    expect(SERVER.slice(at, at + 300)).toMatch(/not by an identifier/);
  });

  it("writes one row per column rather than an average over them", () => {
    // Two columns are two comparisons; a mean would hide the one that matters.
    expect(SERVER).toMatch(/for \(const column of columns\)/);
    expect(MIGRATION).toMatch(/column_name text NOT NULL/);
  });

  it("never guesses which outcome is the good one", () => {
    expect(SERVER).toMatch(/model\.favourable_label\?\.trim\(\) \|\| null/);
    expect(MIGRATION).toMatch(/NAMED BY A PERSON, never inferred/);
  });
});

describe("the threshold reaches the code that reads it", () => {
  it("is in the settings SELECT list, not only declared", () => {
    const select = CONFIG.slice(CONFIG.indexOf("lakehouse_memory_limit"));
    expect(
      select.slice(0, select.indexOf('"')),
      "ml_fairness_min_ratio missing from the SELECT — the admin value would never apply",
    ).toContain("ml_fairness_min_ratio");
  });

  it("defaults to four fifths through row, env, then constant", () => {
    expect(CONFIG).toMatch(
      /mlFairnessMinRatio:\s*positiveNum\(data\?\.ml_fairness_min_ratio\) \?\? envNum\("ML_FAIRNESS_MIN_RATIO"\) \?\? 0\.8/s,
    );
  });

  it("is what the verdict is measured against", () => {
    expect(SERVER).toMatch(/fairnessVerdict\(result, limits\.mlFairnessMinRatio\)/);
  });
});

describe("the boundary the agent layer is held to", () => {
  it("sends column names and types for a suggestion, never values", () => {
    // A column of ethnicities is sensitive data. Posting a sample of it to an
    // inference endpoint to ask whether it is sensitive answers its own
    // question.
    const at = SERVER.indexOf("export async function suggestSensitiveColumns");
    const body = SERVER.slice(at, SERVER.indexOf("export async function narrateFairnessCheck"));
    expect(body).toMatch(/COLUMN NAMES AND TYPES ONLY - never values/);
    // The payload is built from the schema's name/dtype/distinct only.
    expect(body).toMatch(/\$\{c\.name\} \(\$\{c\.dtype \?\? "unknown"\}/);
    // The sharp version of the claim: this function never reads the DATA at
    // all. It touches the model row and the recorded feature schema, and if it
    // ever grew a lakehouse read, that read would be of the very column whose
    // sensitivity is in question.
    expect(body, "the suggestion path must not query the lake").not.toContain(
      "runLakehouseStatement",
    );
  });

  it("asks for proxies, which is the half people miss", () => {
    expect(SERVER).toMatch(/PROXIES/);
    expect(SERVER).toMatch(/postcode for ethnicity/i);
  });

  it("drops any column the model invented", () => {
    // An answer naming a column that does not exist is the clearest sign it
    // was not grounded, and it would fail at save with a confusing error.
    expect(SERVER).toMatch(/const known = new Set\(schema\.map\(\(c\) => c\.name\)\)/);
    expect(SERVER).toMatch(/known\.has\(s\.column\)/);
  });

  it("suggests and never configures", () => {
    // Nothing is written by the suggestion path. Which attributes are
    // protected is a legal question about a context the platform cannot see.
    const at = SERVER.indexOf("export async function suggestSensitiveColumns");
    const body = SERVER.slice(at, SERVER.indexOf("export async function narrateFairnessCheck"));
    expect(body, "the suggestion path must not write the configuration").not.toMatch(
      /\.update\(|\.insert\(|\.upsert\(/,
    );
    // And the panel makes the person tick.
    expect(PANEL).toMatch(/tick what applies/i);
    expect(PANEL).toMatch(/Nothing is enabled until/i);
  });

  it("forbids the narration from producing a number", () => {
    const at = SERVER.indexOf("export async function narrateFairnessCheck");
    const body = SERVER.slice(at);
    expect(body).toMatch(/Do not compute, estimate, round differently/);
    expect(body).toMatch(/not in the input/);
    // Every figure it is given was measured and stored first.
    expect(body).toMatch(/selection_rate_ratio: check\.disparate_impact/);
    expect(body).toMatch(/largest_true_positive_rate_gap: check\.equal_opportunity_gap/);
  });

  it("keeps the narration beside the numbers, never instead of them", () => {
    // A narration that drifts is then visibly contradicted by the table above
    // it, which is the only durable defence against one.
    expect(MIGRATION).toMatch(/narrative text/);
    expect(PANEL).toMatch(/the table is the record/);
  });

  it("goes through the governed door, so budgets and audit apply", () => {
    expect(SERVER).toContain("internalChatText");
    expect(SERVER).toMatch(/agentName: "ML fairness assistant"/);
    expect(SERVER).toMatch(/action: "ml\.fairness\.suggest"/);
    expect(SERVER).toMatch(/action: "ml\.fairness\.narrate"/);
  });

  it("spends the owner's model budget only on an owner's request", () => {
    const at = FUNCTIONS.indexOf("mlSuggestSensitiveColumns");
    const body = FUNCTIONS.slice(at, at + 900);
    expect(body).toMatch(/\{ write: true \}/);
  });
});

describe("what the words say", () => {
  it("says review, never unfair", () => {
    // Nothing computable decides whether a model is fair; that is a judgement
    // about a context this platform cannot see.
    const visible = [...PANEL.matchAll(/>([^<>{}]{6,})</g)].map((m) => m[1]);
    const offenders = visible.filter((t) => /\bunfair\b|\bbiased\b|\bdiscriminat/i.test(t));
    expect(offenders, `the panel passes judgement: ${offenders.join(" | ")}`).toEqual([]);
    expect(PANEL).toMatch(/Worth a review/);
    expect(MIGRATION).toMatch(/'even', 'review', 'unmeasurable'/);
  });

  it("shows a group too small to judge rather than hiding it", () => {
    expect(PANEL).toMatch(/too few to judge/i);
    expect(PANEL).toContain("MIN_GROUP_FOR_VERDICT");
  });

  it("explains the four-fifths default as a rule of thumb, not a law", () => {
    expect(rd("src/components/admin/RuntimeTab.tsx")).toMatch(/rule of thumb rather than a law/i);
  });
});
