// ML pipelines (R540): the workflows that train, score or run a Kubeflow
// pipeline, shown where people look for them, in Data science.
//
// There is one orchestrator. A pipeline here IS a workflow (the same graph,
// runner, schedule, retries, approvals and run history): an ML pipeline is
// the name for the workflows that do model work, and the ML pipelines page is
// the view of them from the model side. A new one starts from a starter graph
// (retrain, then score) and opens in the workflow editor.
import {
  NODE_KIND_LABEL,
  topoOrder,
  type WorkflowGraph,
  type WorkflowNode,
  type WorkflowNodeKind,
} from "@/lib/workflows";

/** The steps that make a workflow an ML pipeline. */
export const ML_PIPELINE_KINDS: readonly WorkflowNodeKind[] = ["ml_schedule", "kubeflow_run"];

export function isMlPipeline(graph: WorkflowGraph | null | undefined): boolean {
  return Boolean(graph?.nodes?.some((n) => ML_PIPELINE_KINDS.includes(n.kind)));
}

/**
 * What a new ML pipeline starts with: retrain, then score. Neither step has
 * its schedule picked yet, so the editor opens on them and a save asks for
 * both; the retrain step's schedule decides whether a better version is
 * promoted, and the scoring step runs the model's batch prediction after it.
 */
export function mlPipelineStarter(): WorkflowGraph {
  return {
    nodes: [
      { id: "n_retrain", kind: "ml_schedule", label: "Retrain", x: 60, y: 80 },
      { id: "n_score", kind: "ml_schedule", label: "Score new rows", x: 340, y: 80 },
    ],
    edges: [{ from: "n_retrain", to: "n_score" }],
    params: [],
  };
}

export const ML_PIPELINE_DESCRIPTION =
  "An ML pipeline: retrain the model, then score new rows with it. Pick each step's schedule, or add Kubeflow, approval and notification steps.";

/** The steps in the order they run, as names a person reads. */
export function pipelineSteps(graph: WorkflowGraph): string[] {
  const order = topoOrder(graph) ?? graph.nodes.map((n) => n.id);
  const byId = new Map(graph.nodes.map((n) => [n.id, n] as const));
  return order
    .map((id) => byId.get(id))
    .filter((n): n is WorkflowNode => Boolean(n))
    .map((n) => n.label || NODE_KIND_LABEL[n.kind]);
}

/** How a pipeline is started, in words. */
export function triggerLine(w: {
  schedule: string;
  cron_expr?: string | null;
  is_active: boolean;
}): string {
  if (!w.is_active) return "Paused";
  switch (w.schedule) {
    case "hourly":
      return "Every hour";
    case "daily":
      return "Every day";
    case "weekly":
      return "Every week";
    case "cron":
      return w.cron_expr ? `On a schedule (${w.cron_expr})` : "On a schedule";
    default:
      return "When started";
  }
}

/** Kubeflow pipelines a graph runs, by name, for the list. */
export function kubeflowPipelinesIn(graph: WorkflowGraph): string[] {
  return graph.nodes
    .filter((n) => n.kind === "kubeflow_run")
    .map((n) => n.kubeflow?.pipelineName || n.label || "Kubeflow pipeline");
}

/** The ML schedules a graph runs, by id, to name their models. */
export function mlSchedulesIn(graph: WorkflowGraph): string[] {
  return graph.nodes
    .filter((n) => n.kind === "ml_schedule" && n.targetId)
    .map((n) => n.targetId as string);
}
