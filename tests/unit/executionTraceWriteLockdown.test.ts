// A user cannot erase or zero their own LLM-cost records to defeat a budget cap.
//
// VA-2026-10-25-13 (execution_traces portion). The table's RLS was a single
// "Users manage own traces" FOR ALL policy, so a signed-in user could DELETE
// their rows or UPDATE cost_usd = 0 over PostgREST. The monthly budget a
// superadmin caps is SUM(execution_traces.cost_usd) (budgetSpend.server.ts), so
// that erased the evidence the cap is measured on.
//
// The fix is a split policy (owner-only SELECT, no client write policy — the
// service role bypasses RLS and is the only writer) PLUS moving the three write
// sites that still used the caller's client onto supabaseAdmin. The policy
// itself is enforced by Postgres, and the migration proves it on apply (the DO
// block raises if a write policy survives), so the push succeeding is the live
// proof; here we pin the migration's shape and that no execution_traces write
// goes through a user client.
//
// (The swarm_runs half of the finding is tracked separately: its writes come
// from the browser bundle and need a server-function refactor, and swarm_runs
// does not feed the budget cap.)
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const MIGRATION = "supabase/migrations/20261027000000_execution_trace_write_lockdown.sql";
const mig = readFileSync(MIGRATION, "utf8");

describe("the migration locks execution_traces writes to the service role", () => {
  it("drops the blanket FOR ALL policy", () => {
    expect(mig).toMatch(
      /DROP POLICY IF EXISTS "Users manage own traces" ON public\.execution_traces/,
    );
  });

  it("replaces it with an owner-only SELECT policy", () => {
    expect(mig).toMatch(
      /CREATE POLICY "Owners read own traces"[\s\S]*?ON public\.execution_traces[\s\S]*?FOR SELECT[\s\S]*?USING \(auth\.uid\(\) = user_id\)/,
    );
  });

  it("adds no client write policy — the SELECT policy is the only one created", () => {
    const creates = mig.match(/CREATE POLICY/g) ?? [];
    expect(creates.length).toBe(1);
    // Scope the FOR-clause check to the one CREATE POLICY statement, so the
    // finding's prose and the self-check's "FOR ALL policy" error string don't
    // count: the created policy is SELECT, never a write command.
    const start = mig.indexOf("CREATE POLICY");
    const createBlock = mig.slice(start, mig.indexOf(";", start));
    expect(createBlock).toMatch(/FOR SELECT\b/);
    expect(createBlock).not.toMatch(/FOR (ALL|INSERT|UPDATE|DELETE)\b/);
  });

  it("proves on apply that no client write policy remains", () => {
    // The DO block fails the push if a write policy survived.
    expect(mig).toContain("cmd IN ('ALL', 'INSERT', 'UPDATE', 'DELETE')");
    expect(mig).toMatch(/RAISE EXCEPTION 'trace lockdown:[^']*write polic/);
    expect(mig).toMatch(/exactly one SELECT policy/);
  });
});

describe("every execution_traces write runs as the service role", () => {
  const chat = readFileSync("src/routes/api/chat.ts", "utf8");
  const py = readFileSync("src/routes/api/python-chat.ts", "utf8");
  const obs = readFileSync("src/utils/observability.functions.ts", "utf8");
  const gw = readFileSync("src/utils/observability/recordGatewayUsage.server.ts", "utf8");
  const reprice = readFileSync("src/utils/observability/reprice.server.ts", "utf8");
  const retention = readFileSync("src/utils/chatRetention.server.ts", "utf8");

  it("chat.ts upserts the cost record via supabaseAdmin, not the caller's client", () => {
    expect(chat).toMatch(/\(supabaseAdmin\.from\("execution_traces"\) as any\)\.upsert/);
    // The caller-scoped client must no longer write this table.
    expect(chat).not.toMatch(/\bsb\.from\("execution_traces"\)/);
  });

  it("python-chat.ts inserts the notebook trace via supabaseAdmin", () => {
    expect(py).toMatch(/supabaseAdmin\.from\("execution_traces"\)\.insert/);
    expect(py).not.toMatch(/\bsb\.from\("execution_traces"\)/);
  });

  it("seedTraces inserts via supabaseAdmin (its count read stays owner-scoped)", () => {
    expect(obs).toMatch(/supabaseAdmin\.from\("execution_traces"\)\.insert/);
    expect(obs).not.toMatch(/\bsupabase\.from\("execution_traces"\)\.insert/);
  });

  it("the gateway-usage, reprice and retention writers stay on the service role", () => {
    // A regression guard: if any of these drifts back to a user client, the
    // restriction would silently drop its writes.
    expect(gw).toMatch(/supabaseAdmin\.from\("execution_traces"\)/);
    expect(reprice).toMatch(/supabaseAdmin[\s\S]{0,40}\.from\("execution_traces"\)/);
    expect(retention).toMatch(
      /supabaseAdmin[\s\S]{0,40}\.from\("execution_traces"\)[\s\S]{0,40}\.delete/,
    );
  });
});
