// The recovery dialog must not offer a model the server will refuse.
//
// use-iam states the invariant in its own comment: the matcher is shared with
// the server "so the UI can never offer a model the server would refuse". Three
// pickers honoured it — the agent form, the BI model select, the swarm node
// inspector — and ModelFallbackDialog did not. That is the worst of the four
// places to miss, because this dialog opens ONLY after a model has already
// failed: it is the recovery path, and it was sending an already-blocked user
// to a second refusal with nothing explaining why.
//
// The subtle part, and the reason these tests exist rather than a code comment:
// collapseModelPolicy encodes "no restriction" as NULL and "deny by default,
// nothing granted" as an EMPTY ARRAY. Those are opposite meanings that a length
// check collapses into one. The first version of the empty-state guard used
// `(rules?.length ?? 0) > 0` and so stayed silent in the most restricted state
// of all.
import { describe, expect, it } from "vitest";

import { collapseModelPolicy, isModelAllowed, type ModelRuleLike } from "@/lib/iamRules";

/** The predicate the dialog applies to every option it lists. */
const offer = (rules: ModelRuleLike[] | null, options: { provider: string; model: string }[]) =>
  options.filter((o) => isModelAllowed(rules, o.provider, o.model));

const CATALOGUE = [
  { provider: "openrouter", model: "openrouter/free" },
  { provider: "openrouter", model: "google/gemini-2.5-pro" },
  { provider: "openai", model: "gpt-4o-mini" },
];

describe("an empty rule array is the most restrictive state, not the least", () => {
  it("null means no restriction — everything is offered", () => {
    expect(offer(null, CATALOGUE)).toHaveLength(3);
  });

  it("EMPTY ARRAY means deny-by-default with nothing granted — nothing is offered", () => {
    expect(offer([], CATALOGUE)).toHaveLength(0);
  });

  it("collapseModelPolicy produces null for the default allow policy", () => {
    expect(collapseModelPolicy({ mode: "allow", isSuperadmin: false, applicable: [] })).toBeNull();
  });

  it("collapseModelPolicy produces an empty array for deny-by-default", () => {
    expect(collapseModelPolicy({ mode: "deny", isSuperadmin: false, applicable: [] })).toEqual([]);
  });

  it("a superadmin under deny-by-default is unrestricted", () => {
    expect(collapseModelPolicy({ mode: "deny", isSuperadmin: true, applicable: [] })).toBeNull();
  });
});

describe("the dialog's empty-state guard", () => {
  // Mirrors the expression in ModelFallbackDialog: policy is in force whenever
  // the rules are not null, INCLUDING when the array is empty.
  const emptiedByRules = (rules: ModelRuleLike[] | null, offered: number) =>
    offered === 0 && rules !== null;

  it("explains an empty list when deny-by-default granted nothing", () => {
    const rules = collapseModelPolicy({ mode: "deny", isSuperadmin: false, applicable: [] });
    expect(emptiedByRules(rules, offer(rules, CATALOGUE).length)).toBe(true);
  });

  it("explains an empty list when rules exist but match none of the catalogue", () => {
    const rules: ModelRuleLike[] = [{ provider: "anthropic", model_pattern: "claude-*" }];
    expect(emptiedByRules(rules, offer(rules, CATALOGUE).length)).toBe(true);
  });

  it("stays silent when nothing is restricted and the list is empty for another reason", () => {
    // No providers connected is not a policy problem, and blaming an
    // administrator for it would send the user to the wrong person.
    expect(emptiedByRules(null, 0)).toBe(false);
  });

  it("stays silent when options survived the filter", () => {
    const rules: ModelRuleLike[] = [{ provider: "openrouter", model_pattern: "*" }];
    const offered = offer(rules, CATALOGUE);
    expect(offered.length).toBeGreaterThan(0);
    expect(emptiedByRules(rules, offered.length)).toBe(false);
  });

  it("would have stayed silent under the length check — the bug this replaced", () => {
    // Kept as a live demonstration: `length > 0` reads deny-all as unrestricted.
    const denyAll = collapseModelPolicy({ mode: "deny", isSuperadmin: false, applicable: [] });
    const byLength = (denyAll?.length ?? 0) > 0;
    expect(byLength).toBe(false);
    expect(denyAll !== null).toBe(true);
  });
});

describe("filtering keeps what the rules allow", () => {
  it("offers only the provider a rule names", () => {
    const rules: ModelRuleLike[] = [{ provider: "openrouter", model_pattern: "*" }];
    expect(offer(rules, CATALOGUE).map((o) => o.provider)).toEqual(["openrouter", "openrouter"]);
  });

  it("respects a narrower model pattern within an allowed provider", () => {
    const rules: ModelRuleLike[] = [{ provider: "openrouter", model_pattern: "openrouter/*" }];
    expect(offer(rules, CATALOGUE).map((o) => o.model)).toEqual(["openrouter/free"]);
  });
});
