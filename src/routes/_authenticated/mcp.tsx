import { createFileRoute, Link } from "@tanstack/react-router";
import { McpServersPanel } from "@/components/settings/McpServersPanel";
import { useEffect, useState } from "react";
import { listClaim } from "@/lib/listClaim";
import { countLabels } from "@/lib/countClaim";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogDescription,
} from "@/components/ui/dialog";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Plus,
  Database,
  FolderTree,
  GitBranch,
  Globe,
  Boxes,
  Trash2,
  RefreshCw,
  Wifi,
  WifiOff,
  ChevronRight,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { confirmAsk } from "@/components/ui/confirm-dialog";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { probeMcpServer } from "@/lib/mcp/probe.functions";
import { saveMcpServer } from "@/lib/mcp/servers.functions";
import type { McpTool } from "@/utils/mcpApps/sse";

export const Route = createFileRoute("/_authenticated/mcp")({
  component: McpPage,
});

type McpServerType = "database" | "filesystem" | "git" | "api" | "custom";
type McpAuthType = "none" | "token" | "oauth";

/** A parameter as a tool's input schema describes it; every part is optional. */
type SchemaParam = {
  type?: string | string[];
  enum?: unknown[];
  anyOf?: unknown[];
  description?: string;
};
type McpServer = {
  id: string;
  name: string;
  type: McpServerType;
  endpoint: string;
  description: string | null;
  status: string;
  tools_count: number;
  tools: McpTool[] | null;
  auth_type: McpAuthType;
  last_ping: string | null;
};

const TYPE_ICON: Record<McpServerType, LucideIcon> = {
  database: Database,
  filesystem: FolderTree,
  git: GitBranch,
  api: Globe,
  custom: Boxes,
};

function timeAgo(iso: string | null) {
  if (!iso) return "never";
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

function McpPage() {
  return (
    <div className="flex">
      <div className="flex-1 p-6 space-y-6">
        <div>
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-primary">
            Integrations
          </p>
          <h1 className="font-display text-3xl font-semibold tracking-tight">MCP Integrations</h1>
          <p className="text-muted-foreground mt-1">
            Model Context Protocol servers expose tools and resources to your agents. To write your
            own instead of connecting to someone else's, use{" "}
            <Link to="/mcp-builder" className="text-primary hover:underline">
              MCP Builder
            </Link>{" "}
            — servers you register there appear in this list automatically.
          </p>
        </div>
        <McpServersPanel showBuilderLink={false} />
      </div>
    </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Description</Label>
          <Textarea
            rows={2}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What tools does this server expose?"
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1.5">
            <Label className="text-xs">Auth Type</Label>
            <Select value={authType} onValueChange={(v: McpAuthType) => setAuthType(v)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None</SelectItem>
                <SelectItem value="token">Bearer Token</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {authType !== "none" && (
            <div className="space-y-1.5">
              <Label className="text-xs">Auth Token</Label>
              <Input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="••••••••"
              />
            </div>
          )}
        </div>
        <Button type="submit" className="w-full">
          Connect Server
        </Button>
      </form>
    </DialogContent>
  );
}

function ToolRow({ tool }: { tool: McpTool }) {
  const [open, setOpen] = useState(false);
  const schema = tool.inputSchema;
  const props = (schema?.properties ?? {}) as Record<string, SchemaParam | undefined>;
  const required = new Set<string>(
    Array.isArray(schema?.required)
      ? schema.required.filter((r): r is string => typeof r === "string")
      : [],
  );
  const paramEntries = Object.entries(props);
  const hasParams = paramEntries.length > 0;

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="rounded border border-border/40 bg-background/60"
    >
      <CollapsibleTrigger className="w-full flex items-center gap-1.5 px-1.5 py-1 text-left hover:bg-muted/40 rounded">
        <ChevronRight
          className={`h-3 w-3 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`}
        />
        <Badge variant="secondary" className="text-[10px] font-mono px-1.5 py-0 h-5 shrink-0">
          {tool.name}
        </Badge>
        {tool.description && (
          <span className="text-[10px] text-muted-foreground truncate">{tool.description}</span>
        )}
      </CollapsibleTrigger>
      <CollapsibleContent className="px-2 pb-2 pt-1">
        {!hasParams ? (
          <p className="text-[10px] text-muted-foreground italic px-1">No parameters</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[10px]">
              <thead>
                <tr className="text-muted-foreground border-b border-border/40">
                  <th className="text-left font-medium py-1 pr-2">Parameter</th>
                  <th className="text-left font-medium py-1 pr-2">Type</th>
                  <th className="text-left font-medium py-1 pr-2">Required</th>
                  <th className="text-left font-medium py-1">Description</th>
                </tr>
              </thead>
              <tbody>
                {paramEntries.map(([name, def]) => {
                  const d = def;
                  const type = d?.type
                    ? Array.isArray(d.type)
                      ? d.type.join(" | ")
                      : String(d.type)
                    : d?.enum
                      ? "enum"
                      : d?.anyOf
                        ? "anyOf"
                        : "any";
                  return (
                    <tr key={name} className="border-b border-border/20 last:border-0 align-top">
                      <td className="py-1 pr-2 font-mono">{name}</td>
                      <td className="py-1 pr-2 font-mono text-muted-foreground">{type}</td>
                      <td className="py-1 pr-2">
                        {required.has(name) ? (
                          <span className="text-amber-400">Yes</span>
                        ) : (
                          <span className="text-muted-foreground">No</span>
                        )}
                      </td>
                      <td className="py-1 text-muted-foreground">
                        {d?.description ||
                          (Array.isArray(d?.enum) ? `One of: ${d.enum.join(", ")}` : "—")}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
