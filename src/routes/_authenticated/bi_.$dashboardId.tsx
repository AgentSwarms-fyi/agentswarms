// BI project editor — an editable dashboard under the BI Workspace.
// Owners compose widgets (manual SQL charts, AI-generated visuals, markdown
// text), arrange them on the grid, refresh data snapshots and publish.
// Users the project is shared with (IAM grants) get a read-only view.
import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  ArrowLeft,
  BarChart3,
  Copy,
  FileDown,
  Globe,
  Loader2,
  MoreVertical,
  Pencil,
  Plus,
  RefreshCw,
  Share2,
  Sparkles,
  Trash2,
  Type,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { BiBuilderPane, type BuilderTab } from "@/components/bi/BiBuilderPane";
import { BiWidgetCard } from "@/components/bi/BiWidgetCard";
import { DashboardGrid } from "@/components/bi/DashboardGrid";
import { PublishDialog } from "@/components/bi/PublishDialog";
import type { BiDataContext } from "@/components/bi/biDataContext";
import { useAuth } from "@/hooks/use-auth";
import type { Json } from "@/integrations/supabase/types";
import {
  generateWidgetInsight,
  loadSavedMetrics,
  loadSemantics,
  type SavedMetric,
  type SemanticEntry,
} from "@/lib/biAgent";
import {
  addWidgetToLayout,
  compactLayout,
  getDashboard,
  parseLayout,
  parseWidgets,
  pushDown,
  snapshotRows,
  updateDashboard,
  type BiDashboardRow,
  type BiLayoutItem,
  type BiWidget,
  type BiWidgetSource,
} from "@/lib/biDashboards";
import { exportDashboardPdf } from "@/lib/biPdf";
import { fetchWarehouseSchema, runWarehouseQuery } from "@/lib/warehouseClient";
import { hydrateFromSupabase, runQuery, type DatasetMeta, type QueryResult } from "@/lib/sqlEngine";
import { listWarehouseConnections } from "@/utils/warehouse.functions";
import type { WarehouseConnectionSummary, WarehouseTable } from "@/utils/warehouse/types";

export const Route = createFileRoute("/_authenticated/bi_/$dashboardId")({
  head: () => ({
    meta: [{ title: "BI Project — AgentSwarms" }],
  }),
  component: BiProjectPage,
});

function BiProjectPage() {
  const { dashboardId } = Route.useParams();
  const { user, session } = useAuth();
  const token = session?.access_token ?? null;

  const [row, setRow] = useState<BiDashboardRow | "missing" | null>(null);
  const [widgets, setWidgets] = useState<BiWidget[]>([]);
  const [layout, setLayout] = useState<BiLayoutItem[]>([]);
  const [name, setName] = useState("");
  const [saveState, setSaveState] = useState<"saved" | "saving" | "error">("saved");
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Connected data (owner only — viewers render snapshots).
  const [datasets, setDatasets] = useState<DatasetMeta[]>([]);
  const [semantics, setSemantics] = useState<Map<string, SemanticEntry>>(new Map());
  const [metrics, setMetrics] = useState<SavedMetric[]>([]);
  const [warehouses, setWarehouses] = useState<WarehouseConnectionSummary[]>([]);
  const [whTables, setWhTables] = useState<Record<string, WarehouseTable[] | "loading" | "error">>(
    {},
  );
  const listWarehousesFn = useServerFn(listWarehouseConnections);

  // Builder pane + dialogs
  const [pane, setPane] = useState<BuilderTab | null>(null);
  const [builderInitial, setBuilderInitial] = useState<BiWidget | null>(null);
  const [textOpen, setTextOpen] = useState(false);
  const [textInitial, setTextInitial] = useState<BiWidget | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [insightBusyId, setInsightBusyId] = useState<string | null>(null);
  const gridWrapRef = useRef<HTMLDivElement>(null);

  const isOwner = row !== null && row !== "missing" && row.user_id === user?.id;
  const readOnly = !isOwner;

  // ── Load dashboard ──────────────────────────────────────────────────
  useEffect(() => {
    getDashboard(dashboardId)
      .then((r) => {
        if (!r) return setRow("missing");
        setRow(r);
        setName(r.name);
        const w = parseWidgets(r.widgets);
        setWidgets(w);
        setLayout(parseLayout(r.layout, w));
      })
      .catch((e) => {
        toast.error((e as Error).message);
        setRow("missing");
      });
  }, [dashboardId]);

  // ── Load connected data sources (owner only) ────────────────────────
  useEffect(() => {
    if (!isOwner || !user?.id) return;
    (async () => {
      try {
        const tables = await hydrateFromSupabase();
        setDatasets(tables);
        const [sem, mets] = await Promise.all([
          loadSemantics(tables.map((d) => d.id)),
          loadSavedMetrics(),
        ]);
        setSemantics(sem);
        setMetrics(mets);
      } catch (e) {
        toast.error(`Could not load local datasets: ${(e as Error).message}`);
      }
    })();
  }, [isOwner, user?.id]);

  useEffect(() => {
    if (!isOwner || !token) return;
    listWarehousesFn({ data: { access_token: token } }).then((res) => {
      if (res.ok) setWarehouses(res.connections.filter((c) => c.is_active));
    });
  }, [isOwner, token, listWarehousesFn]);

  const ensureSchema = useCallback(
    (connId: string) => {
      setWhTables((s) => {
        if (s[connId] && s[connId] !== "error") return s;
        if (token) {
          fetchWarehouseSchema(token, connId)
            .then((tables) => setWhTables((cur) => ({ ...cur, [connId]: tables })))
            .catch((e) => {
              setWhTables((cur) => ({ ...cur, [connId]: "error" }));
              toast.error((e as Error).message);
            });
        }
        return { ...s, [connId]: "loading" };
      });
    },
    [token],
  );

  const runSql = useCallback(
    async (source: BiWidgetSource, sql: string): Promise<QueryResult> => {
      if (source.kind === "warehouse") {
        if (!token) throw new Error("Not signed in");
        return runWarehouseQuery(token, source.connection_id, sql);
      }
      return runQuery(sql);
    },
    [token],
  );

  const ctx: BiDataContext = useMemo(
    () => ({
      userId: user?.id ?? null,
      datasets,
      semantics,
      metrics,
      warehouses,
      whTables,
      ensureSchema,
      runSql,
    }),
    [user?.id, datasets, semantics, metrics, warehouses, whTables, ensureSchema, runSql],
  );

  // ── Persistence (debounced autosave) ────────────────────────────────
  const persist = useCallback(
    (nextWidgets: BiWidget[], nextLayout: BiLayoutItem[]) => {
      setWidgets(nextWidgets);
      setLayout(nextLayout);
      if (readOnly) return;
      setSaveState("saving");
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        updateDashboard(dashboardId, {
          widgets: nextWidgets as unknown as Json,
          layout: nextLayout as unknown as Json,
        })
          .then(() => setSaveState("saved"))
          .catch((e) => {
            setSaveState("error");
            toast.error(`Save failed: ${(e as Error).message}`);
          });
      }, 700);
    },
    [dashboardId, readOnly],
  );

  async function saveName() {
    if (row === null || row === "missing" || readOnly) return;
    const trimmed = name.trim();
    if (!trimmed || trimmed === row.name) return setName(row.name);
    try {
      await updateDashboard(dashboardId, { name: trimmed });
      setRow({ ...row, name: trimmed });
    } catch (e) {
      toast.error((e as Error).message);
      setName(row.name);
    }
  }

  // ── Widget operations ───────────────────────────────────────────────
  const addWidget = (w: BiWidget) => persist([...widgets, w], addWidgetToLayout(layout, w));

  const replaceWidget = (w: BiWidget) =>
    persist(
      widgets.map((x) => (x.id === w.id ? w : x)),
      layout,
    );

  const removeWidget = (id: string) =>
    persist(
      widgets.filter((w) => w.id !== id),
      layout.filter((l) => l.i !== id),
    );

  const duplicateWidget = (id: string) => {
    const src = widgets.find((w) => w.id === id);
    if (!src) return;
    const copy: BiWidget = { ...src, id: crypto.randomUUID(), title: `${src.title} (copy)` };
    persist([...widgets, copy], addWidgetToLayout(layout, copy));
  };

  async function refreshAll() {
    const chartWidgets = widgets.filter((w) => w.kind === "chart" && w.sql);
    if (chartWidgets.length === 0) return toast.info("No chart widgets to refresh");
    setRefreshing(true);
    let failures = 0;
    const next = [...widgets];
    for (const w of chartWidgets) {
      try {
        const res = await runSql(w.source ?? { kind: "local" }, w.sql!);
        const idx = next.findIndex((x) => x.id === w.id);
        next[idx] = {
          ...next[idx],
          columns: res.columns,
          rows: snapshotRows(res.rows),
          refreshed_at: new Date().toISOString(),
        };
      } catch (e) {
        failures++;
        toast.error(`"${w.title}": ${(e as Error).message}`);
      }
    }
    persist(next, layout);
    setRefreshing(false);
    if (failures === 0) toast.success("All widget data refreshed");
  }

  function editWidget(w: BiWidget) {
    if (w.kind === "text") {
      setTextInitial(w);
      setTextOpen(true);
    } else {
      setBuilderInitial(w);
      setPane("build");
    }
  }

  /** Generate an AI insight card and place it directly below the visual. */
  async function addInsight(w: BiWidget) {
    if (!w.rows || w.rows.length === 0) {
      return toast.error("No data snapshot — run or refresh this widget first");
    }
    setInsightBusyId(w.id);
    try {
      const insight = await generateWidgetInsight({
        title: w.title,
        sql: w.sql,
        columns: w.columns ?? [],
        rows: w.rows,
      });
      const widget: BiWidget = {
        id: crypto.randomUUID(),
        kind: "text",
        title: `Insight — ${w.title}`,
        text: insight,
      };
      const anchor = layout.find((l) => l.i === w.id);
      let nextLayout: BiLayoutItem[];
      if (anchor) {
        const item: BiLayoutItem = {
          i: widget.id,
          x: anchor.x,
          y: anchor.y + anchor.h,
          w: anchor.w,
          h: 3,
        };
        nextLayout = compactLayout(pushDown([...layout, item], item));
      } else {
        nextLayout = addWidgetToLayout(layout, widget);
      }
      persist([...widgets, widget], nextLayout);
      toast.success("AI insight added below the visual");
    } catch (e) {
      toast.error(`Insight failed: ${(e as Error).message}`);
    } finally {
      setInsightBusyId(null);
    }
  }

  async function handleExport() {
    if (row === null || row === "missing" || !gridWrapRef.current) return;
    setExporting(true);
    try {
      await exportDashboardPdf({
        title: row.name,
        description: row.description,
        container: gridWrapRef.current,
      });
      toast.success("PDF downloaded");
    } catch (e) {
      toast.error(`Export failed: ${(e as Error).message}`);
    } finally {
      setExporting(false);
    }
  }

  // ── Render ──────────────────────────────────────────────────────────
  if (row === null) {
    return (
      <div className="space-y-4 p-6">
        <Skeleton className="h-10 w-72" />
        <div className="grid grid-cols-2 gap-4">
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
        </div>
      </div>
    );
  }

  if (row === "missing") {
    return (
      <div className="flex flex-col items-center justify-center gap-3 p-16 text-center">
        <BarChart3 className="h-10 w-10 text-muted-foreground" />
        <p className="font-medium">
          This BI project doesn&apos;t exist or you don&apos;t have access.
        </p>
        <Button asChild variant="secondary">
          <Link to="/bi">
            <ArrowLeft className="mr-1.5 h-4 w-4" /> Back to BI Workspace
          </Link>
        </Button>
      </div>
    );
  }

  const widgetById = new Map(widgets.map((w) => [w.id, w]));

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
        <Button
          asChild
          size="sm"
          variant="ghost"
          className="h-8 w-8 p-0"
          title="Back to BI Workspace"
        >
          <Link to="/bi">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        {readOnly ? (
          <h1 className="min-w-0 truncate text-base font-semibold">{row.name}</h1>
        ) : (
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => void saveName()}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            className="h-8 w-64 border-transparent bg-transparent text-base font-semibold hover:border-border focus:border-border"
          />
        )}
        {row.published && (
          <Badge className="gap-1 bg-emerald-500/15 text-[10px] text-emerald-600 hover:bg-emerald-500/15 dark:text-emerald-400">
            <Globe className="h-2.5 w-2.5" /> Published
          </Badge>
        )}
        {readOnly && (
          <Badge variant="outline" className="text-[10px]">
            Read-only · shared with you
          </Badge>
        )}

        <div className="ml-auto flex items-center gap-1.5">
          {!readOnly && (
            <span className="mr-1 text-[10px] text-muted-foreground">
              {saveState === "saving" ? "Saving…" : saveState === "error" ? "Save failed" : "Saved"}
            </span>
          )}
          {!readOnly && (
            <>
              <Button
                size="sm"
                variant="outline"
                className="h-8 gap-1.5 text-xs"
                onClick={() => {
                  setBuilderInitial(null);
                  setPane("build");
                }}
              >
                <Plus className="h-3.5 w-3.5" /> Chart
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-8 gap-1.5 text-xs"
                onClick={() => setPane("ai")}
              >
                <Sparkles className="h-3.5 w-3.5 text-primary" /> AI analyst
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-8 gap-1.5 text-xs"
                onClick={() => {
                  setTextInitial(null);
                  setTextOpen(true);
                }}
              >
                <Type className="h-3.5 w-3.5" /> Text
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-8 gap-1.5 text-xs"
                onClick={() => void refreshAll()}
                disabled={refreshing}
              >
                {refreshing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )}
                Refresh data
              </Button>
            </>
          )}
          <Button
            size="sm"
            variant="outline"
            className="h-8 gap-1.5 text-xs"
            onClick={() => void handleExport()}
            disabled={exporting || layout.length === 0}
            title="Export this dashboard as a PDF report"
          >
            {exporting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <FileDown className="h-3.5 w-3.5" />
            )}
            Export PDF
          </Button>
          {!readOnly && (
            <Button size="sm" className="h-8 gap-1.5 text-xs" onClick={() => setPublishOpen(true)}>
              <Share2 className="h-3.5 w-3.5" /> Publish &amp; share
            </Button>
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-y-auto bg-muted/20 p-4">
          <div ref={gridWrapRef}>
            <DashboardGrid
              layout={layout}
              editable={!readOnly}
              onLayoutChange={(next) => persist(widgets, next)}
              emptyState={
                <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border/70 py-20 text-center">
                  <BarChart3 className="h-8 w-8 text-muted-foreground" />
                  <p className="text-sm font-medium">This dashboard is empty</p>
                  {!readOnly && (
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="secondary"
                        className="gap-1.5"
                        onClick={() => {
                          setBuilderInitial(null);
                          setPane("build");
                        }}
                      >
                        <Plus className="h-3.5 w-3.5" /> Add a chart
                      </Button>
                      <Button size="sm" className="gap-1.5" onClick={() => setPane("ai")}>
                        <Sparkles className="h-3.5 w-3.5" /> Generate with AI
                      </Button>
                    </div>
                  )}
                </div>
              }
              renderItem={(id) => {
                const w = widgetById.get(id);
                if (!w) return null;
                return (
                  <BiWidgetCard
                    widget={w}
                    actions={
                      readOnly ? undefined : (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button size="sm" variant="ghost" className="h-6 w-6 shrink-0 p-0">
                              <MoreVertical className="h-3.5 w-3.5" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => editWidget(w)}>
                              <Pencil className="mr-2 h-3.5 w-3.5" /> Edit
                            </DropdownMenuItem>
                            {w.kind === "chart" && (
                              <DropdownMenuItem
                                disabled={insightBusyId !== null}
                                onClick={() => void addInsight(w)}
                              >
                                {insightBusyId === w.id ? (
                                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <Sparkles className="mr-2 h-3.5 w-3.5 text-primary" />
                                )}
                                AI insight
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuItem onClick={() => duplicateWidget(w.id)}>
                              <Copy className="mr-2 h-3.5 w-3.5" /> Duplicate
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              className="text-destructive focus:text-destructive"
                              onClick={() => removeWidget(w.id)}
                            >
                              <Trash2 className="mr-2 h-3.5 w-3.5" /> Remove
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )
                    }
                  />
                );
              }}
            />
          </div>
        </div>

        {!readOnly && pane !== null && (
          <BiBuilderPane
            ctx={ctx}
            tab={pane}
            onTabChange={setPane}
            initial={builderInitial}
            onSubmit={(w) => {
              if (builderInitial) {
                replaceWidget(w);
                setBuilderInitial(null);
              } else {
                addWidget(w);
              }
            }}
            onInsertAi={addWidget}
            onClose={() => {
              setPane(null);
              setBuilderInitial(null);
            }}
          />
        )}
      </div>

      {!readOnly && (
        <>
          <TextWidgetDialog
            open={textOpen}
            onOpenChange={setTextOpen}
            initial={textInitial}
            onSubmit={(w) => (textInitial ? replaceWidget(w) : addWidget(w))}
          />
          <PublishDialog
            open={publishOpen}
            onOpenChange={setPublishOpen}
            dashboard={row}
            accessToken={token}
            onUpdated={(patch) => setRow({ ...row, ...patch })}
          />
        </>
      )}
    </div>
  );
}

function TextWidgetDialog({
  open,
  onOpenChange,
  initial,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  initial: BiWidget | null;
  onSubmit: (w: BiWidget) => void;
}) {
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");

  useEffect(() => {
    if (!open) return;
    setTitle(initial?.title ?? "");
    setText(initial?.text ?? "");
  }, [open, initial]);

  function submit() {
    if (!title.trim()) return toast.error("Give the text block a title");
    onSubmit({
      id: initial?.id ?? crypto.randomUUID(),
      kind: "text",
      title: title.trim(),
      text,
    });
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{initial ? "Edit text block" : "Add text block"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Title</Label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Executive summary"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Content (Markdown supported)</Label>
            <Textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={8}
              placeholder={"## Key takeaways\n- Revenue grew 12% QoQ\n- …"}
              className="font-mono text-xs"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit}>{initial ? "Save" : "Add to dashboard"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
