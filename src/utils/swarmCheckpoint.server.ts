// Persistence for swarm run checkpoints. The shape and the (de)serialisation
// live in src/lib/swarmCheckpoint.ts; this is only the database half.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { fromRow, toRow, type CheckpointRow, type SwarmCheckpoint } from "@/lib/swarmCheckpoint";
import { openCheckpoint, sealCheckpoint } from "@/utils/observability/sealedRuns.server";

/**
 * Write the run's position. Overwrites in place — the checkpoint is where the
 * run is now; swarm_run_steps is the history.
 *
 * Failure is logged and swallowed. A run that is working must not die because
 * the checkpoint table is unavailable; the cost is that this particular run
 * falls back to being non-resumable, which is exactly where we were before.
 * The same goes for its owner's key: the flow state is sealed under it (R449),
 * and a state that cannot be sealed is not written rather than kept in the clear.
 */
export async function saveCheckpoint(args: {
  runId: string;
  userId: string;
  checkpoint: SwarmCheckpoint;
  source: string;
  depth: number;
}): Promise<void> {
  try {
    const row = await sealCheckpoint(args.userId, args.runId, toRow(args.checkpoint));
    const { error } = await supabaseAdmin.from("swarm_run_checkpoints").upsert(
      {
        run_id: args.runId,
        user_id: args.userId,
        source: args.source,
        depth: args.depth,
        ...row,
        suspended_at: args.checkpoint.suspendedNodeId ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
      } as never,
      { onConflict: "run_id" },
    );
    if (error) console.warn("[swarmCheckpoint] save failed:", error.message);
  } catch (e) {
    console.warn("[swarmCheckpoint] save threw:", (e as Error).message);
  }
}

/**
 * Load a run's checkpoint, scoped to its owner. Null when there isn't one, or it
 * could not be read. Throws when it is there and cannot be opened (its key is
 * gone): that is not "nothing to resume", which reads as already resumed.
 */
export async function loadCheckpoint(
  runId: string,
  userId: string,
): Promise<SwarmCheckpoint | null> {
  let stored: CheckpointRow | null;
  try {
    const { data } = await supabaseAdmin
      .from("swarm_run_checkpoints")
      .select(
        "ctx, last_output, completed_node_ids, skipped_node_ids, dead_edge_ids, level_index, suspended_node_id",
      )
      .eq("run_id", runId)
      .eq("user_id", userId)
      .maybeSingle();
    stored = (data ?? null) as CheckpointRow | null;
  } catch (e) {
    console.warn("[swarmCheckpoint] load threw:", (e as Error).message);
    return null;
  }
  return stored ? fromRow(await openCheckpoint(runId, stored)) : null;
}

/**
 * Drop the checkpoint once a run reaches a terminal state.
 *
 * Kept deliberately: leaving it behind would let a finished run be "resumed",
 * re-running whatever came after the last node — and the run row plus its steps
 * are the durable record, so nothing is lost by removing it.
 */
export async function clearCheckpoint(runId: string): Promise<void> {
  try {
    await supabaseAdmin.from("swarm_run_checkpoints").delete().eq("run_id", runId);
  } catch (e) {
    console.warn("[swarmCheckpoint] clear threw:", (e as Error).message);
  }
}
