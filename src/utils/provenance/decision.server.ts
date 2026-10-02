// A decision is the top-level thing a person asks "where did this come from?"
// about: one chat turn, one swarm run, one dashboard refresh.
//
// Its id is the correlation key. Every execution_traces row and every
// audit_events row written while the decision is underway carries it, so the
// full chain -- model call, tools invoked, data read (down to the table), cost,
// approvals -- can be assembled with two indexed queries instead of guessed at
// from timestamps.
//
// The decision row itself records the one fact that cannot be reconstructed
// afterwards: which lakehouse snapshot was current when it began. The catalog
// can be re-attached pinned to that snapshot, so that integer is the difference
// between an answer that is merely recorded and one that is reproducible.
import { randomUUID } from "node:crypto";

import type { Json } from "@/integrations/supabase/types";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

import { isDataRead } from "./actions";

export { isDataRead };
import { lakehouseEnabled, lakehouseSnapshotId } from "@/utils/lakehouse/core.server";

export type DecisionKind =
  | "chat_turn"
  | "swarm_run"
  | "dashboard_refresh"
  | "ml_training"
  | "ml_prediction";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Mint (or adopt) a decision id and record its starting state.
 *
 * Callers that already have a natural uuid -- a chat turn's trace id, a swarm
 * run's id -- pass it so the decision IS that thing rather than a second id
 * beside it. A dashboard refresh has no such id and gets a fresh one.
 *
 * Never throws and never blocks: the insert is fire-and-forget, like
 * auditEvent, because a provenance failure must not fail the answer it is
 * describing. Returns the id synchronously so callers can stamp it at once.
 */
export function beginDecision(args: {
  userId: string;
  kind: DecisionKind;
  /** Reuse a domain id as the decision id when it is a uuid. */
  id?: string | null;
  rootRef?: string | null;
}): string {
  const id = args.id && UUID_RE.test(args.id) ? args.id : randomUUID();
  void (async () => {
    try {
      // TWO PHASES, deliberately. The row is written first, without the
      // snapshot, so provenance exists the moment the answer does. Reading the
      // lakehouse snapshot costs ~2s on a cold engine (26ms warm), and a
      // provenance row that appears seconds after the answer is a row that is
      // not there when someone opens the trace to look at it.
      //
      // Cast: the generated types are rebuilt from a pushed schema, and this
      // table ships in 20260848000000.
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const { error } = await (supabaseAdmin.from("decisions" as never) as any).insert({
        id,
        user_id: args.userId,
        kind: args.kind,
        root_ref: args.rootRef ?? args.id ?? null,
        lakehouse_snapshot_id: null,
      } as never);
      if (error) {
        console.warn("[decision] insert failed:", error.message);
        return;
      }
      // Then upgrade it to reproducible, if the lakehouse can say which
      // snapshot this answer saw. Failing here leaves the row NULL, which the
      // passport renders honestly as "recorded, not reproducible".
      if (!lakehouseEnabled()) return;
      const snapshot = await lakehouseSnapshotId();
      if (!snapshot) return;
      await (supabaseAdmin.from("decisions" as never) as any)
        .update({ lakehouse_snapshot_id: snapshot } as never)
        .eq("id", id);
      /* eslint-enable @typescript-eslint/no-explicit-any */
    } catch (e) {
      // Provenance must never fail the answer it describes, nor reject into a
      // caller that deliberately did not await it.
      console.warn("[decision] skipped:", (e as Error).message);
    }
  })();
  return id;
}

export type DecisionRecord = {
  id: string;
  user_id: string;
  kind: DecisionKind;
  root_ref: string | null;
  lakehouse_snapshot_id: string | null;
  created_at: string;
};

export type DecisionTrace = {
  id: string;
  agent_name: string;
  llm_provider: string;
  llm_model: string;
  status: string;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  latency_ms: number;
  prompt: string | null;
  tool_calls: Json;
  created_at: string;
};

export type DecisionEvent = {
  id: string;
  action: string;
  resource_type: string | null;
  resource_name: string | null;
  detail: Json;
  created_at: string;
};

export type DecisionChain = {
  decision: DecisionRecord;
  traces: DecisionTrace[];
  events: DecisionEvent[];
  /** Whether the lakehouse state this answer saw can be re-queried. */
  reproducible: boolean;
};

/**
 * Assemble everything one decision touched, for its owner.
 *
 * Ownership is checked on the decision row; traces and events are then read by
 * key. Both are owner-scoped tables already, so a decision id from another
 * tenant yields nothing rather than something.
 */
export async function getDecisionChain(
  userId: string,
  decisionId: string,
): Promise<DecisionChain | null> {
  if (!UUID_RE.test(decisionId)) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: decision } = await (supabaseAdmin.from("decisions" as never) as any)
    .select("*")
    .eq("id", decisionId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!decision) return null;

  // decision_id is likewise newer than the generated types; the chains are
  // cast once at the root rather than at every filter.
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const [{ data: traces }, { data: events }] = await Promise.all([
    (supabaseAdmin.from("execution_traces") as any)
      .select(
        "id, agent_name, llm_provider, llm_model, status, tokens_in, tokens_out, cost_usd, latency_ms, prompt, tool_calls, created_at",
      )
      .eq("decision_id", decisionId)
      .eq("user_id", userId)
      .order("created_at", { ascending: true }),
    (supabaseAdmin.from("audit_events") as any)
      .select("id, action, resource_type, resource_name, detail, created_at")
      .eq("decision_id", decisionId)
      .eq("user_id", userId)
      .order("created_at", { ascending: true }),
  ]);
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const rec = decision as DecisionRecord;
  return {
    decision: rec,
    traces: (traces ?? []) as unknown as DecisionTrace[],
    events: (events ?? []) as unknown as DecisionEvent[],
    reproducible:
      rec.lakehouse_snapshot_id !== null && !rec.lakehouse_snapshot_id.startsWith("nosnap"),
  };
}
