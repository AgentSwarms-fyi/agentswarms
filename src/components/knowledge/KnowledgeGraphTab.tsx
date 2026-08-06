// Graph RAG visualization tab. Shows the entity-relation graph stored in
// kb_graph_entities / kb_graph_relations for a single knowledge base, plus a
// "Build graph" button that hits /api/kb/build-graph.
//
// We use @xyflow/react for the visualization with a simple radial layout —
// no heavy graph library needed for the v1 demo (typical KB has 50-200 nodes).
//
// CRITICAL: extraction model is currently hardcoded to google/gemini-2.5-flash
// on the server. We surface that to the user so it's not a black box.
import { useCallback, useEffect, useMemo, useState } from "react";
import { ReactFlow, Background, Controls, MiniMap, type Node, type Edge } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { GitBranch, Loader2, Sparkles, RefreshCw, AlertCircle, Network } from "lucide-react";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";

type GraphEntity = {
  id: string;
  name: string;
  type: string;
  description: string | null;
  mention_count: number;
};
type GraphRelation = {
  id: string;
  source_entity_id: string;
  target_entity_id: string;
  predicate: string;
  weight: number;
};
type KbMeta = {
  is_sample: boolean;
  kb_graph_status: string | null;
  kb_graph_built_at: string | null;
  kb_graph_error: string | null;
};

type Props = {
  knowledgeBaseId: string;
  isSample: boolean;
};

// Color per entity type — explicit oklch values so nodes/edges stay vivid in
// both themes. We avoid `hsl(var(--token))` because this project's tokens are
// oklch, not hsl, and wrapping them in hsl() yields invalid colors.
const TYPE_COLOR: Record<string, string> = {
  person: "oklch(0.62 0.22 265)", // indigo
  org: "oklch(0.65 0.18 160)", // teal
  product: "oklch(0.65 0.24 305)", // violet
  concept: "oklch(0.68 0.18 220)", // sky
  location: "oklch(0.72 0.17 75)", // amber
  event: "oklch(0.65 0.23 18)", // rose
  other: "oklch(0.6 0.04 260)", // slate
};

export function KnowledgeGraphTab({ knowledgeBaseId, isSample }: Props) {
  const [entities, setEntities] = useState<GraphEntity[]>([]);
  const [relations, setRelations] = useState<GraphRelation[]>([]);
  const [meta, setMeta] = useState<KbMeta | null>(null);
  const [loading, setLoading] = useState(false);
  const [building, setBuilding] = useState(false);
  const [selectedEntity, setSelectedEntity] = useState<GraphEntity | null>(null);

  const loadGraph = useCallback(async () => {
    setLoading(true);
    try {
      const [{ data: kb }, { data: ents }, { data: rels }] = await Promise.all([
        supabase
          .from("knowledge_bases")
          .select("is_sample, kb_graph_status, kb_graph_built_at, kb_graph_error")
          .eq("id", knowledgeBaseId)
          .maybeSingle(),
        supabase
          .from("kb_graph_entities")
          .select("id, name, type, description, mention_count")
          .eq("knowledge_base_id", knowledgeBaseId)
          .order("mention_count", { ascending: false })
          .limit(200),
        supabase
          .from("kb_graph_relations")
          .select("id, source_entity_id, target_entity_id, predicate, weight")
          .eq("knowledge_base_id", knowledgeBaseId)
          .limit(400),
      ]);
      setMeta(kb as KbMeta | null);
      setEntities((ents as GraphEntity[]) ?? []);
      setRelations((rels as GraphRelation[]) ?? []);
    } finally {
      setLoading(false);
    }
  }, [knowledgeBaseId]);

  useEffect(() => {
    loadGraph();
  }, [loadGraph]);

  async function buildGraph() {
    if (isSample) {
      toast.error("Sample knowledge bases ship with a pre-built graph.");
      return;
    }
    setBuilding(true);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      const res = await fetch("/api/kb/build-graph", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ knowledge_base_id: knowledgeBaseId }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        error?: string;
        entities?: number;
        relations?: number;
      };
      if (!res.ok) {
        toast.error(json.error || `Build failed (${res.status})`);
      } else {
        toast.success(
          `Graph built — ${json.entities ?? 0} entities, ${json.relations ?? 0} relations`,
        );
        await loadGraph();
      }
    } catch (e) {
      toast.error(`Build failed: ${(e as Error).message}`);
    } finally {
      setBuilding(false);
    }
  }

  // Radial layout — top-N entities by mention_count get inner ring positions
  // so the most central nodes are easy to find.
  const { nodes, edges } = useMemo(() => {
    if (entities.length === 0) return { nodes: [] as Node[], edges: [] as Edge[] };
    const ordered = [...entities].sort((a, b) => b.mention_count - a.mention_count);
    const cx = 480;
    const cy = 320;
    const innerRadius = 140;
    const outerRadius = 320;
    const innerCount = Math.min(8, ordered.length);
    const innerStep = (2 * Math.PI) / Math.max(innerCount, 1);
    const outerStep = (2 * Math.PI) / Math.max(ordered.length - innerCount, 1);

    const nodes: Node[] = ordered.map((e, idx) => {
      const inInner = idx < innerCount;
      const angle = inInner ? idx * innerStep : (idx - innerCount) * outerStep;
      const r = inInner ? innerRadius : outerRadius;
      const color = TYPE_COLOR[e.type] || TYPE_COLOR.other;
      return {
        id: e.id,
        position: { x: cx + r * Math.cos(angle) - 70, y: cy + r * Math.sin(angle) - 18 },
        data: {
          label: (
            <div className="flex flex-col items-center gap-0.5 px-1">
              <div className="text-xs font-medium leading-tight text-center max-w-[120px] truncate">
                {e.name}
              </div>
              <div className="text-[9px] uppercase tracking-wider opacity-70">{e.type}</div>
            </div>
          ),
        },
        style: {
          width: 140,
          padding: 6,
          borderRadius: 8,
          border: `2px solid ${color}`,
          background: "var(--card)",
          color: "var(--card-foreground)",
          boxShadow: `0 1px 2px oklch(0 0 0 / 0.08), 0 0 0 1px ${color} inset`,
        },
      } as Node;
    });

    const edges: Edge[] = relations.map((r) => ({
      id: r.id,
      source: r.source_entity_id,
      target: r.target_entity_id,
      label: r.predicate,
      labelStyle: { fontSize: 10, fill: "var(--foreground)", fontWeight: 500 },
      labelBgStyle: { fill: "var(--card)", fillOpacity: 0.9 },
      labelBgPadding: [4, 2] as [number, number],
      labelBgBorderRadius: 4,
      style: { stroke: "var(--muted-foreground)", strokeWidth: 1.5, opacity: 0.7 },
      animated: false,
    }));

    return { nodes, edges };
  }, [entities, relations]);

  const typeBuckets = useMemo(() => {
    const buckets = new Map<string, number>();
    for (const e of entities) buckets.set(e.type, (buckets.get(e.type) ?? 0) + 1);
    return Array.from(buckets.entries()).sort((a, b) => b[1] - a[1]);
  }, [entities]);

  const status = meta?.kb_graph_status ?? "none";
  const hasGraph = entities.length > 0;

  return (
    <div className="space-y-4 mt-3">
      {/* Header banner */}
      <Card className="border-primary/20 bg-primary/5">
        <CardContent className="flex flex-wrap items-center justify-between gap-3 py-3">
          <div className="flex items-center gap-3 min-w-0">
            <Network className="h-5 w-5 text-primary shrink-0" />
            <div className="min-w-0">
              {/* div, not p: Badge renders a <div>, and a div inside a p is
                  invalid HTML — React flags it as a hydration error. */}
              <div className="text-sm font-medium flex items-center gap-2 flex-wrap">
                Knowledge Graph
                {status === "ready" && (
                  <Badge
                    variant="outline"
                    className="border-emerald-500/40 text-emerald-600 dark:text-emerald-400 text-[10px]"
                  >
                    Ready
                  </Badge>
                )}
                {status === "building" && (
                  <Badge
                    variant="outline"
                    className="border-amber-500/40 text-amber-600 dark:text-amber-400 text-[10px]"
                  >
                    Building…
                  </Badge>
                )}
                {status === "error" && (
                  <Badge
                    variant="outline"
                    className="border-destructive/40 text-destructive text-[10px]"
                  >
                    Error
                  </Badge>
                )}
                {(status === "none" || !status) && (
                  <Badge variant="outline" className="text-[10px]">
                    Not built
                  </Badge>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                {hasGraph
                  ? `${entities.length} entities · ${relations.length} relations`
                  : "Build a graph to enable multi-hop Graph RAG retrieval"}
                {meta?.kb_graph_built_at &&
                  ` · built ${formatDistanceToNow(new Date(meta.kb_graph_built_at), { addSuffix: true })}`}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={loadGraph} disabled={loading}>
              <RefreshCw className={`h-3 w-3 mr-1 ${loading ? "animate-spin" : ""}`} />
              Refresh
            </Button>
            {!isSample && (
              <Button size="sm" onClick={buildGraph} disabled={building}>
                {building ? (
                  <>
                    <Loader2 className="h-3 w-3 mr-1 animate-spin" /> Building…
                  </>
                ) : hasGraph ? (
                  <>
                    <GitBranch className="h-3 w-3 mr-1" /> Rebuild Graph
                  </>
                ) : (
                  <>
                    <Sparkles className="h-3 w-3 mr-1" /> Build Graph
                  </>
                )}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Error surface */}
      {meta?.kb_graph_error && (
        <Card className="border-destructive/40 bg-destructive/5">
          <CardContent className="flex items-start gap-2 py-3 text-xs">
            <AlertCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
            <div className="min-w-0">
              <p className="font-medium text-destructive">Last build failed</p>
              <p className="text-muted-foreground break-words">{meta.kb_graph_error}</p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Empty state */}
      {!hasGraph && !loading && (
        <Card className="border-dashed">
          <CardContent className="py-10 text-center space-y-3">
            <Network className="h-10 w-10 mx-auto text-muted-foreground" />
            <div className="space-y-1">
              <p className="text-sm font-medium">No graph yet</p>
              <p className="text-xs text-muted-foreground max-w-md mx-auto">
                Graph RAG extracts <span className="font-medium">entities</span> (people, products,
                concepts) and the
                <span className="font-medium"> relations</span> between them, so agents can answer
                multi-hop questions like
                <em> "if we change Auth, who is affected?"</em> — questions that vector RAG misses.
              </p>
              <p className="text-[11px] text-muted-foreground pt-2">
                Extraction uses{" "}
                <code className="px-1 bg-muted rounded">google/gemini-2.5-flash</code> via the
                built-in AI gateway. Hardcoded for v1 — model picker coming soon.
              </p>
            </div>
            {!isSample && (
              <Button onClick={buildGraph} disabled={building}>
                {building ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Building…
                  </>
                ) : (
                  <>
                    <Sparkles className="h-4 w-4 mr-2" /> Build Graph from Documents
                  </>
                )}
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      {/* Visualization */}
      {hasGraph && (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="md:col-span-3">
            <Card className="overflow-hidden">
              <div style={{ width: "100%", height: 560, background: "var(--muted)" }}>
                <ReactFlow
                  nodes={nodes}
                  edges={edges}
                  fitView
                  fitViewOptions={{ padding: 0.2 }}
                  proOptions={{ hideAttribution: true }}
                  nodesDraggable
                  nodesConnectable={false}
                  elementsSelectable
                  onNodeClick={(_, n) => {
                    const e = entities.find((x) => x.id === n.id);
                    if (e) setSelectedEntity(e);
                  }}
                >
                  <Background gap={18} color="var(--border)" />
                  <Controls className="!bg-card !border-border" />
                  <MiniMap
                    pannable
                    zoomable
                    maskColor="oklch(0 0 0 / 0.15)"
                    nodeColor={(n) => {
                      const ent = entities.find((x) => x.id === n.id);
                      return TYPE_COLOR[ent?.type ?? "other"] || TYPE_COLOR.other;
                    }}
                    nodeStrokeColor={(n) => {
                      const ent = entities.find((x) => x.id === n.id);
                      return TYPE_COLOR[ent?.type ?? "other"] || TYPE_COLOR.other;
                    }}
                    nodeStrokeWidth={3}
                    nodeBorderRadius={4}
                    style={{ background: "var(--card)" }}
                  />
                </ReactFlow>
              </div>
            </Card>
          </div>

          <div className="space-y-3">
            <Card>
              <CardContent className="p-3 space-y-2">
                <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Entity Types
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {typeBuckets.map(([type, count]) => (
                    <Badge
                      key={type}
                      variant="outline"
                      className="text-[10px] gap-1"
                      style={{ borderColor: TYPE_COLOR[type] || TYPE_COLOR.other }}
                    >
                      <span
                        className="h-1.5 w-1.5 rounded-full"
                        style={{ background: TYPE_COLOR[type] || TYPE_COLOR.other }}
                      />
                      {type} ({count})
                    </Badge>
                  ))}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-3 space-y-2">
                <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  {selectedEntity ? "Selected entity" : "Top entities"}
                </p>
                {selectedEntity ? (
                  <div className="space-y-2">
                    <div>
                      <p className="text-sm font-medium">{selectedEntity.name}</p>
                      <Badge variant="outline" className="text-[10px] mt-1">
                        {selectedEntity.type}
                      </Badge>
                    </div>
                    {selectedEntity.description && (
                      <p className="text-xs text-muted-foreground">{selectedEntity.description}</p>
                    )}
                    <p className="text-[10px] text-muted-foreground">
                      Mentioned {selectedEntity.mention_count}× across documents
                    </p>
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-full text-xs"
                      onClick={() => setSelectedEntity(null)}
                    >
                      Clear selection
                    </Button>
                  </div>
                ) : (
                  <ScrollArea className="h-[300px]">
                    <ul className="space-y-1 pr-2">
                      {entities.slice(0, 30).map((e) => (
                        <li
                          key={e.id}
                          className="text-xs px-2 py-1 rounded cursor-pointer hover:bg-muted flex items-center justify-between gap-2"
                          onClick={() => setSelectedEntity(e)}
                        >
                          <span className="truncate flex items-center gap-1.5">
                            <span
                              className="h-1.5 w-1.5 rounded-full shrink-0"
                              style={{ background: TYPE_COLOR[e.type] || TYPE_COLOR.other }}
                            />
                            {e.name}
                          </span>
                          <span className="text-muted-foreground shrink-0">{e.mention_count}</span>
                        </li>
                      ))}
                    </ul>
                  </ScrollArea>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      )}

      {/* How to use */}
      {hasGraph && (
        <Card className="border-border/50">
          <CardContent className="py-3 text-xs text-muted-foreground space-y-1">
            <p className="font-medium text-foreground">How agents use this graph</p>
            <p>
              Enable the <span className="font-mono px-1 bg-muted rounded">kb_graph_search</span>{" "}
              tool on any agent or swarm node wired to this knowledge base. The agent will query the
              graph for entity neighbourhoods (1–2 hops) and use the resulting triples to answer
              multi-hop questions.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
