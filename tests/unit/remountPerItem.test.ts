// A component whose mount effect reads its item is mounted once per item (R323).
//
// FOUND IN R323, from the react-hooks lint warnings. NodeInspector loads the
// MCP servers once per mount and prunes servers that no longer exist from the
// inspected node's selection. The canvas rendered it without a key, so
// selecting another node kept the same mount: the first node was pruned and
// every later one was not, and could show a server that is gone. AgentForm
// loads one agent's memory settings on mount, inside a dialog that is closed
// between edits; it is keyed too, so it does not depend on that.
//
// The swarm page's running-node Set was memoised on a computed expression in
// its dependency list, which the hooks rule cannot check. It is keyed on the
// ids' content now.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const swarms = readFileSync("src/routes/_authenticated/swarms.tsx", "utf8");
const agents = readFileSync("src/routes/_authenticated/agents.tsx", "utf8");

describe("one mount per item", () => {
  it("the inspector is keyed by the node it inspects", () => {
    const at = swarms.indexOf("<NodeInspector");
    expect(at).toBeGreaterThan(0);
    const props = swarms.slice(at, swarms.indexOf("/>", at));
    expect(props).toContain("key={selectedNode.id}");
    expect(props).toContain("node={selectedNode}");
  });

  it("the agent form is keyed by the agent it edits", () => {
    const at = agents.indexOf("<AgentForm");
    const props = agents.slice(at, agents.indexOf("/>", at));
    expect(props).toContain('key={editing?.id ?? "new"}');
  });

  it("their mount-only effects say so", () => {
    for (const p of [
      "src/components/swarms/NodeInspector.tsx",
      "src/components/agents/AgentForm.tsx",
    ]) {
      expect(readFileSync(p, "utf8"), p).toMatch(
        /keys? (this form|the inspector) by (agent|node) id \(R323\)/,
      );
    }
  });
});

describe("the running-node Set", () => {
  it("is keyed on the ids' content, which the hooks rule can check", () => {
    expect(swarms).toContain("const runningKey = JSON.stringify(activeRun?.runningNodeIds ?? []);");
    expect(swarms).toMatch(
      /const runningNodeIds = useMemo\(\(\) => new Set<string>\(JSON\.parse\(runningKey\)\), \[runningKey\]\);/,
    );
  });

  it("round-trips any id, including one with the old separator in it", () => {
    const ids = ["node-1", "a|b", 'quote"d'];
    expect([...new Set<string>(JSON.parse(JSON.stringify(ids)))]).toEqual(ids);
  });
});
