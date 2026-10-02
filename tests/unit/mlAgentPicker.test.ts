// "ML Predictions" on an agent: a model picker, wired through every hop.
//
// The defect this replaces was a UI branch that did not exist. `ml_predict`
// was marked requiresConfig, no branch of the config panel matched it, and it
// fell through to the generic "API Key / Endpoint" password field — a box for
// a credential, for a tool that needs no key, with "paste here" in it.
//
// The allow-list that replaces it has ONE rule that runs through every file
// below and is the reason most of these guards exist: ABSENT means every
// model (what every agent saved before the list did), PRESENT means exactly
// those, and [] means none. Two representations on purpose. The SQL table
// list collapses absent and empty into "all", and the adversarial log records
// what that cost when an import dropped it: a node that could read everything.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { mlModelsAllowed } from "@/utils/tools/registry.server";

const rd = (p: string) => readFileSync(p, "utf8");
const REGISTRY = rd("src/utils/tools/registry.server.ts");
const CHAT = rd("src/routes/api/chat.ts");
const SWARM = rd("src/lib/swarmRuntime.ts");
const FORM = rd("src/components/agents/AgentForm.tsx");
const CANVAS = rd("src/components/swarms/NodeInspector.tsx");
const MAPPING = rd("src/lib/agentToSwarmNode.ts");

/**
 * JSX with its `{/* … *\/}` comments removed.
 *
 * The negative guards below must read CODE. The first version of this file
 * failed on its own prose: the branch's comment explains what it replaced by
 * naming "API Key / Endpoint", and `not.toContain` found it there. A guard
 * satisfied — or tripped — by a comment is the same defect either way.
 */
const codeOnly = (jsx: string) => jsx.replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

/** The save-time assembly of toolConfigs, from its opening IIFE to the next payload key. */
const savePath = (() => {
  const from = FORM.indexOf("toolConfigs: (() => {");
  const to = FORM.indexOf("workflows: workflowConfigs", from);
  expect(from).toBeGreaterThan(0);
  expect(to).toBeGreaterThan(from);
  return FORM.slice(from, to);
})();

/** The ml_predict branch of the form's config panel, and nothing after it. */
const formBranch = (() => {
  const from = FORM.indexOf('tool.id === "ml_predict" ? (');
  const to = FORM.indexOf('tool.id === "mcp_call_tool" ? (', from);
  return codeOnly(FORM.slice(from, to));
})();

describe("the rule, as a function", () => {
  const models = [{ name: "churn" }, { name: "ltv" }, { name: "plan" }];

  it("absent means every model", () => {
    expect(mlModelsAllowed(models, undefined)).toEqual(models);
  });

  it("an empty list means none", () => {
    expect(mlModelsAllowed(models, [])).toEqual([]);
  });

  it("a named list means exactly those, whatever their order or padding", () => {
    expect(mlModelsAllowed(models, [" plan", "churn "])).toEqual([
      { name: "churn" },
      { name: "plan" },
    ]);
  });

  it("and a name nobody has is simply not there", () => {
    expect(mlModelsAllowed(models, ["nope"])).toEqual([]);
  });
});

describe("the form", () => {
  it("has a branch of its own, so the tool no longer falls through to a key field", () => {
    expect(formBranch.length).toBeGreaterThan(200);
    expect(formBranch).toContain("Models this agent may predict with");
    expect(formBranch).not.toContain("API Key / Endpoint");
    expect(formBranch).not.toContain('type="password"');
  });

  it("offers the same set the tool can reach, read under RLS like the semantic picker", () => {
    // Own models plus IAM-shared ones — resolveGrantedResourceIds on the same
    // grants the RLS policy reads — so the picker cannot offer a model the
    // tool would then refuse.
    expect(FORM).toContain('.from("ml_models")');
    expect(FORM).toContain('.select("id, name, task, user_id, production_version_id")');
  });

  it("says which state it is in, every time", () => {
    expect(formBranch).toContain("All models you can use");
    expect(formBranch).toContain("No models selected");
    expect(formBranch).toContain("Restricted to ${mlModelNames.length} model");
  });

  it("writes the list only once it has been configured, and then even when empty", () => {
    // Absent is the compatibility case and must survive a save that never
    // touched the picker; [] is a decision and must survive a save too. A
    // `kept.length > 0` gate here, copied from the semantic block, would have
    // silently turned "none" back into "all".
    expect(savePath).toContain("model_names: mlModelNames.filter(");
    // THE CONDITION ON THE WRITE IS `mlConfigured` AND NOTHING ELSE. A first
    // version of this test only refused `kept.length > 0`; a mutation pass
    // added `&& mlModelNames.length > 0` to the condition instead and the
    // test did not notice — which is precisely the regression this whole list
    // is built to prevent, sitting behind a guard that would have passed it.
    const condition = /if \(([^{]*)\) \{\s*out\.ml_predict = \{/.exec(savePath)?.[1]?.trim();
    expect(condition).toBe("mlConfigured");
  });
});

describe("the save path", () => {
  // The first shipped version of the picker failed its own reset in the UI:
  // "Allow every model again" rendered the allow-all state and the save
  // wrote the old model list back. The cause was older than the picker. The
  // SQL and semantic lists each spread `rest` — the whole config minus their
  // own key — over the payload, so any key an earlier spread had dropped was
  // put back by the next one, and the base spread of the unpruned state put
  // back the rest. Clearing the SQL table restriction on the demo assistant
  // and saving wrote ["saas_sales"] straight back; checked against the row.
  // The shape now: strip every allow-list key, then write back the ones that
  // should exist.

  it("removes every allow-list key from the state before writing any back", () => {
    expect(savePath).toMatch(
      /const \{\s*sql_query: sqlCfg,\s*metric_query: metricCfg,\s*ml_predict: mlCfg,\s*\.\.\.others\s*\} = toolConfigs/,
    );
    expect(savePath).toContain(
      "const out: Record<string, Record<string, unknown>> = { ...others };",
    );
  });

  it("never spreads the unpruned state or a `rest` of it into the payload", () => {
    expect(savePath).not.toContain("...toolConfigs");
    expect(savePath).not.toContain("...rest");
    expect(savePath).not.toContain("_omit");
  });

  it("writes each list under its own condition and nothing else writes them", () => {
    expect(savePath).toContain("if (sqlTableNames.length > 0) {\n          out.sql_query = {");
    expect(savePath).toContain("if (metricKept.length > 0) {\n          out.metric_query = {");
    expect(savePath).toContain("if (mlConfigured) {\n          out.ml_predict = {");
    for (const key of ["sql_query", "metric_query", "ml_predict"]) {
      expect(savePath.match(new RegExp(`out\\.${key} = `, "g"))?.length).toBe(1);
    }
  });
});

describe("the canvas", () => {
  it("has the same picker on an agent node", () => {
    expect(CANVAS).toContain('t.id === "ml_predict" && (');
    expect(CANVAS).toContain("Models this node may predict with");
    expect(CANVAS).toContain("patchToolConfig({ ml_model_names: next })");
  });

  it("keeps absent and empty apart on the node too", () => {
    expect(CANVAS).toContain("!Array.isArray(tc.ml_model_names)");
    expect(CANVAS).toContain("All models you can use");
    // Allowing everything again DROPS the key rather than writing [] — the
    // two mean different things.
    expect(CANVAS).toContain("const { ml_model_names: _drop, ...rest } = tc;");
  });

  it("and importing an agent carries its list across, presence included", () => {
    // strings() reads absent and empty alike; the Array.isArray gate is what
    // stops an agent restricted to nothing becoming a node allowed everything.
    expect(MAPPING).toContain("const mlRaw = obj(cfgs.ml_predict).model_names;");
    expect(MAPPING).toContain("if (Array.isArray(mlRaw)) out.ml_model_names = strings(mlRaw);");
  });
});

describe("the server", () => {
  it("declares the list beside the semantic one, with the opposite default stated", () => {
    expect(REGISTRY).toContain("ml_model_names?: string[];");
    expect(REGISTRY).toContain("ABSENT MEANS EVERY MODEL THE CALLER CAN USE");
    expect(SWARM).toContain("ml_model_names?: string[];");
  });

  it("applies it to what is offered AND to what is accepted", () => {
    // Advertising a narrower list is not enforcement: a model can be named
    // from memory, or from a turn before the list was narrowed.
    const ml = REGISTRY.slice(REGISTRY.indexOf('if (allows("ml_predict"))'));
    expect(ml).toContain("cfg.ml_model_names,\n    );\n    if (mlModels.length > 0) {");
    // The handler hands ITS list to the shared runner, and the runner is
    // where the refusal lives (lifted out for the canvas node — see
    // mlScoreNode.test.ts), naming the caller it refused for.
    expect(ml).toMatch(/runMlPredict\(c, a, cfg\.ml_model_names\)/);
    expect(REGISTRY).toContain("mlModelsAllowed([model], allow).length === 0");
    expect(REGISTRY).toContain("is not enabled for ${who}");
    expect(REGISTRY).toContain('via === "agent_tool" ? "this agent" : via === "ai_analyst"');
  });

  it("reads the list when the agent is saved, and merges it when it chats", () => {
    // The chat route keeps two inline copies of the config type; the toggles
    // file records that this mapping twice omitted a toggle. Both copies and
    // both hops are pinned.
    expect(CHAT.match(/ml_model_names\?: string\[\];/g)?.length).toBe(2);
    expect(CHAT).toContain("agentToolConfigs.ml_model_names = raw.filter(");
    expect(CHAT).toContain("if (Array.isArray(c.ml_model_names)) {");
    // Copied when present INCLUDING empty — a `.length > 0` gate, copied from
    // the metric line above it, would turn "none" into "all" at chat time.
    expect(CHAT).not.toContain("c.ml_model_names.length > 0");
  });
});
