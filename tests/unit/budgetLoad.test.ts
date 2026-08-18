// The budgets page's data load, and what each read's failure must produce.
//
// Module 25 of the adversarial pass. This is a spend-PROTECTION page, so a
// discarded read error does not read as "unknown" — it reads as "you are not
// protected" or "you cannot see that you are". The three failures each had
// their own way of saying that, all silently:
//   - budget read fails → taken for "no budget", INSERT attempted, rejected
//     by the user_id UNIQUE index, `budget` stays null, skeleton for ever.
//   - agents read fails → "No agents yet" for an account with seven.
//   - agent_limits read fails → every agent renders uncapped.
//
// loadBudgetData keeps every error and only creates a budget when the read
// SUCCEEDED and returned nothing — the one path allowed to insert.
import { describe, expect, it, vi } from "vitest";
import { loadBudgetData, type BudgetReads } from "@/lib/budgetLoad";

const ok = <T>(data: T) => Promise.resolve({ data, error: null });
const fail = (message: string) => Promise.resolve({ data: null, error: { message } });

const reads = (over: Partial<BudgetReads> = {}): BudgetReads => ({
  readBudget: () => ok({ id: "b1", monthly_cap_usd: 20 }),
  createBudget: () => ok({ id: "b-new" }),
  readAgents: () => ok([{ id: "a1", name: "Agent 1", is_active: true }]),
  readLimits: () => ok([{ id: "l1", agent_id: "a1", max_spend_per_day_usd: 5 }]),
  ...over,
});

describe("loadBudgetData — the happy path", () => {
  it("returns the budget, agents and a limits map keyed by agent", async () => {
    const res = await loadBudgetData(reads());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.budget.id).toBe("b1");
    expect(res.data.agents).toHaveLength(1);
    expect(res.data.limits["a1"].id).toBe("l1");
  });
});

describe("loadBudgetData — a missing budget is created, a FAILED read is not", () => {
  it("creates a budget when the read succeeded and returned none", async () => {
    const createBudget = vi.fn(() => ok({ id: "b-new" }));
    const res = await loadBudgetData(reads({ readBudget: () => ok(null), createBudget }));
    expect(createBudget).toHaveBeenCalledOnce();
    expect(res.ok && res.data.budget.id).toBe("b-new");
  });

  it("does NOT insert when the budget read failed — that path hid the failure and hit the unique index", async () => {
    const createBudget = vi.fn(() => ok({ id: "b-new" }));
    const res = await loadBudgetData(
      reads({ readBudget: () => fail("permission denied"), createBudget }),
    );
    expect(createBudget).not.toHaveBeenCalled();
    expect(res).toEqual({ ok: false, error: "permission denied" });
  });

  it("reports a create that itself fails rather than leaving budget null", async () => {
    const res = await loadBudgetData(
      reads({ readBudget: () => ok(null), createBudget: () => fail("duplicate key") }),
    );
    expect(res).toEqual({ ok: false, error: "duplicate key" });
  });

  it("reports a create that returns nothing", async () => {
    const res = await loadBudgetData(
      reads({ readBudget: () => ok(null), createBudget: () => ok(null) }),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/could not create/i);
  });
});

describe("loadBudgetData — every read failure fails the load, not the account", () => {
  it("fails when agents cannot be read (never '[] = No agents yet')", async () => {
    const res = await loadBudgetData(reads({ readAgents: () => fail("agents 403") }));
    expect(res).toEqual({ ok: false, error: "agents 403" });
  });

  it("fails when limits cannot be read (never 'every agent uncapped')", async () => {
    const res = await loadBudgetData(reads({ readLimits: () => fail("limits 403") }));
    expect(res).toEqual({ ok: false, error: "limits 403" });
  });
});

describe("loadBudgetData — genuinely empty is distinct from failed", () => {
  it("a real empty agent list loads fine (empty, not error)", async () => {
    const res = await loadBudgetData(reads({ readAgents: () => ok([]), readLimits: () => ok([]) }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.agents).toEqual([]);
    expect(res.data.limits).toEqual({});
  });
});
