// The last two places that summed a month of trace rows in the browser.
//
// budgetSpend.server fixed this on every path that ENFORCES a cap. The budgets
// page and the dashboard kept doing it for DISPLAY:
//
//   .from("execution_traces").select("cost_usd").gte("created_at", monthStart)
//   → reduce(+)
//
// which fails the same three ways — a row cap yields a prefix, an error yields
// [], and a busy month pulls ~1.3M rows into a phone — except the result is
// rendered to a human as "$40 of your $100 cap" instead of refusing a call.
// A number someone reads and acts on has to be right or admit it is not.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { monthStartIso } from "@/lib/budgetSpendClient";

const CLIENT = readFileSync("src/lib/budgetSpendClient.ts", "utf8");
const BUDGETS = readFileSync("src/routes/_authenticated/budgets.tsx", "utf8");
const DASHBOARD = readFileSync("src/routes/_authenticated/dashboard.tsx", "utf8");

describe("the month boundary matches the server's", () => {
  // A client boundary an hour off the server's would render a total that
  // disagrees with the one the cap is enforced against.
  it("starts at the first instant of the current UTC month", () => {
    expect(monthStartIso(new Date("2026-03-17T13:45:00Z"))).toBe("2026-03-01T00:00:00.000Z");
  });

  it("does not slip at either edge, or in a leap February", () => {
    expect(monthStartIso(new Date("2026-03-01T00:00:00Z"))).toBe("2026-03-01T00:00:00.000Z");
    expect(monthStartIso(new Date("2026-03-31T23:59:59Z"))).toBe("2026-03-01T00:00:00.000Z");
    expect(monthStartIso(new Date("2028-02-29T12:00:00Z"))).toBe("2028-02-01T00:00:00.000Z");
    expect(monthStartIso(new Date("2026-12-31T23:59:59Z"))).toBe("2026-12-01T00:00:00.000Z");
  });
});

describe("unknown is not zero, on the display path too", () => {
  it("returns a discriminated result rather than a bare number", () => {
    expect(CLIENT).toMatch(/ok: true; spend: number/);
    expect(CLIENT).toMatch(/ok: false; error: string/);
  });

  it("reports a query error instead of returning a total", () => {
    expect(CLIENT).toMatch(/if \(error\) return \{ ok: false, error: error\.message \}/);
  });

  it("refuses a non-numeric answer rather than coercing it", () => {
    // Number(null) is 0, and 0 renders as "spent nothing".
    expect(CLIENT).toMatch(/Number\.isFinite/);
  });

  it("has no row-scan fallback", () => {
    // A fallback that sums rows would reintroduce exactly the truncation this
    // replaces, and would do it silently on the instances least able to
    // afford it — the busy ones.
    // Checked against CODE ONLY. The header comment quotes the old query
    // verbatim to explain what was replaced, so both a substring check for the
    // table name and a regex for the call shape matched the description rather
    // than a reintroduction.
    const code = CLIENT.split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");
    expect(code, "the client re-added a row scan").not.toMatch(/\.from\(\s*["']execution_traces/);
  });
});

describe("neither page sums rows in the browser any more", () => {
  for (const [name, src] of [
    ["budgets", BUDGETS],
    ["dashboard", DASHBOARD],
  ] as const) {
    it(`${name} goes through the aggregate`, () => {
      expect(src, `${name} does not use the shared helper`).toContain("mySpendSince");
      expect(src, `${name} still scans trace rows to total them`).not.toMatch(
        /from\("execution_traces"\)[\s\S]{0,80}\.select\("cost_usd"\)/,
      );
    });
  }

  it("budgets renders an unavailable figure as unavailable", () => {
    // Not as $0.00, which is the most reassuring possible way to say
    // "we could not tell".
    expect(BUDGETS).toMatch(/useState<number \| null>/);
    expect(BUDGETS).toMatch(/mtdSpend == null \? "unavailable"/);
  });

  it("dashboard hides the badge rather than showing 0% of cap", () => {
    expect(DASHBOARD).toMatch(/capUsd > 0 && spend\.ok/);
  });
});

describe("the aggregate it calls is the one the migration defines", () => {
  const sql = readFileSync("supabase/migrations/20260780000000_budget_spend_aggregate.sql", "utf8");

  it("uses the same function name and parameter names", () => {
    expect(sql).toContain("FUNCTION public.budget_spend_since");
    expect(CLIENT).toContain("budget_spend_since");
    for (const p of ["_user_id", "_since"]) {
      expect(sql, `${p} is not a parameter`).toContain(p);
      expect(CLIENT, `${p} is not passed`).toContain(p);
    }
  });

  it("is callable by a browser for its OWN total", () => {
    // SECURITY DEFINER over an RLS'd table: the self branch is what makes a
    // client call safe, and its absence would make every page call fail.
    expect(sql).toMatch(/_user_ids IS NULL AND auth\.uid\(\) = _user_id/);
  });
});
