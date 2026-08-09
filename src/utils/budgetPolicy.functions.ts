// Report whether the monthly cap is actually enforced on THIS deployment.
//
// The cap is opt-in: budgetGuard only gates a model call when
// ENFORCE_BUDGET_CAP is set, and that default is deliberate — monthly_cap_usd
// starts small, so enforcing by default would begin refusing calls on existing
// instances whose cap was never meant to bite.
//
// The Budgets page did not know any of that. It stated, unconditionally,
// "Agents will refuse new requests once this cap is reached", on an instance
// where nothing enforces it and spend runs past the cap indefinitely. Measured
// here: ENFORCE_BUDGET_CAP unset, month-to-date $4.12 against a $5.00 cap, and
// no gate anywhere in the request path.
//
// The repo already holds the principle this violates, in guardrails.ts: "A
// governance control that silently does nothing is worse than an absent one,
// because it manufactures false assurance — so the disclosure is the feature,
// not an apology for a gap." Guardrails discloses its inert fields. The cap
// promised a hard stop it does not perform.
//
// Environment variables are server-side, so the page cannot read them; this is
// the bridge. It exposes only two booleans — never the values — so it is safe
// for any signed-in user to call.
import { createServerFn } from "@tanstack/react-start";

import { budgetEnforcementEnabled, budgetFailsClosed } from "@/utils/budgetGuard.server";

export type BudgetPolicy = {
  /** ENFORCE_BUDGET_CAP — whether reaching the cap actually refuses calls. */
  enforced: boolean;
  /** BUDGET_FAIL_CLOSED — whether an unreadable spend figure refuses too. */
  failsClosed: boolean;
};

export const budgetPolicy = createServerFn({ method: "GET" }).handler(
  async (): Promise<BudgetPolicy> => ({
    enforced: budgetEnforcementEnabled(),
    failsClosed: budgetFailsClosed(),
  }),
);
