// Assembling the budgets page's data, with every read's failure kept.
//
// The page reads four things — the budget row, the agent list, the per-agent
// limits, and month-to-date spend — and before this existed it discarded the
// error on the first three. Each failure had its own way of lying, and this
// is a SPEND-PROTECTION page, so a lie here reads as "you are not protected"
// or "you cannot see that you are":
//
//   * budget_settings fails → the row reads null, the code takes it for "no
//     budget yet" and tries to INSERT one, which the user_id UNIQUE index
//     rejects; that error is discarded too, `budget` stays null, and the
//     render gate `loading || !budget` keeps the skeleton up for ever.
//   * agents fails → `[]` → "No agents yet. Create one in the Agent Builder
//     first." for an account with seven agents.
//   * agent_limits fails → an empty map → every agent renders with NO cap
//     configured, so a page whose entire job is showing which agents are
//     capped shows all of them as uncapped.
//
// mySpendSince already returns a discriminated result and is left as-is.

export type BudgetRowT = { id: string; [k: string]: unknown };
export type AgentT = { id: string; name: string; is_active: boolean };
export type AgentLimitT = { id: string; agent_id: string; [k: string]: unknown };

export type BudgetReads = {
  /** The singleton budget row, or null when none exists yet (NOT on error). */
  readBudget: () => Promise<{ data: BudgetRowT | null; error: { message: string } | null }>;
  /** Create the budget row for a first-time user. */
  createBudget: () => Promise<{ data: BudgetRowT | null; error: { message: string } | null }>;
  readAgents: () => Promise<{ data: AgentT[] | null; error: { message: string } | null }>;
  readLimits: () => Promise<{ data: AgentLimitT[] | null; error: { message: string } | null }>;
};

export type BudgetData = {
  budget: BudgetRowT;
  agents: AgentT[];
  limits: Record<string, AgentLimitT>;
};

export type BudgetLoadResult = { ok: true; data: BudgetData } | { ok: false; error: string };

/**
 * Load everything the page needs, or say why it could not.
 *
 * The one subtlety worth stating: a null budget row means "create one" ONLY
 * when the read succeeded. A null from a FAILED read must never trigger the
 * insert — that is the path that both hides the failure and pointlessly
 * collides with the unique index.
 */
export async function loadBudgetData(reads: BudgetReads): Promise<BudgetLoadResult> {
  const budgetRes = await reads.readBudget();
  if (budgetRes.error) return { ok: false, error: budgetRes.error.message };

  let budget = budgetRes.data;
  if (!budget) {
    const created = await reads.createBudget();
    if (created.error) return { ok: false, error: created.error.message };
    if (!created.data) return { ok: false, error: "Could not create a budget for this account." };
    budget = created.data;
  }

  const agentsRes = await reads.readAgents();
  if (agentsRes.error) return { ok: false, error: agentsRes.error.message };

  const limitsRes = await reads.readLimits();
  if (limitsRes.error) return { ok: false, error: limitsRes.error.message };

  const limits: Record<string, AgentLimitT> = {};
  for (const l of limitsRes.data ?? []) limits[l.agent_id] = l;

  return { ok: true, data: { budget, agents: (agentsRes.data ?? []) as AgentT[], limits } };
}
