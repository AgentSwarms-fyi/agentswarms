// Reading JSON columns as the objects they should hold (R347).
//
// R347 replaced `as any` / `Record<string, any>` reads of json columns (the
// integrations page's config, an agent's tools, an imported agent file) with
// recordOf and textOf. These pin what each reads, and the two places where
// reading through them changed an answer: a tools value that is not an object
// no longer yields tool ids made of its indices, and a file that is a JSON
// array is no longer imported as an agent with every field defaulted.
import { describe, expect, it } from "vitest";
import { isRecord, recordOf, textOf } from "@/lib/jsonRecord";
import { buildAgentManifest, parseImportedAgent } from "@/lib/agentExport";
import type { Agent } from "@/components/agents/AgentForm";

describe("isRecord, recordOf and textOf", () => {
  it("an object is a record; null, arrays and scalars are not", () => {
    expect(isRecord({ a: 1 })).toBe(true);
    for (const v of [null, undefined, [], [1], "x", 3, true]) {
      expect(isRecord(v), JSON.stringify(v)).toBe(false);
      expect(recordOf(v), JSON.stringify(v)).toEqual({});
    }
    const o = { base_url: "https://gw.example.test" };
    expect(recordOf(o)).toBe(o);
  });

  it("a field is text only when it holds a string", () => {
    expect(textOf("litellm")).toBe("litellm");
    for (const v of [null, undefined, 42, true, {}, ["a"]]) expect(textOf(v)).toBe("");
  });
});

const agent = (tools: unknown): Agent =>
  ({
    id: "1",
    name: "A",
    description: null,
    system_prompt: null,
    llm_provider: "openrouter",
    llm_model: "openai/gpt-4o",
    temperature: 0.7,
    max_tokens: 1024,
    tools,
    n8n_webhook_url: null,
    knowledge_base_id: null,
    is_active: true,
  }) as Agent;

describe("an agent's manifest reads its tools column as objects", () => {
  it("enabled tools, workflows and the ones that need configuration", () => {
    const m = buildAgentManifest(
      agent({
        builtInTools: { kb_search: true, web_search: false, sql_query: true },
        activeWorkflows: { nightly: true },
        toolConfigs: { sql_query: { db: "x" } },
        guardrails: { blockPII: true },
      }),
    );
    expect(m.tools).toEqual({
      built_in: ["kb_search", "sql_query"],
      workflows: ["nightly"],
      requires_config: ["sql_query"],
    });
    expect(m.guardrails).toEqual({ blockPII: true });
  });

  it("a part that is not an object contributes nothing", () => {
    // Object.entries over an array or a string lists its indices: these used
    // to export tools named "0" and "1".
    const m = buildAgentManifest(
      agent({ builtInTools: ["kb_search", "sql_query"], activeWorkflows: "ab", guardrails: "on" }),
    );
    expect(m.tools.built_in).toEqual([]);
    expect(m.tools.workflows).toEqual([]);
    expect(m.guardrails).toEqual({});
    expect(buildAgentManifest(agent(null)).tools.built_in).toEqual([]);
  });
});

describe("an imported agent file", () => {
  it("a JSON array is not an agent definition", () => {
    expect(() => parseImportedAgent("[1, 2]", "agent.json")).toThrow(
      /does not contain an agent definition/,
    );
  });

  it("a YAML list of agents imports its first", () => {
    const a = parseImportedAgent(
      "agents:\n  - role: Researcher\n    goal: Find things\n    llm: openrouter/openai/gpt-4o-mini\n",
      "agents.yaml",
    );
    expect(a.name).toBe("Researcher");
    expect(a.description).toBe("Find things");
  });

  it("a YAML map of agents imports its first", () => {
    const a = parseImportedAgent(
      "agents:\n  researcher:\n    role: Researcher\n    backstory: Careful\n",
      "agents.yaml",
    );
    expect(a.name).toBe("Researcher");
    expect(a.system_prompt).toBe("Careful");
  });
});
