// Team budget alerts — auditing the thing I just built.
//
// Group caps were ENFORCEABLE BUT SILENT. budget_limits carried a cap and an
// on/off flag and nothing else, so a team went from 0% to blocked with nobody
// told, while the personal path had warned at 50/75/90 since the beginning.
// Enforcement and the admin UI already existed; only the warning did not.
//
// The properties below are the ones that decide whether an alert is trustworthy
// rather than merely present.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const TRIGGER = readFileSync("src/lib/email/budgetAlertTrigger.server.ts", "utf8");
const MIGRATION = readFileSync(
  "supabase/migrations/20260782000000_group_budget_alerts.sql",
  "utf8",
);
const FN = TRIGGER.slice(TRIGGER.indexOf("export async function checkAndNotifyGroupBudgets"));

describe("an alert fires once, not on every call", () => {
  it("carries the same per-period dedupe columns the personal path uses", () => {
    // This runs after EVERY traced call. Without per-period state, crossing
    // 50% would email on call 1, call 2 and call 900.
    for (const col of [
      "alert_thresholds",
      "notified_thresholds",
      "notified_period",
      "cap_exceeded_notified_period",
    ]) {
      expect(MIGRATION, `${col} missing`).toContain(col);
    }
  });

  it("treats a rolled month as an empty set rather than clearing it on a schedule", () => {
    // Comparing the stored period to today's means no job has to run for the
    // new month to start clean.
    expect(FN).toMatch(/limit\.notified_period === period/);
    expect(FN).toMatch(/samePeriod\s*\?/);
  });

  it("tracks 'exceeded' separately from the thresholds", () => {
    // Crossing 90% and hitting 100% are different messages; sharing one flag
    // would let the first suppress the second.
    expect(FN).toMatch(/cap_exceeded_notified_period === period/);
    expect(FN).toMatch(/fireExceeded/);
  });

  it("records the send AFTER sending", () => {
    // Marking first loses the alert entirely when the send fails. A duplicate
    // email is a smaller harm than a missing one.
    const send = FN.indexOf("enqueueBudgetEmail");
    const record = FN.indexOf('from("budget_limits").update');
    expect(send).toBeGreaterThan(-1);
    expect(record, "the update moved").toBeGreaterThan(-1);
    expect(send, "state is recorded before the email is sent").toBeLessThan(record);
  });
});

describe("the figure it alerts on is the team's, and is trusted only when known", () => {
  it("sums across every member, not just the caller", () => {
    // A TEAM cap is a sum across the team. Alerting on one member's spend
    // would fire late or never.
    expect(FN).toMatch(/from\("iam_group_members"\)[\s\S]{0,120}eq\("group_id"/);
    expect(FN).toMatch(/userIds: memberIds/);
  });

  it("does not treat an unknown spend as zero", () => {
    // spendSince returns a discriminated result precisely so a failed lookup
    // is distinguishable from a quiet month. Reading it as 0 would silence the
    // alert exactly when the query is slow because the month was busy.
    expect(FN).toMatch(/if \(!result\.ok\)/);
    expect(FN).toMatch(/group spend lookup failed/);
    // Line-based, because slicing to the first "}" lands inside the template
    // literal `${limit.scope_id}` in the warn call and cuts the branch in half
    // — the block then "does not contain continue" for a reason that has
    // nothing to do with the code.
    const lines = FN.split("\n");
    const start = lines.findIndex((l) => l.includes("if (!result.ok)"));
    expect(start).toBeGreaterThan(-1);
    const indent = lines[start].match(/^\s*/)![0];
    const end = lines.findIndex((l, i) => i > start && l === `${indent}}`);
    const branch = lines.slice(start, end + 1).join("\n");
    expect(branch, "a failed lookup still sends").toContain("continue");
    expect(branch, "a failed lookup is treated as spend").not.toMatch(/result\.spend/);
  });

  it("only looks at groups the caller belongs to", () => {
    // A call cannot move another team's spend, so scanning every group on
    // every traced call is work that cannot change an answer.
    expect(FN).toMatch(/in\("scope_id", groupIds\)/);
  });
});

describe("alerts are opt-in and independent of enforcement", () => {
  it("defaults to off in the schema", () => {
    // Enabling alerts is a choice. Nobody should start receiving email
    // because they applied a migration.
    expect(MIGRATION).toMatch(/alerts_enabled boolean NOT NULL DEFAULT false/);
  });

  it("checks both the enforcement flag and the alert flag", () => {
    // They are separate on purpose: watch first, enforce later is the only
    // safe way to introduce a cap.
    expect(FN).toMatch(/!limit\.is_active \|\| !limit\.alerts_enabled/);
  });

  it("rejects nonsense thresholds at the database", () => {
    // 0 fires on the first call of the month; 120 can never fire. Both are
    // configuration mistakes better refused than debugged.
    expect(MIGRATION).toContain("budget_limits_alert_thresholds_range");
    expect(MIGRATION).toMatch(/CHECK \(/);
  });

  it("ignores a threshold outside 0–100 at runtime too", () => {
    // The constraint only guards new writes; rows written before it exist.
    expect(FN).toMatch(/t > 0 && t < 100/);
  });
});

describe("the email says whose budget it is", () => {
  it("passes the group name through as a scope label", () => {
    // The recipient is an admin who has not spent anything — their team has.
    // Personal wording would name the wrong owner.
    expect(FN).toMatch(/scopeLabel: groupName/);
    const tpl = readFileSync("src/lib/email-templates/budget-alert.tsx", "utf8");
    expect(tpl).toMatch(/scopeLabel\?: string/);
    expect(tpl, "the template still says 'your budget' for a team").toMatch(
      /scopeLabel\s*\?[\s\S]{0,200}has used/,
    );
  });

  it("links an admin to the page that owns the cap", () => {
    // A group cap lives under Admin → IAM → Budgets, not the personal
    // /budgets page.
    const tpl = readFileSync("src/lib/email-templates/budget-alert.tsx", "utf8");
    expect(tpl).toMatch(/scopeLabel \? `\$\{siteUrl\}\/admin\/iam`/);
  });

  it("goes to people who can actually raise the cap", () => {
    // Superadmins set group caps. Mailing every member would also publish the
    // team's total spend to the whole team, which is a disclosure nobody
    // chose — see the note in the trigger.
    expect(FN).toMatch(/superadminRecipients/);
    expect(TRIGGER).toMatch(/eq\("role", "superadmin"\)/);
  });
});

describe("it is wired to every path that records spend", () => {
  it("fires from BOTH call sites", () => {
    // There are two, and wiring only one is precisely the mistake made when
    // the fail-open spend bug was fixed in budgetGuard and left in the alert
    // path. Listing them keeps the next addition honest.
    for (const f of [
      "src/utils/observability/recordGatewayUsage.server.ts",
      "src/routes/api/chat.ts",
    ]) {
      const src = readFileSync(f, "utf8");
      expect(src, `${f} does not fire group alerts`).toContain("checkAndNotifyGroupBudgets");
      expect(src, `${f} still fires only the personal alert`).toContain("checkAndNotifyBudget");
    }
  });

  it("cannot break the call that triggered it", () => {
    // Fire-and-forget on the hot path: an alert failure must never surface as
    // a failed model call.
    expect(FN).toMatch(/try \{/);
    expect(FN).toMatch(/catch \(e\)/);
    expect(FN).toMatch(/checkAndNotifyGroupBudgets\] failed/);
    for (const f of [
      "src/utils/observability/recordGatewayUsage.server.ts",
      "src/routes/api/chat.ts",
    ]) {
      expect(readFileSync(f, "utf8")).toMatch(/void checkAndNotifyGroupBudgets\(/);
    }
  });
});

describe("nothing in the email reads as the admin's own spend", () => {
  const TPL = readFileSync("src/lib/email-templates/budget-alert.tsx", "utf8");

  it("names the team in the SUBJECT", () => {
    // The first thing the reader sees. "You've used 90% of your budget" about
    // a group they are not even in sends them to the wrong page.
    const subject = TPL.slice(TPL.indexOf("subject:"), TPL.indexOf("displayName:"));
    expect(subject, "the subject is still personal for a group alert").toMatch(/scopeLabel/);
    expect(subject).toMatch(/has used \$\{pct\}% of its/);
  });

  it("explains why an admin received it", () => {
    expect(TPL).toMatch(/getting this as an administrator/);
  });

  it("still reads personally when there is no scope", () => {
    // The personal path is the common one and must not regress into
    // third-person wording.
    expect(TPL).toMatch(/You've used \$\{pct\}% of your/);
    expect(TPL).toMatch(/spend alerts are enabled on your account/);
  });
});
