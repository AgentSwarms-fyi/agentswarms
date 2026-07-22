// Editable, executable multi-agent swarm canvas.
// - Drag/drop palette of node types (input, agent, condition, loop, approval, output)
// - Click a node → NodeInspector lets you edit name, prompt, model, temperature, I/O vars
// - Run button executes the graph in-browser via swarmRuntime, calling /api/chat
// - Load template loads a real, runnable example into the canvas
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  addEdge,
  useNodesState,
  useEdgesState,
  Handle,
  Position,
  useReactFlow,
  type Node,
  type Edge,
  type Connection,
  type NodeProps,
  MarkerType,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Bot,
  Network,
  GitBranch,
  RotateCw,
  Shield,
  ArrowRightToLine,
  ArrowLeftToLine,
  Save,
  Loader2,
  Play,
  Sparkles,
  Plus,
  Trash2,
  Maximize2,
  Minimize2,
  GraduationCap,
  Download,
  Upload,
  BookOpen,
  ArrowLeft,
  LayoutGrid,
  Eye,
  Lock,
  Cloud,
  Code2,
  ClipboardCheck,
  MoreVertical,
  Compass,
  Variable,
  Globe,
  Wrench,
  Repeat2,
  Braces,
  Merge,
  Library,
  Workflow,
  Rocket,
} from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useTheme } from "@/hooks/use-theme";
import { LearnPanel } from "@/components/LearnPanel";
import { learnSwarms } from "@/lib/learnContent";
import { type SwarmNodeData } from "@/lib/swarmRuntime";
import {
  startRun as startManagedRun,
  cancelRun as cancelManagedRun,
  getActiveRunForSwarm,
  subscribe as subscribeRuns,
  getSnapshot as getRunsSnapshot,
} from "@/lib/swarmRunManager";
import {
  SWARM_TEMPLATES,
  getSwarmTemplate,
  type SwarmTourStep,
  type SwarmTemplate,
} from "@/lib/swarmTemplates";
import { NodeInspector } from "@/components/swarms/NodeInspector";
import { RunPanel } from "@/components/swarms/RunPanel";
import { SwarmTour } from "@/components/swarms/SwarmTour";
import { FailureLabPanel } from "@/components/swarms/FailureLabPanel";
import { getFailureLab, type FailureLab } from "@/lib/failureLabs";
import { evaluateLab, type LabEvaluation } from "@/lib/failureLabCheck";
import { exportSwarm, downloadSwarmAsJson, importSwarm } from "@/lib/swarmPortable";
import { downloadSwarmAsLangGraph } from "@/lib/swarmExportLangGraph";
import { downloadSwarmAsCrewAI, downloadSwarmAsOpenAIAgents } from "@/lib/swarmExportFrameworks";
import { downloadSwarmAsStrands } from "@/lib/swarmExportStrands";
import { SwarmGallery } from "@/components/swarms/SwarmGallery";
import { SwarmDeployDialog } from "@/components/swarms/SwarmDeployDialog";

export const Route = createFileRoute("/_authenticated/swarms")({
  component: SwarmsPage,
  validateSearch: (s: Record<string, unknown>) => {
    const out: { template?: string; swarm?: string; lab?: string; view?: "canvas"; new?: 1 } = {};
    if (typeof s.template === "string") out.template = s.template;
    if (typeof s.swarm === "string") out.swarm = s.swarm;
    if (typeof s.lab === "string") out.lab = s.lab;
    if (s.view === "canvas") out.view = "canvas";
    if (s.new === 1 || s.new === "1") out.new = 1;
    return out;
  },
});

// ──────────────────────────────────────────────────────────────────
// Node renderers
// ──────────────────────────────────────────────────────────────────
function nodeShellClass(selected: boolean, color: string, status?: string): string {
  const base =
    "relative min-w-[180px] rounded-xl border-2 bg-card shadow-lg transition-all hover:shadow-[0_0_24px_-6px_color-mix(in_oklch,var(--primary)_40%,transparent)]";
  if (status === "running" || status === "waiting") {
    // Pulsing accent glow on the currently-executing node so users can
    // visually track which step the swarm is on during a run.
    return `${base} border-amber-400 ring-4 ring-amber-400/40 shadow-[0_0_24px_rgba(251,191,36,0.55)] scale-[1.03] animate-pulse`;
  }
  if (status === "done") {
    return `${base} border-emerald-500/70 ring-2 ring-emerald-400/30 shadow-[0_0_16px_rgba(16,185,129,0.35)]`;
  }
  if (status === "error") {
    return `${base} border-destructive ring-2 ring-destructive/40 shadow-[0_0_16px_rgba(239,68,68,0.4)]`;
  }
  if (status === "skipped") {
    return `${base} border-border/40 opacity-50 grayscale`;
  }
  return `${base} ${selected ? `${color} shadow-primary/30` : "border-border"}`;
}

function statusDot(status?: string) {
  const map: Record<string, string> = {
    running: "bg-amber-500 animate-pulse",
    done: "bg-emerald-500",
    error: "bg-destructive",
    waiting: "bg-amber-400 animate-pulse",
    idle: "bg-muted-foreground/40",
    skipped: "bg-muted-foreground/30",
  };
  return map[status ?? "idle"] || "bg-muted-foreground/40";
}

function GenericNode({
  data,
  selected,
  accentBorder,
  accentText,
  accentBg,
  Icon,
  kindLabel,
  showSource = true,
  showTarget = true,
}: NodeProps<Node<SwarmNodeData>> & {
  accentBorder: string;
  accentText: string;
  accentBg: string;
  Icon: typeof Bot;
  kindLabel: string;
  showSource?: boolean;
  showTarget?: boolean;
}) {
  return (
    <div className={nodeShellClass(selected, accentBorder, data.status)}>
      <div
        className={`${accentBg} px-3 py-1.5 border-b ${accentBorder} rounded-t-[10px] flex items-center justify-between gap-1.5`}
      >
        <div className="flex items-center gap-1.5">
          <Icon className={`h-3 w-3 ${accentText}`} />
          <span className={`text-[10px] uppercase tracking-wider font-bold ${accentText}`}>
            {kindLabel}
          </span>
        </div>
        <span className={`h-1.5 w-1.5 rounded-full ${statusDot(data.status)}`} />
      </div>
      <div className="p-3 flex items-center gap-2">
        <div className="text-xl">{data.avatar || "🤖"}</div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold truncate">{data.label}</p>
          {data.model && (
            <p className="text-[10px] text-muted-foreground truncate font-mono">{data.model}</p>
          )}
          {data.kind === "approval" && (
            <p className="text-[10px] text-muted-foreground truncate">
              risk: {data.approvalRisk || "medium"}
            </p>
          )}
          {data.outputVar && (
            <p className="text-[10px] text-muted-foreground truncate">→ {data.outputVar}</p>
          )}
        </div>
      </div>
      {showTarget && (
        <>
          <Handle
            type="target"
            position={Position.Top}
            className="!bg-primary !w-3 !h-3 !border-2 !border-card"
          />
          <span className="absolute -top-4 left-1/2 -translate-x-1/2 text-[8px] uppercase tracking-wider font-semibold text-muted-foreground pointer-events-none">
            in
          </span>
        </>
      )}
      {data.kind === "condition" ? (
        <>
          <Handle
            type="source"
            id="yes"
            position={Position.Right}
            className="!bg-emerald-500 !w-3 !h-3 !border-2 !border-card"
          />
          <span className="absolute top-1/2 -right-7 -translate-y-1/2 text-[8px] uppercase tracking-wider font-semibold text-emerald-500 pointer-events-none">
            yes
          </span>
          <Handle
            type="source"
            id="no"
            position={Position.Bottom}
            className="!bg-red-500 !w-3 !h-3 !border-2 !border-card"
          />
          <span className="absolute -bottom-4 left-1/2 -translate-x-1/2 text-[8px] uppercase tracking-wider font-semibold text-red-500 pointer-events-none">
            no
          </span>
        </>
      ) : data.kind === "router" ? (
        <>
          {/* Single source handle — multiple outgoing edges with route-name
              labels fan out from here. The runtime reads each edge's label
              to build the choice list at run time. */}
          <Handle
            type="source"
            position={Position.Bottom}
            className="!bg-indigo-400 !w-3 !h-3 !border-2 !border-card"
          />
          <span className="absolute -bottom-4 left-1/2 -translate-x-1/2 text-[8px] uppercase tracking-wider font-semibold text-indigo-400 pointer-events-none">
            route → (label each edge)
          </span>
        </>
      ) : (
        showSource && (
          <>
            <Handle
              type="source"
              position={Position.Bottom}
              className="!bg-primary !w-3 !h-3 !border-2 !border-card"
            />
            <span className="absolute -bottom-4 left-1/2 -translate-x-1/2 text-[8px] uppercase tracking-wider font-semibold text-muted-foreground pointer-events-none">
              out
            </span>
          </>
        )
      )}
    </div>
  );
}

const nodeTypes = {
  input: (p: NodeProps<Node<SwarmNodeData>>) => (
    <GenericNode
      {...p}
      accentBorder="border-sky-500/50"
      accentText="text-sky-400"
      accentBg="bg-sky-500/10"
      Icon={ArrowRightToLine}
      kindLabel="Input"
      showTarget={false}
    />
  ),
  agent: (p: NodeProps<Node<SwarmNodeData>>) => (
    <GenericNode
      {...p}
      accentBorder="border-primary/50"
      accentText="text-primary"
      accentBg="bg-primary/10"
      Icon={Bot}
      kindLabel="Agent"
    />
  ),
  condition: (p: NodeProps<Node<SwarmNodeData>>) => (
    <GenericNode
      {...p}
      accentBorder="border-violet-500/50"
      accentText="text-violet-400"
      accentBg="bg-violet-500/10"
      Icon={GitBranch}
      kindLabel="Condition"
    />
  ),
  router: (p: NodeProps<Node<SwarmNodeData>>) => (
    <GenericNode
      {...p}
      accentBorder="border-indigo-500/50"
      accentText="text-indigo-300"
      accentBg="bg-indigo-500/10"
      Icon={Compass}
      kindLabel="Router"
    />
  ),
  loop: (p: NodeProps<Node<SwarmNodeData>>) => (
    <GenericNode
      {...p}
      accentBorder="border-orange-500/50"
      accentText="text-orange-400"
      accentBg="bg-orange-500/10"
      Icon={RotateCw}
      kindLabel="Loop"
    />
  ),
  approval: (p: NodeProps<Node<SwarmNodeData>>) => (
    <GenericNode
      {...p}
      accentBorder="border-amber-500/50"
      accentText="text-amber-400"
      accentBg="bg-amber-500/10"
      Icon={Shield}
      kindLabel="Approval"
    />
  ),
  output: (p: NodeProps<Node<SwarmNodeData>>) => (
    <GenericNode
      {...p}
      accentBorder="border-emerald-500/50"
      accentText="text-emerald-400"
      accentBg="bg-emerald-500/10"
      Icon={ArrowLeftToLine}
      kindLabel="Output"
      showSource={false}
    />
  ),
  a2a_remote: (p: NodeProps<Node<SwarmNodeData>>) => (
    <GenericNode
      {...p}
      accentBorder="border-fuchsia-500/50"
      accentText="text-fuchsia-400"
      accentBg="bg-fuchsia-500/10"
      Icon={Cloud}
      kindLabel="A2A Remote"
    />
  ),
  function: (p: NodeProps<Node<SwarmNodeData>>) => (
    <GenericNode
      {...p}
      accentBorder="border-zinc-500/50"
      accentText="text-zinc-300"
      accentBg="bg-zinc-500/10"
      Icon={Code2}
      kindLabel="Function"
    />
  ),
  evaluate: (p: NodeProps<Node<SwarmNodeData>>) => (
    <GenericNode
      {...p}
      accentBorder="border-teal-500/50"
      accentText="text-teal-400"
      accentBg="bg-teal-500/10"
      Icon={ClipboardCheck}
      kindLabel="Evaluate"
    />
  ),
  set_var: (p: NodeProps<Node<SwarmNodeData>>) => (
    <GenericNode
      {...p}
      accentBorder="border-cyan-500/50"
      accentText="text-cyan-300"
      accentBg="bg-cyan-500/10"
      Icon={Variable}
      kindLabel="Set Variable"
    />
  ),
  http: (p: NodeProps<Node<SwarmNodeData>>) => (
    <GenericNode
      {...p}
      accentBorder="border-lime-500/50"
      accentText="text-lime-300"
      accentBg="bg-lime-500/10"
      Icon={Globe}
      kindLabel="HTTP"
    />
  ),
  tool: (p: NodeProps<Node<SwarmNodeData>>) => (
    <GenericNode
      {...p}
      accentBorder="border-rose-500/50"
      accentText="text-rose-300"
      accentBg="bg-rose-500/10"
      Icon={Wrench}
      kindLabel="Tool"
    />
  ),
  foreach: (p: NodeProps<Node<SwarmNodeData>>) => (
    <GenericNode
      {...p}
      accentBorder="border-amber-600/50"
      accentText="text-amber-300"
      accentBg="bg-amber-600/10"
      Icon={Repeat2}
      kindLabel="For Each"
    />
  ),
  extract: (p: NodeProps<Node<SwarmNodeData>>) => (
    <GenericNode
      {...p}
      accentBorder="border-sky-600/50"
      accentText="text-sky-300"
      accentBg="bg-sky-600/10"
      Icon={Braces}
      kindLabel="Extract"
    />
  ),
  merge: (p: NodeProps<Node<SwarmNodeData>>) => (
    <GenericNode
      {...p}
      accentBorder="border-slate-400/50"
      accentText="text-slate-300"
      accentBg="bg-slate-400/10"
      Icon={Merge}
      kindLabel="Merge"
    />
  ),
  retrieve: (p: NodeProps<Node<SwarmNodeData>>) => (
    <GenericNode
      {...p}
      accentBorder="border-emerald-600/50"
      accentText="text-emerald-300"
      accentBg="bg-emerald-600/10"
      Icon={Library}
      kindLabel="Retrieve"
    />
  ),
  subswarm: (p: NodeProps<Node<SwarmNodeData>>) => (
    <GenericNode
      {...p}
      accentBorder="border-purple-500/50"
      accentText="text-purple-300"
      accentBg="bg-purple-500/10"
      Icon={Workflow}
      kindLabel="Execute Swarm"
    />
  ),
};

// Stable empty array so the derived `events` prop keeps a constant identity
// when no run is active (avoids needless RunPanel re-renders).
const EMPTY_EVENTS: never[] = [];

// Derived from theme tokens so edges follow the brand color in both modes.
const EDGE_COLOR = "color-mix(in oklch, var(--primary) 65%, var(--border))";
const defaultEdgeStyle = {
  animated: true,
  style: { stroke: EDGE_COLOR, strokeWidth: 1.5 },
  markerEnd: { type: MarkerType.ArrowClosed, color: EDGE_COLOR, width: 18, height: 18 },
};
// Apply default edge styling but PRESERVE any per-edge overrides supplied by
// templates (e.g. a thicker dashed line on an "image data" edge to signal
// multimodal flow). Plain spread would let defaults clobber template style.
function withDefaultEdgeStyle(e: Edge): Edge {
  return {
    ...defaultEdgeStyle,
    ...e,
    style: { ...defaultEdgeStyle.style, ...(e.style ?? {}) },
    markerEnd: e.markerEnd ?? defaultEdgeStyle.markerEnd,
  };
}

// ──────────────────────────────────────────────────────────────────
// Palette definition
// ──────────────────────────────────────────────────────────────────
type PaletteItem = {
  kind: SwarmNodeData["kind"];
  label: string;
  avatar: string;
  description: string;
  defaults: Partial<SwarmNodeData>;
};

// Palette icon chips reuse the same accent pairs as the canvas node headers
// so the palette previews exactly what lands on the canvas.
const PALETTE_ACCENTS: Record<SwarmNodeData["kind"], { chip: string; Icon: typeof Bot }> = {
  input: { chip: "bg-sky-500/10 text-sky-500", Icon: ArrowRightToLine },
  agent: { chip: "bg-primary/10 text-primary", Icon: Bot },
  condition: { chip: "bg-violet-500/10 text-violet-500", Icon: GitBranch },
  router: { chip: "bg-indigo-500/10 text-indigo-500", Icon: Compass },
  loop: { chip: "bg-orange-500/10 text-orange-500", Icon: RotateCw },
  approval: { chip: "bg-amber-500/10 text-amber-500", Icon: Shield },
  a2a_remote: { chip: "bg-fuchsia-500/10 text-fuchsia-500", Icon: Cloud },
  function: { chip: "bg-zinc-500/10 text-zinc-500", Icon: Code2 },
  evaluate: { chip: "bg-teal-500/10 text-teal-500", Icon: ClipboardCheck },
  output: { chip: "bg-emerald-500/10 text-emerald-500", Icon: ArrowLeftToLine },
  set_var: { chip: "bg-cyan-500/10 text-cyan-500", Icon: Variable },
  http: { chip: "bg-lime-500/10 text-lime-500", Icon: Globe },
  tool: { chip: "bg-rose-500/10 text-rose-500", Icon: Wrench },
  foreach: { chip: "bg-amber-600/10 text-amber-600", Icon: Repeat2 },
  extract: { chip: "bg-sky-600/10 text-sky-600", Icon: Braces },
  merge: { chip: "bg-slate-400/10 text-slate-400", Icon: Merge },
  retrieve: { chip: "bg-emerald-600/10 text-emerald-600", Icon: Library },
  subswarm: { chip: "bg-purple-500/10 text-purple-500", Icon: Workflow },
};

const PALETTE_GROUPS: { label: string; kinds: SwarmNodeData["kind"][] }[] = [
  { label: "Flow", kinds: ["input", "output", "approval"] },
  { label: "Agents", kinds: ["agent", "router", "a2a_remote", "subswarm"] },
  { label: "Logic", kinds: ["condition", "loop", "foreach", "merge", "evaluate"] },
  { label: "Data & Tools", kinds: ["set_var", "extract", "retrieve", "http", "tool", "function"] },
];

const PALETTE: PaletteItem[] = [
  {
    kind: "input",
    label: "Input",
    avatar: "📨",
    description: "Seed value for the run",
    defaults: { outputVar: "input" },
  },
  {
    kind: "agent",
    label: "Agent",
    avatar: "🤖",
    description: "LLM call",
    defaults: {
      provider: "openrouter",
      model: "google/gemini-3-flash-preview",
      temperature: 0.4,
      systemPrompt: "You are a helpful assistant.",
      inputs: ["input"],
    },
  },
  {
    kind: "condition",
    label: "Condition",
    avatar: "🔀",
    description: "YES/NO router",
    defaults: {
      provider: "openrouter",
      model: "google/gemini-3-flash-preview",
      conditionPrompt: "Is the input positive?",
      inputs: ["input"],
    },
  },
  {
    kind: "router",
    label: "Router Agent",
    avatar: "🧭",
    description: "LLM picks 1 of N routes",
    defaults: {
      provider: "openrouter",
      model: "google/gemini-3-flash-preview",
      temperature: 0,
      routerPrompt:
        "You manage multiple specialists. Pick the single best route for the user's request.",
      inputs: ["input"],
    },
  },
  {
    kind: "loop",
    label: "Loop",
    avatar: "🔁",
    description: "Retry until DONE",
    defaults: {
      provider: "openrouter",
      model: "google/gemini-3-flash-preview",
      maxIters: 3,
      systemPrompt: "Refine the answer. Append DONE when satisfied.",
      inputs: ["input"],
    },
  },
  {
    kind: "approval",
    label: "Approval",
    avatar: "🛡️",
    description: "Pause for human",
    defaults: { approvalTitle: "Approve this action", approvalRisk: "medium", inputs: ["input"] },
  },
  {
    kind: "a2a_remote",
    label: "A2A Remote",
    avatar: "🌐",
    description: "Delegate to a remote A2A agent",
    defaults: { a2aEndpoint: "", a2aStreaming: false, inputs: ["input"] },
  },
  {
    kind: "function",
    label: "Function (JS)",
    avatar: "⚙️",
    description: "Sandboxed JS transform — 2s timeout",
    defaults: {
      functionCode:
        "// ctx.input is the upstream value (string).\n// ctx.vars holds the whole context map.\n// Return any value — objects are JSON-stringified for downstream nodes.\nreturn ctx.input.toUpperCase();",
      functionTimeoutMs: 2000,
      inputs: ["input"],
    },
  },
  {
    kind: "evaluate",
    label: "Evaluate",
    avatar: "📊",
    description: "LLM-as-a-judge scoring",
    defaults: {
      provider: "openrouter",
      model: "openai/gpt-5",
      temperature: 0.1,
      inputs: ["input"],
      evalMetrics: [
        {
          id: "faithfulness",
          name: "Faithfulness",
          enabled: true,
          weight: 0.3,
          description: "Are all claims grounded in the provided context?",
        },
        {
          id: "answer_relevancy",
          name: "Answer Relevancy",
          enabled: true,
          weight: 0.25,
          description: "Does the answer address the question asked?",
        },
        {
          id: "completeness",
          name: "Completeness",
          enabled: true,
          weight: 0.2,
          description: "Does the answer cover all parts of the question?",
        },
        {
          id: "coherence",
          name: "Coherence",
          enabled: true,
          weight: 0.15,
          description: "Is the answer logically structured and clear?",
        },
        {
          id: "harmlessness",
          name: "Harmlessness",
          enabled: false,
          weight: 0.1,
          description: "Is the answer free of harmful or toxic content?",
        },
      ],
      evalPassThreshold: 0.7,
    },
  },
  {
    kind: "set_var",
    label: "Set Variable",
    avatar: "🔧",
    description: "Write named values into flow state",
    defaults: {
      inputs: ["input"],
      stateAssignments: [{ key: "my_var", value: "{{input}}" }],
    },
  },
  {
    kind: "extract",
    label: "Extract (JSON)",
    avatar: "🧩",
    description: "LLM structured output → JSON fields",
    defaults: {
      provider: "openrouter",
      model: "openai/gpt-4o-mini",
      temperature: 0.1,
      inputs: ["input"],
      extractSchema: [
        { name: "summary", type: "string", description: "One-sentence summary of the input" },
      ],
    },
  },
  {
    kind: "http",
    label: "HTTP Request",
    avatar: "🌐",
    description: "Call any REST API (deterministic)",
    defaults: {
      httpMethod: "GET",
      httpUrl: "https://api.example.com/{{input}}",
      httpHeaders: [{ key: "Accept", value: "application/json" }],
      inputs: ["input"],
    },
  },
  {
    kind: "tool",
    label: "Tool (deterministic)",
    avatar: "🛠️",
    description: "Run one tool without an LLM",
    defaults: {
      toolId: "web_search",
      toolArgs: { query: "{{input}}" },
      inputs: ["input"],
    },
  },
  {
    kind: "foreach",
    label: "For Each",
    avatar: "🔁",
    description: "Map an agent over each array item",
    defaults: {
      provider: "openrouter",
      model: "google/gemini-3-flash-preview",
      temperature: 0.3,
      maxIters: 25,
      foreachItemVar: "item",
      systemPrompt: "Process this item and return the result:\n{{item}}",
      inputs: ["input"],
    },
  },
  {
    kind: "merge",
    label: "Merge (aggregator)",
    avatar: "🔀",
    description: "Combine several inputs into one value",
    defaults: {
      mergeMode: "concat",
      inputs: ["input"],
    },
  },
  {
    kind: "retrieve",
    label: "Retrieve (KB)",
    avatar: "📚",
    description: "Search a knowledge base (no LLM)",
    defaults: {
      retrieveQuery: "{{input}}",
      retrieveTopK: 5,
      inputs: ["input"],
    },
  },
  {
    kind: "subswarm",
    label: "Execute Swarm",
    avatar: "🧩",
    description: "Run another saved swarm as a node",
    defaults: { subSwarmId: null, inputs: ["input"] },
  },
  {
    kind: "output",
    label: "Output",
    avatar: "✅",
    description: "Terminal value",
    defaults: { inputs: ["input"] },
  },
];

// ──────────────────────────────────────────────────────────────────
// Canvas
// ──────────────────────────────────────────────────────────────────
function SwarmsCanvas({
  initialTemplate,
  initialSwarmId,
  initialLab,
  isFullscreen,
  onToggleFullscreen,
  learnVisible,
  onToggleLearn,
  onBackToGallery,
}: {
  initialTemplate?: string;
  initialSwarmId?: string;
  initialLab?: string;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
  learnVisible: boolean;
  onToggleLearn: () => void;
  onBackToGallery: () => void;
}) {
  const { user } = useAuth();
  const { theme } = useTheme();
  const reactFlow = useReactFlow();
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<SwarmNodeData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [edgeLabelTarget, setEdgeLabelTarget] = useState<{ id: string; value: string } | null>(
    null,
  );
  const [swarmId, setSwarmId] = useState<string | null>(null);
  const [swarmList, setSwarmList] = useState<{ id: string; name: string }[]>([]);
  const [swarmName, setSwarmName] = useState("My First Swarm");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [knowledgeBases, setKnowledgeBases] = useState<{ id: string; name: string }[]>([]);
  const [agentLibrary, setAgentLibrary] = useState<
    Array<{
      id: string;
      name: string;
      description: string | null;
      llm_provider: string;
      llm_model: string;
      temperature: number;
      system_prompt: string | null;
      knowledge_base_id: string | null;
      tools: unknown;
    }>
  >([]);
  const idCounter = useRef(1);
  // Track which user/template/swarm combo we've already loaded so token
  // refreshes (which produce a new `user` object reference on tab refocus)
  // don't re-trigger the loader and wipe unsaved canvas edits.
  const loadedKeyRef = useRef<string | null>(null);

  // Guided tour state — populated when a template is loaded
  const [tourSteps, setTourSteps] = useState<SwarmTourStep[]>([]);
  const [tourTitle, setTourTitle] = useState("");
  const [tourCaseStudies, setTourCaseStudies] = useState<SwarmTemplate["caseStudies"]>([]);
  const [tourOpen, setTourOpen] = useState(false);

  // Failure-Mode Lab state — populated when a lab is loaded (?lab=)
  const [activeLab, setActiveLab] = useState<FailureLab | null>(null);
  const [labResult, setLabResult] = useState<LabEvaluation | null>(null);
  const [labHasRun, setLabHasRun] = useState(false);
  const labHintsUsedRef = useRef(0);
  const labRevealedRef = useRef(false);

  // run state. Execution lives in the module-level swarmRunManager so a run
  // keeps going across client navigation (the "Gallery" back button) instead
  // of being orphaned when this component unmounts. We derive the live view
  // from that store and reflect it onto the canvas.
  const [runInput, setRunInput] = useState("");
  const [deployOpen, setDeployOpen] = useState(false);
  // Values for the typed input form (when the input node declares inputFields).
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [traceEnabled, setTraceEnabled] = useState(true);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const managedRuns = useSyncExternalStore(subscribeRuns, getRunsSnapshot, getRunsSnapshot);
  // The run this canvas is watching: the one we started, or (on a fresh mount
  // while a run is still going) the newest active run for this swarm.
  const activeRun = useMemo(() => {
    if (activeRunId) return managedRuns.find((r) => r.runId === activeRunId) ?? null;
    return getActiveRunForSwarm(swarmId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [managedRuns, activeRunId, swarmId]);
  const running = !!activeRun && (activeRun.status === "running" || activeRun.status === "waiting");
  const events = activeRun?.events ?? EMPTY_EVENTS;
  const finalOutput = activeRun?.finalOutput ?? null;
  const traceRunId = activeRun?.dbRunId ?? null;
  const runningNodeIds = useMemo(
    () => new Set(activeRun?.runningNodeIds ?? []),
    [activeRun?.runId, (activeRun?.runningNodeIds ?? []).join("|")],
  );
  // Typed input form fields declared on the input node (empty = single textarea).
  const inputFields = useMemo(
    () => nodes.find((n) => n.data.kind === "input")?.data.inputFields ?? [],
    [nodes],
  );

  // Track unsaved edits so we can warn on tab/window close.
  const dirtyRef = useRef(false);

  const applySwarmRow = useCallback(
    (row: { id: string; name: string; nodes: unknown; edges: unknown }) => {
      setSwarmId(row.id);
      setSwarmName(row.name);
      const loadedNodes = (row.nodes as Node<SwarmNodeData>[]) ?? [];
      const loadedEdges = (row.edges as Edge[]) ?? [];
      setNodes(loadedNodes);
      setEdges(loadedEdges.map(withDefaultEdgeStyle));
      idCounter.current = loadedNodes.length + 1;
      setSelectedNodeId(null);
      setActiveRunId(null);
      // Freshly loaded from DB → not dirty.
      dirtyRef.current = false;
    },
    [setNodes, setEdges],
  );

  useEffect(() => {
    if (loading) return;
    dirtyRef.current = true;
  }, [nodes, edges, swarmName, loading]);
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  // Load existing swarms + knowledge bases.
  // IMPORTANT: depend on `user?.id` (a stable string), NOT the `user` object
  // reference. Supabase fires onAuthStateChange on tab refocus / token refresh
  // and produces a new user object — without this guard, the effect would
  // re-run and reload from the DB, wiping in-progress canvas edits.
  const userId = user?.id;
  useEffect(() => {
    if (!userId) return;
    const loadKey = `${userId}|${initialTemplate ?? ""}|${initialSwarmId ?? ""}|${initialLab ?? ""}`;
    if (loadedKeyRef.current === loadKey) return;
    loadedKeyRef.current = loadKey;
    (async () => {
      const [{ data: swarmRows }, { data: kbs }, { data: agentRows }] = await Promise.all([
        supabase.from("swarms").select("*").order("created_at", { ascending: true }),
        supabase.from("knowledge_bases").select("id, name"),
        supabase
          .from("agents")
          .select(
            "id, name, description, llm_provider, llm_model, temperature, system_prompt, knowledge_base_id, tools",
          )
          .order("created_at", { ascending: false }),
      ]);
      setKnowledgeBases(kbs ?? []);
      setAgentLibrary(agentRows ?? []);
      const rows = swarmRows ?? [];
      setSwarmList(rows.map((r) => ({ id: r.id, name: r.name })));

      // If there's a template query param, populate the canvas without
      // creating a new DB row. The user can hit Save to persist as their own swarm.
      if (initialTemplate) {
        const tpl = getSwarmTemplate(initialTemplate);
        if (tpl) {
          setSwarmId(null);
          setSwarmName(tpl.title);
          setNodes(tpl.nodes);
          setEdges(tpl.edges.map(withDefaultEdgeStyle));
          setRunInput(tpl.exampleInput);
          setTourSteps(tpl.tour);
          setTourTitle(tpl.title);
          setTourCaseStudies(tpl.caseStudies ?? []);
          setTourOpen(true);
          idCounter.current = tpl.nodes.length + 1;
          setLoading(false);
          toast.success(`Loaded template: ${tpl.title}`, {
            description: "Click Save to keep this as your own swarm.",
          });
          return;
        }
      }

      // If a failure-mode lab was requested, load the broken swarm and open
      // the lab panel (no tour). Mirrors the template-load path above.
      if (initialLab) {
        const lab = getFailureLab(initialLab);
        if (lab) {
          setSwarmId(null);
          setSwarmName(`Lab · ${lab.title}`);
          setNodes(lab.nodes);
          setEdges(lab.edges.map(withDefaultEdgeStyle));
          setRunInput(lab.exampleInput);
          setActiveLab(lab);
          setLabResult(null);
          setLabHasRun(false);
          labHintsUsedRef.current = 0;
          labRevealedRef.current = false;
          idCounter.current = lab.nodes.length + 1;
          setLoading(false);
          toast.info(`Failure Lab: ${lab.title}`, {
            description: "Diagnose the bug, fix the canvas, and re-run to check.",
          });
          return;
        }
      }

      // If a specific swarm id was requested, load it
      if (initialSwarmId) {
        const target = rows.find((r) => r.id === initialSwarmId);
        if (target) {
          applySwarmRow(target);
          setLoading(false);
          return;
        }
      }

      if (rows.length > 0) {
        applySwarmRow(rows[0]);
      } else {
        const { data: created } = await supabase
          .from("swarms")
          .insert({
            user_id: userId,
            name: "My First Swarm",
            nodes: [],
            edges: [],
          })
          .select()
          .single();
        if (created) {
          setSwarmId(created.id);
          setSwarmList([{ id: created.id, name: created.name }]);
        }
      }
      setLoading(false);
    })();
  }, [userId, initialTemplate, initialSwarmId, initialLab, setNodes, setEdges, applySwarmRow]);

  const handleSwitchSwarm = async (id: string) => {
    if (id === swarmId) return;
    const { data } = await supabase.from("swarms").select("*").eq("id", id).maybeSingle();
    if (data) applySwarmRow(data);
  };

  const handleNewSwarm = async () => {
    if (!user) return;
    const { data: created } = await supabase
      .from("swarms")
      .insert({
        user_id: user.id,
        name: `Swarm ${swarmList.length + 1}`,
        nodes: [],
        edges: [],
      })
      .select()
      .single();
    if (created) {
      setSwarmList((prev) => [...prev, { id: created.id, name: created.name }]);
      setSwarmId(created.id);
      setSwarmName(created.name);
      setNodes([]);
      setEdges([]);
      setSelectedNodeId(null);
      setActiveRunId(null);
      idCounter.current = 1;
      toast.success("New swarm created");
    }
  };

  const performDeleteSwarm = async () => {
    if (!swarmId || !user) return;
    await supabase.from("swarms").delete().eq("id", swarmId);
    const remaining = swarmList.filter((s) => s.id !== swarmId);
    setSwarmList(remaining);
    if (remaining.length > 0) {
      await handleSwitchSwarm(remaining[0].id);
    } else {
      const { data: created } = await supabase
        .from("swarms")
        .insert({
          user_id: user.id,
          name: "My First Swarm",
          nodes: [],
          edges: [],
        })
        .select()
        .single();
      if (created) {
        setSwarmList([{ id: created.id, name: created.name }]);
        setSwarmId(created.id);
        setSwarmName(created.name);
        setNodes([]);
        setEdges([]);
      }
    }
    toast.success("Swarm deleted");
  };

  const selectedNode = useMemo(
    () => nodes.find((n) => n.id === selectedNodeId) ?? null,
    [nodes, selectedNodeId],
  );

  const onConnect = useCallback(
    (params: Connection) => {
      setEdges((eds: Edge[]) => {
        // Auto-label edges leaving routing nodes so the runtime has a route
        // name to work with. Condition nodes use the sourceHandle ("yes"/"no");
        // router nodes get a fresh "route-N" placeholder the user can rename.
        const srcNode = nodes.find((n) => n.id === params.source);
        let label: string | undefined;
        if (srcNode?.data.kind === "condition" && params.sourceHandle) {
          label = params.sourceHandle; // "yes" | "no"
        } else if (srcNode?.data.kind === "router") {
          const existing = eds
            .filter((e) => e.source === params.source && typeof e.label === "string")
            .map((e) => String(e.label));
          let n = existing.length + 1;
          while (existing.includes(`route-${n}`)) n += 1;
          label = `route-${n}`;
        }
        return addEdge({ ...params, ...defaultEdgeStyle, ...(label ? { label } : {}) }, eds);
      });
      // Auto-wire the target node's `inputs` to include the source node's
      // `outputVar` so downstream nodes (especially `output`) receive the
      // upstream value without the user having to type the variable name.
      if (params.source && params.target) {
        setNodes((nds: Node<SwarmNodeData>[]) => {
          const src = nds.find((n) => n.id === params.source);
          if (!src) return nds;
          const srcVar =
            src.data.outputVar || (src.data.kind === "input" ? "input" : `out_${src.id.slice(-4)}`);
          return nds.map((n) => {
            if (n.id !== params.target) return n;
            const existing = Array.isArray(n.data.inputs) ? n.data.inputs : [];
            if (existing.includes(srcVar)) return n;
            return { ...n, data: { ...n.data, inputs: [...existing, srcVar] } };
          });
        });
      }
    },
    [setEdges, setNodes, nodes],
  );

  // Click an edge to rename its route label. Used by router nodes (route name)
  // and condition nodes (yes/no). Other edges can also be labeled freely.
  const onEdgeClick = useCallback((_e: React.MouseEvent, edge: Edge) => {
    const current = typeof edge.label === "string" ? edge.label : "";
    setEdgeLabelTarget({ id: edge.id, value: current });
  }, []);

  const commitEdgeLabel = useCallback(() => {
    if (!edgeLabelTarget) return;
    const trimmed = edgeLabelTarget.value.trim();
    setEdges((eds: Edge[]) =>
      eds.map((e) => (e.id === edgeLabelTarget.id ? { ...e, label: trimmed || undefined } : e)),
    );
    setEdgeLabelTarget(null);
  }, [edgeLabelTarget, setEdges]);

  const addNode = useCallback(
    (item: PaletteItem, pos?: { x: number; y: number }) => {
      const id = `n_${Date.now()}_${idCounter.current++}`;
      const newNode: Node<SwarmNodeData> = {
        id,
        type: item.kind,
        position: pos ?? { x: 200 + Math.random() * 300, y: 100 + Math.random() * 300 },
        data: {
          label: item.label,
          kind: item.kind,
          avatar: item.avatar,
          status: "idle",
          outputVar: item.defaults.outputVar ?? `out_${id.slice(-4)}`,
          ...item.defaults,
        },
      };
      setNodes((nds: Node<SwarmNodeData>[]) => [...nds, newNode]);
      setSelectedNodeId(id);
    },
    [setNodes],
  );

  const onDragStart = (event: React.DragEvent, item: PaletteItem) => {
    event.dataTransfer.setData("application/swarmnode", JSON.stringify(item));
    event.dataTransfer.effectAllowed = "move";
  };

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }, []);

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      const raw = event.dataTransfer.getData("application/swarmnode");
      if (!raw) return;
      const item = JSON.parse(raw) as PaletteItem;
      const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
      addNode(item, { x: event.clientX - bounds.left - 90, y: event.clientY - bounds.top - 40 });
    },
    [addNode],
  );

  const updateSelectedNode = useCallback(
    (patch: Partial<SwarmNodeData>) => {
      if (!selectedNodeId) return;
      setNodes((nds: Node<SwarmNodeData>[]) =>
        nds.map((n) => (n.id === selectedNodeId ? { ...n, data: { ...n.data, ...patch } } : n)),
      );
    },
    [selectedNodeId, setNodes],
  );

  const deleteSelected = useCallback(() => {
    if (!selectedNodeId) return;
    setNodes((nds: Node<SwarmNodeData>[]) => nds.filter((n) => n.id !== selectedNodeId));
    setEdges((eds: Edge[]) =>
      eds.filter((e: Edge) => e.source !== selectedNodeId && e.target !== selectedNodeId),
    );
    setSelectedNodeId(null);
  }, [selectedNodeId, setNodes, setEdges]);

  const handleSave = async () => {
    if (!user) return;
    setSaving(true);
    const cleanEdges = edges.map(({ id, source, target, sourceHandle, targetHandle }) => ({
      id,
      source,
      target,
      sourceHandle,
      targetHandle,
    }));
    // Strip transient runtime fields before persisting
    const cleanNodes = nodes.map((n) => ({
      ...n,
      data: { ...n.data, status: "idle", lastOutput: undefined },
    }));

    if (!swarmId) {
      // Template loaded (or fresh canvas) but never saved — create a new row now.
      const { data: created, error } = await supabase
        .from("swarms")
        .insert({
          user_id: user.id,
          name: swarmName,
          nodes: cleanNodes as never,
          edges: cleanEdges as never,
        })
        .select()
        .single();
      setSaving(false);
      if (error || !created) {
        toast.error("Failed to save");
        return;
      }
      setSwarmId(created.id);
      setSwarmList((prev) => [...prev, { id: created.id, name: created.name }]);
      dirtyRef.current = false;
      toast.success("Swarm saved to your library");
      return;
    }

    const { error } = await supabase
      .from("swarms")
      .update({ name: swarmName, nodes: cleanNodes as never, edges: cleanEdges as never })
      .eq("id", swarmId);
    setSaving(false);
    if (error) {
      toast.error("Failed to save");
    } else {
      setSwarmList((prev) => prev.map((s) => (s.id === swarmId ? { ...s, name: swarmName } : s)));
      dirtyRef.current = false;
      toast.success("Swarm saved");
    }
  };

  const handleLoadTemplate = (templateId: string) => {
    const tpl = getSwarmTemplate(templateId);
    if (!tpl) return;
    setSwarmName(tpl.title);
    setNodes(tpl.nodes);
    setEdges(tpl.edges.map(withDefaultEdgeStyle));
    setRunInput(tpl.exampleInput);
    setSelectedNodeId(null);
    setActiveRunId(null);
    setTourSteps(tpl.tour);
    setTourTitle(tpl.title);
    setTourCaseStudies(tpl.caseStudies ?? []);
    setTourOpen(true);
    idCounter.current = tpl.nodes.length + 1;
    toast.success(`Loaded ${tpl.title}`, {
      description: "Guided tour open at the bottom of the canvas.",
    });
  };

  const handleFocusNode = useCallback(
    (nodeId: string) => {
      setSelectedNodeId(nodeId);
      const node = nodes.find((n) => n.id === nodeId);
      if (node) {
        // The guided-tour card sits at bottom-right (~440px wide). Shift the
        // camera target to the right (in world-space) so the focused node lands
        // in the visible left portion of the canvas, never behind the panel.
        const xOffset = tourOpen ? 260 : 90;
        reactFlow.setCenter(node.position.x + xOffset, node.position.y + 40, {
          zoom: 1.15,
          duration: 600,
        });
      }
    },
    [nodes, reactFlow, tourOpen],
  );

  // While a swarm is running, pan/zoom the camera to follow the currently
  // executing node(s) so users can watch execution progress without manually
  // scrolling the canvas.
  useEffect(() => {
    if (!running) return;
    if (runningNodeIds.size === 0) return;
    const ids = Array.from(runningNodeIds);
    const targets = ids
      .map((id) => nodes.find((n) => n.id === id))
      .filter((n): n is Node<SwarmNodeData> => Boolean(n));
    if (targets.length === 0) return;
    const xOffset = tourOpen ? 220 : 60;
    if (targets.length === 1) {
      const node = targets[0];
      reactFlow.setCenter(node.position.x + xOffset, node.position.y + 40, {
        zoom: 1.25,
        duration: 700,
      });
    } else {
      reactFlow.fitView({
        nodes: targets.map((n) => ({ id: n.id })),
        padding: 0.4,
        duration: 700,
        maxZoom: 1.25,
        minZoom: 0.6,
      });
    }
    // Re-run when the *set* of running ids changes, not on every node mutation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, Array.from(runningNodeIds).sort().join("|")]);

  // Reflect the live run's per-node status/output onto the canvas nodes. This
  // works both for a run we just started AND for one we re-attach to after
  // navigating back into the canvas while it's still executing.
  useEffect(() => {
    if (!activeRun) return;
    setNodes((nds: Node<SwarmNodeData>[]) =>
      nds.map((n) => {
        const st = activeRun.nodeStatus[n.id];
        if (!st) return n;
        const lastOutput = activeRun.nodeOutput[n.id] ?? n.data.lastOutput;
        if (n.data.status === st && n.data.lastOutput === lastOutput) return n;
        return { ...n, data: { ...n.data, status: st, lastOutput } };
      }),
    );
  }, [activeRun, setNodes]);

  // Surface node warnings and run errors as toasts. We skip the backlog when a
  // run first comes into view (e.g. on re-attach) so we don't re-toast history.
  const toastRunRef = useRef<{ id: string | null; seen: number }>({ id: null, seen: 0 });
  useEffect(() => {
    if (!activeRun) return;
    if (toastRunRef.current.id !== activeRun.runId) {
      toastRunRef.current = { id: activeRun.runId, seen: activeRun.events.length };
      return;
    }
    for (let i = toastRunRef.current.seen; i < activeRun.events.length; i++) {
      const e = activeRun.events[i];
      if (e.type === "node_warning") toast.warning(e.warning);
      else if (e.type === "run_error") toast.error(e.error);
    }
    toastRunRef.current.seen = activeRun.events.length;
  }, [activeRun]);

  // Failure-Mode Lab: the run now executes in the background manager, so we
  // evaluate once the run this canvas started reaches a terminal state.
  const pendingLabRunRef = useRef<string | null>(null);

  const handleRun = async () => {
    if (nodes.length === 0) return;
    const usingForm = inputFields.length > 0;
    if (usingForm) {
      const missing = inputFields.filter((f) => f.required && !(fieldValues[f.name] ?? "").trim());
      if (missing.length > 0) {
        toast.warning(`Fill in: ${missing.map((f) => f.label || f.name).join(", ")}`);
        return;
      }
    } else if (!runInput.trim()) {
      return;
    }
    // The primary field seeds `input`; every field is also seeded by name.
    const effectiveInput = usingForm ? (fieldValues[inputFields[0].name] ?? "") : runInput;
    const initialState = usingForm ? { ...fieldValues } : undefined;

    // Pre-run DAG validation: warn ONLY about nodes that declare inputs but
    // have no incoming edge at all — i.e. genuinely orphaned nodes that can
    // never receive upstream data. We deliberately do NOT match declared input
    // variable *names* against upstream outputVars: the runtime's
    // gatherInputs() falls back to the previous node's output, so a name
    // mismatch is normal and expected on most well-built swarms. Matching on
    // names produced a false-positive warning on essentially every run.
    // Never blocks execution.
    const edgeTargets = new Set(edges.map((e) => e.target));
    const orphanInputNodes = nodes.filter(
      (n) => (n.data.inputs?.length ?? 0) > 0 && !edgeTargets.has(n.id),
    );
    if (orphanInputNodes.length > 0) {
      const labels = orphanInputNodes.map((n) => `"${n.data.label}"`).join(", ");
      toast.warning(
        `${orphanInputNodes.length} node${orphanInputNodes.length > 1 ? "s" : ""} (${labels}) declare inputs but have no incoming connection — they will only see the run's initial input. Wire an edge into them if that's not intended.`,
        { duration: 6000 },
      );
    }

    // Reset canvas node statuses for the new run.
    setNodes((nds: Node<SwarmNodeData>[]) =>
      nds.map((n) => ({ ...n, data: { ...n.data, status: "idle", lastOutput: undefined } })),
    );
    if (activeLab) {
      setLabResult(null);
      setLabHasRun(false);
    }

    // Hand execution to the module-level manager so it survives navigation.
    const runId = await startManagedRun({
      swarmId: swarmId ?? null,
      swarmName,
      nodes,
      edges,
      input: effectiveInput,
      initialState,
      traceEnabled,
    });
    setActiveRunId(runId);
    if (activeLab) pendingLabRunRef.current = runId;
  };

  // Upsert a lab attempt row (mirrors the quiz_attempts pattern). Best-effort.
  // lab_attempts isn't in the generated Supabase types until Lovable runs the
  // migration, so we access it through a minimal typed shim.
  const persistLabAttempt = async (labId: string, solved: boolean) => {
    if (!userId) return;
    type LabRow = { id: string; attempts: number | null; solved: boolean | null };
    type LabBuilder = {
      select: (cols: string) => {
        eq: (
          c: string,
          v: string,
        ) => {
          eq: (c: string, v: string) => { maybeSingle: () => Promise<{ data: LabRow | null }> };
        };
      };
      update: (row: Record<string, unknown>) => {
        eq: (c: string, v: string) => Promise<{ error: unknown }>;
      };
      insert: (row: Record<string, unknown>) => Promise<{ error: unknown }>;
    };
    const labTable = () => supabase.from("lab_attempts" as never) as unknown as LabBuilder;
    try {
      const { data: existing } = await labTable()
        .select("id, attempts, solved")
        .eq("user_id", userId)
        .eq("lab_id", labId)
        .maybeSingle();
      const row = {
        user_id: userId,
        lab_id: labId,
        solved: solved || existing?.solved || false,
        hints_used: labHintsUsedRef.current,
        revealed: labRevealedRef.current,
        attempts: (existing?.attempts ?? 0) + 1,
        updated_at: new Date().toISOString(),
      };
      if (existing) {
        await labTable().update(row).eq("id", existing.id);
      } else {
        await labTable().insert(row);
      }
      window.dispatchEvent(new CustomEvent("lab-progress-updated"));
    } catch {
      /* table may not be migrated yet — non-fatal */
    }
  };

  // Evaluate a Failure-Mode Lab once the background run it launched finishes.
  useEffect(() => {
    if (!activeLab || !pendingLabRunRef.current) return;
    const r = managedRuns.find((x) => x.runId === pendingLabRunRef.current);
    if (!r) return;
    if (r.status === "success" || r.status === "error" || r.status === "cancelled") {
      pendingLabRunRef.current = null;
      const evaln = evaluateLab(activeLab, {
        finalOutput: r.finalOutput ?? "",
        events: r.events,
        nodes,
        edges,
      });
      setLabResult(evaln);
      setLabHasRun(true);
      void persistLabAttempt(activeLab.id, evaln.passed);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [managedRuns, activeLab, nodes, edges]);

  const handleStop = () => {
    if (activeRunId) cancelManagedRun(activeRunId);
  };

  const runPanelRef = useRef<HTMLDivElement | null>(null);

  const handleRunOrFocus = () => {
    const ready = nodes.length > 0 && (inputFields.length > 0 ? true : runInput.trim().length > 0);
    if (ready) {
      handleRun();
    } else {
      // Scroll the run panel into view
      runPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
      toast.info("Enter your input in the Run panel below to execute this swarm.");
    }
  };

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const getPortable = () => {
    if (nodes.length === 0) {
      toast.error("Nothing to export — this swarm is empty.");
      return null;
    }
    return exportSwarm({
      name: swarmName,
      nodes,
      edges,
      exportedBy: user?.email || "AgentSwarms user",
    });
  };

  const handleExport = () => {
    const portable = getPortable();
    if (!portable) return;
    downloadSwarmAsJson(portable);
    toast.success("Swarm exported as JSON");
  };

  const handleExportLangGraph = (lang: "python" | "typescript") => {
    const portable = getPortable();
    if (!portable) return;
    downloadSwarmAsLangGraph(portable, lang);
    toast.success(`Swarm exported as LangGraph ${lang === "python" ? "Python" : "TypeScript"}`);
  };

  const handleExportCrewAI = () => {
    const portable = getPortable();
    if (!portable) return;
    downloadSwarmAsCrewAI(portable);
    toast.success("Swarm exported as CrewAI (Python)");
  };

  const handleExportOpenAIAgents = () => {
    const portable = getPortable();
    if (!portable) return;
    downloadSwarmAsOpenAIAgents(portable);
    toast.success("Swarm exported as OpenAI Agents SDK (Python)");
  };

  const handleExportStrands = (lang: "python" | "typescript") => {
    const portable = getPortable();
    if (!portable) return;
    downloadSwarmAsStrands(portable, lang);
    toast.success(`Swarm exported as Strands SDK ${lang === "python" ? "Python" : "TypeScript"}`);
  };

  const handleImportClick = () => fileInputRef.current?.click();

  const handleImportFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = ""; // allow re-importing the same file
    if (!file || !user) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const imported = importSwarm(parsed);
      const { data: created, error } = await supabase
        .from("swarms")
        .insert({
          user_id: user.id,
          name: imported.name,
          nodes: imported.nodes as never,
          edges: imported.edges as never,
        })
        .select()
        .single();
      if (error || !created) throw new Error(error?.message || "Failed to save imported swarm");
      setSwarmList((prev) => [...prev, { id: created.id, name: created.name }]);
      applySwarmRow(created);
      toast.success(`Imported "${imported.name}"`, {
        description: `${imported.nodes.length} nodes · ${imported.edges.length} edges`,
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to import swarm");
    }
  };

  if (loading) {
    return (
      <div className="flex h-[calc(100vh-3rem)] items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <>
      <Dialog
        open={!!edgeLabelTarget}
        onOpenChange={(o) => {
          if (!o) setEdgeLabelTarget(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Edit edge label</DialogTitle>
            <DialogDescription>
              Used as the route name by Router / Condition nodes. Leave empty to clear.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="edge-label-input">Label</Label>
            <Input
              id="edge-label-input"
              autoFocus
              value={edgeLabelTarget?.value ?? ""}
              onChange={(e) =>
                setEdgeLabelTarget((prev) => (prev ? { ...prev, value: e.target.value } : prev))
              }
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitEdgeLabel();
                }
              }}
              placeholder="e.g. billing, yes, route-1"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEdgeLabelTarget(null)}>
              Cancel
            </Button>
            <Button onClick={commitEdgeLabel}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <div className="flex h-[calc(100vh-3rem)] w-full">
        {/* Palette */}
        <aside className="w-64 border-r border-border bg-card/40 flex flex-col overflow-y-auto">
          <div className="p-3 border-b border-border">
            <h3 className="text-sm font-semibold">Node palette</h3>
            <p className="text-[11px] text-muted-foreground">Drag onto canvas or click to add</p>
          </div>
          <div className="p-2 space-y-2">
            {PALETTE_GROUPS.map((group) => (
              <div key={group.label} className="space-y-1">
                <p className="px-1 pt-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {group.label}
                </p>
                {group.kinds.map((kind) => {
                  const p = PALETTE.find((item) => item.kind === kind);
                  if (!p) return null;
                  const accent = PALETTE_ACCENTS[p.kind];
                  return (
                    <Card
                      key={p.kind}
                      draggable
                      onDragStart={(e) => onDragStart(e, p)}
                      onClick={() => addNode(p)}
                      className="p-2 cursor-grab active:cursor-grabbing hover:border-primary/50 hover:bg-muted/50 transition-all border-border/50"
                    >
                      <div className="flex items-center gap-2">
                        <span
                          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${accent.chip}`}
                        >
                          <accent.Icon className="h-3.5 w-3.5" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="text-xs font-medium truncate">{p.label}</p>
                          <p className="text-[10px] text-muted-foreground truncate">
                            {p.description}
                          </p>
                        </div>
                      </div>
                    </Card>
                  );
                })}
              </div>
            ))}
          </div>

          <div className="p-3 border-t border-border">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground flex items-center gap-1">
              <Sparkles className="h-3 w-3" /> Tip
            </p>
            <p className="text-[10px] text-muted-foreground mt-1">
              Drag nodes onto the canvas to build your swarm. Hit <strong>Save</strong> to keep your
              changes, or go back to the <strong>Gallery</strong> to switch swarms or load a
              template.
            </p>
          </div>

          <div className="mt-auto p-3 border-t border-border space-y-1 text-[11px] text-muted-foreground">
            <div className="flex justify-between">
              <span>Nodes:</span>
              <span className="font-mono">{nodes.length}</span>
            </div>
            <div className="flex justify-between">
              <span>Edges:</span>
              <span className="font-mono">{edges.length}</span>
            </div>
          </div>
        </aside>

        {/* Canvas + bottom run dock */}
        <div className="flex-1 flex flex-col min-w-0 min-h-0">
          <div className="relative flex-1 min-h-0" onDrop={onDrop} onDragOver={onDragOver}>
            <div className="absolute top-3 left-3 right-3 z-10 flex items-center gap-2 flex-wrap pr-2">
              <Button
                onClick={onBackToGallery}
                variant="outline"
                size="sm"
                className="h-8 bg-card/80 backdrop-blur"
                title="Back to swarm gallery"
              >
                <ArrowLeft className="h-3.5 w-3.5 mr-1.5" /> Gallery
              </Button>
              <Input
                value={swarmName}
                onChange={(e) => setSwarmName(e.target.value)}
                className="h-8 w-64 text-sm font-semibold bg-card/80 backdrop-blur"
                placeholder="Swarm name"
              />
              <Badge variant="outline" className="text-[10px] hidden xl:inline-flex">
                {nodes.length} nodes
              </Badge>
              <div className="ml-auto flex items-center gap-2">
                {/* ── More options dropdown ── */}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 w-8 p-0 bg-card/80 backdrop-blur"
                      title="More options"
                    >
                      <MoreVertical className="h-3.5 w-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-52">
                    {tourSteps.length > 0 && !tourOpen && (
                      <DropdownMenuItem onClick={() => setTourOpen(true)}>
                        <GraduationCap className="h-4 w-4 mr-2" /> Tour
                      </DropdownMenuItem>
                    )}
                    {!isFullscreen && !learnVisible && (
                      <DropdownMenuItem onClick={onToggleLearn}>
                        <BookOpen className="h-4 w-4 mr-2" /> Show Lesson
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem onClick={onToggleFullscreen}>
                      {isFullscreen ? (
                        <Minimize2 className="h-4 w-4 mr-2" />
                      ) : (
                        <Maximize2 className="h-4 w-4 mr-2" />
                      )}
                      {isFullscreen ? "Exit Fullscreen" : "Fullscreen"}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={handleImportClick}>
                      <Upload className="h-4 w-4 mr-2" /> Import
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={handleExport}>
                      <Download className="h-4 w-4 mr-2" /> Export JSON
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => handleExportLangGraph("python")}>
                      <Code2 className="h-4 w-4 mr-2" /> Export LangGraph Python
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => handleExportLangGraph("typescript")}>
                      <Code2 className="h-4 w-4 mr-2" /> Export LangGraph TypeScript
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={handleExportCrewAI}>
                      <Code2 className="h-4 w-4 mr-2" /> Export CrewAI (Python)
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={handleExportOpenAIAgents}>
                      <Code2 className="h-4 w-4 mr-2" /> Export OpenAI Agents SDK (Python)
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => handleExportStrands("python")}>
                      <Code2 className="h-4 w-4 mr-2" /> Export Strands SDK (Python)
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => handleExportStrands("typescript")}>
                      <Code2 className="h-4 w-4 mr-2" /> Export Strands SDK (TypeScript)
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>

                <input
                  ref={fileInputRef}
                  type="file"
                  accept="application/json,.json"
                  className="hidden"
                  onChange={handleImportFile}
                />

                {/* ── Delete (only for saved swarms) ── */}
                {swarmId ? (
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 w-8 p-0 text-destructive hover:text-destructive bg-card/80 backdrop-blur"
                        title="Delete swarm"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Delete this swarm?</AlertDialogTitle>
                        <AlertDialogDescription>
                          <span className="font-semibold text-foreground">{swarmName}</span> will be
                          permanently removed along with its nodes and edges. This action cannot be
                          undone.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                          onClick={performDeleteSwarm}
                          className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        >
                          Delete swarm
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                ) : (
                  <Badge
                    variant="outline"
                    className="h-8 px-2 text-[10px] bg-card/80 backdrop-blur gap-1"
                  >
                    <Sparkles className="h-3 w-3 text-primary" /> Template — Save to copy
                  </Badge>
                )}

                {/* ── Save ── */}
                <Button
                  onClick={handleSave}
                  variant="outline"
                  size="sm"
                  className="h-8"
                  disabled={saving}
                >
                  {saving ? (
                    <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                  ) : (
                    <Save className="h-3.5 w-3.5 mr-1.5" />
                  )}
                  Save
                </Button>

                {/* ── Deploy (saved swarms only) ── */}
                {swarmId && (
                  <Button
                    onClick={() => setDeployOpen(true)}
                    variant="outline"
                    size="sm"
                    className="h-8"
                    title="Deploy via API key or schedule"
                  >
                    <Rocket className="h-3.5 w-3.5 mr-1.5" /> Deploy
                  </Button>
                )}

                {/* ── Run ── */}
                <Button onClick={handleRunOrFocus} className="h-8 shadow-lg" size="sm">
                  <Play className="h-3.5 w-3.5 mr-1.5" /> Run
                </Button>
              </div>
            </div>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onNodeClick={(_: React.MouseEvent, n: Node) => setSelectedNodeId(n.id)}
              onEdgeClick={onEdgeClick}
              onPaneClick={() => setSelectedNodeId(null)}
              nodeTypes={nodeTypes}
              fitView
              fitViewOptions={{ padding: 0.2 }}
              colorMode={theme}
              proOptions={{ hideAttribution: true }}
            >
              <Background
                gap={20}
                size={1}
                color={theme === "dark" ? "oklch(0.4 0.02 260)" : "oklch(0.85 0.01 260)"}
              />
              <Controls className="!bg-card !border-border" />
              <MiniMap
                pannable
                zoomable
                className="!bg-card !border-border"
                maskColor={theme === "dark" ? "oklch(0 0 0 / 0.6)" : "oklch(0.95 0.01 260 / 0.6)"}
                nodeColor={() => "oklch(0.62 0.22 265)"}
                nodeStrokeColor={() => "oklch(0.7 0.18 265)"}
                nodeStrokeWidth={3}
                nodeBorderRadius={6}
              />
            </ReactFlow>
            {tourOpen && tourSteps.length > 0 && (
              <SwarmTour
                steps={tourSteps}
                templateTitle={tourTitle}
                caseStudies={tourCaseStudies}
                onFocusNode={handleFocusNode}
                onClose={() => setTourOpen(false)}
                activeNodeIds={runningNodeIds}
                isRunning={running}
              />
            )}
            {activeLab && (
              <FailureLabPanel
                lab={activeLab}
                result={labResult}
                isRunning={running}
                hasRun={labHasRun}
                onClose={() => setActiveLab(null)}
                onHintsUsedChange={(n) => {
                  labHintsUsedRef.current = n;
                }}
                onRevealed={() => {
                  labRevealedRef.current = true;
                }}
              />
            )}
          </div>

          {/* Bottom horizontal run dock — always available */}
          <div ref={runPanelRef}>
            <RunPanel
              layout="bottom"
              input={runInput}
              setInput={setRunInput}
              isRunning={running}
              events={events}
              finalOutput={finalOutput}
              onRun={handleRun}
              onStop={handleStop}
              exampleInput={SWARM_TEMPLATES.find((t) => t.title === swarmName)?.exampleInput}
              traceRunId={traceRunId}
              traceEnabled={traceEnabled}
              onTraceEnabledChange={setTraceEnabled}
              state={activeRun?.state}
              inputFields={inputFields}
              fieldValues={fieldValues}
              onFieldChange={(name, val) => setFieldValues((v) => ({ ...v, [name]: val }))}
            />
          </div>
        </div>

        {/* Right side: inspector when a node is selected */}
        {selectedNode && (
          <NodeInspector
            node={selectedNode}
            knowledgeBases={knowledgeBases}
            agentLibrary={agentLibrary}
            onChange={updateSelectedNode}
            onDelete={deleteSelected}
            onClose={() => setSelectedNodeId(null)}
          />
        )}
      </div>
    </>
  );
}

function SwarmsPage() {
  const { template, swarm, lab, view } = Route.useSearch();
  const navigate = useNavigate();
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [learnVisible, setLearnVisible] = useState(false);

  const showCanvas = view === "canvas" || !!template || !!swarm || !!lab;

  const goToGallery = () => {
    setIsFullscreen(false);
    navigate({
      to: "/swarms",
      search: { template: undefined, swarm: undefined, lab: undefined, view: undefined },
    });
  };

  if (!showCanvas) {
    return <SwarmGallery />;
  }

  if (isFullscreen) {
    return (
      <div className="fixed inset-0 z-50 bg-background">
        <ReactFlowProvider>
          <SwarmsCanvas
            initialTemplate={template}
            initialSwarmId={swarm}
            initialLab={lab}
            isFullscreen
            onToggleFullscreen={() => setIsFullscreen(false)}
            learnVisible={false}
            onToggleLearn={() => undefined}
            onBackToGallery={goToGallery}
          />
        </ReactFlowProvider>
      </div>
    );
  }

  return (
    <div className="flex">
      <div className="flex-1 min-w-0">
        <ReactFlowProvider>
          <SwarmsCanvas
            initialTemplate={template}
            initialSwarmId={swarm}
            initialLab={lab}
            isFullscreen={false}
            onToggleFullscreen={() => setIsFullscreen(true)}
            learnVisible={learnVisible}
            onToggleLearn={() => setLearnVisible((v) => !v)}
            onBackToGallery={goToGallery}
          />
        </ReactFlowProvider>
      </div>
      {learnVisible && (
        <LearnPanel
          topic="Multi-agent swarms"
          tagline="Build, edit, and run real swarms. Click a node to configure it."
          section={learnSwarms}
          onHide={() => setLearnVisible(false)}
          className="w-64 xl:w-72 p-4"
        />
      )}
    </div>
  );
}
