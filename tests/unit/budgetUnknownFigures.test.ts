// BUDGET_FAIL_CLOSED, honoured for every figure the cap depends on.
//
// FOUND IN R250, from the sweep-7 queue ("budget caps fall back to no cap").
// The default is fail-open on purpose, and that is unchanged. The defect is
// the operator's switch: BUDGET_FAIL_CLOSED means "the cap must hold", and it
// was honoured on exactly one read, month-to-date spend. A failed CAP read
// answered "no cap"; a failed credential or group cap read answered "no cap";
// a failed membership read answered "in no groups"; a failed MEMBERS read
// reached groupSpend as [] and groupSpend([]) is $0 — "the team spent nothing";
// and both catch-alls answered "allowed". Every one of those let the call
// through on a deployment whose operator had said not to.
//
// And the refusals that did fire said "You have reached your monthly AI budget"
// about a spend nobody had read.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Resp = { data: unknown; error: { message: string } | null };

const db = vi.hoisted(() => ({
  /** Answers by table, and for iam_group_members by the column filtered on. */
  budget_settings: { data: { monthly_cap_usd: 10 }, error: null } as Resp,
  budget_limits: { data: { monthly_cap_usd: 10, is_active: true }, error: null } as Resp,
  membershipsOfUser: { data: [{ group_id: "g1" }], error: null } as Resp,
  membersOfGroup: { data: [{ user_id: "u1" }, { user_id: "u2" }], error: null } as Resp,
  spend: { ok: true, spend: 1, unpriced: 0 } as
    { ok: true; spend: number; unpriced: number | null } | { ok: false; error: string },
}));

vi.mock("@/integrations/supabase/client.server", () => {
  const chain = (table: string) => {
    let filteredOn = "";
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = (col: string) => {
      filteredOn = filteredOn || col;
      return b;
    };
    const answer = (): Resp => {
      if (table === "budget_settings") return db.budget_settings;
      if (table === "budget_limits") return db.budget_limits;
      if (table === "iam_group_members")
        return filteredOn === "user_id" ? db.membershipsOfUser : db.membersOfGroup;
      return { data: null, error: null };
    };
    b.maybeSingle = () => Promise.resolve(answer());
    b.then = (res: (v: Resp) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(answer()).then(res, rej);
    return b;
  };
  return { supabaseAdmin: { from: (t: string) => chain(t) } };
});

vi.mock("@/utils/budgetSpend.server", () => ({
  monthStartIso: () => "2026-10-01T00:00:00Z",
  spendSince: async () => db.spend,
}));

const FAIL = { data: null, error: { message: "connection reset" } };

function healthy() {
  db.budget_settings = { data: { monthly_cap_usd: 10 }, error: null };
  db.budget_limits = { data: { monthly_cap_usd: 10, is_active: true }, error: null };
  db.membershipsOfUser = { data: [{ group_id: "g1" }], error: null };
  db.membersOfGroup = { data: [{ user_id: "u1" }, { user_id: "u2" }], error: null };
  db.spend = { ok: true, spend: 1, unpriced: 0 };
}

let n = 0;
/** A fresh user id each time, so the module's 60 s caches never answer. */
const user = () => `user-${++n}`;

beforeEach(() => {
  healthy();
  vi.stubEnv("ENFORCE_BUDGET_CAP", "true");
});
afterEach(() => vi.unstubAllEnvs());

describe("with BUDGET_FAIL_CLOSED set, every unknown figure refuses", () => {
  beforeEach(() => vi.stubEnv("BUDGET_FAIL_CLOSED", "true"));

  it("allows a call under every cap when everything reads (the baseline)", async () => {
    const { getBudgetDecision } = await import("@/utils/budgetGuard.server");
    expect((await getBudgetDecision(user())).over).toBe(false);
  });

  it.each([
    ["the personal cap", () => (db.budget_settings = FAIL)],
    ["the group memberships", () => (db.membershipsOfUser = FAIL)],
    ["a group's cap", () => (db.budget_limits = FAIL)],
    ["a group's members", () => (db.membersOfGroup = FAIL)],
  ])("refuses when %s cannot be read", async (_what, breakIt) => {
    breakIt();
    const { getBudgetDecision } = await import("@/utils/budgetGuard.server");
    const d = await getBudgetDecision(user());
    expect(d.over).toBe(true);
    expect(d.unknown).toBe(true);
  });

  it("refuses when the credential's cap cannot be read", async () => {
    db.budget_limits = FAIL;
    db.membershipsOfUser = { data: [], error: null };
    const { getBudgetDecision } = await import("@/utils/budgetGuard.server");
    const d = await getBudgetDecision(user(), { type: "gateway_key", id: "k1" });
    expect(d).toMatchObject({ over: true, scope: "credential", unknown: true });
  });

  it("says the budget could not be checked, not that it was reached", async () => {
    db.budget_settings = FAIL;
    const { getBudgetDecision, budgetMessage } = await import("@/utils/budgetGuard.server");
    const msg = budgetMessage(await getBudgetDecision(user()));
    expect(msg).toMatch(/could not be checked/);
    expect(msg).not.toMatch(/reached/);
  });
});

describe("without it, the documented default is unchanged", () => {
  it.each([
    ["the personal cap", () => (db.budget_settings = FAIL)],
    ["the group memberships", () => (db.membershipsOfUser = FAIL)],
    ["a group's cap", () => (db.budget_limits = FAIL)],
    ["a group's members", () => (db.membersOfGroup = FAIL)],
  ])("still allows the call when %s cannot be read", async (_what, breakIt) => {
    breakIt();
    const { getBudgetDecision } = await import("@/utils/budgetGuard.server");
    expect((await getBudgetDecision(user())).over).toBe(false);
  });

  it("still refuses a team that really is over its cap", async () => {
    db.spend = { ok: true, spend: 50, unpriced: 0 };
    db.budget_settings = { data: { monthly_cap_usd: 1000 }, error: null };
    const { getBudgetDecision } = await import("@/utils/budgetGuard.server");
    expect(await getBudgetDecision(user())).toMatchObject({ over: true, scope: "group" });
  });

  // An "allowed" given because a figure could not be read is a guess, and a
  // guess must not be remembered: the decision cache lasts a minute.
  it("does not remember a verdict built on a figure it could not read", async () => {
    const who = user();
    const { getBudgetDecision } = await import("@/utils/budgetGuard.server");
    db.membersOfGroup = FAIL;
    db.spend = { ok: true, spend: 50, unpriced: 0 };
    db.budget_settings = { data: { monthly_cap_usd: 1000 }, error: null };
    expect((await getBudgetDecision(who)).over).toBe(false);
    // The read recovers, and the team is over its $10 cap.
    db.membersOfGroup = { data: [{ user_id: "u1" }], error: null };
    expect(await getBudgetDecision(who)).toMatchObject({ over: true, scope: "group" });
  });
});
