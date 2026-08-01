// Model allow-list enforcement.
//
// These rules decide which models a user may call. They were implemented three
// times — server, client mirror, and a picker variant — and had no tests, so
// "the copies agree" was an assumption rather than a fact. They are now one
// module; this is the file that holds it to its contract.
//
// The subtlety worth the most attention is `null` versus `[]`. `null` means
// "no restriction applies to this user". `[]` means "an allow-list applies and
// it permits nothing". Conflating them turns every unrestricted user into a
// blocked one, or — far worse, and the direction a careless fix tends to go —
// turns a user whose rules failed to load into a user who may call anything.

import { describe, expect, it } from "vitest";

import {
  allowedProviders,
  isModelAllowed,
  modelMatchesAnyRule,
  modelPatternMatches,
  type ModelRuleLike,
} from "@/lib/iamRules";

const rule = (provider: string, model_pattern: string): ModelRuleLike => ({
  provider,
  model_pattern,
});

describe("modelPatternMatches", () => {
  it("matches everything on the bare wildcard", () => {
    expect(modelPatternMatches("*", "anything/at-all")).toBe(true);
    expect(modelPatternMatches("*", "")).toBe(true);
  });

  it("matches an exact id", () => {
    expect(modelPatternMatches("gpt-4o", "gpt-4o")).toBe(true);
    expect(modelPatternMatches("gpt-4o", "gpt-4o-mini")).toBe(false);
  });

  it("matches a trailing-* prefix", () => {
    expect(modelPatternMatches("claude-*", "claude-haiku-4.5")).toBe(true);
    expect(modelPatternMatches("claude-*", "claude-")).toBe(true);
  });

  it("anchors the prefix at the START — a suffix must not sneak through", () => {
    // The bypass this guards: a model named to end with an allowed pattern.
    expect(modelPatternMatches("claude-*", "evil/claude-haiku")).toBe(false);
    expect(modelPatternMatches("gpt-*", "notgpt-4")).toBe(false);
  });

  it("treats the pattern as literal, not as a regex", () => {
    // `.` and `+` must not act as wildcards, or an allow-list means something
    // its author never intended.
    expect(modelPatternMatches("gpt.4", "gptX4")).toBe(false);
    expect(modelPatternMatches("a+", "aaa")).toBe(false);
    // A mid-string star is not a wildcard either.
    expect(modelPatternMatches("gpt-*-mini", "gpt-4-mini")).toBe(false);
  });

  it("an empty pattern matches only an empty id", () => {
    expect(modelPatternMatches("", "gpt-4o")).toBe(false);
    expect(modelPatternMatches("", "")).toBe(true);
  });

  it("is case-sensitive", () => {
    // Model ids are case-sensitive everywhere else in the product; a matcher
    // that quietly folded case would admit ids the admin did not list.
    expect(modelPatternMatches("gpt-4o", "GPT-4O")).toBe(false);
  });
});

describe("isModelAllowed", () => {
  const rules = [rule("openai", "gpt-4*"), rule("anthropic", "claude-haiku-4.5")];

  it("allows a model the rules cover", () => {
    expect(isModelAllowed(rules, "openai", "gpt-4o")).toBe(true);
    expect(isModelAllowed(rules, "anthropic", "claude-haiku-4.5")).toBe(true);
  });

  it("refuses a model no rule covers", () => {
    expect(isModelAllowed(rules, "openai", "o1-preview")).toBe(false);
    expect(isModelAllowed(rules, "anthropic", "claude-opus-5")).toBe(false);
  });

  it("requires the PROVIDER to match, not just the model", () => {
    // Otherwise a rule permitting a model on a cheap self-hosted provider
    // would also permit the same id on a metered one.
    expect(isModelAllowed(rules, "anthropic", "gpt-4o")).toBe(false);
    expect(isModelAllowed([rule("openai", "*")], "openrouter", "gpt-4o")).toBe(false);
  });

  it("null means UNRESTRICTED", () => {
    expect(isModelAllowed(null, "anything", "at-all")).toBe(true);
    expect(isModelAllowed(undefined, "anything", "at-all")).toBe(true);
  });

  it("an EMPTY list allows nothing — it is a real allow-list, not 'no rules'", () => {
    // The distinction that must never be collapsed. A loader returns null for
    // "unrestricted"; [] can only arise from an allow-list that permits
    // nothing, and treating it as unrestricted would be a silent bypass.
    expect(isModelAllowed([], "openai", "gpt-4o")).toBe(false);
  });

  it("a wildcard rule opens one provider, not all of them", () => {
    const wild = [rule("openai", "*")];
    expect(isModelAllowed(wild, "openai", "literally-anything")).toBe(true);
    expect(isModelAllowed(wild, "anthropic", "literally-anything")).toBe(false);
  });

  it("any one matching rule is enough", () => {
    const many = [rule("openai", "gpt-3*"), rule("openai", "gpt-4*")];
    expect(isModelAllowed(many, "openai", "gpt-4o")).toBe(true);
  });
});

describe("modelMatchesAnyRule", () => {
  const rules = [rule("openai", "gpt-4*")];

  it("ignores the provider, for pickers that do not know it yet", () => {
    expect(modelMatchesAnyRule(rules, "gpt-4o")).toBe(true);
  });

  it("is looser than isModelAllowed, so it must never authorise a call", () => {
    // Documented here because the two are easy to reach for interchangeably.
    expect(modelMatchesAnyRule(rules, "gpt-4o")).toBe(true);
    expect(isModelAllowed(rules, "anthropic", "gpt-4o")).toBe(false);
  });

  it("still refuses a model no pattern covers", () => {
    expect(modelMatchesAnyRule(rules, "claude-opus-5")).toBe(false);
  });

  it("null is unrestricted; empty allows nothing", () => {
    expect(modelMatchesAnyRule(null, "anything")).toBe(true);
    expect(modelMatchesAnyRule([], "anything")).toBe(false);
  });
});

describe("allowedProviders", () => {
  it("lists the providers with rules", () => {
    const set = allowedProviders([rule("openai", "*"), rule("anthropic", "claude-*")]);
    expect(set).toEqual(new Set(["openai", "anthropic"]));
  });

  it("null when unrestricted, empty set when nothing is allowed", () => {
    expect(allowedProviders(null)).toBeNull();
    expect(allowedProviders([])).toEqual(new Set());
  });
});

describe("the server check and the client check are the same function", () => {
  it("no drift is possible, because there is one implementation", async () => {
    // The reason this module exists. If these ever stop being identical, the
    // UI can offer a model the server refuses — or hide one it would allow,
    // which looks like the rule working when it is not.
    const server = await import("@/utils/iam.server");
    const client = await import("@/hooks/use-iam");
    expect(server.isModelAllowed).toBe(isModelAllowed);
    expect(client.isModelAllowedByRules).toBe(isModelAllowed);
  });
});
