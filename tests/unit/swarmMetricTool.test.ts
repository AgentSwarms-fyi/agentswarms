// metric_query on a swarm agent node.
//
// A swarm runs HEADLESS: no user JWT, so tools execute under the service-role
// client with RLS off. /api/chat therefore caps the toolset to a hard-coded set
// of tools that honour `scopeUserId`, whatever the caller sent. A tool that
// ignored that scope would read across tenants the moment it were added to that
// set, so membership is a security claim and not a convenience.
//
// These read the real source rather than mocking the route, because the claim
// being checked is about the ALLOW-LIST ITSELF — a mock of it would agree with
// whatever it was given.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { TOOLABLE_IDS } from "@/utils/tools/registry.server";

const chatSrc = readFileSync("src/routes/api/chat.ts", "utf8");
const metricSrc = readFileSync("src/utils/tools/metric.server.ts", "utf8");
const runtimeSrc = readFileSync("src/lib/swarmRuntime.ts", "utf8");

/** The literal contents of HEADLESS_AGENT_TOOL_ALLOW, read from source. */
function headlessAllowList(): string[] {
  const m = chatSrc.match(/HEADLESS_AGENT_TOOL_ALLOW\s*=\s*new Set<ToolableId>\(\[([\s\S]*?)\]\)/);
  if (!m) throw new Error("HEADLESS_AGENT_TOOL_ALLOW not found — has it been renamed?");
  return [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]);
}

describe("a swarm agent node can use metric_query", () => {
  it("is permitted on headless runs", () => {
    expect(headlessAllowList()).toContain("metric_query");
  });

  it("is a real toolable id, not a typo that silently does nothing", () => {
    for (const id of headlessAllowList()) {
      expect(TOOLABLE_IDS as readonly string[], `${id} is not a TOOLABLE_ID`).toContain(id);
    }
  });

  it("is offered by the swarm node type, so the picker can set it", () => {
    expect(runtimeSrc).toMatch(/\|\s*"metric_query"/);
    expect(runtimeSrc).toContain("metric_model_names");
  });
});

describe("the headless allow-list stays honest", () => {
  it("only contains tools that scope by user", () => {
    // The whole basis for letting these run under the service role. Anything
    // added here without honouring scopeUserId reads across tenants.
    const SCOPE_AWARE = new Set([
      "web_search",
      "web_browse",
      "calculator",
      "datetime",
      "weather",
      "mcp_call_tool",
      "sql_query",
      "kb_search",
      "metric_query",
    ]);
    for (const id of headlessAllowList()) {
      expect(
        SCOPE_AWARE.has(id),
        `"${id}" was added to HEADLESS_AGENT_TOOL_ALLOW. Confirm it honours ` +
          `scopeUserId — under the service role, RLS is OFF — then add it here.`,
      ).toBe(true);
    }
  });

  it("metric_query actually forwards the tenant scope it claims to", () => {
    // The reason it qualifies. If these ever stop being passed, the tool
    // reads every tenant's models on a headless run.
    expect(metricSrc).toMatch(/scopeUserId:\s*ctx\.scopeUserId/);
    expect(metricSrc).toMatch(/grantedModelIds:\s*await grantedModelIdsFor\(ctx\)/);
  });

  it("excludes tools known NOT to be scope-safe", () => {
    // Named explicitly: these were deliberately left out, and a future edit
    // that adds one should have to delete this assertion to do it.
    const list = headlessAllowList();
    for (const unsafe of ["kb_graph_search", "memory_remember", "memory_recall", "memory_set"]) {
      expect(list, `${unsafe} must not run headless`).not.toContain(unsafe);
    }
  });
});
