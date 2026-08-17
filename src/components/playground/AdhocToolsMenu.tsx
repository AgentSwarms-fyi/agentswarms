// The "+ Tools" menu in the chat composer: session-scoped tool switches.
//
// Everything here lasts for THIS conversation only. It never writes to the
// agent — the permanent switches live in the agent builder, and when the agent
// already has one of these tools on permanently the row says so instead of
// offering a toggle that would change nothing.
import { useState } from "react";
import {
  Calculator,
  Clock,
  CloudSun,
  GitBranch,
  Globe,
  Plus,
  Search,
  type LucideIcon,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { ADHOC_SERVER_TOOLS, DIAGRAM_TOOL_ID } from "@/lib/adhocTools";

const TOOL_ICONS: Record<string, LucideIcon> = {
  web_search: Search,
  web_browse: Globe,
  calculator: Calculator,
  datetime: Clock,
  weather: CloudSun,
  [DIAGRAM_TOOL_ID]: GitBranch,
};

export function AdhocToolsMenu({
  // Tool ids currently armed for this conversation (server tools + "diagram").
  active,
  onToggle,
  // Ad-hoc-offerable tools the agent already has on permanently.
  permanent,
  disabled = false,
}: {
  active: string[];
  onToggle: (id: string, next: boolean) => void;
  permanent: Set<string>;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  // Permanent tools don't count toward the badge — the badge answers "what
  // have I added for this chat", not "what can the agent do".
  const addedCount = active.filter((id) => !permanent.has(id)).length;

  const row = (id: string, label: string, description: string) => {
    const Icon = TOOL_ICONS[id] ?? Plus;
    const isPermanent = permanent.has(id);
    const isOn = isPermanent || active.includes(id);
    return (
      <div key={id} className="flex items-start gap-3 rounded-md px-2 py-2 hover:bg-muted/60">
        <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium leading-none">{label}</span>
            {isPermanent && (
              <Badge
                variant="outline"
                className="h-4 px-1 text-[10px] text-muted-foreground"
                title="Enabled permanently in the agent builder — already active in every chat with this agent."
              >
                on for this agent
              </Badge>
            )}
          </div>
          <p className="mt-1 text-xs leading-snug text-muted-foreground">{description}</p>
        </div>
        <Switch
          checked={isOn}
          disabled={disabled || isPermanent}
          onCheckedChange={(next) => onToggle(id, next)}
          aria-label={`${label} for this chat`}
          className="mt-0.5"
        />
      </div>
    );
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant={addedCount > 0 ? "default" : "outline"}
          className="h-7 gap-1.5 text-xs"
          disabled={disabled}
          title="Enable tools for this chat only — the agent's saved configuration is not changed"
          aria-label="Tools for this chat"
        >
          <Plus className="h-3.5 w-3.5" /> Tools
          {addedCount > 0 && (
            <span className="rounded-full bg-primary-foreground/20 px-1.5 text-[10px] leading-4">
              {addedCount}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-80 p-2">
        <p className="px-2 pb-2 pt-1 text-[11px] leading-snug text-muted-foreground">
          For <span className="font-medium text-foreground">this chat only</span>. To enable a tool
          permanently, use the agent builder&rsquo;s tool settings.
        </p>
        <div className="space-y-0.5">
          {ADHOC_SERVER_TOOLS.map((t) => row(t.id, t.label, t.description))}
          {row(
            DIAGRAM_TOOL_ID,
            "Diagrams",
            "Ask for a flowchart, sequence or architecture diagram — it renders right in the chat, downloadable as SVG or PNG.",
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
