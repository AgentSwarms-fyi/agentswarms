// Whether a workflow's last run still vouches for what its next run would do.
//
// FOUND IN R184 (sweep item 2, a badge that outlives what it vouched for; the
// ETL chip was R183). The workflows list showed `last_run_status` beside each
// workflow, and a save writes the graph and none of the run stamps. Driven: a
// workflow with one SQL step (`SELECT 184 AS r184`) ran and read
// "succeeded"; its statement became a query on a table that does not exist,
// and after the save the list still read "succeeded".
//
// Each run pins the graph it ran (`workflow_runs.graph`), so the list compares
// that with the graph now. Only what a run executes counts: a step's canvas
// position and display name do not, and neither does the order the editor
// happened to write steps and arrows in, or the key order Postgres gave the
// stored JSON.
import type { WorkflowEdge, WorkflowGraph, WorkflowNode, WorkflowParam } from "@/lib/workflows";

/**
 * A value with every object's keys in one order. An undefined key and a
 * missing one read the same, since JSON.stringify leaves undefined out.
 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

const edgeKey = (e: WorkflowEdge) => `${e.from}\u0000${e.to}\u0000${e.branch ?? ""}`;

/** What a run executes of a graph, as one string. */
export function executableGraph(value: unknown): string {
  const g = (value ?? {}) as Partial<WorkflowGraph>;
  const nodes = (Array.isArray(g.nodes) ? g.nodes : [])
    .map(({ x: _x, y: _y, label: _label, ...step }: WorkflowNode) => step)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const edges = (Array.isArray(g.edges) ? g.edges : [])
    .map((e: WorkflowEdge) => ({ from: e.from, to: e.to, branch: e.branch || undefined }))
    .sort((a, b) => edgeKey(a).localeCompare(edgeKey(b)));
  const params = (Array.isArray(g.params) ? g.params : [])
    .map(({ description: _description, ...p }: WorkflowParam) => p)
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return JSON.stringify(canonical({ nodes, edges, params }));
}

/**
 * Whether the graph now differs from the one the run executed. Null when
 * there is no run to compare with: the list then claims nothing.
 */
export function workflowChangedSinceRun(current: unknown, ran: unknown): boolean | null {
  if (ran === null || ran === undefined) return null;
  return executableGraph(current) !== executableGraph(ran);
}
