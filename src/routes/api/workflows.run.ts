// POST /api/workflows/run — start a workflow from somebody else's system.
//
// The point of an orchestrator having an API is that the trigger is often not
// a clock: a deploy finished, a vendor's file landed, a human clicked something
// in a tool you do not own. This is that door, and it is the ETL pipeline's
// trigger door with the nouns changed — deliberately, so an operator who has
// wired one into their CI finds the second one identical.
//
// Authorization: Bearer wfk_…
// Body: { workflow_id: "<uuid>", params?: { "day": "2026-01-01" } }
// → 202 { accepted: true, run_id }
import { createFileRoute } from "@tanstack/react-router";
import { createHash, timingSafeEqual } from "node:crypto";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { auditEvent } from "@/utils/audit.server";
import { envInt, rateLimitedGlobal } from "@/utils/rateLimit.server";

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/**
 * Constant-time compare of two fixed-length hex digests.
 *
 * Both sides are the output of SHA-256, so the lengths always match and the
 * comparison never leaks a prefix through timing.
 */
function hashMatches(presented: string, storedHash: string): boolean {
  const a = Buffer.from(createHash("sha256").update(presented).digest("hex"));
  const b = Buffer.from(storedHash);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const Route = createFileRoute("/api/workflows/run")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = request.headers.get("authorization") ?? "";
        if (!auth.startsWith("Bearer ")) return json({ error: "Missing bearer token" }, 401);
        const token = auth.slice("Bearer ".length).trim();
        if (!token.startsWith("wfk_")) return json({ error: "Not a workflow trigger token" }, 401);

        let body: { workflow_id?: unknown; params?: unknown };
        try {
          body = (await request.json()) as typeof body;
        } catch {
          return json({ error: "Body must be JSON" }, 400);
        }
        const id = typeof body.workflow_id === "string" ? body.workflow_id : "";
        if (!id) return json({ error: "workflow_id is required" }, 400);

        const { data: workflow } = await supabaseAdmin
          .from("workflows")
          .select("*")
          .eq("id", id)
          .maybeSingle();

        // ONE undifferentiated answer for "no such workflow", "no token
        // minted" and "wrong token", so a caller holding a valid token for
        // workflow A cannot enumerate the ids of workflows B and C.
        if (
          !workflow ||
          !workflow.trigger_token_hash ||
          !hashMatches(token, workflow.trigger_token_hash)
        ) {
          // A bad token presented against a workflow that EXISTS is a security
          // signal its owner should see, so it is audited to them — the same
          // class of event as an embed or swarm API key denial. The presented
          // token is never recorded, only that one was refused. Nothing is
          // written when the workflow does not exist: there is no owner to
          // tell, and the caller learns nothing either way because the answer
          // is the same undifferentiated 404. `auditEvent` does not await, so
          // the refusal path stays the same length whichever branch it took.
          if (workflow) {
            auditEvent({
              userId: String(workflow.user_id),
              action: "workflow.trigger.denied",
              resourceType: "workflow",
              resourceId: String(workflow.id),
              resourceName: String(workflow.name),
              detail: { reason: workflow.trigger_token_hash ? "wrong token" : "no token minted" },
            });
          }
          return json({ error: "Not found" }, 404);
        }
        if (!workflow.is_active) return json({ error: "This workflow is paused" }, 409);

        const perMin = envInt("WORKFLOW_TRIGGER_PER_MIN", 6);
        // Global rather than per process, so the documented ceiling holds
        // however many replicas are behind the load balancer.
        if (!(await rateLimitedGlobal(`wfrun:${id}`, perMin))) {
          return json({ error: "Too many triggers for this workflow" }, 429);
        }

        const params: Record<string, string> = {};
        if (body.params && typeof body.params === "object") {
          for (const [k, v] of Object.entries(body.params as Record<string, unknown>)) {
            if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
              params[k] = String(v);
            }
          }
        }

        const { startWorkflowRun } = await import("@/utils/workflows/run.server");
        const res = await startWorkflowRun(
          workflow as unknown as import("@/utils/workflows/run.server").WorkflowRow,
          "api",
          { params },
        );
        if (!res.ok) return json({ error: res.error }, 409);
        return json({ accepted: true, run_id: res.runId }, 202);
      },
    },
  },
});
