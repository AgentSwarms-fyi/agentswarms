// MCP Builder — the list of servers you have authored.
//
// The counterpart to /mcp: that page connects to somebody else's MCP server,
// this one is where you write your own. A server here is Python (FastMCP) that
// runs on the same sandboxed kernel the Developer workspace uses, reachable
// over Streamable HTTP once deployed.
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import {
  ArrowUpRight,
  Copy,
  Flame,
  Globe,
  Loader2,
  Plug,
  Plus,
  Trash2,
  Wrench,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { MCP_TEMPLATES } from "@/lib/mcpTemplates";
import { cn } from "@/lib/utils";
import {
  mcpAppCreate,
  mcpAppDelete,
  mcpAppList,
  type McpAppSummary,
} from "@/utils/mcpApps.functions";

export const Route = createFileRoute("/_authenticated/mcp-builder")({
  component: McpBuilderPage,
});

const STATUS_STYLES: Record<string, string> = {
  ready: "bg-emerald-500",
  deploying: "bg-amber-500 animate-pulse",
  error: "bg-rose-500",
  stopped: "bg-muted-foreground/40",
  draft: "bg-muted-foreground/40",
};

function McpBuilderPage() {
  const navigate = useNavigate();
  const listFn = useServerFn(mcpAppList);
  const createFn = useServerFn(mcpAppCreate);
  const deleteFn = useServerFn(mcpAppDelete);

  const [apps, setApps] = useState<McpAppSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [name, setName] = useState("");
  const [template, setTemplate] = useState(MCP_TEMPLATES[0].id);
  const [pendingDelete, setPendingDelete] = useState<McpAppSummary | null>(null);

  const load = async () => {
    const res = await listFn({});
    if (res.ok) setApps(res.apps);
    else toast.error(res.error);
    setLoading(false);
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const create = async () => {
    if (!name.trim()) return;
    setCreating(true);
    const res = await createFn({ data: { name: name.trim(), template } });
    setCreating(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    setNewOpen(false);
    setName("");
    void navigate({ to: "/mcp-builder/$appId", params: { appId: res.id } });
  };

  const remove = async (app: McpAppSummary) => {
    const res = await deleteFn({ data: { id: app.id } });
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    toast.success(`Deleted "${app.name}"`);
    setPendingDelete(null);
    void load();
  };

  return (
    <div className="dot-matrix-bg min-h-full p-6 sm:p-8">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 font-display text-2xl font-semibold tracking-tight">
            <Wrench className="h-6 w-6 text-primary" />
            MCP Builder
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Write a server in Python with FastMCP, deploy it to a sandboxed kernel, and call it over
            Streamable HTTP — from your own agents here, or from any MCP client once you expose it.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild variant="ghost" size="sm" className="gap-1.5 text-muted-foreground">
            <Link to="/mcp">
              <Plug className="h-4 w-4" />
              Connected servers
            </Link>
          </Button>
          <Button onClick={() => setNewOpen(true)} className="gap-1.5">
            <Plus className="h-4 w-4" />
            New server
          </Button>
        </div>
      </header>

      {loading ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-40 rounded-xl" />
          ))}
        </div>
      ) : apps.length === 0 ? (
        <EmptyState
          onPick={(id) => {
            setTemplate(id);
            setNewOpen(true);
          }}
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {apps.map((app) => (
            <div
              key={app.id}
              className="group flex flex-col rounded-xl border border-border bg-card p-4 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"
            >
              <div className="flex items-start justify-between gap-2">
                <Link
                  to="/mcp-builder/$appId"
                  params={{ appId: app.id }}
                  className="min-w-0 flex-1"
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        "h-2 w-2 shrink-0 rounded-full",
                        STATUS_STYLES[app.status] ?? "bg-muted-foreground/40",
                      )}
                      title={app.status}
                    />
                    <span className="truncate font-medium text-foreground">{app.name}</span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                    {app.description || "No description."}
                  </p>
                </Link>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7 shrink-0 text-muted-foreground opacity-0 transition group-hover:opacity-100 hover:text-destructive"
                  onClick={() => setPendingDelete(app)}
                  aria-label={`Delete ${app.name}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                <Badge variant="secondary" className="text-[10px]">
                  {app.tools.length} {app.tools.length === 1 ? "tool" : "tools"}
                </Badge>
                {app.keep_warm && (
                  <Badge variant="outline" className="gap-1 text-[10px]">
                    <Flame className="h-3 w-3" />
                    Warm
                  </Badge>
                )}
                {app.is_public && (
                  <Badge variant="outline" className="gap-1 text-[10px]">
                    <Globe className="h-3 w-3" />
                    Public
                  </Badge>
                )}
                {app.registered_server_id && (
                  <Badge variant="outline" className="gap-1 text-[10px]">
                    <Plug className="h-3 w-3" />
                    Agents
                  </Badge>
                )}
              </div>

              {app.status === "error" && app.deploy_error && (
                <p className="mt-2 line-clamp-2 text-[11px] text-destructive">{app.deploy_error}</p>
              )}

              <div className="mt-auto flex items-center justify-between pt-3 text-[11px] text-muted-foreground">
                <span className="truncate font-mono">/{app.slug}</span>
                <Link
                  to="/mcp-builder/$appId"
                  params={{ appId: app.id }}
                  className="inline-flex items-center gap-1 font-medium text-primary opacity-0 transition group-hover:opacity-100"
                >
                  Open <ArrowUpRight className="h-3 w-3" />
                </Link>
              </div>
            </div>
          ))}
        </div>
      )}

      <Dialog open={newOpen} onOpenChange={setNewOpen}>
        <DialogContent className="max-w-lg [&>*]:min-w-0">
          <DialogHeader>
            <DialogTitle>New MCP server</DialogTitle>
            <DialogDescription>
              Start from a template — each one deploys as-is, so you can press Deploy first and edit
              afterwards.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="mcp-name">Name</Label>
              <Input
                id="mcp-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Billing tools"
                onKeyDown={(e) => {
                  if (e.key === "Enter") void create();
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Template</Label>
              <div className="grid gap-2">
                {MCP_TEMPLATES.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setTemplate(t.id)}
                    className={cn(
                      "rounded-lg border p-3 text-left transition",
                      template === t.id
                        ? "border-primary bg-primary/5"
                        : "border-border hover:border-primary/40",
                    )}
                  >
                    <div className="text-sm font-medium text-foreground">{t.title}</div>
                    <div className="text-xs text-muted-foreground">{t.tagline}</div>
                  </button>
                ))}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setNewOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => void create()} disabled={!name.trim() || creating}>
              {creating && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!pendingDelete} onOpenChange={(o) => !o && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete "{pendingDelete?.name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              This stops the server, revokes every API key it issued, and removes it from your
              connected servers. Anything calling it — including your own agents — will start
              failing. The source and its version history are deleted too.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => pendingDelete && void remove(pendingDelete)}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function EmptyState({ onPick }: { onPick: (templateId: string) => void }) {
  return (
    <div className="rounded-xl border border-border bg-card p-8 text-center shadow-sm">
      <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-primary/10 text-primary">
        <Wrench className="h-7 w-7" />
      </div>
      <h2 className="mt-4 text-lg font-semibold text-foreground">Build your first MCP server</h2>
      <p className="mx-auto mt-1 max-w-lg text-sm text-muted-foreground">
        Anything you can reach from Python can become a tool — an internal API, a database, your
        knowledge base. Pick a starting point:
      </p>
      <div className="mx-auto mt-5 grid max-w-3xl gap-3 sm:grid-cols-3">
        {MCP_TEMPLATES.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => onPick(t.id)}
            className="rounded-xl border border-border p-4 text-left transition hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md"
          >
            <div className="text-sm font-medium text-foreground">{t.title}</div>
            <div className="mt-1 text-xs text-muted-foreground">{t.tagline}</div>
          </button>
        ))}
      </div>
    </div>
  );
}
