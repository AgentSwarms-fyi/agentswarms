// Progressive skill disclosure: below the inline budget nothing changes at
// all, and above it the prompt carries an index while use_skill serves the
// bodies. The first property is the important one — every agent that exists
// today sits under the default budget, so "nothing changes" is not a figure
// of speech: the inline path must stay byte-identical to what shipped before
// the index existed.
import { describe, expect, it } from "vitest";

import {
  buildSkillsIndexBlock,
  buildSkillsPromptBlock,
  skillIndexEntry,
  skillsPromptMode,
  SKILLS_INLINE_MAX_CHARS_DEFAULT,
  SAMPLE_SKILLS,
  sampleSkillToSkill,
} from "@/lib/skills";

const skill = (name: string, body: string, description: string | null = null) => ({
  id: name,
  name,
  description,
  body,
  tags: [],
  isSample: false,
});

describe("skillsPromptMode", () => {
  it("stays inline at and below the budget, defers above it", () => {
    const s = [skill("a", "x".repeat(4000)), skill("b", "y".repeat(4000))];
    expect(skillsPromptMode(s, 8000)).toBe("inline"); // exactly at budget
    expect(skillsPromptMode(s, 7999)).toBe("deferred");
    expect(skillsPromptMode([], 1)).toBe("inline");
  });

  it("every bundled sample skill together fits the default budget", () => {
    // This is the compatibility promise: attach ALL the samples and the
    // prompt is still the classic inline block. If a new sample pushes the
    // total over the default, that is a decision to make consciously — this
    // test is where you find out.
    const all = SAMPLE_SKILLS.map(sampleSkillToSkill);
    expect(skillsPromptMode(all, SKILLS_INLINE_MAX_CHARS_DEFAULT)).toBe("inline");
  });
});

describe("the inline path is unchanged", () => {
  it("buildSkillsPromptBlock still contains every full body", () => {
    const s = [skill("Review", "## When to use\nReviewing code.\n\n## Steps\n1. Read it.")];
    const block = buildSkillsPromptBlock(s);
    expect(block).toContain("### Skill: Review");
    expect(block).toContain("1. Read it.");
    expect(block).toContain("(End of skills.)");
  });
});

describe("buildSkillsIndexBlock", () => {
  const long = skill(
    "Contract Review",
    "# Contract Review\n\nApply when reviewing supplier contracts for renewal.\n\n" +
      "## Instructions\n" +
      "SECRET-BODY-MARKER ".repeat(500),
  );

  it("carries names and summaries but never the bodies", () => {
    const block = buildSkillsIndexBlock([long]);
    expect(block).toContain("**Contract Review**");
    expect(block).toContain("use_skill");
    expect(block).not.toContain("SECRET-BODY-MARKER");
    // And it is small — the entire point.
    expect(block.length).toBeLessThan(800);
  });

  it("prefers the description, falls back to the first paragraph, and clips", () => {
    expect(skillIndexEntry(skill("A", "body", "Short description"))).toContain("Short description");
    expect(skillIndexEntry(long)).toContain("Apply when reviewing supplier contracts");
    const noisy = skill("B", "# Heading only\n\n" + "w".repeat(1000));
    const entry = skillIndexEntry(noisy);
    expect(entry.length).toBeLessThan(280);
    expect(entry).toContain("…");
  });

  it("instructs loading before applying, so the model does not improvise", () => {
    const block = buildSkillsIndexBlock([long]);
    expect(block).toMatch(/BEFORE applying/i);
    expect(block).toMatch(/do not guess/i);
  });
});

describe("use_skill tool registration (registry)", () => {
  it("registers the tool with an enum of exact names and serves exact bodies", async () => {
    const { resolveAgentTools } = await import("@/utils/tools/registry.server");
    const deferred = [
      { name: "Contract Review", body: "FULL BODY ONE" },
      { name: "Escalation", body: "FULL BODY TWO" },
    ];
    const resolved = await resolveAgentTools(
      // No storage is touched on this path; a null client proves it.
      { userId: null, agentId: null, authToken: null, sb: null as never },
      { enabledTools: [], deferredSkills: deferred },
    );
    const def = resolved.tools.find((t) => t.function.name === "use_skill");
    expect(def).toBeTruthy();
    expect((def!.function.parameters as any).properties.skill.enum).toEqual([
      "Contract Review",
      "Escalation",
    ]);

    const handler = resolved.handlers.get("use_skill")!;
    const ok = JSON.parse(await handler({} as never, { skill: "Escalation" }));
    expect(ok).toEqual({ skill: "Escalation", instructions: "FULL BODY TWO" });

    const bad = JSON.parse(await handler({} as never, { skill: "Nope" }));
    expect(bad.error).toContain('Unknown skill "Nope"');
    expect(bad.error).toContain("Contract Review");
  });

  it("registers nothing when no skills were deferred", async () => {
    const { resolveAgentTools } = await import("@/utils/tools/registry.server");
    const resolved = await resolveAgentTools(
      { userId: null, agentId: null, authToken: null, sb: null as never },
      { enabledTools: [], deferredSkills: [] },
    );
    expect(resolved.tools.find((t) => t.function.name === "use_skill")).toBeUndefined();
    expect(resolved.handlers.has("use_skill")).toBe(false);
  });
});
