// Open, portable JSON format for AgentSwarms multi-agent graphs.
//
// Goals:
//   • Vendor-neutral — any runtime can parse this.
//   • Stable, versioned schema (semver in `schemaVersion`).
//   • Strips ephemeral runtime fields (status, lastOutput, React Flow styling).
//   • Round-trippable: exported file can be re-imported without loss.
//
// The format is intentionally close to "agent flow" conventions used by
// open frameworks (LangGraph-style nodes/edges, plain JSON, no binary blobs).
import type { Node, Edge } from "@xyflow/react";
import type { SwarmNodeData } from "@/lib/swarmRuntime";

export const SWARM_SCHEMA_URL = "https://agentswarms.fyi/schemas/swarm.v1.json";
export const SWARM_SCHEMA_VERSION = "1.0.0";

export interface PortableSwarmNode {
  id: string;
  kind: SwarmNodeData["kind"];
  label: string;
  avatar?: string;
  position: { x: number; y: number };
  // LLM config (optional — only meaningful for agent / condition / loop)
  provider?: string;
  model?: string;
  temperature?: number;
  systemPrompt?: string;
  conditionPrompt?: string;
  routerPrompt?: string;
  maxIters?: number;
  // I/O wiring
  inputs?: string[];
  outputVar?: string;
  // Tooling / governance
  knowledgeBaseId?: string | null;
  enabledTools?: SwarmNodeData["enabledTools"];
  toolConfigs?: SwarmNodeData["toolConfigs"];
  skillIds?: string[];
  guardrails?: SwarmNodeData["guardrails"];
  memory?: SwarmNodeData["memory"];
  approvalTitle?: string;
  approvalRisk?: "low" | "medium" | "high";
  // A2A remote agent (only meaningful for kind === "a2a_remote")
  a2aEndpoint?: string;
  a2aSkillId?: string;
  a2aStreaming?: boolean;
  // Function node
  functionCode?: string;
  functionTimeoutMs?: number;
  // Evaluate node
  evalMetrics?: SwarmNodeData["evalMetrics"];
  evalRubric?: string;
  evalCustomInstructions?: string;
  evalPassThreshold?: number;
  evalReferenceInput?: string;
  // Note: a2aAgentCard and a2aAuthHeader intentionally NOT exported
  // (cards are re-discovered; auth headers are user secrets).
}

export interface PortableSwarmEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
  label?: string;
}

export interface PortableSwarm {
  $schema: string;
  schemaVersion: string;
  kind: "agent-swarm";
  name: string;
  description?: string;
  exportedAt: string;
  exportedBy: string;
  nodes: PortableSwarmNode[];
  edges: PortableSwarmEdge[];
}

function toPortableNode(n: Node<SwarmNodeData>): PortableSwarmNode {
  const d = n.data;
  return {
    id: n.id,
    kind: d.kind,
    label: d.label,
    avatar: d.avatar,
    position: { x: Math.round(n.position.x), y: Math.round(n.position.y) },
    provider: d.provider,
    model: d.model,
    temperature: d.temperature,
    systemPrompt: d.systemPrompt,
    conditionPrompt: d.conditionPrompt,
    routerPrompt: d.routerPrompt,
    maxIters: d.maxIters,
    inputs: d.inputs,
    outputVar: d.outputVar,
    knowledgeBaseId: d.knowledgeBaseId ?? null,
    enabledTools: d.enabledTools,
    toolConfigs: d.toolConfigs,
    skillIds: d.skillIds,
    guardrails: d.guardrails,
    memory: d.memory,
    approvalTitle: d.approvalTitle,
    approvalRisk: d.approvalRisk,
    a2aEndpoint: d.a2aEndpoint,
    a2aSkillId: d.a2aSkillId,
    a2aStreaming: d.a2aStreaming,
    functionCode: d.functionCode,
    functionTimeoutMs: d.functionTimeoutMs,
    evalMetrics: d.evalMetrics,
    evalRubric: d.evalRubric,
    evalCustomInstructions: d.evalCustomInstructions,
    evalPassThreshold: d.evalPassThreshold,
    evalReferenceInput: d.evalReferenceInput,
  };
}

function toPortableEdge(e: Edge): PortableSwarmEdge {
  return {
    id: e.id,
    source: e.source,
    target: e.target,
    sourceHandle: e.sourceHandle ?? null,
    targetHandle: e.targetHandle ?? null,
    label: typeof e.label === "string" ? e.label : undefined,
  };
}

export function exportSwarm(opts: {
  name: string;
  description?: string;
  nodes: Node<SwarmNodeData>[];
  edges: Edge[];
  exportedBy?: string;
}): PortableSwarm {
  return {
    $schema: SWARM_SCHEMA_URL,
    schemaVersion: SWARM_SCHEMA_VERSION,
    kind: "agent-swarm",
    name: opts.name,
    description: opts.description,
    exportedAt: new Date().toISOString(),
    exportedBy: opts.exportedBy || "AgentSwarms",
    nodes: opts.nodes.map(toPortableNode),
    edges: opts.edges.map(toPortableEdge),
  };
}

export function downloadSwarmAsJson(portable: PortableSwarm) {
  const blob = new Blob([JSON.stringify(portable, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const safeName =
    portable.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "swarm";
  a.download = `${safeName}.swarm.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export interface ImportedSwarm {
  name: string;
  description?: string;
  nodes: Node<SwarmNodeData>[];
  edges: Edge[];
}

export function importSwarm(raw: unknown): ImportedSwarm {
  if (!raw || typeof raw !== "object") throw new Error("Invalid swarm file: not an object");
  const obj = raw as Record<string, unknown>;
  if (obj.kind !== "agent-swarm")
    throw new Error('Invalid swarm file: expected kind "agent-swarm"');
  const portableNodes = Array.isArray(obj.nodes) ? (obj.nodes as PortableSwarmNode[]) : [];
  const portableEdges = Array.isArray(obj.edges) ? (obj.edges as PortableSwarmEdge[]) : [];

  const nodes: Node<SwarmNodeData>[] = portableNodes.map((p) => ({
    id: p.id,
    type: p.kind,
    position: p.position ?? { x: 0, y: 0 },
    data: {
      label: p.label,
      kind: p.kind,
      avatar: p.avatar,
      status: "idle",
      provider: p.provider,
      model: p.model,
      temperature: p.temperature,
      systemPrompt: p.systemPrompt,
      conditionPrompt: p.conditionPrompt,
      routerPrompt: p.routerPrompt,
      maxIters: p.maxIters,
      inputs: p.inputs,
      outputVar: p.outputVar,
      knowledgeBaseId: p.knowledgeBaseId ?? undefined,
      enabledTools: p.enabledTools,
      toolConfigs: p.toolConfigs,
      approvalTitle: p.approvalTitle,
      approvalRisk: p.approvalRisk,
      a2aEndpoint: p.a2aEndpoint,
      a2aSkillId: p.a2aSkillId,
      a2aStreaming: p.a2aStreaming,
      skillIds: p.skillIds,
      guardrails: p.guardrails,
      memory: p.memory,
      functionCode: p.functionCode,
      functionTimeoutMs: p.functionTimeoutMs,
      evalMetrics: p.evalMetrics,
      evalRubric: p.evalRubric,
      evalCustomInstructions: p.evalCustomInstructions,
      evalPassThreshold: p.evalPassThreshold,
      evalReferenceInput: p.evalReferenceInput,
    },
  }));

  const edges: Edge[] = portableEdges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    sourceHandle: e.sourceHandle ?? undefined,
    targetHandle: e.targetHandle ?? undefined,
    label: e.label,
  }));

  return {
    name: typeof obj.name === "string" ? obj.name : "Imported Swarm",
    description: typeof obj.description === "string" ? obj.description : undefined,
    nodes,
    edges,
  };
}
