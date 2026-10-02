// Somebody else has to say yes before a version serves production.
//
// Everything here is about a gate being real rather than decorative. The
// failure modes are all quiet ones: a second code path that promotes without
// asking, a self-signed approval, a client that writes "approved" into a row
// and gets a promotion out of it. Each would leave an audit trail saying a
// review happened.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const rd = (p: string) => readFileSync(p, "utf8");
const PROMOTE = rd("src/utils/ml/promote.server.ts");
const FUNCTIONS = rd("src/utils/ml.functions.ts");
const INBOX = rd("src/components/ApprovalInbox.tsx");
const PAGE = rd("src/routes/_authenticated/ml_.$modelId.tsx");
const GATE = rd("src/components/ml/PromotionGate.tsx");
const MIGRATION = rd("supabase/migrations/20260905000000_ml_promotion_approval.sql");

describe("there is one implementation of promote", () => {
  it("moves a version in exactly one place", () => {
    // A gate guards a door. A second door is how it ends up guarding nothing.
    expect(PROMOTE).toContain("export async function applyPromotion");
    const writes = [...FUNCTIONS.matchAll(/\.from\("ml_model_versions"\)\s*\.update\(\{\s*stage/g)];
    expect(
      writes.length,
      "ml.functions must not set a version's stage itself — applyPromotion does",
    ).toBe(0);
    const prodWrites = [...FUNCTIONS.matchAll(/\.update\(\{ production_version_id/g)];
    expect(prodWrites.length, "only applyPromotion may move production_version_id").toBe(0);
  });

  it("is what both paths call", () => {
    expect(FUNCTIONS).toMatch(/return await applyPromotion\(model, version, data\.stage, userId\)/);
    expect(PROMOTE).toMatch(/return await applyPromotion\(\s*model,\s*version,\s*"production"/s);
  });
});

describe("the requester is never the approver", () => {
  it("is filtered out when the request is raised", () => {
    expect(PROMOTE).toMatch(
      /const approvers = \(model\.promotion_approvers \?\? \[\]\)\.filter\(\(a\) => a !== requestedBy\)/,
    );
    // And naming nobody else is refused rather than silently ungated.
    const at = PROMOTE.indexOf("if (!approvers.length)");
    expect(PROMOTE.slice(at, at + 400)).toMatch(/nobody may approve their own/i);
  });

  it("is checked AGAIN when the approval is applied", () => {
    // Belt to the braces: reaching that line means the row was edited.
    const at = PROMOTE.indexOf("export async function applyApprovedPromotion");
    const body = PROMOTE.slice(at);
    expect(body).toMatch(/payload\.requested_by === callerId/);
    expect(body).toMatch(/cannot approve it/);
  });

  it("is refused at configuration time too", () => {
    const at = FUNCTIONS.indexOf("mlSetPromotionApprovers");
    const body = FUNCTIONS.slice(at, at + 2000);
    expect(body).toMatch(/const others = ids\.filter\(\(id\) => id !== userId\)/);
    expect(body).toMatch(/Name somebody other than yourself/);
    // And the panel says so before you type.
    expect(GATE).toMatch(/nobody may approve their own promotion/i);
  });
});

describe("the server decides, not the client", () => {
  it("re-checks every condition when applying", () => {
    const at = PROMOTE.indexOf("export async function applyApprovedPromotion");
    const body = PROMOTE.slice(at);
    for (const check of [
      /action_type !== ML_PROMOTE_ACTION/,
      /approval\.status !== "approved"/,
      /approver_user_ids \?\? \[\]\)\.includes\(callerId\)/,
    ]) {
      expect(body, String(check)).toMatch(check);
    }
  });

  it("is what the inbox calls after recording a decision", () => {
    expect(INBOX).toContain("mlApplyApprovedPromotion");
    const at = INBOX.indexOf('isPromotion && status === "approved"');
    expect(at, "the inbox dispatches an approved promotion").toBeGreaterThan(-1);
    // A decision that saves but does not promote must say so rather than
    // looking like it worked.
    expect(INBOX.slice(at, at + 700)).toMatch(/the version was not promoted/);
  });
});

describe("what is gated, and what is not", () => {
  it("gates production only", () => {
    // Staging and archiving change nothing a customer meets.
    expect(PROMOTE).toMatch(
      /return stage === "production" && \(model\.promotion_approvers \?\? \[\]\)\.length > 0/,
    );
  });

  it("is off unless somebody turns it on", () => {
    expect(MIGRATION).toMatch(/NULL or empty means promotion is ungated/);
  });

  it("raises one request per version, not one per press", () => {
    const at = PROMOTE.indexOf("export async function requestPromotion");
    const body = PROMOTE.slice(at, PROMOTE.indexOf("export async function applyApprovedPromotion"));
    expect(body).toMatch(/\.eq\("status", "pending"\)/);
    expect(body).toMatch(/contains\("payload", \{ version_id: version\.id \}\)/);
  });
});

describe("it reuses the approvals everybody already has", () => {
  it("writes to public.approvals rather than a second table", () => {
    expect(PROMOTE).toMatch(/\.from\("approvals"\)/);
    expect(MIGRATION).toMatch(/NO SECOND APPROVALS SYSTEM/);
    // The migration adds a column, not an inbox.
    expect(MIGRATION).not.toMatch(/CREATE TABLE/i);
  });

  it("does not describe a promotion as an agent resuming", () => {
    // The inbox is shared, so its copy has to be true for both kinds.
    const at = INBOX.indexOf("const isPromotion");
    expect(at).toBeGreaterThan(-1);
    expect(INBOX.slice(at, at + 800)).toMatch(/is going into production/);
  });
});

describe("the button says what it will do", () => {
  it("asks for approval rather than promising an immediate switch", () => {
    // The confirm dialog is where a gate is first visible. Saying "switch to
    // it immediately" and then raising a request is a lie told at the exact
    // moment somebody is deciding whether to press.
    expect(PAGE).toMatch(/Ask for v\$\{v\.version\} to go into production\?/);
    expect(PAGE).toMatch(/until an approver agrees/);
    expect(PAGE).toMatch(/gated \? "Ask for approval" : "Promote"/);
  });

  it("tells the truth afterwards too", () => {
    expect(PAGE).toMatch(/r\.pending/);
    expect(PAGE).toMatch(/goes into production when an approver agrees, and not before/);
  });
});

describe("the record", () => {
  it("names both the person who asked and the person who agreed", () => {
    expect(PROMOTE).toMatch(/approved_by: decidedBy \?\? null/);
    expect(PROMOTE).toMatch(/gated: Boolean\(decidedBy\)/);
    expect(PROMOTE).toMatch(/action: "ml\.version\.promote\.requested"/);
  });

  it("audits turning the gate on and off", () => {
    expect(FUNCTIONS).toMatch(/ml\.promotion\.gate\.on/);
    expect(FUNCTIONS).toMatch(/ml\.promotion\.gate\.off/);
  });
});
