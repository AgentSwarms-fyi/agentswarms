// BI Workspace — the list of BI projects (editable dashboards/reports).
// Own projects open in the editor; projects shared via IAM group grants open
// read-only. Published projects expose a public read-only link.
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import {
  BarChart3,
  Check,
  Globe,
  LayoutDashboard,
  Link2,
  Loader2,
  Plus,
  Trash2,
  Wand2,
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
import { useAuth } from "@/hooks/use-auth";
import {
  createDashboard,
  deleteDashboard,
  listDashboards,
  parseWidgets,
  publicDashboardUrl,
  type BiDashboardRow,
} from "@/lib/biDashboards";

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
  const navigate = useNavigate();
  const [tab, setTab] = useState<"projects" | "prep">("projects");
  const [dashboards, setDashboards] = useState<BiDashboardRow[] | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const reload = useCallback(() => {
    listDashboards()
      .then(setDashboards)
      .catch((e) => {
        toast.error((e as Error).message);
        setDashboards([]);
      });
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

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

  return (
    <div className="p-6 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <LayoutDashboard className="h-7 w-7 text-primary" /> BI Workspace
          </h1>
          <p className="text-muted-foreground mt-1 max-w-2xl">
            Build dashboards and reports from your datasets and connected warehouses — by hand or
            with the AI analyst — then publish them with a link or share them with groups.
          </p>
        </div>
        <Button className="gap-1.5" onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4" /> New BI project
        </Button>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as "projects" | "prep")}>
        <TabsList>
          <TabsTrigger value="projects" className="gap-1.5">
            <LayoutDashboard className="h-3.5 w-3.5" /> Projects
          </TabsTrigger>
          <TabsTrigger value="prep" className="gap-1.5">
            <Wand2 className="h-3.5 w-3.5" /> Data preparation
          </TabsTrigger>
        </TabsList>

        <TabsContent value="prep" className="mt-4">
          {tab === "prep" && <DataPrepTab />}
        </TabsContent>

        <TabsContent value="projects" className="mt-4">
          {dashboards === null ? (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-40 rounded-xl" />
              ))}
            </div>
          ) : dashboards.length === 0 ? (
            <Card className="border-dashed border-border/60">
              <CardContent className="flex flex-col items-center justify-center gap-3 py-16 text-center">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
                  <BarChart3 className="h-6 w-6 text-primary" />
                </div>
                <div>
                  <p className="font-medium">No BI projects yet</p>
                  <p className="mt-1 max-w-md text-sm text-muted-foreground">
                    Create a project to compose charts from your Data &amp; SQL datasets or
                    connected warehouses, or generate visuals with AI and insert them here.
                  </p>
                </div>
                <Button className="gap-1.5" onClick={() => setCreateOpen(true)}>
                  <Plus className="h-4 w-4" /> New BI project
                </Button>
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {dashboards.map((d) => {
                const mine = d.user_id === user?.id;
                const widgetCount = parseWidgets(d.widgets).length;
                return (
                  <Card
                    key={d.id}
                    className="group cursor-pointer border-border/60 transition hover:border-primary/50 hover:shadow-md"
                    onClick={() =>
                      void navigate({ to: "/bi/$dashboardId", params: { dashboardId: d.id } })
                    }
                  >
                    <CardContent className="flex h-full flex-col gap-3 p-4">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate font-semibold">{d.name}</p>
                          {d.description && (
                            <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                              {d.description}
                            </p>
                          )}
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
                      <div className="mt-auto flex items-center justify-between text-xs text-muted-foreground">
                        <span>
                          {widgetCount} widget{widgetCount === 1 ? "" : "s"} · updated{" "}
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
    </div>
  );
}
