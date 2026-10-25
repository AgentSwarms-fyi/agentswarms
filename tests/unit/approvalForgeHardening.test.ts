// An approval cannot be forged, nor acted on past its routing
// (VA-2026-10-25-04 and -07, security assessment 2026-10-25).
//
// The approvals table let a client write any row where user_id = auth.uid(),
// including an already-"approved" one naming someone else's model or parked
// swarm run. applyApprovedPromotion trusted the row's own approver list, and
// resumeApprovedSwarmRun trusted that the row was approved. Two controls close
// it: model promotions re-authorize against the MODEL's configured approvers
// and check the version belongs to the model (here, behaviourally); and the
// migration lets a client create only a pending approval for a run it owns and
// makes an approval's routing immutable (pinned from its text).
import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

// A per-table row the mocked service-role client returns for `.maybeSingle()`.
const rows = vi.hoisted(() => ({
  approvals: null as Record<string, unknown> | null,
  ml_models: null as Record<string, unknown> | null,
  ml_model_versions: null as Record<string, unknown> | null,
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: keyof typeof rows) => {
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "update", "insert"]) b[m] = () => b;
      b.maybeSingle = () => Promise.resolve({ data: rows[table], error: null });
      return b;
    },
  },
}));
vi.mock("@/utils/audit.server", () => ({ auditEvent: () => {} }));
vi.mock("@/utils/notify.server", () => ({ notifyUser: () => {} }));

const { applyApprovedPromotion } = await import("@/utils/ml/promote.server");

const VICTIM_MODEL = "11111111-1111-1111-1111-111111111111";
const ATTACKER = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const OWNER_APPROVER = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const REQUESTER = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const VERSION = "22222222-2222-2222-2222-222222222222";

beforeEach(() => {
  // A forged, already-"approved" promotion naming the victim's model, with the
  // attacker listed as the approver on the row.
  rows.approvals = {
    id: "33333333-3333-3333-3333-333333333333",
    action_type: "ml.promote",
    status: "approved",
    user_id: ATTACKER,
    approver_user_ids: [ATTACKER],
    payload: { model_id: VICTIM_MODEL, version_id: VERSION, requested_by: REQUESTER },
  };
  // The victim's model: its real approvers do not include the attacker.
  rows.ml_models = {
    id: VICTIM_MODEL,
    user_id: "dddddddd-dddd-dddd-dddd-dddddddddddd",
    promotion_approvers: [OWNER_APPROVER, REQUESTER],
  };
  // A version that really belongs to the victim's model.
  rows.ml_model_versions = { id: VERSION, model_id: VICTIM_MODEL, status: "ready", version: 7 };
});

describe("applyApprovedPromotion authorizes against the model, not the row", () => {
  it("refuses a caller who is not one of the model's configured approvers", async () => {
    const res = await applyApprovedPromotion(rows.approvals!.id as string, ATTACKER);
    expect(res).toEqual({ ok: false, error: "You are not a named approver for this model" });
  });

  it("refuses the person who asked, even if they are a configured approver", async () => {
    const res = await applyApprovedPromotion(rows.approvals!.id as string, REQUESTER);
    expect(res).toEqual({
      ok: false,
      error: "The person who asked for a promotion cannot approve it",
    });
  });

  it("refuses a version that belongs to another model", async () => {
    rows.ml_model_versions = {
      id: VERSION,
      model_id: "99999999-9999-9999-9999-999999999999",
      status: "ready",
      version: 7,
    };
    const res = await applyApprovedPromotion(rows.approvals!.id as string, OWNER_APPROVER);
    expect(res).toEqual({ ok: false, error: "That version does not belong to that model" });
  });

  it("does not read the row's own approver list to authorize", () => {
    const src = readFileSync("src/utils/ml/promote.server.ts", "utf8");
    const body = src.slice(src.indexOf("export async function applyApprovedPromotion"));
    expect(body).toContain("(model.promotion_approvers ?? []).includes(callerId)");
    expect(body).toContain("version.model_id !== model.id");
    expect(body).not.toContain("approval.approver_user_ids ?? []).includes(callerId)");
  });
});

describe("the approvals migration", () => {
  const SQL = readFileSync(
    "supabase/migrations/20261026000000_approval_forge_hardening.sql",
    "utf8",
  );

  it("drops the blanket FOR ALL policy", () => {
    expect(SQL).toContain(
      'DROP POLICY IF EXISTS "Users manage own approvals" ON public.approvals;',
    );
  });

  it("lets a client create only a pending approval for a run it owns", () => {
    const flat = SQL.replace(/\s+/g, " ");
    expect(flat).toContain(
      "CREATE POLICY \"Owners create pending approvals for their own runs\" ON public.approvals FOR INSERT WITH CHECK ( auth.uid() = user_id AND status = 'pending'",
    );
    expect(flat).toContain(
      "swarm_run_id IS NULL OR EXISTS ( SELECT 1 FROM public.swarm_runs r WHERE r.id = approvals.swarm_run_id AND r.user_id = auth.uid() )",
    );
  });

  it("lets the owner decide only an un-routed gate", () => {
    const flat = SQL.replace(/\s+/g, " ");
    expect(flat).toContain(
      'CREATE POLICY "Owners decide their own un-routed approvals" ON public.approvals FOR UPDATE',
    );
    expect(flat).toContain(
      "cardinality(approver_user_ids) = 0 AND cardinality(approver_group_ids) = 0",
    );
  });

  it("makes an approval's identity and routing immutable", () => {
    for (const col of [
      "user_id",
      "action_type",
      "agent_id",
      "swarm_run_id",
      "approver_user_ids",
      "approver_group_ids",
      "payload",
    ]) {
      expect(SQL).toContain(`NEW.${col} IS DISTINCT FROM OLD.${col}`);
    }
    expect(SQL).toMatch(
      /CREATE TRIGGER approvals_structural_immutable\s*BEFORE UPDATE ON public\.approvals/,
    );
  });

  it("proves itself on apply", () => {
    expect(SQL).toContain("the blanket FOR ALL policy is still present");
    expect(SQL).toContain("the pending-only INSERT policy is missing");
    expect(SQL).toContain("the immutability trigger is missing");
  });
});
