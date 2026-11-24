// The length limits on the agent and knowledge-base forms' free text, and the
// places that apply them. A description of any length ran cards and pickers
// off the screen, as long names did before visibleName.ts bounded those.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { DESCRIPTION_MAX_LENGTH, PROMPT_MAX_LENGTH, lengthProblem } from "@/lib/textLimits";

const read = (p: string) => readFileSync(resolve(__dirname, "../..", p), "utf8");

describe("lengthProblem", () => {
  it("lets text up to the limit through", () => {
    expect(lengthProblem("", 120, "description")).toBeNull();
    expect(lengthProblem("a".repeat(120), 120, "description")).toBeNull();
  });

  it("names the field, the limit and the length when over", () => {
    expect(lengthProblem("a".repeat(121), 120, "description")).toBe(
      "Keep the description to 120 characters (it has 121)",
    );
  });

  it("counts an emoji as one character, as the database does", () => {
    expect(lengthProblem("🙂".repeat(120), 120, "description")).toBeNull();
    expect(lengthProblem("🙂".repeat(121), 120, "description")).toContain("(it has 121)");
  });

  it("ignores a value that is not text", () => {
    expect(lengthProblem(undefined, 120, "x")).toBeNull();
    expect(lengthProblem(null, 120, "x")).toBeNull();
  });
});

describe("the limits are the ones asked for", () => {
  it("120 for a description, 2000 for a prompt", () => {
    expect(DESCRIPTION_MAX_LENGTH).toBe(120);
    expect(PROMPT_MAX_LENGTH).toBe(2000);
  });
});

describe("every form that takes this text applies the limit", () => {
  it("the agent form bounds the description and system prompt, and checks them on save", () => {
    const src = read("src/components/agents/AgentForm.tsx");
    expect(src).toContain("maxLength={DESCRIPTION_MAX_LENGTH}");
    expect(src).toContain("maxLength={PROMPT_MAX_LENGTH}");
    expect(src).toMatch(/lengthProblem\(description, DESCRIPTION_MAX_LENGTH/);
    expect(src).toMatch(/lengthProblem\(systemPrompt, PROMPT_MAX_LENGTH/);
  });

  it("the knowledge-base form bounds the description and checks it on create", () => {
    const src = read("src/routes/_authenticated/knowledge.tsx");
    expect(src).toContain("maxLength={DESCRIPTION_MAX_LENGTH}");
    expect(src).toMatch(/lengthProblem\(newBaseDesc, DESCRIPTION_MAX_LENGTH/);
  });
});
