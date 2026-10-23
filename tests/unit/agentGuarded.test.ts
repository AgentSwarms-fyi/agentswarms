// The agents list says "Guarded" when the enforcer would act (R347).
//
// FOUND FROM THE UI. An agent imported from a file whose only guardrail was
// `piiMode: "redact"` had the email in its first prompt sent to the model as
// [REDACTED_EMAIL] (the trace recorded `guardrailRedactions: {email: 1}`),
// and its card on /agents said nothing about guardrails. The card checked four
// fields of its own; the enforcer reads the JSON through parseGuardrails and
// asks isAnyGuardrailActive. agentIsGuarded asks the enforcer's question.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { agentIsGuarded } from "@/lib/agentGuarded";
import { parseImportedAgent } from "@/lib/agentExport";

describe("an agent's guardrails, as the card reads them", () => {
  it("an imported agent whose only guardrail is a PII mode is guarded", () => {
    const file = JSON.stringify({
      schema: "agent.json/v1",
      name: "R347 PII-only agent",
      model: { provider: "openrouter", model: "google/gemini-3-flash-preview" },
      tools: { built_in: [] },
      guardrails: { piiMode: "redact" },
    });
    const imported = parseImportedAgent(file, "r347-pii-only.json");
    expect(imported.tools?.guardrails?.blockPII).toBe(false);
    expect(agentIsGuarded(imported.tools)).toBe(true);
  });

  it("a guardrails object with nothing set is not guarded", () => {
    // A missing content-safety level is not "off", so the old check said yes.
    expect(agentIsGuarded({ guardrails: {} })).toBe(false);
    expect(agentIsGuarded({ guardrails: { contentSafetyLevel: "bogus" } })).toBe(false);
  });

  it("each kind of guardrail counts, the legacy PII switch included", () => {
    for (const g of [
      { blockPII: true },
      { piiMode: "block" },
      { enableInputFilters: true },
      { enableOutputFilters: true },
      { contentSafetyLevel: "medium" },
      { blockedPatterns: "internal-only" },
      { allowedTopics: "billing" },
    ]) {
      expect(agentIsGuarded({ guardrails: g }), JSON.stringify(g)).toBe(true);
    }
  });

  it("tools with no guardrails, or that are not an object, are not guarded", () => {
    for (const tools of [{}, null, undefined, "x", [], { guardrails: "on" }]) {
      expect(agentIsGuarded(tools), JSON.stringify(tools)).toBe(false);
    }
  });

  it("the agents page asks agentIsGuarded", () => {
    const page = readFileSync("src/routes/_authenticated/agents.tsx", "utf8");
    expect(page).toContain("return agentIsGuarded(agent.tools);");
    expect(page).not.toContain('g.contentSafetyLevel !== "off"');
  });
});
