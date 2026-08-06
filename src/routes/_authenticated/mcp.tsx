import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
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
} from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { probeMcpServer } from "@/lib/mcp/probe.functions";
import { saveMcpServer } from "@/lib/mcp/servers.functions";

export const Route = createFileRoute("/_authenticated/mcp")({
  component: McpPage,
});

type McpServerType = "database" | "filesystem" | "git" | "api" | "custom";
type McpAuthType = "none" | "token" | "oauth";

type McpTool = { name: string; description?: string; inputSchema?: Record<string, any> };
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

const TYPE_ICON: Record<McpServerType, any> = {
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
  const { user } = useAuth();
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);

  const load = async () => {
    // Explicit column list — never select auth_token / auth_token_enc into the
    // browser; the bearer token stays server-side.
    const { data, error } = await supabase
      .from("mcp_servers")
      .select(
        "id, name, type, endpoint, description, status, tools_count, tools, auth_type, last_ping",
      )
      .order("created_at", { ascending: false });
    if (error) {
      toast.error("Failed to load MCP servers");
    } else {
      setServers((data ?? []) as McpServer[]);
    }
    setLoading(false);
  };

  useEffect(() => {
    if (!user) return;
    load();
    const channel = supabase
      .channel("mcp-changes")
      .on("postgres_changes", { event: "*", schema: "public", table: "mcp_servers" }, load)
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [user]);

  const probeServer = async (id: string, opts?: { silent?: boolean }) => {
    try {
      const result = await probeMcpServer({ data: { id } });
      if (!opts?.silent) {
        if (result.ok) {
          toast.success(
            result.toolsCount > 0
              ? `Discovered ${result.toolsCount} tool${result.toolsCount === 1 ? "" : "s"}`
              : (result.message ?? "Connected"),
          );
        } else {
          toast.error(`Probe failed: ${result.message ?? "unknown error"}`);
        }
      }
    } catch (e) {
      if (!opts?.silent) toast.error("Failed to probe MCP server");
    }
    await load();
  };

  const toggleStatus = async (server: McpServer) => {
    if (server.status !== "connected") {
      // Re-connect → probe.
      await probeServer(server.id);
      return;
    }
    const { error } = await supabase
      .from("mcp_servers")
      .update({ status: "disconnected", last_ping: new Date().toISOString() })
      .eq("id", server.id);
    if (error) toast.error("Failed to toggle");
    else toast.success("Server disconnected");
    await load();
  };

  const removeServer = async (id: string) => {
    const { error } = await supabase.from("mcp_servers").delete().eq("id", id);
    if (error) toast.error("Failed to remove");
    else toast.success("MCP server removed");
    await load();
  };

  const addServer = async (server: {
    name: string;
    type: McpServerType;
    endpoint: string;
    description: string;
    auth_type: McpAuthType;
    auth_token: string;
  }) => {
    if (!user) return;
    // Save via a server function so the bearer token is encrypted at rest and
    // never stored in the clear.
    const res = await saveMcpServer({
      data: {
        name: server.name,
        type: server.type,
        endpoint: server.endpoint,
        description: server.description,
        auth_type: server.auth_type === "token" ? "token" : "none",
        auth_token: server.auth_token,
      },
    });
    if (!res.ok) {
      toast.error(`Failed to add server: ${res.error}`);
    } else {
      setAddOpen(false);
      toast.success(`Added MCP server: ${server.name}`);
      await load();
      // Best-effort probe so tools_count reflects what the server actually exposes.
      await probeServer(res.id, { silent: false });
    }
  };

  const connectedCount = servers.filter((s) => s.status === "connected").length;
  const totalTools = servers.reduce(
    (acc, s) => acc + (s.status === "connected" ? s.tools_count : 0),
    0,
  );

  return (
    <div className="flex">
      <div className="flex-1 p-6 space-y-6">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-primary">
              Integrations
            </p>
            <h1 className="font-display text-3xl font-semibold tracking-tight">MCP Integrations</h1>
            <p className="text-muted-foreground mt-1">
              Model Context Protocol servers expose tools and resources to your agents. To write
              your own instead of connecting to someone else's, use{" "}
              <Link to="/mcp-builder" className="text-primary hover:underline">
                MCP Builder
              </Link>{" "}
              — servers you register there appear in this list automatically.
            </p>
            <div className="flex gap-2 mt-3">
              <Badge variant="outline" className="text-emerald-400 border-emerald-500/30">
                <Wifi className="h-3 w-3 mr-1" /> {connectedCount} connected
              </Badge>
              <Badge variant="outline" className="text-muted-foreground">
                {totalTools} tools available
              </Badge>
            </div>
          </div>
          <Dialog open={addOpen} onOpenChange={setAddOpen}>
            <DialogTrigger asChild>
              <Button>
                <Plus className="h-4 w-4 mr-1.5" /> Add MCP Server
              </Button>
            </DialogTrigger>
            <AddServerDialog onAdd={addServer} />
          </Dialog>
        </div>

        {loading ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-[220px]" />
            ))}
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {servers.map((server) => {
              const Icon = TYPE_ICON[server.type] ?? Boxes;
              const isConnected = server.status === "connected";
              const isError = server.status === "error";
              return (
                <Card
                  key={server.id}
                  className="border-border/50 hover:border-border transition-colors group"
                >
                  <CardHeader className="pb-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <div className="h-9 w-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                          <Icon className="h-4 w-4 text-primary" />
                        </div>
                        <div className="min-w-0">
                          <CardTitle className="text-sm truncate">{server.name}</CardTitle>
                          <p className="text-[11px] text-muted-foreground capitalize">
                            {server.type} · {server.auth_type}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <span className="relative flex h-2 w-2">
                          {isConnected && (
                            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                          )}
                          <span
                            className={`relative inline-flex rounded-full h-2 w-2 ${
                              isConnected
                                ? "bg-emerald-500"
                                : isError
                                  ? "bg-red-500"
                                  : "bg-muted-foreground/40"
                            }`}
                          />
                        </span>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <p className="text-xs text-muted-foreground line-clamp-2 min-h-[32px]">
                      {server.description}
                    </p>

                    <div className="rounded-md bg-muted/40 px-2 py-1.5">
                      <p
                        className="text-[10px] text-muted-foreground font-mono truncate"
                        title={server.endpoint}
                      >
                        {server.endpoint}
                      </p>
                    </div>

                    <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                      <span>
                        {isConnected ? (
                          <span className="text-emerald-400">● Active</span>
                        ) : isError ? (
                          <span className="text-red-400">● Error</span>
                        ) : (
                          <span>○ Disconnected</span>
                        )}
                      </span>
                      <span>
                        {server.tools_count} tools · {timeAgo(server.last_ping)}
                      </span>
                    </div>

                    {Array.isArray(server.tools) && server.tools.length > 0 && (
                      <div className="rounded-md border border-border/50 bg-background/40 p-2 space-y-1 max-h-64 overflow-y-auto">
                        <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">
                          Available tools
                        </p>
                        <div className="space-y-1">
                          {server.tools.map((t) => (
                            <ToolRow key={t.name} tool={t} />
                          ))}
                        </div>
                      </div>
                    )}

                    <div className="flex gap-1.5 pt-1">
                      <Button
                        variant="outline"
                        size="sm"
                        className="flex-1 h-7 text-xs"
                        onClick={() => toggleStatus(server)}
                      >
                        {isConnected ? (
                          <WifiOff className="h-3 w-3 mr-1" />
                        ) : (
                          <RefreshCw className="h-3 w-3 mr-1" />
                        )}
                        {isConnected ? "Disconnect" : "Connect"}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs"
                        onClick={() => probeServer(server.id)}
                        title="Refresh tool definitions from the MCP server"
                      >
                        <RefreshCw className="h-3 w-3 mr-1" />
                        Refresh
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0 text-destructive opacity-0 group-hover:opacity-100 transition-opacity"
                        onClick={() => removeServer(server.id)}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              );
            })}

            <button
              onClick={() => setAddOpen(true)}
              className="rounded-lg border-2 border-dashed border-border hover:border-primary/40 hover:bg-muted/20 transition-all flex flex-col items-center justify-center gap-2 min-h-[200px] text-muted-foreground hover:text-primary"
            >
              <Plus className="h-8 w-8" />
              <span className="text-sm font-medium">Add MCP Server</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function AddServerDialog({
  onAdd,
}: {
  onAdd: (s: {
    name: string;
    type: McpServerType;
    endpoint: string;
    description: string;
    auth_type: McpAuthType;
    auth_token: string;
  }) => void;
}) {
  const [name, setName] = useState("");
  const [type, setType] = useState<McpServerType>("database");
  const [endpoint, setEndpoint] = useState("");
  const [description, setDescription] = useState("");
  const [authType, setAuthType] = useState<McpAuthType>("none");
  const [token, setToken] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name || !endpoint) return;
    onAdd({ name, type, endpoint, description, auth_type: authType, auth_token: token });
    setName("");
    setEndpoint("");
    setDescription("");
    setToken("");
    setAuthType("none");
    setType("database");
  };

  return (
    <DialogContent className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>Add MCP Server</DialogTitle>
        <DialogDescription className="text-xs">
          Connect a Model Context Protocol server to expose its tools and resources to your agents.
        </DialogDescription>
      </DialogHeader>
      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="space-y-1.5">
          <Label className="text-xs">Server Name *</Label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Production PostgreSQL"
            required
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Server Type</Label>
          <Select value={type} onValueChange={(v: McpServerType) => setType(v)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="database">Database</SelectItem>
              <SelectItem value="filesystem">Filesystem</SelectItem>
              <SelectItem value="git">Git / VCS</SelectItem>
              <SelectItem value="api">External API</SelectItem>
              <SelectItem value="custom">Custom</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">MCP Endpoint URL *</Label>
          <Input
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            placeholder="https://mcp.example.com/mcp  or  sse://mcp.example.com/sse"
            className="font-mono text-xs"
            required
          />
          <p className="text-[10px] text-muted-foreground">
            Must be reachable from the server — an HTTP(S) Streamable or SSE endpoint. stdio servers
            run locally and can&apos;t be called from here.
          </p>
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
  const props = (schema?.properties ?? {}) as Record<string, any>;
  const required = new Set<string>(Array.isArray(schema?.required) ? schema!.required : []);
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
                  const d = def as any;
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
