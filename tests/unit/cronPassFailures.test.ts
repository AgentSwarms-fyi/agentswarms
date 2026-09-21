// The scheduler's pass, when a read or a step fails.
//
// runCronPass folded some twenty steps to console.warn — most `return 0` —
// and the three reads that decide what is due folded to "nothing due":
//
//   const { data: due } = await supabaseAdmin.from("bi_schedules")…   // due ?? []
//   const { data: flows } = await supabaseAdmin.from("user_prep_flows")… // → return 0
//   const { data: alerts } = await supabaseAdmin.from("bi_alerts")…    // alerts ?? []
//
// The result had no field for any of it, so /api/bi/cron answered
// { ok: true, processed: 0, … } over a pass that could not read its own
// schedule, and a refresh that crossed an alert threshold notified nobody.
//
// The reads are behavioural: the real functions, forced past their interval
// guards, against an admin client whose read fails. The pass and the route
// are source-anchored: the pass acquires a cross-instance lease and imports
// twenty modules, and the route is a file route.
import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

type Resp = { data: unknown; error: { message: string } | null };

const admin = vi.hoisted(() => ({
  responses: {} as Record<string, Resp>,
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const resp = admin.responses[table] ?? { data: [], error: null };
      const b: Record<string, unknown> = {};
      for (const m of [
        "select",
        "eq",
        "neq",
        "lte",
        "gte",
        "lt",
        "gt",
        "in",
        "is",
        "not",
        "or",
        "filter",
        "order",
        "limit",
        "update",
        "insert",
        "upsert",
        "delete",
      ]) {
        b[m] = () => b;
      }
      b.maybeSingle = () => Promise.resolve(resp);
      b.single = () => Promise.resolve(resp);
      b.then = (res: (v: Resp) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve(resp).then(res, rej);
      return b;
    },
    rpc: async () => ({ data: null, error: null }),
  },
}));

const FAILED = { data: null, error: { message: "connection reset" } };

describe("processDueSchedules, when the schedule cannot be read", () => {
  it("fails with the reason instead of running nothing", async () => {
    admin.responses = { bi_schedules: FAILED };
    const { processDueSchedules } = await import("@/utils/bi/refresh.server");
    await expect(processDueSchedules(true)).rejects.toThrow(
      /could not read due schedules: connection reset/,
    );
  });

  it("still runs nothing, quietly, when nothing is due", async () => {
    admin.responses = { bi_schedules: { data: [], error: null } };
    const { processDueSchedules } = await import("@/utils/bi/refresh.server");
    await expect(processDueSchedules(true)).resolves.toBe(0);
  });
});

describe("processDuePrepFlows, when the flows cannot be read", () => {
  it("fails with the reason instead of running nothing", async () => {
    admin.responses = { user_prep_flows: FAILED };
    const { processDuePrepFlows } = await import("@/utils/bi/refresh.server");
    await expect(processDuePrepFlows(true)).rejects.toThrow(
      /could not read prep flows due: connection reset/,
    );
  });

  it("still runs nothing, quietly, when no flow is due", async () => {
    admin.responses = { user_prep_flows: { data: [], error: null } };
    const { processDuePrepFlows } = await import("@/utils/bi/refresh.server");
    await expect(processDuePrepFlows(true)).resolves.toBe(0);
  });
});

describe("the pass and the route, when a step fails", () => {
  const SRC = readFileSync("src/utils/bi/refresh.server.ts", "utf8");
  const ROUTE = readFileSync("src/routes/api/bi.cron.ts", "utf8");
  const pass = SRC.slice(
    SRC.indexOf("export async function runCronPass("),
    SRC.indexOf("export function ensureScheduler("),
  );

  it("records every folded failure instead of only warning", () => {
    expect(pass).toMatch(/const errors: string\[\] = \[\];/);
    expect(pass).toMatch(/errors\.push\(`\$\{step\}: \$\{msg\}`\);/);
    expect(pass, "a step still folds to console.warn alone").not.toMatch(
      /\.catch\(\(e\) => console\.warn\(/,
    );
    expect(pass, "a step still folds to warn + return 0").not.toMatch(
      /console\.warn\("\[[a-z-]+\][^"]*", \(e as Error\)\.message\);\s*return 0;/,
    );
    expect((pass.match(/fold\("[a-z-]+", e/g) ?? []).length).toBeGreaterThanOrEqual(20);
  });

  it("does not let a failed schedule read abort the other sweeps", () => {
    expect(pass).toMatch(
      /processDueSchedules\(force\)\.catch\(\(e\) => fold\("bi-schedules", e, 0\)\)/,
    );
    expect(pass).toMatch(
      /processDuePrepFlows\(force\)\.catch\(\(e\) => fold\("prep-flows", e, 0\)\)/,
    );
  });

  it("returns the failures with the counts", () => {
    expect(pass).toMatch(/ran: true,[\s\S]{0,400}?errors,\s*\};/);
    expect(SRC).toMatch(/errors: string\[\];/);
    expect(SRC).toMatch(/ml_evaluations: 0,\s*errors: \[\],/);
  });

  it("the route's ok is false when anything failed", () => {
    expect(ROUTE).toMatch(/ok: result\.errors\.length === 0,/);
  });

  it("evaluateAlerts reads its alerts' error", () => {
    const fn = SRC.slice(
      SRC.indexOf("export async function evaluateAlerts("),
      SRC.indexOf("export function computeNextRun("),
    );
    expect(fn).toMatch(
      /if \(alertsErr\) throw new Error\(`could not read alerts: \$\{alertsErr\.message\}`\);/,
    );
  });
});
