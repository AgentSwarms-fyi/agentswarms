// Importing an agent file.
//
// AN AGENT FILE IS UNTRUSTED INPUT. It arrives by drag-and-drop from wherever
// the user got it — a colleague, a gist, a vendor's docs — and every field
// used to be written to the database exactly as found. Verified by feeding the
// parser hostile JSON:
//
//     temperature: "hot"          -> stored as the string "hot"
//     temperature: 999 / -50      -> stored unclamped
//     max_tokens: 100_000_000     -> stored unclamped
//     name: { $ne: null }         -> an object written to a text column
//     guardrails: {...}           -> passed through with no normalisation
//     tools.built_in: "web"       -> threw "builtIn.map is not a function"
//
// max_tokens is the sharp one: it is sent to the provider and drives spend
// directly, so an agent file could provoke a very expensive call before the
// budget guard noticed.
//
// The guardrails passthrough mattered too — an imported `blockedPatterns` of
// `(a+)+$` was a denial of service by e-mailed agent file, until
// looksCatastrophic started rejecting those at compile time. It is now also
// normalised through parseGuardrails on the way in, so an import cannot plant
// a shape the enforcer will not recognise.
//
// WHAT WAS ALREADY SAFE, checked rather than assumed: js-yaml is 4.1.1, whose
// `load` uses the default schema — `!!js/function` is rejected, so the YAML
// path is not an RCE. And the parser builds `tools` itself rather than copying
// the file's, so toolConfigs, knowledgeBaseIds and skillIds cannot be injected.
import { describe, expect, it } from "vitest";

import { MAX_IMPORT_BYTES, MAX_IMPORT_TOKENS, parseImportedAgent } from "@/lib/agentExport";

const json = (o: unknown) => parseImportedAgent(JSON.stringify(o), "agent.json");

describe("numeric fields are clamped", () => {
  it("clamps temperature into the range a provider accepts", () => {
    expect(json({ name: "x", model: { temperature: 999 } }).temperature).toBe(2);
    expect(json({ name: "x", model: { temperature: -50 } }).temperature).toBe(0);
    expect(json({ name: "x", model: { temperature: 0.35 } }).temperature).toBe(0.35);
  });

  it("falls back rather than passing a non-numeric temperature through", () => {
    expect(json({ name: "x", model: { temperature: "hot" } }).temperature).toBe(0.7);
    expect(json({ name: "x", model: { temperature: null } }).temperature).toBe(0.7);
    expect(json({ name: "x", model: { temperature: {} } }).temperature).toBe(0.7);
  });

  it("caps max_tokens, because it is spend", () => {
    expect(json({ name: "x", model: { max_tokens: 100_000_000 } }).max_tokens).toBe(
      MAX_IMPORT_TOKENS,
    );
    expect(json({ name: "x", model: { max_tokens: -1 } }).max_tokens).toBe(1);
    expect(json({ name: "x", model: { max_tokens: 8192 } }).max_tokens).toBe(8192);
  });

  it("returns a whole number of tokens", () => {
    expect(Number.isInteger(json({ name: "x", model: { max_tokens: 4096.7 } }).max_tokens)).toBe(
      true,
    );
  });
});

describe("string fields reject non-strings", () => {
  it("does not write an object or array into a text column", () => {
    expect(json({ name: { $ne: null }, model: {} }).name).toBe("Imported Agent");
    expect(json({ name: ["a", "b"], model: {} }).name).toBe("Imported Agent");
    expect(json({ name: 42, model: {} }).name).toBe("Imported Agent");
  });

  it("drops a non-string description or prompt rather than storing it", () => {
    expect(json({ name: "x", description: { a: 1 }, model: {} }).description).toBeUndefined();
    expect(json({ name: "x", system_prompt: ["a"], model: {} }).system_prompt).toBeUndefined();
  });

  it("keeps real strings", () => {
    const r = json({
      name: "Support Bot",
      description: "helps",
      system_prompt: "be nice",
      model: {},
    });
    expect(r.name).toBe("Support Bot");
    expect(r.description).toBe("helps");
    expect(r.system_prompt).toBe("be nice");
  });

  it("caps absurd lengths instead of storing them", () => {
    const r = json({ name: "n".repeat(50_000), model: {} });
    expect(r.name.length).toBeLessThanOrEqual(200);
  });

  it("survives a model block that is not an object", () => {
    expect(json({ name: "x", model: "gpt-4" }).llm_provider).toBe("openrouter");
    expect(json({ name: "x" }).llm_model).toBeTruthy();
  });
});

describe("tools cannot be smuggled in", () => {
  it("keeps only string tool names", () => {
    const r = json({
      name: "x",
      model: {},
      tools: { built_in: ["web_search", 42, { a: 1 }, "sql_query"] },
    });
    expect(Object.keys(r.tools.builtInTools).sort()).toEqual(["sql_query", "web_search"]);
    expect(r.toolCount).toBe(2);
  });

  it("does not throw when built_in is not an array", () => {
    // It did: "builtIn.map is not a function" escaped the parser instead of
    // being reported as a malformed file.
    expect(() => json({ name: "x", model: {}, tools: { built_in: "web_search" } })).not.toThrow();
    expect(json({ name: "x", model: {}, tools: { built_in: "web_search" } }).toolCount).toBe(0);
  });

  it("ignores a tools block the file invents", () => {
    // toolConfigs / knowledgeBaseIds / skillIds are built by the app, never
    // copied from the file — an import must not be able to wire itself to
    // someone's knowledge base or widen its own allow-list.
    const r = json({
      name: "x",
      model: {},
      tools: {
        built_in: ["web_search"],
        toolConfigs: { sql_query: { table_names: ["salaries"] } },
        knowledgeBaseIds: ["11111111-1111-1111-1111-111111111111"],
        skillIds: ["anything"],
      },
    });
    expect(r.tools).not.toHaveProperty("toolConfigs");
    expect(r.tools).not.toHaveProperty("knowledgeBaseIds");
    expect(r.tools).not.toHaveProperty("skillIds");
  });
});

describe("guardrails are normalised, not trusted", () => {
  it("returns a fully-populated guardrail object for a partial one", () => {
    const g = json({ name: "x", model: {}, guardrails: { blockProfanity: true } }).tools.guardrails;
    expect(g.blockProfanity).toBe(true);
    expect(g).toHaveProperty("piiMode");
    expect(g).toHaveProperty("contentSafetyLevel");
  });

  it("rejects nonsense enum values instead of storing them", () => {
    const g = json({
      name: "x",
      model: {},
      guardrails: { piiMode: "nonsense", contentSafetyLevel: "extreme" },
    }).tools.guardrails;
    expect(g.piiMode).toBe("off");
    expect(g.contentSafetyLevel).toBe("off");
  });

  it("normalises a missing guardrails block rather than storing undefined", () => {
    expect(json({ name: "x", model: {} }).tools.guardrails).toHaveProperty("piiMode");
  });
});

describe("oversized files are refused", () => {
  it("throws before parsing something far too large", () => {
    const huge = JSON.stringify({ name: "x", model: {}, pad: "p".repeat(MAX_IMPORT_BYTES + 1000) });
    expect(() => parseImportedAgent(huge, "agent.json")).toThrow(/too large/i);
  });

  it("accepts a normal-sized file", () => {
    expect(() => json({ name: "x", model: {} })).not.toThrow();
  });
});

describe("the CrewAI YAML path gets the same treatment", () => {
  const yamlDoc = (body: string) => parseImportedAgent(body, "crew.yaml");

  it("clamps and coerces exactly as the JSON path does", () => {
    const r = yamlDoc(`
agents:
  researcher:
    role: Researcher
    goal: find things
    backstory: a careful analyst
    llm: openrouter/openai/gpt-4o-mini
    temperature: 99
    max_tokens: 999999999
    tools:
      - web_search
`);
    expect(r.name).toBe("Researcher");
    expect(r.temperature).toBe(2);
    expect(r.max_tokens).toBe(MAX_IMPORT_TOKENS);
    expect(r.toolCount).toBe(1);
  });

  it("refuses YAML that tries to construct a function", () => {
    // js-yaml v4's `load` uses the default schema. Asserted so an upgrade to a
    // permissive schema cannot pass unnoticed.
    expect(() => yamlDoc('agents:\n  a: !!js/function "function(){return 1}"')).toThrow();
  });

  it("reports a file with no agent definition instead of crashing", () => {
    expect(() => yamlDoc("agents:\n  {}\n")).toThrow();
  });
});
