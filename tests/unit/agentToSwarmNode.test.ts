// Importing an agent into a swarm node must not quietly remove its limits.
//
// The bug these exist for was invisible in every way that matters: the import
// reported success, the node showed the right name, prompt and model, and the
// swarm ran. What did not survive were the settings whose entire purpose is to
// restrict — the guardrails and the two tool allow-lists.
//
// The fixture below is shaped on a REAL agent from the account this was found
// on ("Demo · Friendly Assistant"): 18 guardrail settings, sql_query limited to
// one table, metric_query limited to one model, four tools enabled. Before the
// fix, importing it produced a node with no guardrails, no table limit, and two
// of its four tools missing.
import { describe, expect, it } from "vitest";

import {
  SWARM_TOOL_IDS,
  agentToNodePatch,
  importableToolConfigs,
  importableTools,
  type ImportableAgentRow,
} from "@/lib/agentToSwarmNode";

const agent: ImportableAgentRow = {
  name: "Demo · Friendly Assistant",
  system_prompt: "Be helpful.",
  llm_provider: "openrouter",
  llm_model: "moonshotai/kimi-k3",
  temperature: 0.4,
  knowledge_base_id: "kb-primary",
  tools: {
    guardrails: {
      blockPII: true,
      piiMode: "redact",
      contentSafetyLevel: "high",
      blockedPatterns: "ssn|card",
      rateLimitPerMinute: 30,
    },
    builtInTools: {
      sql_query: true,
      metric_query: true,
      web_search: true,
      web_browse: true,
      send_notification: true,
      calculator: false,
    },
    toolConfigs: {
      sql_query: { table_names: ["saas_sales"] },
      metric_query: { model_names: ["saas_sales_model"] },
    },
    knowledgeBaseIds: ["kb-primary", "kb-second"],
    skillIds: ["skill-a", "skill-b"],
    mcpServerNames: ["billing-mcp"],
    activeWorkflows: { "wf-1": true, "wf-2": false },
    reranker: { provider: "cohere", model: "rerank-3" },
    routeThroughGateway: true,
    webhooks: [{ type: "n8n_webhook", url: "https://example.test/hook" }],
  },
};

describe("the settings whose job is to restrict come across", () => {
  it("CARRIES THE GUARDRAILS", () => {
    // The central regression. A node built from a guarded agent ran with no
    // PII policy, no blocked patterns and no rate limit.
    const { patch } = agentToNodePatch(agent);
    expect(patch.guardrails).toMatchObject({
      blockPII: true,
      piiMode: "redact",
      contentSafetyLevel: "high",
      rateLimitPerMinute: 30,
    });
  });

  it("CARRIES THE SQL TABLE ALLOW-LIST, which does not fail safe", () => {
    // An absent sql_table_names means EVERY table the owner can see, so
    // dropping this widened the node's reach instead of narrowing it.
    const { patch } = agentToNodePatch(agent);
    expect(patch.toolConfigs?.sql_table_names).toEqual(["saas_sales"]);
  });

  it("carries the metric model allow-list", () => {
    const { patch } = agentToNodePatch(agent);
    expect(patch.toolConfigs?.metric_model_names).toEqual(["saas_sales_model"]);
  });

  it("carries skills and MCP servers", () => {
    const { patch } = agentToNodePatch(agent);
    expect(patch.skillIds).toEqual(["skill-a", "skill-b"]);
    expect(patch.toolConfigs?.mcp_server_names).toEqual(["billing-mcp"]);
  });

  it("carries only the workflows that were switched on", () => {
    const { patch } = agentToNodePatch(agent);
    expect(patch.toolConfigs?.n8n_workflow_ids).toEqual(["wf-1"]);
  });

  it("writes undefined rather than an empty guardrail object", () => {
    // An empty object reads in the inspector as "configured, and permissive",
    // which is a different claim from "not configured".
    const { patch } = agentToNodePatch({ ...agent, tools: { builtInTools: { calculator: true } } });
    expect(patch.guardrails).toBeUndefined();
    expect(patch.toolConfigs).toBeUndefined();
    expect(patch.skillIds).toBeUndefined();
  });
});

describe("tools map across the whole vocabulary", () => {
  it("imports sql_query and metric_query, which the old mapping dropped", () => {
    const { patch } = agentToNodePatch(agent);
    expect(patch.enabledTools).toContain("sql_query");
    expect(patch.enabledTools).toContain("metric_query");
  });

  it("ignores a tool that is switched off", () => {
    expect(importableTools({ calculator: false, datetime: true }).tools).toEqual(["datetime"]);
  });

  it("maps every swarm tool id, not a hand-picked three", () => {
    const all = Object.fromEntries(SWARM_TOOL_IDS.map((id) => [id, true]));
    expect(importableTools(all).tools.sort()).toEqual([...SWARM_TOOL_IDS].sort());
    expect(importableTools(all).unsupported).toEqual([]);
  });

  it("accepts the legacy web_browser spelling", () => {
    expect(importableTools({ web_browser: true }).tools).toEqual(["web_browse"]);
  });

  it("reports a tool the node cannot run instead of ignoring it", () => {
    expect(importableTools({ send_notification: true }).unsupported).toEqual(["send_notification"]);
  });

  it("adds kb_search when the agent has a knowledge base", () => {
    const { patch } = agentToNodePatch({ ...agent, tools: {} });
    expect(patch.enabledTools).toEqual(["kb_search"]);
  });

  it("does not add kb_search twice", () => {
    const { patch } = agentToNodePatch({
      ...agent,
      tools: { builtInTools: { kb_search: true } },
    });
    expect(patch.enabledTools?.filter((t) => t === "kb_search")).toHaveLength(1);
  });
});

describe("what cannot come across is said, not skipped", () => {
  it("lists the unsupported tool with a reason", () => {
    const { dropped } = agentToNodePatch(agent);
    const d = dropped.find((x) => x.what.includes("send_notification"));
    expect(d).toBeDefined();
    expect(d?.why).toBeTruthy();
  });

  it("says how many knowledge bases were left behind", () => {
    const { dropped } = agentToNodePatch(agent);
    expect(dropped.some((d) => d.what.includes("1 additional knowledge base"))).toBe(true);
  });

  it("reports the gateway preference and webhooks", () => {
    const { dropped } = agentToNodePatch(agent);
    expect(dropped.some((d) => d.what === "Route through gateway")).toBe(true);
    expect(dropped.some((d) => d.what === "Webhooks")).toBe(true);
  });

  it("drops nothing when there is nothing to drop", () => {
    const { dropped } = agentToNodePatch({
      ...agent,
      knowledge_base_id: null,
      tools: { builtInTools: { calculator: true } },
    });
    expect(dropped).toEqual([]);
  });
});

describe("the copy stays a copy", () => {
  it("never links the node back to the agent", () => {
    // Deliberate: a reviewed, deployed swarm must not change because someone
    // edited the source agent afterwards.
    expect(agentToNodePatch(agent).patch.agentId).toBeNull();
  });

  it("copies the identity fields", () => {
    const { patch } = agentToNodePatch(agent);
    expect(patch.label).toBe("Demo · Friendly Assistant");
    expect(patch.model).toBe("moonshotai/kimi-k3");
    expect(patch.temperature).toBe(0.4);
    expect(patch.knowledgeBaseId).toBe("kb-primary");
    expect(patch.reranker).toEqual({ provider: "cohere", model: "rerank-3" });
  });

  it("falls back to the first listed knowledge base when the column is null", () => {
    const { patch } = agentToNodePatch({
      ...agent,
      knowledge_base_id: null,
      tools: { knowledgeBaseIds: ["kb-only"] },
    });
    expect(patch.knowledgeBaseId).toBe("kb-only");
  });

  it("survives junk in the tools blob without throwing", () => {
    for (const junk of [null, undefined, "nope", 42, [], { toolConfigs: "no" }]) {
      expect(() => agentToNodePatch({ ...agent, tools: junk })).not.toThrow();
    }
  });

  it("ignores non-string entries in an allow-list", () => {
    const cfg = importableToolConfigs({
      toolConfigs: { sql_query: { table_names: ["ok", 5, null, ""] } },
    });
    expect(cfg.sql_table_names).toEqual(["ok"]);
  });
});
