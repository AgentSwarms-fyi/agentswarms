// Month-to-date spend, and the difference between "zero" and "we don't know".
//
// This figure decides whether a call is refused. It was computed in five places
// by SELECTing every execution_traces row for the month and adding cost_usd up
// in JavaScript — no LIMIT, no aggregate — and every one of them read the
// result as `data ?? []`.
//
// That is the bug. A statement timeout produces an empty array, an empty array
// sums to $0, and $0 is under every cap. The gate stopped enforcing exactly
// when there was the most spend to enforce against, and said nothing. At the
// 30/min rate limit a single public embed key can write ~1.3M trace rows in a
// month, all of which were being fetched once a minute to total one column.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { monthStartIso } from "@/utils/budgetSpend.server";

describe("the month boundary", () => {
  it("starts at the first instant of the current UTC month", () => {
    expect(monthStartIso(new Date("2026-03-17T13:45:00Z"))).toBe("2026-03-01T00:00:00.000Z");
  });

  it("does not slip a month at either edge", () => {
    // A boundary off by an hour silently includes or excludes a day of spend.
    expect(monthStartIso(new Date("2026-03-01T00:00:00Z"))).toBe("2026-03-01T00:00:00.000Z");
    expect(monthStartIso(new Date("2026-03-31T23:59:59Z"))).toBe("2026-03-01T00:00:00.000Z");
    expect(monthStartIso(new Date("2026-01-01T00:00:00Z"))).toBe("2026-01-01T00:00:00.000Z");
    expect(monthStartIso(new Date("2026-12-31T23:59:59Z"))).toBe("2026-12-01T00:00:00.000Z");
  });

  it("handles a leap February", () => {
    expect(monthStartIso(new Date("2028-02-29T12:00:00Z"))).toBe("2028-02-01T00:00:00.000Z");
  });
});

describe("an unknown figure is never reported as zero", () => {
  const src = readFileSync("src/utils/budgetSpend.server.ts", "utf8");

  it("returns a discriminated result rather than a bare number", () => {
    // The whole point: `0` and "the query failed" must not be the same value.
    expect(src).toMatch(/ok: true; spend: number/);
    expect(src).toMatch(/ok: false; error: string/);
  });

  it("reports a query error instead of summing what came back", () => {
    expect(src).toMatch(/if \(error\) return \{ ok: false, error: error\.message \}/);
  });

  it("refuses to guess when the fallback hits its row cap", () => {
    // A truncated sum is an UNDER-count, and an under-count on a budget gate
    // lets spend through. Better to say the figure is unavailable.
    //
    // Anchored on the LAST return of fallbackSum rather than a loose window.
    // A `[\s\S]{0,200}` window let a mutation to `ok: true, spend: total`
    // through, because the phrase it looked for was still within range of an
    // earlier, unrelated return.
    expect(src).toContain("MAX_FALLBACK_ROWS");
    const fn = src.slice(src.indexOf("async function fallbackSum"));
    const finalReturn = fn.slice(fn.lastIndexOf("return {"));
    expect(finalReturn).toContain("ok: false");
    expect(finalReturn, "a truncated sum is presented as a total").not.toContain("spend:");
    expect(finalReturn).toContain("migration");
  });

  it("only falls back when the aggregate is genuinely absent", () => {
    // A permissions error or a timeout must NOT silently re-run the slow path
    // and present its result as authoritative.
    expect(src).toMatch(/does not exist\|schema cache\|not find the function/);
  });
});

describe("the guard acts on the difference", () => {
  const guard = readFileSync("src/utils/budgetGuard.server.ts", "utf8");

  it("goes through the shared aggregate, not its own row scan", () => {
    expect(guard).toContain("spendSince(");
    // Whitespace-insensitive: a first version required a newline between the
    // two calls, so a one-line reintroduction of the row scan slipped past.
    expect(guard, "still fetches raw rows to sum").not.toMatch(
      /from\(["']execution_traces["']\)[\s\S]{0,40}\.select\(["']cost_usd["']\)/,
    );
  });

  it("logs a failed lookup instead of treating it as under-cap", () => {
    expect(guard).toMatch(/\[budget\] spend lookup failed/);
  });

  it("does not cache a failure as a decision", () => {
    // Caching "not over" after a timeout would extend a single failure into a
    // minute of unenforced spend.
    const status = guard.slice(guard.indexOf("export async function getBudgetStatus"));
    const failBranch = status.slice(status.indexOf("if (!result.ok)"));
    expect(failBranch.slice(0, failBranch.indexOf("}"))).not.toContain("cache.set");
  });

  it("offers fail-closed for operators who need the cap to hold", () => {
    // Fail-open is the right default — governance should not break legitimate
    // calls — but it was previously indistinguishable from "spent nothing",
    // so there was no choice to make.
    //
    // The FUNCTION BODY is checked, not the name. A mutation that stubbed it
    // to `return false` passed on the name alone, because BUDGET_FAIL_CLOSED
    // still appeared in the doc comment above it.
    const fn = guard.slice(guard.indexOf("export function budgetFailsClosed"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    expect(body, "the setting is not actually read").toContain("process.env.BUDGET_FAIL_CLOSED");
    expect(guard).toMatch(/budgetFailsClosed\(\) \? \{ over: true/);
  });

  it("applies the same rule to credential caps", () => {
    // The per-credential cap is what bounds a leaked public embed key, so it
    // must not read a failed lookup as zero either.
    expect(guard).toMatch(/credentialSpend\(scope: CostScope\): Promise<number \| null>/);
    expect(guard).toMatch(/if \(spend === null\)/);
  });
});

describe("every server path that reads spend uses the aggregate", () => {
  // THE FIRST FIX WAS INCOMPLETE, and this is what caught it. budgetGuard was
  // corrected while budgetAlertTrigger kept the same `data ?? []` idiom — so a
  // failed query still summed to $0, which is 0% of the cap, which fires no
  // alert and returns silently. The one path whose entire job is to warn you
  // went quiet exactly when spend was high enough to make the query slow.
  //
  // Listing the files rather than checking one keeps the next copy honest.
  const SERVER_READERS = [
    "src/utils/budgetGuard.server.ts",
    "src/lib/email/budgetAlertTrigger.server.ts",
  ];

  for (const f of SERVER_READERS) {
    it(`${f.split("/").pop()} goes through spendSince`, () => {
      const src = readFileSync(f, "utf8");
      expect(src, "does not use the shared aggregate").toContain("spendSince(");
      expect(src, "still scans rows to sum them itself").not.toMatch(
        /from\(["']execution_traces["']\)[\s\S]{0,60}\.select\(["']cost_usd["']\)/,
      );
    });
  }

  it("treats a failed lookup as unknown, not as nothing spent", () => {
    const alert = readFileSync("src/lib/email/budgetAlertTrigger.server.ts", "utf8");
    expect(alert).toMatch(/if \(!result\.ok\)/);
    expect(alert).toMatch(/\[budget-alert\] spend lookup failed/);
  });
});

describe("the migration the aggregate needs", () => {
  const sql = readFileSync("supabase/migrations/20260780000000_budget_spend_aggregate.sql", "utf8");

  it("sums in the database rather than returning rows", () => {
    expect(sql).toMatch(/sum\(t\.cost_usd\)/);
    expect(sql).toContain("RETURNS numeric");
  });

  it("authorises the caller, since it is SECURITY DEFINER over an RLS'd table", () => {
    // Without this any signed-in user could read any other user's spend.
    expect(sql).toContain("SECURITY DEFINER");
    expect(sql).toMatch(/auth\.uid\(\) = _user_id/);
    expect(sql).toMatch(/is_superadmin|service_role/);
    expect(sql).toMatch(/RAISE EXCEPTION 'not authorized'/);
  });

  it("scopes a credential query by the credential, not by the user", () => {
    // A per-credential cap bounds what that KEY can spend, WHOEVER triggered
    // it. Narrowing by user as well would let a key shared across a team slip
    // its cap, since each member's slice stays under it.
    //
    // The branch itself is inspected. Asserting the two clauses appeared
    // within 200 characters of each other let a mutation inserting
    // `AND t.user_id = _user_id` between them pass unnoticed.
    const where = sql.slice(sql.indexOf("WHERE t.created_at"), sql.indexOf("RETURN _total"));
    const credentialBranch = where.slice(
      where.indexOf("_scope_type IS NOT NULL"),
      where.indexOf("OR (_scope_type IS NULL"),
    );
    expect(credentialBranch).toContain("cost_scope_id = _scope_id");
    expect(credentialBranch, "a credential query is narrowed by user too").not.toContain("user_id");
  });

  it("answers all three questions from one aggregate", () => {
    // credential, team, and individual. Each branch is mutually exclusive, so
    // a group query cannot accidentally be narrowed to one member.
    expect(sql).toMatch(/_scope_type IS NULL AND _user_ids IS NOT NULL AND t\.user_id = ANY/);
    expect(sql).toMatch(/_scope_type IS NULL AND _user_ids IS NULL AND t\.user_id = _user_id/);
  });

  it("does not let a member read the whole team's spend", () => {
    // The self-only branch is disabled for group queries, so summing across
    // members needs superadmin or the service role.
    expect(sql).toMatch(/_user_ids IS NULL AND auth\.uid\(\) = _user_id/);
  });

  it("indexes what it filters on", () => {
    expect(sql).toMatch(/idx_execution_traces_user_created/);
  });
});
