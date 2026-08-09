// The Budgets page must not promise a hard stop the deployment does not perform.
//
// The cap is opt-in: budgetGuard gates a model call only when
// ENFORCE_BUDGET_CAP is set, and that default is deliberate — monthly_cap_usd
// starts small, so enforcing by default would begin refusing calls on existing
// instances whose cap was never meant to bite.
//
// The page did not know that. It said, unconditionally, "Agents will refuse new
// requests once this cap is reached." Measured on this instance:
// ENFORCE_BUDGET_CAP unset, month-to-date $4.12 against a $5.00 cap, and
// nothing in the request path that would refuse anything.
//
// The decision logic itself is well covered (budgetSpend.test.ts checks
// fail-closed, that a failed lookup is not cached as a decision, and that every
// call site goes through spendSince). The gap was never the guard — it was a
// page telling the operator the guard was on.
//
// guardrails.ts already states the rule this broke: "A governance control that
// silently does nothing is worse than an absent one, because it manufactures
// false assurance — so the disclosure is the feature, not an apology for a
// gap." Guardrails discloses its inert fields; the cap did not.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const page = readFileSync(resolve("src/routes/_authenticated/budgets.tsx"), "utf8");
const policyFn = readFileSync(resolve("src/utils/budgetPolicy.functions.ts"), "utf8");

describe("the cap says whether it is actually enforced", () => {
  it("asks the server for the enforcement state", () => {
    // Environment variables are server-side; the page cannot read them, so an
    // honest page has to ask.
    expect(page).toMatch(/budgetPolicy/);
    expect(policyFn).toMatch(/budgetEnforcementEnabled/);
  });

  it("never promises refusal unconditionally", () => {
    // The exact sentence that was wrong. It may still appear — but only inside
    // a branch that knows enforcement is on.
    const promise = "Agents will refuse new requests once this cap is reached.";
    const at = page.indexOf(promise);
    expect(at, "the promise sentence vanished — this test needs re-anchoring").toBeGreaterThan(0);

    // Walk back to the nearest conditional; the promise must sit inside one
    // that tests the policy.
    const before = page.slice(Math.max(0, at - 600), at);
    expect(
      /policy\?\.enforced/.test(before),
      "the refusal promise is not gated on policy.enforced — it will lie on any " +
        "deployment that has not set ENFORCE_BUDGET_CAP",
    ).toBe(true);
  });

  it("names the switch that would turn it on", () => {
    // A warning the operator cannot act on is only half a disclosure.
    expect(page).toMatch(/ENFORCE_BUDGET_CAP/);
  });

  it("exposes only booleans, never the environment values", () => {
    // This runs for any signed-in user, so it must not become a way to read
    // server configuration.
    expect(policyFn).toMatch(/enforced:\s*budgetEnforcementEnabled\(\)/);
    expect(policyFn).toMatch(/failsClosed:\s*budgetFailsClosed\(\)/);
    expect(policyFn).not.toMatch(/process\.env\.[A-Z_]+\s*[,}]/);
  });
});
