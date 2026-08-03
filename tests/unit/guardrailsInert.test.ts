// Which guardrail settings actually do something.
//
// Four of the eighteen are saved on the agent and enforced by nothing:
// maxTurnsPerConversation, rateLimitPerMinute, requireApprovalAboveTokens and
// customFilterPrompt. That is a deliberate, documented state — the Agent
// Builder tells the operator so, under "Saved but not yet enforced", which is
// the right call: a governance control that silently does nothing is worse
// than an absent one, because it manufactures false assurance.
//
// THE PROBLEM IS THAT NOTHING KEEPS THAT LIST TRUE. It is a hand-written
// paragraph of prose. Implement rate limiting and the paragraph still says it
// does nothing; add a new inert field and the paragraph never mentions it.
// utils/guardrails' own header claims the state is surfaced "honestly via
// `inertFields`" — there is no `inertFields`. It is named in a comment and
// exists nowhere in the codebase, so the mechanism the file advertises is the
// paragraph, and the paragraph had no guard.
//
// This test is that guard, in both directions.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { DEFAULT_GUARDRAILS } from "@/utils/guardrails";

const form = readFileSync("src/components/agents/AgentForm.tsx", "utf8");

/** Modules that would have to reference a field for it to do anything. */
const ENFORCERS = [
  "src/utils/guardrails.ts",
  "src/routes/api/chat.ts",
  "src/routes/api/embed.chat.ts",
  "src/lib/swarmRuntime.ts",
  "src/utils/swarmExecute.server.ts",
].map((f) => ({ f, src: readFileSync(f, "utf8") }));

/**
 * Is the field used anywhere that could act on it?
 *
 * The type declaration, the defaults block and parseGuardrails mention every
 * field by definition, so those are excluded — otherwise everything looks
 * enforced. What is left is real use.
 */
function isEnforcedAnywhere(field: string): boolean {
  for (const { f, src } of ENFORCERS) {
    let body = src;
    if (f === "src/utils/guardrails.ts") {
      // Drop the type, the defaults and the parser: they name every field.
      const parseEnd = body.indexOf("/** Effective PII policy");
      body = parseEnd > 0 ? body.slice(parseEnd) : body;
    }
    body = body.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    if (new RegExp(`\\b${field}\\b`).test(body)) return true;
  }
  return false;
}

const INERT = [
  "maxTurnsPerConversation",
  "rateLimitPerMinute",
  "requireApprovalAboveTokens",
  "customFilterPrompt",
];

describe("the four documented-inert settings really are inert", () => {
  for (const field of INERT) {
    it(`${field} is not read by any enforcement path`, () => {
      // If this fails, someone implemented it — good. Update the "Saved but
      // not yet enforced" paragraph in AgentForm and this list together.
      expect(
        isEnforcedAnywhere(field),
        `${field} is now enforced somewhere; the Agent Builder still tells operators it does nothing`,
      ).toBe(false);
    });
  }
});

describe("the settings that claim to be enforced actually are", () => {
  // The other half. If one of these stops being referenced, the UI is
  // promising enforcement that no longer happens — the more dangerous
  // direction of the same drift.
  for (const field of [
    "maxInputLength",
    "blockedPatterns",
    "topicRestrictions",
    "allowedTopics",
    "contentSafetyLevel",
    "blockProfanity",
    "enableCitationCheck",
    "enableHallucinationFilter",
    "piiMode",
  ]) {
    it(`${field} is read by an enforcement path`, () => {
      expect(
        isEnforcedAnywhere(field),
        `${field} is advertised as active enforcement but nothing reads it`,
      ).toBe(true);
    });
  }
});

describe("the Agent Builder tells the operator the truth", () => {
  // Whitespace collapsed: this is JSX, so the sentence wraps mid-phrase —
  // "custom\n  output filter prompt". Matching the raw slice missed it.
  const disclosure = form
    .slice(
      form.indexOf("Saved but not yet enforced"),
      form.indexOf("Saved but not yet enforced") + 420,
    )
    .replace(/\s+/g, " ");

  it("has the disclosure at all", () => {
    expect(form).toContain("Saved but not yet enforced");
    expect(form).toContain("Active enforcement");
  });

  it("names every inert field in the disclosure", () => {
    // Prose, so match on the human wording rather than the identifier.
    const WORDING: Record<string, RegExp> = {
      maxTurnsPerConversation: /max turns/i,
      rateLimitPerMinute: /rate limit/i,
      requireApprovalAboveTokens: /approval/i,
      customFilterPrompt: /custom output filter|custom filter/i,
    };
    for (const field of INERT) {
      expect(
        WORDING[field].test(disclosure),
        `${field} does nothing but the disclosure does not mention it`,
      ).toBe(true);
    }
  });

  it("does not claim an inert setting is active", () => {
    const active = form.slice(
      form.indexOf("Active enforcement"),
      form.indexOf("Saved but not yet"),
    );
    expect(active).not.toMatch(/rate limit/i);
    expect(active).not.toMatch(/max turns/i);
    expect(active).not.toMatch(/approval/i);
  });
});

describe("the header does not advertise a mechanism that does not exist", () => {
  it("does not claim inertFields is where the state is surfaced", () => {
    // The header used to say the inert state was surfaced "honestly via
    // `inertFields`". No such symbol exists — it is a paragraph in AgentForm.
    //
    // ASSERT THE PROPERTY, NOT THE WORD. A first version of this test banned
    // the string outright, which failed on the corrected comment: explaining
    // that inertFields does not exist requires naming it. Policing prose
    // instead of behaviour is the same mistake as matching a comment that
    // claims a thing is gone.
    const src = readFileSync("src/utils/guardrails.ts", "utf8");
    expect(src, "the header still presents inertFields as the mechanism").not.toMatch(
      /surface[sd]?\s+that\s+honestly\s+via\s+`inertFields`/,
    );
    // And the header must point at where the disclosure really lives.
    expect(src).toMatch(/AgentForm/);
  });

  it("inertFields is not a real symbol anywhere in the source", () => {
    // The underlying fact the header was wrong about. If someone implements a
    // genuine `inertFields`, this fails and the header should be rewritten to
    // point at it for real.
    const hits = ["src/utils/guardrails.ts", "src/components/agents/AgentForm.tsx"]
      .map((f) => readFileSync(f, "utf8"))
      .filter((s) => /\b(const|let|function|export)\s+inertFields\b/.test(s));
    expect(hits).toHaveLength(0);
  });

  it("every field in the type still has a default", () => {
    // A field with no default parses as undefined and the UI control renders
    // uncontrolled — the shape and the defaults must stay in step.
    const src = readFileSync("src/utils/guardrails.ts", "utf8");
    const typeBody = src.slice(src.indexOf("export type Guardrails = {"), src.indexOf("\n};"));
    const fields = [...typeBody.matchAll(/^\s*([a-zA-Z_]\w*)\??:/gm)].map((m) => m[1]);
    expect(fields.length).toBeGreaterThan(15);
    for (const f of fields) {
      expect(DEFAULT_GUARDRAILS, `${f} has no default`).toHaveProperty(f);
    }
  });
});
