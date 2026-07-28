// Resuming a swarm run that parked at a human-approval step.
//
// The approvals inbox records the decision; this turns that decision back into
// a running swarm. Kept separate from the inbox component so the same entry
// point works from anywhere a decision can be made.
import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Database } from "@/integrations/supabase/types";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { resumeSwarmRun } from "@/utils/swarmExecute.server";
import { resolveInternalOrigin } from "@/utils/internalOrigin.server";

type Fail = { ok: false; error: string };

/**
 * Continue the run behind an approval, using the decision already recorded on
 * it.
 *
 * The decision is read from the approvals row rather than taken as a parameter:
 * the row is what the approver actually clicked, and accepting an `approved`
 * flag from the caller would let anyone who can reach this function approve
 * anything.
 */
export const resumeApprovedSwarmRun = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ access_token: z.string().min(1), approval_id: z.string().uuid() }).parse(input),
  )
  .handler(
    async ({
      data,
    }): Promise<Fail | { ok: true; status: string; runId: string | null; output: string }> => {
      try {
        const url = process.env.SUPABASE_URL;
        const key = process.env.SUPABASE_PUBLISHABLE_KEY;
        if (!url || !key) return { ok: false, error: "Server is not configured" };
        const sb = createClient<Database>(url, key, {
          global: { headers: { Authorization: `Bearer ${data.access_token}` } },
        });
        const {
          data: { user },
        } = await sb.auth.getUser();
        if (!user) return { ok: false, error: "Not signed in" };

        // Read under the caller's JWT: RLS decides whether this approval is
        // theirs to see, so a stolen id from another tenant resolves to nothing.
        const { data: approval } = await sb
          .from("approvals")
          .select("id, status, swarm_run_id, user_id, action_title")
          .eq("id", data.approval_id)
          .maybeSingle();
        if (!approval) return { ok: false, error: "Approval not found" };
        if (!approval.swarm_run_id) {
          return { ok: false, error: "This approval is not attached to a swarm run" };
        }
        if (approval.status !== "approved" && approval.status !== "rejected") {
          return { ok: false, error: "This approval has not been decided yet" };
        }

        // The run belongs to the swarm's OWNER, who may not be the approver —
        // approving someone else's run is the normal case. Resume as the owner
        // so the run keeps its own data access, and never widen it to the
        // approver's.
        const { data: run } = await supabaseAdmin
          .from("swarm_runs")
          .select("id, user_id, status")
          .eq("id", approval.swarm_run_id)
          .maybeSingle();
        if (!run) return { ok: false, error: "Run not found" };
        if (run.status !== "suspended") {
          // Not an error worth shouting about: a second click, or a run that
          // was already resumed.
          return { ok: true, status: run.status, runId: run.id, output: "" };
        }

        const result = await resumeSwarmRun({
          runId: run.id,
          userId: run.user_id,
          origin: resolveInternalOrigin(),
          decision: { approved: approval.status === "approved" },
        });
        if (!result) return { ok: false, error: "This run can no longer be resumed" };
        return { ok: true, status: result.status, runId: result.runId, output: result.output };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : "Resume failed" };
      }
    },
  );
