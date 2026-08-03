// Dashboard scope, cost attribution and the time window.
//
// The dashboard's other numbers are RLS-scoped in the browser, which is safe
// by construction. These are not: "my team" and "the whole organisation" are
// answered with the SERVICE ROLE, so the authorisation here is the only thing
// standing between a user and somebody else's spend.
//
// Two failure modes drive this file:
//   * a caller reaching a scope they are not entitled to;
//   * a caller being SILENTLY DOWNGRADED to their own numbers under someone
//     else's label — a lie the number itself cannot reveal.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  DASHBOARD_RANGES,
  DASHBOARD_SCOPES,
  RANGE_LABELS,
  SCOPE_LABELS,
  allowedScopes,
  isDashboardRange,
  isDashboardScope,
  personLabel,
  resolveRange,
} from "@/utils/dashboard/scope";

const fnSrc = readFileSync("src/utils/dashboard.functions.ts", "utf8");
const uiSrc = readFileSync("src/components/dashboard/SpendPanel.tsx", "utf8");

describe("who may ask for what", () => {
  it("always allows a person their own numbers", () => {
    expect(allowedScopes({ isSuperadmin: false, groupCount: 0 })).toEqual(["mine"]);
  });

  it("offers teams only to someone actually in one", () => {
    // Offering it to someone in no group returns their own rows under a team
    // label — the downgrade this design refuses.
    expect(allowedScopes({ isSuperadmin: false, groupCount: 0 })).not.toContain("team");
    expect(allowedScopes({ isSuperadmin: false, groupCount: 1 })).toContain("team");
  });

  it("offers the organisation only to a superadmin", () => {
    expect(allowedScopes({ isSuperadmin: false, groupCount: 5 })).not.toContain("org");
    expect(allowedScopes({ isSuperadmin: true, groupCount: 0 })).toContain("org");
  });

  it("gives a superadmin in a team all three", () => {
    expect(allowedScopes({ isSuperadmin: true, groupCount: 2 })).toEqual(["mine", "team", "org"]);
  });
});

describe("the server refuses rather than downgrades", () => {
  it("throws when the scope is not in the caller's allowed set", () => {
    // Returning "mine" data labelled "org" would be indistinguishable from a
    // correct answer for anyone whose org is small.
    expect(fnSrc).toMatch(/if \(!available\.includes\(data\.scope\)\)/);
    expect(fnSrc).toMatch(/throw new Error\(/);
  });

  it("computes the user set instead of accepting one", () => {
    // A caller-supplied list of user ids would be the whole vulnerability.
    expect(fnSrc).not.toMatch(/user_ids\s*:/);
    expect(fnSrc).not.toMatch(/z\.array\(z\.string\(\)\.uuid\(\)\)/);
    expect(fnSrc).toMatch(/let userIds: string\[\] \| undefined/);
  });

  it("resolves the caller's OWN groups, not groups they name", () => {
    const groups = fnSrc.slice(fnSrc.indexOf("async function myGroups"));
    expect(groups.slice(0, 400)).toContain('.eq("user_id", userId)');
  });

  it("checks superadmin against user_roles, not a client-supplied flag", () => {
    expect(fnSrc).toMatch(/\.eq\("role", "superadmin"\)/);
  });

  it("scopes 'mine' to exactly one user", () => {
    expect(fnSrc).toMatch(/scope === "mine"\) userIds = \[userId\]/);
  });
});

describe("the UI cannot offer what the server would refuse", () => {
  it("renders only the scopes the server returned", () => {
    expect(uiSrc).toMatch(/data\?\.available/);
    expect(uiSrc).toMatch(/available\.map\(/);
  });

  it("assumes only 'mine' before the first response", () => {
    // Optimistically showing "org" and then removing it is a flicker that
    // tells the user something about other people's permissions.
    expect(uiSrc).toMatch(/\["mine"\] as DashboardScope\[\]/);
  });
});

describe("the time window", () => {
  const now = new Date("2026-08-02T15:30:00.000Z");

  it("is half-open and in UTC", () => {
    // An inclusive upper bound double-counts a row landing exactly on the
    // boundary; a local-time boundary makes the dashboard disagree with itself
    // across a timezone change.
    expect(fnSrc).toMatch(/\.gte\("created_at", from\)/);
    expect(fnSrc).toMatch(/\.lt\("created_at", to\)/);
  });

  it("counts back the right amount for each rolling window", () => {
    expect(resolveRange("24h", now).from).toBe("2026-08-01T15:30:00.000Z");
    expect(resolveRange("7d", now).from).toBe("2026-07-26T15:30:00.000Z");
    expect(resolveRange("30d", now).from).toBe("2026-07-03T15:30:00.000Z");
    expect(resolveRange("90d", now).from).toBe("2026-05-04T15:30:00.000Z");
  });

  it("snaps the calendar windows to midnight UTC", () => {
    // "Month to date" starting at 15:30 on the 1st would silently omit that
    // morning's runs.
    expect(resolveRange("mtd", now).from).toBe("2026-08-01T00:00:00.000Z");
    expect(resolveRange("ytd", now).from).toBe("2026-01-01T00:00:00.000Z");
  });

  it("always ends at now", () => {
    for (const r of DASHBOARD_RANGES) {
      expect(resolveRange(r, now).to, `${r} does not end at now`).toBe(now.toISOString());
    }
  });

  it("never produces a window that starts after it ends", () => {
    for (const r of DASHBOARD_RANGES) {
      const { from, to } = resolveRange(r, now);
      expect(Date.parse(from), `${r} is inverted`).toBeLessThanOrEqual(Date.parse(to));
    }
  });
});

describe("cost attribution", () => {
  it("sums the same column the budget guard does", () => {
    // Two definitions of "spend" is how a dashboard and a budget alert end up
    // disagreeing about whether someone is over.
    //
    // The guard no longer names the column itself — it delegates to
    // budgetSpend.server, which prefers a database aggregate. So the check
    // follows the delegation: there is now ONE definition rather than two that
    // happen to match, which is a stronger version of the same property.
    const guard = readFileSync("src/utils/budgetGuard.server.ts", "utf8");
    const spend = readFileSync("src/utils/budgetSpend.server.ts", "utf8");
    expect(guard, "the guard defines spend for itself again").toContain("spendSince(");
    expect(spend).toContain("cost_usd");
    expect(spend).toContain("execution_traces");
    expect(fnSrc).toContain("cost_usd");
    expect(fnSrc).toContain('.from("execution_traces")');
  });

  it("says that team totals overlap rather than quietly double-counting", () => {
    // A person in two teams contributes to both, so the rows do not sum to the
    // total. That is the right answer to "what did this team cost" — but only
    // if it is stated.
    expect(fnSrc).toMatch(/contributes their spend to BOTH/i);
    expect(uiSrc).toContain("someone in two teams counts in both");
  });

  it("distinguishes 'no runs' from '0% success'", () => {
    expect(fnSrc).toMatch(/rows\.length > 0 \? \(ok \/ rows\.length\) \* 100 : null/);
    expect(uiSrc).toMatch(/successRate === null/);
  });

  it("shows no per-person breakdown for a single-person scope", () => {
    // One row of yourself is noise.
    expect(fnSrc).toMatch(/scope === "mine"\s*\?\s*\[\]/);
  });
});

describe("the scope and range vocabularies stay in step", () => {
  it("labels every scope and range", () => {
    for (const s of DASHBOARD_SCOPES) expect(SCOPE_LABELS[s], `${s} has no label`).toBeTruthy();
    for (const r of DASHBOARD_RANGES) expect(RANGE_LABELS[r], `${r} has no label`).toBeTruthy();
  });

  it("validates input against the same lists the UI renders", () => {
    expect(isDashboardScope("org")).toBe(true);
    expect(isDashboardScope("everyone")).toBe(false);
    expect(isDashboardRange("mtd")).toBe(true);
    expect(isDashboardRange("all-time")).toBe(false);
    expect(fnSrc).toMatch(/z\.enum\(DASHBOARD_SCOPES\)/);
    expect(fnSrc).toMatch(/z\.enum\(DASHBOARD_RANGES\)/);
  });
});

describe("personLabel", () => {
  // Found by looking at the running app, not by reading code: the spend
  // breakdown showed SEVEN raw UUIDs out of eight people. The label fallback
  // was working exactly as written — those ids genuinely are not in
  // auth.users, because execution traces outlive the accounts that made them.
  // The code was right and the screen was still useless.
  const ID = "3925a5c9-49c6-429f-90b3-4afa42c85eb5";

  it("uses the email when there is one", () => {
    expect(personLabel(ID, "someone@example.com")).toBe("someone@example.com");
  });

  it("says the account is gone rather than printing a bare UUID", () => {
    // A chargeback table cannot bill a UUID, and a UUID where a name belongs
    // reads as a rendering fault rather than as a fact about the data.
    expect(personLabel(ID)).toBe("Removed account · 3925a5c9");
    expect(personLabel(ID, null)).toBe("Removed account · 3925a5c9");
    expect(personLabel(ID, "")).toBe("Removed account · 3925a5c9");
    expect(personLabel(ID, "   ")).toBe("Removed account · 3925a5c9");
  });

  it("keeps removed accounts distinguishable from each other", () => {
    // Two deleted users must not collapse into one row.
    const a = personLabel("aaaaaaaa-0000-0000-0000-000000000000");
    const b = personLabel("bbbbbbbb-0000-0000-0000-000000000000");
    expect(a).not.toBe(b);
  });

  it("never leaks a full id into the label", () => {
    expect(personLabel(ID)).not.toContain(ID);
  });
});
