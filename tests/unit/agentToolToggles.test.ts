// Every tool the Agent Builder lets you toggle on must reach agent chat.
//
// The chat route maps the agent's saved toggles to tool ids by hand, one
// line per tool. Twice a toggle was added to the builder and not to that
// list — Semantic Metrics, then ML Predictions — and each time the agent
// saved a tool it never received: the model announced a query or a
// prediction it could not make, and nothing in the UI said why. Saving a
// toggle that does nothing is theater; this pins the two lists together.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const REPO = path.resolve(__dirname, "../..");
const rd = (p: string) => readFileSync(path.join(REPO, p), "utf8");

function builderToolIds(): string[] {
  const form = rd("src/components/agents/AgentForm.tsx");
  const start = form.indexOf("BuiltInTool[] = [");
  expect(start).toBeGreaterThan(0);
  const end = form.indexOf("\n];", start);
  const block = form.slice(start, end);
  return [...block.matchAll(/^\s+id: "([a-z_0-9]+)",/gm)].map((m) => m[1]);
}

function deriveSource(): string {
  const chat = rd("src/routes/api/chat.ts");
  const start = chat.indexOf("function deriveEnabledToolsFromAgent()");
  expect(start).toBeGreaterThan(0);
  return chat.slice(start, chat.indexOf("return out.length > 0 ? out : undefined;", start));
}

describe("agent tool toggles reach agent chat", () => {
  it("maps every built-in toggle the builder can save", () => {
    const ids = builderToolIds();
    expect(ids).toContain("ml_predict");
    expect(ids.length).toBeGreaterThanOrEqual(13);
    const derive = deriveSource();
    const missing = ids.filter((id) => !derive.includes(`t.${id}`));
    expect(missing, `toggles the chat route never maps: ${missing.join(", ")}`).toEqual([]);
  });

  it("keeps the ML tools on headless runs, where grants are re-derived from the owner", () => {
    const chat = rd("src/routes/api/chat.ts");
    const start = chat.indexOf("const HEADLESS_AGENT_TOOL_ALLOW = new Set<ToolableId>([");
    const block = chat.slice(start, chat.indexOf("]);", start));
    expect(block).toContain('"ml_predict"');
    expect(block).toContain('"metric_query"');
  });
});
