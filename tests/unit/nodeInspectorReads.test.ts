// The node inspector's pickers under a failed read (R187).
//
// FOUND IN R187, the client read survey's "swarm node inspector (4)". The
// inspector reads the caller's providers, tables, semantic models, ML models
// and MCP servers once, when it opens, and dropped every error. Driven on
// "Embed E2E Mini Swarm": the Researcher node's SQL Query tool on, one table
// ticked ("Node will only see 1 selected table."), the inspector closed and
// reopened with the tables read refused: "No tables yet. Upload a CSV in Data
// & SQL Agents.", and the node's restriction gone from view.
// The component is pinned by source.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SRC = readFileSync("src/components/swarms/NodeInspector.tsx", "utf8");
const effect = SRC.slice(
  SRC.indexOf("const noteError ="),
  SRC.indexOf("setMcpServersLoaded(true);"),
);

describe("the reads", () => {
  it("keep each list's error, by list", () => {
    expect(effect).toMatch(
      /const providersErr = credsErr \?\? integErr;\s*if \(providersErr\) noteError\("providers", providersErr\.message\);/,
    );
    expect(effect).toMatch(
      /if \(dtErr\) noteError\("tables", dtErr\.message\);\s*else if \(dt\) setAvailableDataTables\(dt\);/,
    );
    expect(effect).toMatch(
      /if \(smErr\) noteError\("semantic", smErr\.message\);\s*else if \(sm\) setAvailableSemanticModels\(sm\);/,
    );
    expect(effect).toMatch(
      /if \(mlErr\) noteError\("ml", mlErr\.message\);\s*else if \(ml\) setAvailableMlModels\(ml\);/,
    );
    expect(effect).toMatch(
      /if \(mcpErr\) noteError\("mcp", mcpErr\.message\);[\s\S]{0,120}else if \(mcp\) \{/,
    );
  });

  it("prune the node's MCP selection only from a list that was read", () => {
    const prune = effect.slice(effect.indexOf('if (mcpErr) noteError("mcp"'));
    expect(prune.indexOf("else if (mcp) {")).toBeLessThan(
      prune.indexOf("mcp_server_names: current.filter"),
    );
  });
});

describe("the pickers", () => {
  it("say the list was not read, ahead of the empty-account invitation, and keep the selection in view", () => {
    for (const [key, what, kept, empty] of [
      ["tables", "Your tables", "tc.sql_table_names ?? []", "availableDataTables.length === 0"],
      [
        "semantic",
        "Your semantic models",
        "tc.metric_model_names ?? []",
        "availableSemanticModels.length === 0",
      ],
      ["ml", "Your ML models", "tc.ml_model_names ?? []", "availableMlModels.length === 0"],
      [
        "mcp",
        "Your MCP servers",
        "(tc.mcp_server_names ?? []) as string[]",
        "availableMcpServers.length === 0",
      ],
    ]) {
      const at = SRC.indexOf(`) : listErrors.${key} ? (`);
      expect(at, key).toBeGreaterThan(0);
      const block = SRC.slice(at, SRC.indexOf(empty, at));
      expect(block, key).toContain(`what="${what}"`);
      expect(block, key).toContain(`error={listErrors.${key}}`);
      expect(block, key).toContain(`kept={${kept}}`);
    }
  });

  it("name what the node keeps", () => {
    const comp = SRC.slice(
      SRC.indexOf("function PickerReadError("),
      SRC.indexOf("function Section("),
    );
    expect(comp).toContain("could not be read, so this list says nothing about them: {sentence}");
    // The error ends as a sentence before what the node keeps.
    expect(comp).toMatch(
      /const sentence = \/\[\.!\?\]\$\/\.test\(error\.trim\(\)\) \? error\.trim\(\) : `\$\{error\.trim\(\)\}\.`;/,
    );
    expect(comp).toMatch(
      /kept\.length > 0 \? ` The node keeps its selection: \$\{kept\.join\(", "\)\}\.` : ""/,
    );
  });

  it("mark no provider as not connected from a list that was not read", () => {
    expect(
      (SRC.match(/!listErrors\.providers &&\s*!connectedProviders\.has\(/g) ?? []).length,
    ).toBe(2);
    expect(SRC).toMatch(
      /\{listErrors\.providers && \(\s*<p className="text-\[10px\] text-destructive">\s*Your connected providers could not be read/,
    );
  });
});
