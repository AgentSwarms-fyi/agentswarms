// Two more reads on the agent-tool path that answered absence over a failure.
//
// kb.server read the agent's own configuration as `const { data: agent }`:
// a failed read left the search covering no knowledge base, and the model was
// told the documents had no match. registry.server read an ML model's
// production version the same way and told the model "Production version not
// found" over a failed read.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const KB = readFileSync("src/utils/tools/kb.server.ts", "utf8");
const REG = readFileSync("src/utils/tools/registry.server.ts", "utf8");

describe("the agent's knowledge-base configuration", () => {
  it("a failed read is not 'no knowledge base'", () => {
    expect(KB).toMatch(
      /const \{ data: agent, error: agentErr \} = await sb\s*\.from\("agents"\)[\s\S]{0,600}?if \(agentErr\)\s*throw new Error\(\s*`could not read the agent's knowledge-base configuration: \$\{agentErr\.message\}`,?\s*\);/,
    );
    expect(KB).not.toMatch(/const \{ data: agent \} = await sb\s*\.from\("agents"\)/);
  });
});

describe("an ML model's production version, as the tool tells the model", () => {
  it("a failed read is not 'not found'", () => {
    const tool =
      KB &&
      REG.slice(
        REG.indexOf('.from("ml_model_versions")') - 400,
        REG.indexOf('.from("ml_model_versions")') + 700,
      );
    expect(tool).toMatch(/const \{ data: version, error: versionErr \} = await ctx\.sb/);
    expect(tool).toMatch(
      /if \(versionErr\)\s*return JSON\.stringify\(\{\s*error: `Could not read the production version: \$\{versionErr\.message\}`,\s*\}\);/,
    );
    expect(tool).toMatch(
      /if \(!version\) return JSON\.stringify\(\{ error: "Production version not found" \}\);/,
    );
  });
});
