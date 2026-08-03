// Swarm version history helpers. A version is a point-in-time snapshot of the
// graph (nodes + edges), stripped of transient runtime fields so it round-trips
// cleanly. Snapshots are capped per swarm so history can't grow unbounded.
import { supabase } from "@/integrations/supabase/client";
import type { Node, Edge } from "@xyflow/react";
import type { SwarmNodeData } from "@/lib/swarmRuntime";

const MAX_VERSIONS = 30;

export type SwarmVersionKind = "auto" | "manual" | "restore";

// Strip runtime-only fields (matches how handleSave persists a swarm) so a
// snapshot is a faithful, restorable copy of the graph.
export function serializeGraph(nodes: Node<SwarmNodeData>[], edges: Edge[]) {
  const cleanEdges = edges.map(({ id, source, target, sourceHandle, targetHandle }) => ({
    id,
    source,
    target,
    sourceHandle: sourceHandle ?? null,
    targetHandle: targetHandle ?? null,
  }));
  const cleanNodes = nodes.map((n) => {
    // React Flow writes UI state back onto the node objects. `...n` carried all
    // of it into the snapshot, and graphHash stringifies the result — so
    // CLICKING a node set selected:true, changed the hash, and made the next
    // Save record a "version" whose only difference from the last one was which
    // node had focus. With MAX_VERSIONS at 30, that churn evicts real history.
    //
    // position is deliberately NOT stripped: moving a node is a real edit to
    // the graph and should be versioned.
    const { selected, dragging, resizing, measured, ...rest } = n as typeof n & {
      resizing?: boolean;
      measured?: { width?: number; height?: number };
    };
    void selected;
    void dragging;
    void resizing;
    void measured;
    return { ...rest, data: { ...n.data, status: "idle", lastOutput: undefined } };
  });
  return { cleanNodes, cleanEdges };
}

// Stable fingerprint of the serialized graph — used to skip snapshotting a Save
// that didn't actually change anything.
export function graphHash(nodes: Node<SwarmNodeData>[], edges: Edge[]): string {
  const { cleanNodes, cleanEdges } = serializeGraph(nodes, edges);
  return JSON.stringify({ n: cleanNodes, e: cleanEdges });
}

export async function snapshotSwarmVersion(opts: {
  swarmId: string;
  userId: string;
  nodes: Node<SwarmNodeData>[];
  edges: Edge[];
  label: string;
  kind: SwarmVersionKind;
}): Promise<void> {
  const { cleanNodes, cleanEdges } = serializeGraph(opts.nodes, opts.edges);
  const { error } = await supabase.from("swarm_versions").insert({
    swarm_id: opts.swarmId,
    user_id: opts.userId,
    label: opts.label,
    kind: opts.kind,
    nodes: cleanNodes as never,
    edges: cleanEdges as never,
    node_count: cleanNodes.length,
  });
  if (error) return; // versioning is best-effort; never block a save

  // Prune to the most recent MAX_VERSIONS for this swarm.
  const { data: ids } = await supabase
    .from("swarm_versions")
    .select("id")
    .eq("swarm_id", opts.swarmId)
    .order("created_at", { ascending: false });
  if (ids && ids.length > MAX_VERSIONS) {
    const toDelete = ids.slice(MAX_VERSIONS).map((r) => r.id);
    if (toDelete.length) await supabase.from("swarm_versions").delete().in("id", toDelete);
  }
}
