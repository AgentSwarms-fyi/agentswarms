// Read-only custom node renderer for the Patterns canvas.
// Visual states: default, dimmed (when another node is being highlighted in the tour),
// and active (glowing accent ring + slight scale).
import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import { ACCENT_CLASSES, type AgenticPattern, type PatternNode as PatternNodeData } from "@/lib/agenticPatterns";
import { cn } from "@/lib/utils";

export type PatternFlowNodeData = {
  node: PatternNodeData;
  accent: AgenticPattern["accent"];
  /** "active" → glowing ring; "dimmed" → faded; "idle" → default */
  highlight: "active" | "dimmed" | "idle";
  isSource: boolean;
  isTarget: boolean;
};

export function PatternFlowNode({ data }: NodeProps<Node<PatternFlowNodeData>>) {
  const { node, accent, highlight, isSource, isTarget } = data;
  const Icon = node.icon;
  // Per-node accent overrides the parent pattern accent (used for branching paths).
  const c = ACCENT_CLASSES[node.accent ?? accent];

  return (
    <div
      className={cn(
        "min-w-[180px] max-w-[200px] rounded-xl border-2 bg-card px-3 py-2.5 shadow-md transition-all duration-300",
        highlight === "idle" && "border-border opacity-100",
        highlight === "dimmed" && "border-border opacity-30",
        highlight === "active" && cn(c.border, "ring-4", c.ring, "shadow-xl scale-[1.04]"),
      )}
    >
      {isTarget && (
        <Handle
          type="target"
          position={Position.Left}
          className="!h-2 !w-2 !border-0 !bg-muted-foreground/50"
          isConnectable={false}
        />
      )}

      <div className="flex items-center gap-2">
        <div className={cn("grid h-7 w-7 place-items-center rounded-md", c.bg)}>
          <Icon className={cn("h-4 w-4", c.text)} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-semibold leading-tight">{node.label}</p>
          {node.sublabel && (
            <p className="truncate text-[10px] leading-tight text-muted-foreground">
              {node.sublabel}
            </p>
          )}
        </div>
      </div>

      {isSource && (
        <Handle
          type="source"
          position={Position.Right}
          className="!h-2 !w-2 !border-0 !bg-muted-foreground/50"
          isConnectable={false}
        />
      )}
    </div>
  );
}
