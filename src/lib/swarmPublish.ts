// Draft vs published resolution for deployed swarms.
//
// The canvas edits the DRAFT (`nodes`/`edges`). API keys, schedules and any
// Execute-Swarm node inside a headless run serve the PUBLISHED snapshot, so
// saving a half-finished edit cannot reach production callers.
//
// PURE module — no Supabase — because three separate code paths (the run
// endpoint, the scheduler, the sub-swarm loader) must resolve identically. One
// of them quietly reading `nodes` instead would reintroduce the whole bug for
// that path only, which is the sort of thing nobody notices until it matters.

export type PublishableSwarm = {
  nodes: unknown;
  edges: unknown;
  published_nodes?: unknown;
  published_edges?: unknown;
  published_at?: string | null;
};

export type ResolvedGraph = {
  nodes: unknown;
  edges: unknown;
  /**
   * "published" — served a pinned snapshot.
   * "live" — no snapshot exists, so the draft was served. Only possible for
   * swarms deployed before publishing existed; the UI surfaces it rather than
   * letting it be invisible.
   */
  source: "published" | "live";
};

export function isPublished(s: PublishableSwarm): boolean {
  return Array.isArray(s.published_nodes);
}

/** What a HEADLESS run should execute. */
export function resolveDeployedGraph(s: PublishableSwarm): ResolvedGraph {
  if (isPublished(s)) {
    return { nodes: s.published_nodes, edges: s.published_edges ?? [], source: "published" };
  }
  return { nodes: s.nodes, edges: s.edges, source: "live" };
}

/**
 * Comparable form of a graph.
 *
 * Node POSITION is deliberately excluded: dragging a node around the canvas is
 * not a change to what the swarm does, and treating it as one would show
 * "unpublished changes" after every idle mouse move — the fastest way to teach
 * someone to ignore the badge. Everything that affects behaviour (kind, data,
 * wiring, labels) is included.
 */
export function graphFingerprint(nodes: unknown, edges: unknown): string {
  const n = (Array.isArray(nodes) ? nodes : [])
    .map((raw) => {
      const node = raw as { id?: string; type?: string; data?: unknown };
      return { id: node.id ?? "", type: node.type ?? "", data: stable(strip(node.data)) };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  const e = (Array.isArray(edges) ? edges : [])
    .map((raw) => {
      const edge = raw as { id?: string; source?: string; target?: string; label?: unknown };
      return {
        id: edge.id ?? "",
        source: edge.source ?? "",
        target: edge.target ?? "",
        label: edge.label == null ? "" : String(edge.label),
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  return JSON.stringify({ n, e });
}

/**
 * Per-node RUN state, which lives in `data` next to the configuration but is
 * not part of the graph.
 *
 * Two ways this bites if it is left in, both found live:
 *  - The canvas save handler strips these before writing, so the in-memory
 *    nodes and the saved row differ on them from the moment you press Save —
 *    and the publish panel would tell you your work was unsaved at exactly the
 *    moment it had just been saved.
 *  - Running a swarm writes `status` into every node it touches, so simply
 *    pressing Run would light up "Draft ahead" on a swarm nobody had edited.
 */
const TRANSIENT = new Set(["status", "lastOutput"]);

function strip(data: unknown): unknown {
  if (!data || typeof data !== "object" || Array.isArray(data)) return data;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    if (TRANSIENT.has(k)) continue;
    out[k] = v;
  }
  // A present-but-undefined key must compare equal to an absent one — the save
  // handler writes `lastOutput: undefined` and the database receives no key at
  // all. Nothing here does that on purpose: JSON.stringify drops
  // undefined-valued keys, and the fingerprint is a JSON string. An explicit
  // filter was here briefly and mutation testing showed it changed nothing.
  return out;
}

/** Key order must not change the fingerprint, or every save looks like an edit. */
function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = stable((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

/** True when the draft differs behaviourally from what is deployed. */
export function hasUnpublishedChanges(s: PublishableSwarm): boolean {
  if (!isPublished(s)) return false; // nothing pinned: the draft IS what runs
  return (
    graphFingerprint(s.nodes, s.edges) !== graphFingerprint(s.published_nodes, s.published_edges)
  );
}

export type DeployState =
  /** Pinned and identical to the draft. */
  | "in-sync"
  /** Pinned, and the draft has moved on. */
  | "drifted"
  /** Deployed before publishing existed — serving the live draft. */
  | "unpinned"
  /** Not deployed at all. */
  | "not-deployed";

export function deployState(s: PublishableSwarm, deployed: boolean): DeployState {
  if (!deployed) return "not-deployed";
  if (!isPublished(s)) return "unpinned";
  return hasUnpublishedChanges(s) ? "drifted" : "in-sync";
}

export function deployStateCopy(state: DeployState): { label: string; detail: string } {
  switch (state) {
    case "in-sync":
      return {
        label: "Published",
        detail: "API keys and schedules run exactly what is on the canvas.",
      };
    case "drifted":
      return {
        label: "Draft ahead",
        detail:
          "The canvas has changes that deployed runs are NOT using. Publish to roll them out.",
      };
    case "unpinned":
      // Deliberately says nothing about WHY it is unpinned. An earlier version
      // blamed "deployed before publishing existed", which reads as an accurate
      // explanation right up until someone presses Unpin — and then the panel
      // is confidently telling them something false about their own swarm.
      return {
        label: "Serving the live canvas",
        detail:
          "Every save reaches this swarm's API keys and schedules immediately, including half-finished edits. Publish to pin a version.",
      };
    default:
      return { label: "Not deployed", detail: "No API keys or schedules yet." };
  }
}
