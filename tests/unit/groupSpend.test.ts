// Group budgets: the month's spend was summed in a browser from a page of the
// traces.
//
// Module 29 of the adversarial pass, partiality sweep. The IAM → Budgets tab
// read every trace of the current month into the browser and bucketed them by
// group:
//
//   supabase.from("execution_traces").select("user_id, cost_usd").gte("created_at", iso)
//
// Three findings of this sweep in one line. PostgREST caps the response at
// db-max-rows — 1,000 on a default Supabase project, measured against 1,104
// traces in the current month on this deployment — so the sum was over a
// prefix, and a group's spend, its percentage of cap, and the red "over"
// colouring were all rendered low. `traces ?? []` read a failed query as an
// empty month, which sums to $0 and reads as "nothing spent". And `cost_usd ??
// 0` counted calls on unpriced models as free, which is exactly what R34 had
// already fixed in the ENFORCING path — the display beside it kept doing it.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { floorTotal, formatSpend, spendCaveat } from "@/lib/spendCompleteness";

describe("floorTotal", () => {
  it("is the answer when every call was priced", () => {
    const t = floorTotal(41.5, 0);
    expect(t.partial).toBe(false);
    expect(formatSpend(t)).toBe("$41.50");
    expect(spendCaveat(t)).toBeNull();
  });

  it("is a floor when some calls had no known price", () => {
    const t = floorTotal(41.5, 3);
    expect(t.partial).toBe(true);
    expect(formatSpend(t)).toBe("$41.50+?");
    expect(spendCaveat(t)).toContain("3 calls");
  });

  it("treats an UNKNOWN unpriced count as a floor, not as zero", () => {
    // The distinction the gate already makes: `unpriced === null || > 0`. A
    // figure whose completeness could not be established is not a complete
    // figure, and the display may not round that up to certainty.
    const t = floorTotal(41.5, null);
    expect(t.partial).toBe(true);
    expect(formatSpend(t)).toBe("$41.50+?");
  });

  it("keeps the total itself untouched in every case", () => {
    for (const u of [0, 7, null]) expect(floorTotal(12.34, u).total).toBe(12.34);
  });
});

describe("what the admin budgets tab actually reads", () => {
  const fn = readFileSync("src/utils/budgetAdmin.functions.ts", "utf8");
  const tab = readFileSync("src/components/admin/GroupBudgetsTab.tsx", "utf8");

  it("no longer sums traces in the browser", () => {
    // Anchored on the chained call, not the table name: the comment above the
    // new read names the old query to explain why it went.
    expect(tab).not.toMatch(/\.from\("execution_traces"\)/);
    expect(tab).toContain("await readGroupSpend({");
  });

  it("asks the path that enforces the cap for the figure it displays", () => {
    expect(fn).toContain('await spendSince({ userId: "", since: monthStartIso(), userIds })');
    expect(fn).toContain("unpricedRows: r.unpriced");
  });

  it("reads group membership by cursor, not in one capped select", () => {
    expect(fn).toContain("await scanRows<{ id: string; group_id: string; user_id: string }>(");
    expect(fn).toContain('q = q.gt("id", after)');
    expect(fn).toContain("{ maxRows: MAX_MEMBERSHIPS }");
  });

  it("refuses to publish a total built on a truncated membership list", () => {
    expect(fn).toMatch(/if \(!members\.complete\) \{/);
    expect(fn).toContain("Group membership could not be read in full");
  });

  it("is superadmin-only, since it reads every group's spend", () => {
    expect(fn).toMatch(/if \(!guard\.ok\) throw new Error\(/);
  });

  it("says unknown rather than $0.00 when the figure is unavailable", () => {
    // $0.00 is the one thing it must not say: that is also what an untouched
    // group legitimately shows.
    expect(tab).toContain("total === null ? (");
    expect(tab).toContain("unknown");
  });

  it("marks a floor as a floor, in the number and in the percentage", () => {
    expect(tab).toContain("floorTotal(s.total, s.unpricedRows)");
    expect(tab).toContain("{formatSpend(total)}");
    expect(tab).toContain('{total.partial ? "≥" : ""}');
  });
});
