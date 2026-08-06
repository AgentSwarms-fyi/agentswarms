// Gallery view for the /swarms page.
// Shows the user's saved swarms + curated templates as cards. Each card
// can be opened into the canvas.
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useNavigate } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { RecentRunsPanel } from "@/components/swarms/RecentRunsPanel";
import { subscribe as subscribeRuns, getSnapshot as getRunsSnapshot } from "@/lib/swarmRunManager";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Network,
  Plus,
  Trash2,
  Loader2,
  Search,
  Play,
  LayoutTemplate,
  MoreVertical,
} from "lucide-react";
import { toast } from "sonner";
import { SWARM_TEMPLATES } from "@/lib/swarmTemplates";
import { ExportSwarmDropdown } from "@/components/swarms/ExportSwarmDropdown";
import { useLangChainExportAnnouncement } from "@/hooks/use-langchain-export-announcement";
import type { Node, Edge } from "@xyflow/react";
import type { SwarmNodeData } from "@/lib/swarmRuntime";

type SwarmRow = {
  id: string;
  name: string;
  description: string | null;
  nodes: unknown;
  edges: unknown;
  is_deployed: boolean;
  updated_at: string;
};

// Same accent hues the canvas uses per node kind, so the thumbnail reads as a
// miniature of what you'll see when you open it.
const THUMB_KIND_COLOR: Record<string, string> = {
  input: "text-sky-400",
  agent: "text-primary",
  condition: "text-violet-400",
  router: "text-indigo-400",
  loop: "text-orange-400",
  approval: "text-amber-400",
  a2a_remote: "text-fuchsia-400",
  function: "text-zinc-400",
  evaluate: "text-teal-400",
  output: "text-emerald-400",
};

// Mini SVG preview of a swarm's real graph: node positions are scaled into a
// fixed viewBox, edges drawn as hairlines, nodes as kind-colored pills.
// Pure render from the data we already have — no layout lib, no extra queries.
function SwarmGraphThumb({ nodes, edges }: { nodes: unknown; edges: unknown }) {
  const nodeList = (Array.isArray(nodes) ? nodes : []) as Node<SwarmNodeData>[];
  const edgeList = (Array.isArray(edges) ? edges : []) as Edge[];
  // A draft with no nodes used to render nothing, which made the card look
  // broken. An empty canvas is a real state — draw it as one.
  if (nodeList.length === 0)
    return (
      <div className="dot-matrix-bg grid h-20 place-items-center rounded-md border border-dashed border-border/70 text-[11px] text-muted-foreground">
        Empty canvas — open to start wiring
      </div>
    );

  const W = 280;
  const H = 88;
  const PAD = 18;
  const xs = nodeList.map((n) => n.position?.x ?? 0);
  const ys = nodeList.map((n) => n.position?.y ?? 0);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const spanX = Math.max(Math.max(...xs) - minX, 1);
  const spanY = Math.max(Math.max(...ys) - minY, 1);
  const pos = new Map(
    nodeList.map((n) => [
      n.id,
      {
        x: PAD + (((n.position?.x ?? 0) - minX) / spanX) * (W - PAD * 2),
        y: PAD + (((n.position?.y ?? 0) - minY) / spanY) * (H - PAD * 2),
      },
    ]),
  );

  return (
    <div className="rounded-md border border-border/60 bg-muted/30 px-1.5 py-1">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-20 w-full" aria-hidden="true">
        {edgeList.map((e) => {
          const a = pos.get(e.source);
          const b = pos.get(e.target);
          if (!a || !b) return null;
          return (
            <line
              key={e.id}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              className="stroke-border"
              strokeWidth={1.2}
            />
          );
        })}
        {nodeList.map((n) => {
          const p = pos.get(n.id);
          if (!p) return null;
          const color = THUMB_KIND_COLOR[n.data?.kind ?? ""] ?? "text-muted-foreground";
          return (
            <rect
              key={n.id}
              x={p.x - 9}
              y={p.y - 5}
              width={18}
              height={10}
              rx={3}
              className={`${color} fill-current`}
              opacity={0.9}
            />
          );
        })}
      </svg>
    </div>
  );
}

export function SwarmGallery() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [mySwarms, setMySwarms] = useState<SwarmRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<"library" | "runs">("library");
  useLangChainExportAnnouncement();

  // Live count of in-flight runs, for the Recent runs tab badge.
  const liveRuns = useSyncExternalStore(subscribeRuns, getRunsSnapshot, getRunsSnapshot);
  const activeRunCount = liveRuns.filter(
    (r) => r.status === "running" || r.status === "waiting",
  ).length;

  useEffect(() => {
    if (!user) return;
    void load();
  }, [user]);

  async function load() {
    setLoading(true);
    const { data: swarms } = await supabase
      .from("swarms")
      .select("id, name, description, nodes, edges, is_deployed, updated_at")
      .order("updated_at", { ascending: false });
    setMySwarms((swarms ?? []) as SwarmRow[]);
    setLoading(false);
  }

  async function handleNewSwarm() {
    if (!user) return;
    setCreating(true);
    const { data: created, error } = await supabase
      .from("swarms")
      .insert({
        user_id: user.id,
        name: `Swarm ${mySwarms.length + 1}`,
        nodes: [],
        edges: [],
      })
      .select()
      .single();
    setCreating(false);
    if (error || !created) {
      toast.error("Failed to create swarm");
      return;
    }
    toast.success("New swarm created");
    navigate({ to: "/swarms", search: { swarm: created.id, view: "canvas", template: undefined } });
  }

  async function handleDelete(id: string, name: string) {
    const { error } = await supabase.from("swarms").delete().eq("id", id);
    if (error) {
      toast.error("Failed to delete");
      return;
    }
    setMySwarms((prev) => prev.filter((s) => s.id !== id));
    toast.success(`Deleted "${name}"`);
  }

  function openSwarm(id: string) {
    navigate({ to: "/swarms", search: { swarm: id, view: "canvas", template: undefined } });
  }

  function openTemplate(templateId: string) {
    navigate({ to: "/swarms", search: { template: templateId, view: "canvas", swarm: undefined } });
  }

  const q = search.trim().toLowerCase();
  const filteredMine = useMemo(
    () =>
      mySwarms.filter(
        (s) =>
          !q || s.name.toLowerCase().includes(q) || (s.description ?? "").toLowerCase().includes(q),
      ),
    [mySwarms, q],
  );
  const filteredTemplates = useMemo(
    () =>
      SWARM_TEMPLATES.filter(
        (t) =>
          !q ||
          t.title.toLowerCase().includes(q) ||
          t.tagline.toLowerCase().includes(q) ||
          t.category.toLowerCase().includes(q),
      ),
    [q],
  );

  return (
    <div className="p-6 space-y-8 max-w-7xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <Network className="h-7 w-7 text-primary" /> Swarms
          </h1>
          <p className="text-muted-foreground mt-1">
            Your multi-agent swarms and ready-to-run templates. Open one in the canvas to edit and
            run.
          </p>
        </div>
        <Button onClick={handleNewSwarm} disabled={creating} size="lg" className="shadow-lg">
          {creating ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <Plus className="h-4 w-4 mr-2" />
          )}
          New Swarm
        </Button>
      </div>

      <Tabs
        value={tab}
        onValueChange={(v) => setTab(v as "library" | "runs")}
        className="space-y-6"
      >
        <TabsList>
          <TabsTrigger value="library">Library</TabsTrigger>
          <TabsTrigger value="runs" className="gap-1.5">
            Recent runs
            {activeRunCount > 0 && (
              <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500/20 px-1 text-[10px] font-semibold text-amber-500">
                {activeRunCount}
              </span>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="library" className="space-y-8">
          <div className="relative max-w-md">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search your swarms and templates…"
              className="pl-8"
            />
          </div>

          {/* My swarms */}
          <section className="space-y-3">
            <div className="flex items-baseline justify-between">
              <h2 className="text-xl font-semibold flex items-center gap-2">
                <Network className="h-5 w-5 text-primary" /> My Swarms
                <Badge variant="outline" className="ml-1 text-[10px]">
                  {mySwarms.length}
                </Badge>
              </h2>
            </div>

            {loading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground py-8">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading your swarms…
              </div>
            ) : filteredMine.length === 0 ? (
              <Card className="border-dashed border-2 border-border/50">
                <CardContent className="flex flex-col items-center justify-center py-12">
                  <Network className="h-12 w-12 text-muted-foreground mb-3" />
                  <p className="text-muted-foreground mb-4 text-center max-w-sm">
                    {mySwarms.length === 0
                      ? "You haven't built any swarms yet. Start fresh or remix a template below."
                      : "No swarms match your search."}
                  </p>
                  {mySwarms.length === 0 && (
                    <Button onClick={handleNewSwarm} disabled={creating}>
                      <Plus className="h-4 w-4 mr-2" /> Create your first swarm
                    </Button>
                  )}
                </CardContent>
              </Card>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {filteredMine.map((s) => {
                  const nodeCount = Array.isArray(s.nodes) ? s.nodes.length : 0;
                  const edgeCount = Array.isArray(s.edges) ? s.edges.length : 0;
                  return (
                    <Card key={s.id} className="group hover:border-primary/50 transition-colors">
                      <CardHeader className="p-4 pb-2">
                        <div className="flex items-start justify-between gap-2">
                          <CardTitle className="text-sm truncate flex-1" title={s.name}>
                            {s.name}
                          </CardTitle>
                        </div>
                        {s.description && (
                          <p className="text-xs text-muted-foreground line-clamp-1">
                            {s.description}
                          </p>
                        )}
                      </CardHeader>
                      <CardContent className="space-y-2.5 p-4 pt-0">
                        <SwarmGraphThumb nodes={s.nodes} edges={s.edges} />
                        <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
                          <span>{nodeCount} nodes</span>
                          <span>·</span>
                          <span>{edgeCount} edges</span>
                          {s.is_deployed && (
                            <>
                              <span>·</span>
                              <Badge variant="outline" className="text-[10px] h-4 px-1.5">
                                deployed
                              </Badge>
                            </>
                          )}
                        </div>
                        <div className="flex gap-1.5">
                          <Button
                            size="sm"
                            onClick={() => openSwarm(s.id)}
                            className="h-7 flex-1 text-xs"
                          >
                            <Play className="h-3 w-3 mr-1" /> Open
                          </Button>
                          <ExportSwarmDropdown
                            name={s.name}
                            description={s.description ?? undefined}
                            nodes={s.nodes as Node<SwarmNodeData>[]}
                            edges={s.edges as Edge[]}
                          />
                          {/* Secondary actions live in a kebab so "Open" stays the
                          one obvious thing to click. */}
                          <AlertDialog>
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button size="sm" variant="outline" className="px-2" title="More">
                                  <MoreVertical className="h-3.5 w-3.5" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end" className="w-48">
                                <AlertDialogTrigger asChild>
                                  <DropdownMenuItem className="text-destructive focus:text-destructive">
                                    <Trash2 className="h-4 w-4 mr-2" /> Delete
                                  </DropdownMenuItem>
                                </AlertDialogTrigger>
                              </DropdownMenuContent>
                            </DropdownMenu>
                            <AlertDialogContent>
                              <AlertDialogHeader>
                                <AlertDialogTitle>Delete this swarm?</AlertDialogTitle>
                                <AlertDialogDescription>
                                  <span className="font-semibold text-foreground">{s.name}</span>{" "}
                                  will be permanently removed. This action cannot be undone.
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel>Cancel</AlertDialogCancel>
                                <AlertDialogAction
                                  onClick={() => handleDelete(s.id, s.name)}
                                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                >
                                  Delete swarm
                                </AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            )}
          </section>

          {/* Templates */}
          <section className="space-y-3">
            <div className="flex items-baseline justify-between">
              <h2 className="text-xl font-semibold flex items-center gap-2">
                <LayoutTemplate className="h-5 w-5 text-primary" /> Templates
                <Badge variant="outline" className="ml-1 text-[10px]">
                  {SWARM_TEMPLATES.length}
                </Badge>
              </h2>
              <p className="text-xs text-muted-foreground">
                Runnable example swarms. Open one to load it into the canvas.
              </p>
            </div>

            {filteredTemplates.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4">No templates match your search.</p>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {filteredTemplates.map((t) => (
                  <Card key={t.id} className="group hover:border-primary/50 transition-colors">
                    <CardHeader className="pb-3">
                      <div className="flex items-start justify-between gap-2">
                        <CardTitle className="text-base flex-1" title={t.title}>
                          {t.title}
                        </CardTitle>
                        <Badge variant="outline" className="text-[10px] shrink-0">
                          {t.category}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground line-clamp-2">{t.tagline}</p>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <SwarmGraphThumb nodes={t.nodes} edges={t.edges} />
                      <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
                        <span>{t.nodes.length} nodes</span>
                        <span>·</span>
                        <span>{t.edges.length} edges</span>
                      </div>
                      <Button
                        size="sm"
                        onClick={() => openTemplate(t.id)}
                        className="w-full"
                        variant="outline"
                      >
                        <Play className="h-3.5 w-3.5 mr-1.5" /> Load template
                      </Button>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </section>
        </TabsContent>

        <TabsContent value="runs">
          <RecentRunsPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}
