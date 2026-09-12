// Why one row got the answer it did.
//
// The arithmetic is verified where scikit-learn lives, by
// tests/fixtures/explainProbe.py running the REAL function from TRAIN_PY
// against real fitted pipelines — a mocked model would assert nothing about a
// method whose whole content is "ask the model again". What is checked HERE is
// everything around it that can be wrong without anyone noticing: whether the
// flag survives the round trip through the stored row, whether an explained
// call really takes the path that can answer, and whether the product ever
// calls this SHAP.
//
// That last one is not pedantry. These numbers are the ones somebody may have
// to defend to a regulator, and a Shapley value has properties this does not
// have — it is an ablation against a typical row, it is not additive, and the
// contributions do not sum to the prediction. Naming it accurately is part of
// the feature working.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const rd = (p: string) => readFileSync(p, "utf8");
const PY = rd("src/utils/ml/pyTrain.ts");
const PREDICT = rd("src/utils/ml/predict.server.ts");
const PANEL = rd("src/components/ml/PredictionsPanel.tsx");
const TYPES = rd("src/utils/ml/types.ts");

/** The Python program, as it will be pinned into a session bundle. */
const program = (() => {
  const marker = "export const TRAIN_PY = String.raw`";
  const at = PY.indexOf(marker) + marker.length;
  return PY.slice(at, PY.indexOf("`;", at));
})();

describe("the program that does the explaining", () => {
  it("carries the function and its baseline", () => {
    expect(program).toContain("def _explain(");
    expect(program).toContain("def _baseline_row(");
    // The probe that proves the arithmetic has to keep existing.
    expect(rd("tests/fixtures/explainProbe.py")).toContain("_explain");
  });

  it("recovers the typical row from the distribution drift already records", () => {
    // Not from the training table: a prediction sandbox downloads the artifact
    // and nothing else, so a baseline that needed the rows back would only
    // work where it was least needed.
    const at = program.indexOf("def _baseline_row(");
    const body = program.slice(at, program.indexOf("def _explain(", at));
    // The middle quantile edge for a number, the commonest value for a
    // category — the two summaries drift already stores.
    expect(body).toMatch(/edges\[len\(edges\) \/\/ 2\]/);
    expect(body).toMatch(/max\(props, key=props\.get\)/);
    // And it is the ARTIFACT's recorded distribution that is passed in, which
    // is what makes this work in a sandbox holding nothing but the artifact.
    const ex = program.slice(program.indexOf("def _explain("));
    expect(ex).toMatch(/_baseline_row\(art\.get\('feature_stats'\), feats\)/);
  });

  it("says nothing rather than guessing when it cannot measure a move", () => {
    // A classifier with no predict_proba can only report that the label
    // flipped, which is a yes/no rather than a contribution.
    const at = program.indexOf("def _explain(");
    const body = program.slice(at, program.indexOf("def _drift(", at));
    expect(body).toMatch(/is_class and not has_proba/);
    expect(body).toMatch(/return None/);
  });

  it("asks the model once, not once per feature", () => {
    const at = program.indexOf("def _explain(");
    const body = program.slice(at, program.indexOf("def _drift(", at));
    expect(body).toContain("pd.concat(blocks, ignore_index=True)");
  });

  it("never lets an explanation failure lose the prediction", () => {
    // The answer is the product; the explanation is commentary on it.
    //
    // EVERY such block, not just the first. This used to take a fixed window
    // after one occurrence, and when reason codes added a second — earlier in
    // the function and longer than the window — the test started reading the
    // new block and missing its `except` off the end. The property it cares
    // about is true of both, so it should be asserted of both: a window that
    // happens to fit is not the thing being checked.
    const starts = [...program.matchAll(/if cfg\.get\('explain'\)/g)].map((m) => m.index!);
    expect(starts.length).toBeGreaterThanOrEqual(2);
    for (const at of starts) {
      // To the end of the statement this guards, wherever that falls.
      const block = program.slice(at, program.indexOf("\n\n", at));
      expect(block).toContain("except Exception");
      expect(block).toMatch(/warnings_\.append/);
    }
  });
});

describe("the flag survives the round trip", () => {
  it("is stored on the row, because the program is rebuilt from it", () => {
    // The session asks the server for its code AFTER the row is written. A
    // flag that lived only in the request would be silently dropped, and the
    // symptom would be an explanation that never arrives with no error.
    expect(PREDICT).toMatch(/function summariseInput\(input: MlPredictInput, explain = false\)/);
    expect(PREDICT).toMatch(/explain \? \{ \.\.\.base, explain: true \} : base/);
    expect(PREDICT).toMatch(/explain: Boolean\(\(stored as \{ explain\?: boolean \}\)\.explain\)/);
  });

  it("takes the sandbox, because the warm endpoint cannot answer", () => {
    // A second implementation of "what moved this answer" inside the serving
    // program would be a second definition of it.
    const at = PREDICT.indexOf("if (!args.explain) {");
    expect(at, "the warm path is skipped when explaining").toBeGreaterThan(-1);
    expect(PREDICT.slice(at, at + 200)).toContain("scoreOnDeployment");
  });

  it("survives the server writing the row, which is a whitelist", () => {
    // FOUND FROM THE UI, and invisible to every other kind of test: the stored
    // `result` names its fields one by one rather than spreading what the
    // program returned. The flag reached Python, Python did the work, and the
    // server dropped the answer on the floor without an error anywhere.
    const at = PREDICT.indexOf("result: {");
    expect(at).toBeGreaterThan(-1);
    const block = PREDICT.slice(at, PREDICT.indexOf("} as Json,", at));
    expect(block, "explanations are dropped on the way into the row").toContain("explanations");
  });

  it("is bounded, since every feature costs a prediction", () => {
    // Env-configurable like every other limit here: a ceiling on work, not a
    // licence fee, so a deployment with a big machine may raise it.
    expect(PREDICT).toMatch(/envCount\("ML_EXPLAIN_MAX_ROWS", \d+\)/);
    expect(PREDICT).toMatch(/envCount\("ML_EXPLAIN_TOP_K", \d+\)/);
  });
});

describe("what it is called", () => {
  const SHAP = /\bshap\b|shapley/i;

  it("is not called SHAP anywhere a user can read", () => {
    // Checked on the rendered strings rather than the whole file so a comment
    // explaining the difference is still allowed to name it.
    const visible = [...PANEL.matchAll(/>([^<>{}]{8,})</g)].map((m) => m[1]);
    const offenders = visible.filter((t) => SHAP.test(t));
    expect(offenders, `the panel calls it SHAP: ${offenders.join(" | ")}`).toEqual([]);
  });

  it("says what it actually is, in the panel and in the type", () => {
    expect(PANEL).toContain("What moved this answer");
    expect(PANEL).toMatch(/replaced with a typical one/);
    // And the type's own comment is explicit, for whoever wires it next.
    expect(TYPES).toMatch(/NOT a Shapley value/);
  });

  it("tells the reader which way a bar points", () => {
    expect(PANEL).toMatch(/pushed the answer up/i);
  });
});
