// Global "+" creator menu in the app header.
// Pure navigation — opens existing creation flows on each target page via
// search params (e.g. /agents?new=1). No new state or backend.
import { Link } from "@tanstack/react-router";
import { Plus, Bot, Network, BookOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function GlobalCreateMenu() {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 rounded-md border border-border/60 bg-card/60 hover:border-primary/50 hover:text-primary"
          aria-label="Create something new"
          title="Create new"
        >
          <Plus className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-muted-foreground">
          Create new
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/agents" search={{ new: 1 }} className="flex items-center gap-2 cursor-pointer">
            <Bot className="h-4 w-4 text-primary" />
            <div className="flex flex-col">
              <span className="text-sm font-medium">New Agent</span>
              <span className="text-[10px] text-muted-foreground">LLM + tools + KB</span>
            </div>
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link
            to="/swarms"
            search={{ view: "canvas", new: 1 }}
            className="flex items-center gap-2 cursor-pointer"
          >
            <Network className="h-4 w-4 text-primary" />
            <div className="flex flex-col">
              <span className="text-sm font-medium">New Swarm</span>
              <span className="text-[10px] text-muted-foreground">Multi-agent canvas</span>
            </div>
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link
            to="/knowledge"
            search={{ new: 1 }}
            className="flex items-center gap-2 cursor-pointer"
          >
            <BookOpen className="h-4 w-4 text-primary" />
            <div className="flex flex-col">
              <span className="text-sm font-medium">New Knowledge Base</span>
              <span className="text-[10px] text-muted-foreground">Docs + URLs + GitHub</span>
            </div>
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
