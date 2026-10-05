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
import { callerFailure } from "@/utils/callerLookup.server";

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
          error: authError,
        } = await sb.auth.getUser();
        if (!user) return { ok: false, error: callerFailure(authError, "Not signed in") };

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
        if (run.status === "success" || run.status === "error") {
          // Not an error worth shouting about: a second click, or a run that
          // was already resumed.
          return { ok: true, status: run.status, runId: run.id, output: "" };
        }
        // FOUND IN R179. A cancelled run is over: a decision that arrives
        // after the cancel is recorded, and must not bring the run back.
        if (run.status === "cancelled") {
          return {
            ok: false,
            error: "This run was cancelled. The decision is recorded; the run does not resume.",
          };
        }
        // FOUND FROM THE SURVEY (R90). This used to require the word
        // "suspended", which is written by a stamp that could fail: a run
        // whose stamp did not land read as "already resumed", the decision
        // was swallowed, and the work stayed parked for ever under a cheerful
        // ok. The CHECKPOINT is what a resume actually needs, so that is what
        // decides — and a run with none really was resumed already.
        const { loadCheckpoint } = await import("@/utils/swarmCheckpoint.server");
        if (!(await loadCheckpoint(run.id, run.user_id))) {
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

/**
 * End a run parked at an approval step, as its owner (R179).
 *
 * FOUND IN R179. A parked run could end only by a decision on its approval:
 * approving runs the rest of it, and rejecting ends it as an error, recorded
 * as a rejection of content nobody reviewed. A scheduled swarm with an
 * approval node parked a run each time it fired, each waiting for someone,
 * and nothing on Recent runs could simply stop one. Cancelling ends the run (only if it
 * is still parked, so a resume that got there first wins), removes its
 * checkpoint, and closes its pending approvals, so nobody is asked to decide
 * a run that is over.
 */
export const cancelParkedSwarmRun = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ access_token: z.string().min(1), run_id: z.string().uuid() }).parse(input),
  )
  .handler(
    async ({ data }): Promise<Fail | { ok: true; closedApprovals: number; note?: string }> => {
      try {
        const url = process.env.SUPABASE_URL;
        const key = process.env.SUPABASE_PUBLISHABLE_KEY;
        if (!url || !key) return { ok: false, error: "Server is not configured" };
        const sb = createClient<Database>(url, key, {
          global: { headers: { Authorization: `Bearer ${data.access_token}` } },
        });
        const {
          data: { user },
          error: authError,
        } = await sb.auth.getUser();
        if (!user) return { ok: false, error: callerFailure(authError, "Not signed in") };

        // Read under the caller's JWT: RLS decides whether the run is theirs.
        const { data: run, error: readErr } = await sb
          .from("swarm_runs")
          .select("id, user_id, status, swarm_name")
          .eq("id", data.run_id)
          .maybeSingle();
        if (readErr) return { ok: false, error: `The run could not be read: ${readErr.message}` };
        if (!run) return { ok: false, error: "Run not found" };
        if (run.status !== "suspended") {
          return { ok: false, error: `This run is ${run.status}, not parked at an approval` };
        }

        const now = new Date().toISOString();
        const { data: ended, error: endErr } = await supabaseAdmin
          .from("swarm_runs")
          .update({ status: "cancelled", finished_at: now, cancel_requested: true })
          .eq("id", run.id)
          .eq("status", "suspended")
          .select("id");
        if (endErr)
          return { ok: false, error: `The run could not be cancelled: ${endErr.message}` };
        if (!ended?.length) {
          return {
            ok: false,
            error: "The run moved on before it could be cancelled; refresh to see it",
          };
        }

        const { clearCheckpoint } = await import("@/utils/swarmCheckpoint.server");
        await clearCheckpoint(run.id);
        const { data: closed, error: closeErr } = await supabaseAdmin
          .from("approvals")
          .update({ status: "cancelled", decided_at: now, decided_by: user.id })
          .eq("swarm_run_id", run.id)
          .eq("status", "pending")
          .select("id");
        const { auditEvent } = await import("@/utils/audit.server");
        auditEvent({
          userId: user.id,
          action: "swarm_run.cancel",
          resourceType: "swarm_run",
          resourceId: run.id,
          resourceName: run.swarm_name ?? undefined,
          detail: { parked: true, closed_approvals: closed?.length ?? 0 },
        });
        return {
          ok: true,
          closedApprovals: closed?.length ?? 0,
          ...(closeErr
            ? {
                note: `The run is cancelled, but its approval could not be closed (${closeErr.message}); deciding it will not resume the run.`,
              }
            : {}),
        };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : "Cancel failed" };
      }
    },
  );
