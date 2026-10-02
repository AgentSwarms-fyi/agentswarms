// Predict BY KEY from an agent: `ml_predict` takes `keys` for a model bound
// to a feature view, and the platform reads the features from the table
// training read — the same second way in the REST route has had since feature
// views shipped. Until now the agent tool took rows only, so an agent typed
// twenty feature values out of a conversation: exactly the training–serving
// skew feature views exist to remove.
//
// The rules are the REST route's, pinned here because the tool is a second
// copy of them: rows XOR keys; no view means no keys; the view is loaded and
// read as the model's OWNER (a grantee scores a shared model whose view and
// table are not theirs); a key that matches nothing is NAMED, never scored as
// a row of nulls; and every prediction carries its key column(s).
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { resolutionError } from "@/lib/featureViews";
import { keyedModelViews } from "@/utils/featureViews/keyed.server";
import { docsFamily } from "./docsPages";

const rd = (p: string) => readFileSync(p, "utf8");
const REGISTRY = rd("src/utils/tools/registry.server.ts");
const ROUTE = rd("src/routes/api/ml.predict.ts");
const KEYED = rd("src/utils/featureViews/keyed.server.ts");
const DOCS = rd("docs/ML.md");
const INAPP = docsFamily("ml");

/** Code with its line comments removed — guards must read code, not prose. */
const codeOnly = (s: string) => s.replace(/^\s*\/\/.*$/gm, "");

/**
 * The scoring implementation. It began life as the inline ml_predict handler
 * and was lifted into an exported runMlPredict so the canvas's deterministic
 * node can run the SAME code (mlScoreNode.test.ts); the handler is now a
 * one-line delegation, so the rules are pinned on the function.
 */
const predict = (() => {
  const from = REGISTRY.indexOf("export async function runMlPredict(");
  const to = REGISTRY.indexOf("\nexport ", from + 10);
  expect(from).toBeGreaterThan(0);
  return codeOnly(REGISTRY.slice(from, to > 0 ? to : undefined));
})();

/** The ml_list_models handler. */
const list = (() => {
  const from = REGISTRY.indexOf('handlers.set("ml_list_models"');
  const to = REGISTRY.indexOf('handlers.set("ml_predict"', from);
  expect(from).toBeGreaterThan(0);
  expect(to).toBeGreaterThan(from);
  return codeOnly(REGISTRY.slice(from, to));
})();

/** The offer block: what the model is told the tool does. */
const offer = (() => {
  const from = REGISTRY.indexOf('if (allows("ml_predict"))');
  const to = REGISTRY.indexOf('handlers.set("ml_list_models"', from);
  expect(from).toBeGreaterThan(0);
  expect(to).toBeGreaterThan(from);
  return codeOnly(REGISTRY.slice(from, to));
})();

describe("keyedModelViews", () => {
  it("returns nothing, and asks nothing, when no model is bound to a view", async () => {
    // No supabase call can happen here: the function returns before touching
    // the client, which is why this runs without a database.
    const out = await keyedModelViews([
      { id: "a", feature_view_id: null },
      { id: "b", feature_view_id: null },
    ]);
    expect(out.size).toBe(0);
  });

  it("reads the view as the platform, and hands out only its name and key columns", () => {
    expect(KEYED).toContain(
      'import { supabaseAdmin } from "@/integrations/supabase/client.server";',
    );
    expect(KEYED).toContain('.select("id, name, key_columns")');
    expect(KEYED).toContain(
      "export type KeyedView = { id: string; name: string; key_columns: string[] };",
    );
  });
});

describe("what the agent is told", () => {
  it("marks keyed models in the tool list and explains keys only when one exists", () => {
    expect(offer).toContain("keyedModelViews(mlModels)");
    expect(offer).toContain('`, by key: ${view.key_columns.join(" + ")}`');
    expect(offer).toContain("keyed.size > 0");
    expect(offer).toContain("prefer keys for those models, and never send both");
    expect(offer).toContain("${keysHint}");
  });

  it("declares keys beside rows on the tool", () => {
    expect(offer).toContain("keys: {");
    expect(offer).toContain("do not send rows as well");
    expect(offer).toContain('required: ["model"]');
  });

  it("names each model's view and key columns in ml_list_models, with a nudge to use them", () => {
    expect(list).toContain("keyedModelViews(models)");
    expect(list).toContain(
      "feature_view: view ? { name: view.name, key_columns: view.key_columns } : null,",
    );
    expect(list).toContain("Prefer scoring by key: call ml_predict with keys=");
  });
});

describe("the ml_predict handler", () => {
  it("takes rows or keys, never both", () => {
    expect(predict).toContain("const wantsKeys = a.keys !== undefined;");
    expect(predict).toContain(
      'if (rows.length) return JSON.stringify({ error: "Send rows or keys, not both." });',
    );
  });

  it("refuses keys for a model with no view, and says what to do instead", () => {
    expect(predict).toContain("if (!model.feature_view_id)");
    expect(predict).toContain("has no feature view, so it cannot be scored by key");
    expect(predict).toContain("or attach a feature view to the model");
  });

  it("refuses more than fifty keys rather than trimming them", () => {
    // Rows are trimmed to fifty (a sample the model reads); a KEY is an entity
    // the agent asked about, and a trimmed key is an entity reported as scored.
    expect(predict).toContain("if (keys.length > 50)");
    expect(predict).toContain("At most 50 keys per call");
    expect(predict).not.toMatch(/a\.keys as [^)]*\)\.slice\(0, 50\)/);
  });

  it("loads and reads the view as the model's owner, exactly as the REST route does", () => {
    expect(predict).toContain("loadFeatureView(model.feature_view_id, model.user_id)");
    expect(predict).toContain("userId: model.user_id,");
    // The lookup is attributed to the caller — the runner's `via` param, which
    // the agent handler leaves at "agent_tool" and the canvas node sets.
    expect(predict).toMatch(/lookupFeatures\(\{[^}]*\bvia,/);
    // The REST route is the reference copy of this rule.
    expect(ROUTE).toContain("loadFeatureView(auth.model.feature_view_id, auth.model.user_id)");
    expect(ROUTE).toContain("userId: auth.model.user_id,");
  });

  it("lets the lookup refuse an all-miss, and names a partial miss beside what scored", () => {
    // The lookup itself turns "no key matched" into an error, so the tool
    // returns that error and never reaches scoring; a first version carried
    // its own all-miss answer after that line and the canvas round showed it
    // could never run. The rule lives in ONE place — resolutionError — and is
    // pinned there rather than restated.
    expect(predict).toContain("if (!looked.ok) return JSON.stringify({ error: looked.error });");
    expect(predict).not.toContain("nothing was scored");
    const view = {
      id: "v",
      name: "order_features",
      schema_name: "analytics",
      table_name: "t",
      key_columns: ["order_id"],
      feature_columns: [],
      timestamp_column: null,
    };
    expect(resolutionError(view, { rows: [], missing: ["order_id=999999"], duplicated: [] })).toBe(
      "No features found for order_id=999999 in order_features",
    );
    expect(
      resolutionError(view, {
        rows: [{ order_id: 1000 }],
        missing: ["order_id=999999"],
        duplicated: [],
      }),
    ).toBeNull();
  });

  it("carries the key columns on every prediction and names what was not found", () => {
    expect(predict).toContain("...(resolved ? resolved.keyColumns : []),");
    expect(predict).toContain("feature_view: resolved.viewName,");
    expect(predict).toContain("keys_not_found: resolved.missing,");
    expect(predict).toContain("features_served_from: resolved.servedFrom,");
  });
});

describe("docs", () => {
  it("say the same thing in the repo and in the app", () => {
    // Whitespace-tolerant: prettier reflows JSX prose across lines.
    for (const d of [DOCS, INAPP]) {
      expect(d).toMatch(/Scoring by key/);
      expect(d).toMatch(/keys_not_found/);
      expect(d).toMatch(/features_served_from/);
      expect(d).toMatch(/refused rather than\s+trimmed/);
      expect(d).toMatch(/never send both|do not send rows as well|never accepted together/);
    }
  });
});
