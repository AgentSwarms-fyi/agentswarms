// BI Workspace — the list of BI projects (editable dashboards/reports).
import { identityHue } from "@/lib/identityHue";
// Own projects open in the editor; projects shared via IAM group grants open
// read-only. Published projects expose a public read-only link.
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import {
  BarChart3,
  Building2,
  Check,
  Folder,
  FolderInput,
  FolderPlus,
  Gauge,
  GitBranch,
  Globe,
  LayoutDashboard,
  Link2,
  Loader2,
  Network,
  PieChart,
  Plus,
  Rocket,
  Settings2,
  Table2,
  Trash2,
  Type,
  UserRound,
  Wand2,
  X,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { DataPrepTab } from "@/components/bi/DataPrepTab";
import { BiThumbnail } from "@/components/bi/BiThumbnail";
import { BiMoveDialog } from "@/components/bi/BiMoveDialog";
import { BiPromoteDialog } from "@/components/bi/BiPromoteDialog";
import { BiWorkspaceManager } from "@/components/bi/BiWorkspaceManager";
import { BiGitSyncDialog } from "@/components/bi/BiGitSyncDialog";
import { useAuth } from "@/hooks/use-auth";
import { useIsSuperadmin } from "@/hooks/use-iam";
import {
  createDashboard,
  deleteDashboard,
  listDashboards,
  parseWidgets,
  publicDashboardUrl,
  type BiDashboardRow,
} from "@/lib/biDashboards";
import {
  createFolder,
  deleteFolder,
  listFolders,
  listWorkspaces,
  type BiFolder,
  type BiWorkspace,
} from "@/lib/biWorkspaces";

export const Route = createFileRoute("/_authenticated/bi")({
  head: () => ({
    meta: [
      { title: "BI Workspace — AgentSwarms" },
      {
        name: "description",
        content: "Build, publish and share BI dashboards from your connected data.",
      },
    ],
  }),
  component: BiWorkspacePage,
});

function BiWorkspacePage() {
  const { user } = useAuth();
  const isAdmin = useIsSuperadmin();
  const navigate = useNavigate();
  const [tab, setTab] = useState<"projects" | "prep">("projects");
  const [dashboards, setDashboards] = useState<BiDashboardRow[] | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Workspaces & folders (organizational + read-sharing layer).
  const [workspaces, setWorkspaces] = useState<BiWorkspace[]>([]);
  const [folders, setFolders] = useState<BiFolder[]>([]);
  // Current scope: null = Personal (non-workspace dashboards), else a workspace id.
  const [scopeWs, setScopeWs] = useState<string | null>(null);
  // Selected folder within the scope (null = everything in scope).
  const [folderSel, setFolderSel] = useState<string | null>(null);
  const [moveTarget, setMoveTarget] = useState<BiDashboardRow | null>(null);
  const [promoteTarget, setPromoteTarget] = useState<BiDashboardRow | null>(null);
  const [wsManagerOpen, setWsManagerOpen] = useState(false);
  const [gitSyncOpen, setGitSyncOpen] = useState(false);
  const [addingFolder, setAddingFolder] = useState(false);
  const [folderName, setFolderName] = useState("");

  const reload = useCallback(() => {
    listDashboards()
      .then(setDashboards)
      .catch((e) => {
        toast.error((e as Error).message);
        setDashboards([]);
      });
  }, []);

  const reloadOrg = useCallback(() => {
    void listWorkspaces()
      .then(setWorkspaces)
      .catch(() => setWorkspaces([]));
    void listFolders()
      .then(setFolders)
      .catch(() => setFolders([]));
  }, []);

  useEffect(() => {
    reload();
    reloadOrg();
  }, [reload, reloadOrg]);

  const submitCreate = async () => {
    if (!user?.id) return;
    if (!name.trim()) return toast.error("Give the project a name");
    setBusy(true);
    try {
      const row = await createDashboard({ userId: user.id, name: name.trim(), description });
      toast.success("BI project created");
      setCreateOpen(false);
      setName("");
      setDescription("");
      void navigate({ to: "/bi/$dashboardId", params: { dashboardId: row.id } });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (d: BiDashboardRow) => {
    if (!window.confirm(`Delete BI project "${d.name}"? This cannot be undone.`)) return;
    try {
      await deleteDashboard(d.id);
      toast.success("Project deleted");
      reload();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const copyLink = (d: BiDashboardRow) => {
    if (!d.public_slug) return;
    void navigator.clipboard.writeText(publicDashboardUrl(d.public_slug));
    setCopiedId(d.id);
    setTimeout(() => setCopiedId(null), 1500);
  };

  const selectScope = (ws: string | null) => {
    setScopeWs(ws);
    setFolderSel(null);
    setAddingFolder(false);
  };

  async function addFolder() {
    if (!user?.id || !folderName.trim()) return;
    try {
      await createFolder({ userId: user.id, name: folderName, workspaceId: scopeWs });
      setFolderName("");
      setAddingFolder(false);
      reloadOrg();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function removeFolder(f: BiFolder) {
    if (!window.confirm(`Delete folder "${f.name}"? Dashboards inside stay — just ungrouped.`))
      return;
    try {
      await deleteFolder(f.id);
      if (folderSel === f.id) setFolderSel(null);
      reloadOrg();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  // Folders belonging to the current scope (personal folders I own, or the
  // selected workspace's folders).
  const scopeFolders = folders.filter((f) =>
    scopeWs === null
      ? f.workspace_id === null && f.user_id === user?.id
      : f.workspace_id === scopeWs,
  );

  // Dashboards shown for the current scope + folder selection.
  const visibleDashboards = (dashboards ?? []).filter((d) => {
    const inScope = scopeWs === null ? !d.workspace_id : d.workspace_id === scopeWs;
    if (!inScope) return false;
    if (folderSel === null) return true;
    return d.folder_id === folderSel;
  });

  return (
    <div className="p-6 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-primary">
            Data &amp; BI
          </p>
          <h1 className="font-display text-3xl font-semibold tracking-tight flex items-center gap-2">
            <LayoutDashboard className="h-7 w-7 text-primary" /> BI Workspace
          </h1>
          <p className="text-muted-foreground mt-1 max-w-2xl">
            Build dashboards and reports from your datasets and connected warehouses — by hand or
            with the AI analyst — then publish them with a link or share them with groups.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {isAdmin && (
            <Button variant="outline" className="gap-1.5" onClick={() => setGitSyncOpen(true)}>
              <GitBranch className="h-4 w-4" /> Git sync
            </Button>
          )}
          <Button className="gap-1.5" onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" /> New BI project
          </Button>
        </div>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as "projects" | "prep")}>
        <TabsList className="h-auto w-full justify-start gap-6 rounded-none border-b border-border bg-transparent p-0">
          <TabsTrigger
            value="projects"
            className="gap-1.5 rounded-none border-0 border-b-2 border-transparent bg-transparent px-1 pb-2.5 text-sm font-medium text-muted-foreground shadow-none data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none"
          >
            <LayoutDashboard className="h-3.5 w-3.5" /> Projects
          </TabsTrigger>
          <TabsTrigger
            value="prep"
            className="gap-1.5 rounded-none border-0 border-b-2 border-transparent bg-transparent px-1 pb-2.5 text-sm font-medium text-muted-foreground shadow-none data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none"
          >
            <Wand2 className="h-3.5 w-3.5" /> Data preparation
          </TabsTrigger>
        </TabsList>

        <TabsContent value="prep" className="mt-4">
          {tab === "prep" && <DataPrepTab />}
        </TabsContent>

        <TabsContent value="projects" className="mt-4">
          <div className="flex flex-col gap-5 lg:flex-row">
            {/* Sidebar: scope (Personal / workspaces) + folder tree */}
            <aside className="shrink-0 space-y-3 lg:w-56">
              <div className="space-y-0.5">
                <button
                  type="button"
                  onClick={() => selectScope(null)}
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm ${
                    scopeWs === null ? "bg-accent font-medium" : "hover:bg-muted/60"
                  }`}
                >
                  <UserRound className="h-4 w-4 text-muted-foreground" /> Personal
                </button>
                {workspaces.map((w) => (
                  <button
                    key={w.id}
                    type="button"
                    onClick={() => selectScope(w.id)}
                    className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm ${
                      scopeWs === w.id ? "bg-accent font-medium" : "hover:bg-muted/60"
                    }`}
                    title={w.description ?? undefined}
                  >
                    <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 truncate">{w.name}</span>
                  </button>
                ))}
                {isAdmin && (
                  <button
                    type="button"
                    onClick={() => setWsManagerOpen(true)}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                  >
                    <Settings2 className="h-3.5 w-3.5" /> Manage workspaces
                  </button>
                )}
              </div>

              {/* Folders within the current scope */}
              <div className="space-y-0.5 border-t border-border/50 pt-3">
                <div className="flex items-center justify-between px-2 pb-1">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Folders
                  </span>
                  <button
                    type="button"
                    title="New folder"
                    onClick={() => setAddingFolder((v) => !v)}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <FolderPlus className="h-3.5 w-3.5" />
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => setFolderSel(null)}
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm ${
                    folderSel === null ? "bg-accent font-medium" : "hover:bg-muted/60"
                  }`}
                >
                  <LayoutDashboard className="h-4 w-4 text-muted-foreground" /> All
                </button>
                {scopeFolders.map((f) => (
                  <div
                    key={f.id}
                    className={`group/f flex items-center gap-1 rounded-md px-2 py-1.5 text-sm ${
                      folderSel === f.id ? "bg-accent font-medium" : "hover:bg-muted/60"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => setFolderSel(f.id)}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    >
                      <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 truncate">{f.name}</span>
                    </button>
                    {f.user_id === user?.id && (
                      <button
                        type="button"
                        title="Delete folder"
                        onClick={() => void removeFolder(f)}
                        className="opacity-0 transition group-hover/f:opacity-100 hover:text-destructive"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                ))}
                {addingFolder && (
                  <div className="flex items-center gap-1 px-1 pt-1">
                    <Input
                      autoFocus
                      value={folderName}
                      onChange={(e) => setFolderName(e.target.value)}
                      placeholder="Folder name"
                      className="h-7 text-xs"
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void addFolder();
                        if (e.key === "Escape") setAddingFolder(false);
                      }}
                    />
                    <Button size="sm" className="h-7 px-2" onClick={() => void addFolder()}>
                      Add
                    </Button>
                  </div>
                )}
              </div>
            </aside>

            {/* Main: the dashboard grid for the current scope + folder */}
            <div className="min-w-0 flex-1">
              {dashboards === null ? (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-3">
                  {[0, 1, 2].map((i) => (
                    <Skeleton key={i} className="h-40 rounded-xl" />
                  ))}
                </div>
              ) : visibleDashboards.length === 0 ? (
                <Card className="border-dashed border-border/60">
                  <CardContent className="flex flex-col items-center justify-center gap-3 py-16 text-center">
                    <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
                      <BarChart3 className="h-6 w-6 text-primary" />
                    </div>
                    <div>
                      <p className="font-medium">
                        {(dashboards?.length ?? 0) === 0
                          ? "No BI projects yet"
                          : "Nothing here yet"}
                      </p>
                      <p className="mt-1 max-w-md text-sm text-muted-foreground">
                        {(dashboards?.length ?? 0) === 0
                          ? "Create a project to compose charts from your Data & SQL datasets or connected warehouses, or generate visuals with AI."
                          : "No dashboards in this location. Create one, or move an existing dashboard here."}
                      </p>
                    </div>
                    <Button className="gap-1.5" onClick={() => setCreateOpen(true)}>
                      <Plus className="h-4 w-4" /> New BI project
                    </Button>
                  </CardContent>
                </Card>
              ) : (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-3">
                  {visibleDashboards.map((d) => {
                    const mine = d.user_id === user?.id;
                    const widgets = parseWidgets(d.widgets);
                    const widgetCount = widgets.length;
                    return (
                      <Card
                        key={d.id}
                        className="group flex cursor-pointer flex-col overflow-hidden rounded-xl border-border/60 transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-lg"
                        onClick={() =>
                          void navigate({ to: "/bi/$dashboardId", params: { dashboardId: d.id } })
                        }
                      >
                        <BiThumbnail
                          widgets={d.widgets}
                          layout={d.layout}
                          theme={d.theme}
                          className="aspect-[16/9] w-full shrink-0 rounded-none border-x-0 border-t-0 border-b transition group-hover:brightness-105"
                        />
                        <CardContent className="flex flex-1 flex-col gap-2.5 p-3.5">
                          <div className="flex items-start justify-between gap-2">
                            <div className="flex min-w-0 items-start gap-2">
                              <div
                                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br text-white shadow-sm ${identityHue(d.name)}`}
                              >
                                <LayoutDashboard className="h-4 w-4" />
                              </div>
                              <div className="min-w-0">
                                <p className="truncate font-semibold">{d.name}</p>
                                {d.description ? (
                                  <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                                    {d.description}
                                  </p>
                                ) : (
                                  <p className="mt-0.5 text-xs text-muted-foreground/60">
                                    No description
                                  </p>
                                )}
                              </div>
                            </div>
                            <div className="flex shrink-0 flex-col items-end gap-1">
                              {d.published ? (
                                <Badge className="gap-1 bg-emerald-500/15 text-[10px] text-emerald-600 hover:bg-emerald-500/15 dark:text-emerald-400">
                                  <Globe className="h-2.5 w-2.5" /> Published
                                </Badge>
                              ) : (
                                <Badge variant="secondary" className="text-[10px]">
                                  Draft
                                </Badge>
                              )}
                              {!mine && (
                                <Badge variant="outline" className="text-[10px]">
                                  Shared with you
                                </Badge>
                              )}
                            </div>
                          </div>
                          <div className="mt-auto flex items-center justify-between gap-1 border-t border-border/40 pt-2.5 text-[11px] text-muted-foreground">
                            <span
                              title={
                                d.last_viewed_at
                                  ? `Last viewed ${formatDistanceToNow(new Date(d.last_viewed_at), { addSuffix: true })}`
                                  : undefined
                              }
                            >
                              {widgetCount} widget{widgetCount === 1 ? "" : "s"}
                              {(d.view_count ?? 0) > 0 && (
                                <>
                                  {" "}
                                  · {d.view_count} view{d.view_count === 1 ? "" : "s"}
                                </>
                              )}{" "}
                              · updated{" "}
                              {formatDistanceToNow(new Date(d.updated_at), { addSuffix: true })}
                            </span>
                            <span
                              className="flex items-center gap-1 opacity-0 transition group-hover:opacity-100"
                              onClick={(e) => e.stopPropagation()}
                            >
                              {d.published && d.public_slug && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-7 w-7 p-0"
                                  title="Copy public link"
                                  onClick={() => copyLink(d)}
                                >
                                  {copiedId === d.id ? (
                                    <Check className="h-3.5 w-3.5 text-emerald-500" />
                                  ) : (
                                    <Link2 className="h-3.5 w-3.5" />
                                  )}
                                </Button>
                              )}
                              {mine && workspaces.length > 0 && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-7 w-7 p-0 text-muted-foreground"
                                  title="Promote to a workspace (dev → prod)"
                                  onClick={() => setPromoteTarget(d)}
                                >
                                  <Rocket className="h-3.5 w-3.5" />
                                </Button>
                              )}
                              {mine && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-7 w-7 p-0 text-muted-foreground"
                                  title="Move to a workspace or folder"
                                  onClick={() => setMoveTarget(d)}
                                >
                                  <FolderInput className="h-3.5 w-3.5" />
                                </Button>
                              )}
                              {mine && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                                  title="Delete project"
                                  onClick={() => void remove(d)}
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </Button>
                              )}
                            </span>
                          </div>
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </TabsContent>
      </Tabs>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New BI project</DialogTitle>
            <DialogDescription>
              A project is an editable dashboard. Add charts from your data or generate them with
              AI, then publish when it&apos;s ready.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>Name</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Q3 Revenue Overview"
                onKeyDown={(e) => e.key === "Enter" && void submitCreate()}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Description (optional)</Label>
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
                placeholder="What this dashboard tracks and who it's for"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => void submitCreate()} disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Create project"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <BiMoveDialog
        dashboard={moveTarget}
        workspaces={workspaces}
        folders={folders}
        onClose={() => setMoveTarget(null)}
        onMoved={reload}
      />

      <BiPromoteDialog
        dashboard={promoteTarget}
        workspaces={workspaces}
        userId={user?.id}
        onClose={() => setPromoteTarget(null)}
        onDone={reload}
      />

      {isAdmin && (
        <BiWorkspaceManager
          open={wsManagerOpen}
          onClose={() => setWsManagerOpen(false)}
          workspaces={workspaces}
          onChanged={reloadOrg}
        />
      )}

      {isAdmin && <BiGitSyncDialog open={gitSyncOpen} onClose={() => setGitSyncOpen(false)} />}
    </div>
  );
}
