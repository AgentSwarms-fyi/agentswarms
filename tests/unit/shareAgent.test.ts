// What leaves the building when you share an agent.
//
// The Share dialog used to show a hardcoded link to nexusforge.dev — a domain
// this project does not own, appearing once in the whole codebase, with no
// matching route — labelled "Public read-only URL". Nothing was published; the
// user copied a dead link to a third party.
//
// The part worth a test is quieter. Under that link sat "API keys and tool
// credentials are stripped before sharing", above a preview of name,
// description, model and tools. The manifest ALSO carries system_prompt.
// Someone reading the preview to decide whether sharing was safe would have
// concluded their prompt stayed private. Two claims, so two tests: what the
// manifest must NOT contain, and what it does contain and must therefore say.
//
// Literal values here are deliberately not secret-shaped. Realistic ones in a
// test file tripped GitHub push protection earlier in this work, and push
// protection scans every commit in the range, so the file is not the fix.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { buildAgentManifest } from "@/lib/agentExport";

const agent = (over: Record<string, unknown> = {}) =>
  ({
    id: "1",
    name: "Support Bot",
    description: "Answers billing questions",
    system_prompt: "You are a support agent. Never mention the internal refund threshold.",
    llm_provider: "openrouter",
    llm_model: "openai/gpt-4o",
    temperature: 0.7,
    max_tokens: 4096,
    tools: {},
    ...over,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

const CREDENTIAL = "placeholder-credential-value-not-a-real-key";

describe("credentials do not travel with a shared agent", () => {
  const configured = agent({
    tools: {
      builtInTools: { web_search: true, n8n_run_workflow: true },
      toolConfigs: {
        web_search: { apiKey: CREDENTIAL, endpoint: "https://example.invalid" },
        n8n_run_workflow: { token: CREDENTIAL },
      },
    },
  });

  it("carries no configured credential value anywhere in the manifest", () => {
    // Whole-manifest search, not a per-field check: a field added later that
    // happens to embed a config would be caught by this and not by a list of
    // known keys.
    expect(JSON.stringify(buildAgentManifest(configured))).not.toContain(CREDENTIAL);
  });

  it("names which tools need configuring, without their values", () => {
    const m = buildAgentManifest(configured);
    expect(m.tools.requires_config).toEqual(["web_search", "n8n_run_workflow"]);
    expect(JSON.stringify(m.tools)).not.toContain("apiKey");
    expect(JSON.stringify(m.tools)).not.toContain("example.invalid");
  });

  it("says nothing about tools that were never configured", () => {
    const m = buildAgentManifest(agent({ tools: { builtInTools: { calculator: true } } }));
    expect(m.tools.requires_config).toEqual([]);
    expect(m.tools.built_in).toEqual(["calculator"]);
  });
});

describe("the system prompt DOES travel, so the dialog has to say so", () => {
  it("is in the manifest", () => {
    // Not a leak — an importer needs it for the agent to work at all. It is a
    // disclosure, and the test exists so that nobody can quietly stop
    // disclosing it while the field is still there.
    expect(buildAgentManifest(agent()).system_prompt).toContain("internal refund threshold");
  });

  it("is visible in the dialog's preview, which shows the whole manifest", () => {
    const src = readFileSync("src/components/agents/ShareAgentDialog.tsx", "utf8");
    expect(src).toContain("JSON.stringify(manifest, null, 2)");
    // The old version previewed a hand-picked subset, which is how the preview
    // came to disagree with the file.
    expect(src, "the preview is a subset again").not.toMatch(
      /JSON\.stringify\(\s*\{\s*\n\s*name: manifest\.name/,
    );
  });

  it("tells the user the prompt is included", () => {
    const src = readFileSync("src/components/agents/ShareAgentDialog.tsx", "utf8");
    expect(src).toMatch(/system prompt is included/i);
  });
});

describe("no share URL points at a domain we do not control", () => {
  it("has no hardcoded external host in the dialog", () => {
    const src = readFileSync("src/components/agents/ShareAgentDialog.tsx", "utf8")
      .split("\n")
      // Comments explain what was removed and must keep naming it.
      .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*"))
      .join("\n");
    expect(src).not.toContain("nexusforge");
    expect(src, "a share link is hardcoded rather than derived").not.toMatch(
      /`https?:\/\/[^`$]*\$\{/,
    );
  });

  it("the real embed link is still derived from the running origin", () => {
    // EmbedSection is the surface that mints a genuine public URL. It builds
    // it from window.location.origin, which is the pattern the dialog should
    // never have departed from.
    const src = readFileSync("src/components/embed/EmbedSection.tsx", "utf8");
    expect(src).toContain("window.location.origin");
  });
});
