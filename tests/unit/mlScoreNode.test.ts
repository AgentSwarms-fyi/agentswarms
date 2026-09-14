// "Score with model": the canvas's deterministic tool node can score rows with
// a registry model — no LLM turn deciding whether to, no tokens, no variance.
//
// Before this, ml_predict was only a tool an AGENT node might call: a swarm
// that wanted every run to score the same rows the same way had to spend a
// model turn and trust the model to make the call correctly. The tool node
// list (TOOL_NODE_IDS) excluded it.
//
// One implementation. The agent handler was lifted into an exported
// runMlPredict(ctx, args, allow, via) and the node calls the same function,
// so keys, rows, the allow-list, the owner-scoped feature-view read and the
// audit trail cannot drift between the two callers. The one thing the node
// does differently is FAIL on an error: an agent reads an {"error"} and tries
// again; a flow state would carry it downstream as a result.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { TOOL_NODE_IDS } from "@/utils/swarmNodes.server";
import { docsFamily } from "./docsPages";

const rd = (p: string) => readFileSync(p, "utf8");
const NODES = rd("src/utils/swarmNodes.server.ts");
const FNS = rd("src/utils/swarmNodes.functions.ts");
const EXEC = rd("src/utils/swarmExecute.server.ts");
const RUNTIME = rd("src/lib/swarmRuntime.ts");
const REGISTRY = rd("src/utils/tools/registry.server.ts");
const INSPECTOR = rd("src/components/swarms/NodeInspector.tsx");
const DOCS_SWARMS = rd("src/routes/docs.swarms.tsx");
const DOCS_ML = rd("docs/ML.md");
const DOCS_ML_APP = docsFamily("ml");

/** Code with its line comments removed — guards read code, not prose. */
const codeOnly = (s: string) => s.replace(/^\s*\/\/.*$/gm, "");

/** The ml_predict case of runToolNodeCore, up to the default case. */
const nodeCase = (() => {
  const from = NODES.indexOf('case "ml_predict": {');
  const to = NODES.indexOf("default:", from);
  expect(from).toBeGreaterThan(0);
  expect(to).toBeGreaterThan(from);
  return codeOnly(NODES.slice(from, to));
})();

/** The exported runner, from its signature to the next top-level export. */
const runner = (() => {
  const from = REGISTRY.indexOf("export async function runMlPredict(");
  const to = REGISTRY.indexOf("\nexport ", from + 10);
  expect(from).toBeGreaterThan(0);
  return codeOnly(REGISTRY.slice(from, to > 0 ? to : undefined));
})();

describe("one implementation", () => {
  it("the agent tool delegates to the exported runner with its allow-list", () => {
    expect(codeOnly(REGISTRY)).toMatch(
      /handlers\.set\("ml_predict", \(c, a\) =>\s*runMlPredict\(c, a, cfg\.ml_model_names\),?\s*\)/,
    );
    // The rules the runner carries — pinned in mlPredictByKey.test.ts on the
    // handler's old location — must still be in the function itself.
    expect(runner).toContain("mlModelsAllowed([model], allow).length === 0");
    expect(runner).toContain("loadFeatureView(model.feature_view_id, model.user_id)");
    expect(runner).toContain("keys_not_found: resolved.missing,");
  });

  it("names its caller in the audit trail and on the prediction row", () => {
    // Three callers now: the agent tool, the canvas node, the AI Analyst.
    expect(runner).toContain('via: "agent_tool" | "swarm_tool_node" | "ai_analyst" = "agent_tool"');
    // Every place the handler used to write the literal now writes the param
    // (the literal with its trailing comma is the old call-site form; the
    // signature's default value is the one place the literal belongs).
    expect(runner).not.toContain('via: "agent_tool",');
    expect(runner.match(/\bvia,/g)?.length).toBe(3);
    // And the refusal names the right thing — "this agent" on a chat turn,
    // "this node" on the canvas.
    expect(runner).toMatch(
      /const who =\s*via === "agent_tool" \? "this agent" : via === "ai_analyst" \? "this analyst" : "this node";/,
    );
    expect(runner).toContain("is not enabled for ${who}.");
  });
});

describe("the tool node", () => {
  it("offers ml_predict beside the other eight", () => {
    expect([...TOOL_NODE_IDS]).toContain("ml_predict");
    expect(TOOL_NODE_IDS.length).toBe(9);
  });

  it("parses keys and rows as JSON arrays and refuses anything else", () => {
    expect(nodeCase).toContain('const keys = parseList("keys", a.keys);');
    expect(nodeCase).toContain('const rows = parseList("rows", a.rows);');
    expect(nodeCase).toContain('if (!Array.isArray(v)) throw new Error("not an array");');
    expect(nodeCase).toContain("must be a JSON array of objects");
  });

  it("passes only what was given, so absent stays absent", () => {
    // `keys: undefined` is not the same as no keys: runMlPredict reads
    // `a.keys !== undefined` to decide the path.
    expect(nodeCase).toContain("...(keys ? { keys } : {}), ...(rows ? { rows } : {})");
  });

  it("calls the shared runner as the node, with the node's allow-list", () => {
    expect(nodeCase).toContain("reg.runMlPredict(");
    expect(nodeCase).toContain("p.ml_model_names,");
    expect(nodeCase).toContain('"swarm_tool_node",');
  });

  it("fails on an error instead of writing it into the flow state", () => {
    expect(nodeCase).toContain("const scored = JSON.parse(result) as { error?: unknown };");
    expect(nodeCase).toContain(
      'if (typeof scored.error === "string") return { ok: false, error: scored.error };',
    );
  });
});

describe("the allow-list reaches the node on both paths", () => {
  it("is declared on the params and accepted by the server function", () => {
    expect(codeOnly(NODES)).toContain("ml_model_names?: string[];");
    expect(FNS).toContain("ml_model_names: z.array(z.string()).optional(),");
  });

  it("is passed from the canvas run and from the headless executor", () => {
    expect(RUNTIME).toContain("ml_model_names: node.data.toolConfigs?.ml_model_names,");
    expect(EXEC).toContain("ml_model_names: d.toolConfigs?.ml_model_names,");
  });

  it("is headless-safe by the same rule as the agent tool", () => {
    // HEADLESS_SAFE_TOOLS already carried ml_predict for agent nodes; the tool
    // node checks the same set, so no second list had to be kept.
    const safe = EXEC.slice(
      EXEC.indexOf("const HEADLESS_SAFE_TOOLS"),
      EXEC.indexOf("]);", EXEC.indexOf("const HEADLESS_SAFE_TOOLS")),
    );
    expect(safe).toContain('"ml_predict"');
    expect(EXEC).toContain("HEADLESS_SAFE_TOOLS.has(toolId)");
  });
});

describe("the inspector", () => {
  it("lists the node as Score with model, with keys and rows as templated JSON", () => {
    expect(INSPECTOR).toContain('id: "ml_predict",\n    label: "Score with model",');
    expect(INSPECTOR).toContain(
      '{ key: "keys", placeholder: \'[{"order_id": {{input}}}]\', textarea: true }',
    );
    expect(INSPECTOR).toMatch(
      /\{ key: "rows", placeholder: '\[\{"region": "AMER", "net_usd": 120\}\]', textarea: true \}/,
    );
  });

  it("picks the model from the models the person can use, production versions only", () => {
    expect(INSPECTOR).toContain('{toolId === "ml_predict" && (');
    expect(INSPECTOR).toContain('setArg("model", v === "__none__" ? "" : v)');
    expect(INSPECTOR).toContain(".filter((m) => m.production_version_id)");
    expect(INSPECTOR).toContain("mlModels={availableMlModels}");
  });
});

describe("docs", () => {
  it("count nine tool ids and describe the node the same way in the app and the repo", () => {
    expect(DOCS_SWARMS).toContain("One of the nine ids this node offers");
    expect(DOCS_SWARMS).toContain("mcp_call_tool, ml_predict)");
    for (const d of [DOCS_SWARMS, DOCS_ML, DOCS_ML_APP]) {
      // Whitespace-tolerant: prettier wraps Markdown prose mid-phrase.
      expect(d).toMatch(/Score with\s+model/);
      expect(d).toMatch(/keys_not_found/);
      // "fails the node" in Markdown, "<em>fails</em> on any error" in JSX.
      expect(d).toMatch(/fails(<\/em>)?\s+(the node|this node|on any error)/);
    }
  });
});
