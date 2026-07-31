// Left navigation listing all 7 Agentic AI patterns.
// Click → switches the active pattern on the canvas.
import { AGENTIC_PATTERNS, ACCENT_CLASSES, type AgenticPattern } from "@/lib/agenticPatterns";
import { cn } from "@/lib/utils";
import { GraduationCap } from "lucide-react";

type Props = {
  activeId: string;
  onSelect: (id: string) => void;
};

export function PatternSidebar({ activeId, onSelect }: Props) {
  return (
    <aside className="w-64 shrink-0 border-r border-border bg-card/40 flex flex-col">
      <div className="px-4 py-3 border-b border-border">
        <div className="flex items-center gap-2">
          <GraduationCap className="h-4 w-4 text-primary" />
          <h2 className="text-sm font-bold tracking-tight">Agentic Patterns</h2>
        </div>
        <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
          The reusable shapes every modern AI agent is built from. Pick one to explore.
        </p>
      </div>

      <nav className="flex-1 overflow-y-auto p-2 space-y-1">
        {AGENTIC_PATTERNS.map((p) => (
          <PatternItem
            key={p.id}
            pattern={p}
            isActive={p.id === activeId}
            onClick={() => onSelect(p.id)}
          />
        ))}
      </nav>

      <div className="border-t border-border p-3 text-[10px] text-muted-foreground leading-relaxed">
        <p className="font-semibold text-foreground mb-1">Read-only canvas</p>
        <p>
          Drag nodes to rearrange. You can't edit, connect, or run — this is purely educational.
        </p>
      </div>
    </aside>
  );
}

function PatternItem({
  pattern,
  isActive,
  onClick,
}: {
  pattern: AgenticPattern;
  isActive: boolean;
  onClick: () => void;
}) {
  const c = ACCENT_CLASSES[pattern.accent];
  return (
    <button
      onClick={onClick}
      className={cn(
        "w-full text-left rounded-lg border px-3 py-2 transition-all group",
        isActive
          ? cn(c.border, c.bg, "shadow-md")
          : "border-transparent hover:border-border hover:bg-muted/30",
      )}
    >
      <div className="flex items-center gap-2">
        <span className={cn("h-2 w-2 rounded-full", c.bg, "ring-2", c.ring)} />
        <span
          className={cn("text-xs font-semibold truncate", isActive ? c.text : "text-foreground")}
        >
          {pattern.name}
        </span>
      </div>
      <p className="mt-1 text-[10px] leading-snug text-muted-foreground line-clamp-2">
        {pattern.tagline}
      </p>
    </button>
  );
}
