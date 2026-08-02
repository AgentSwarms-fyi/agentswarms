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
  History,
  Loader2,
  MoreVertical,
  SearchCode,
  Sigma,
  Pencil,
  Plus,
  CalendarClock,
  Palette,
  RefreshCw,
  Share2,
  ShieldCheck,
  Wand2,
  Sparkles,
  Trash2,
  Type,
  Image as ImageIcon,
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
  DropdownMenuPortal,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { BiBuilderPane, type BuilderTab } from "@/components/bi/BiBuilderPane";
import { BiExploreDialog, extractBaseTable } from "@/components/bi/BiExploreDialog";
import { BiFilterBar } from "@/components/bi/BiFilterBar";
import { BiHistoryDialog } from "@/components/bi/BiHistoryDialog";
import { useBiModelPref } from "@/components/bi/BiModelSelect";
import { BiWidgetCard } from "@/components/bi/BiWidgetCard";
import { DashboardGrid } from "@/components/bi/DashboardGrid";
import { PublishDialog } from "@/components/bi/PublishDialog";
import { ScheduleDialog } from "@/components/bi/ScheduleDialog";
import { BiThemeDialog } from "@/components/bi/BiThemeDialog";
import { GenerateDashboardDialog } from "@/components/bi/GenerateDashboardDialog";
import type { BiDataContext } from "@/components/bi/biDataContext";
import { useAuth } from "@/hooks/use-auth";
import { supabase } from "@/integrations/supabase/client";
import { biGetSharedWidgetResults } from "@/utils/bi.functions";
import type { Json } from "@/integrations/supabase/types";
import {
  generateWidgetInsight,
  loadSavedMetrics,
  loadSemantics,
  type SavedMetric,
  type SemanticEntry,
} from "@/lib/biAgent";
import {
  AUTO_SNAPSHOT_MS,
  WIDGET_ACCENTS,
  addWidgetToLayout,
  applyRowFilters,
  compactLayout,
  dashSurfaceStyle,
  parseDashTheme,
  filterWidgetRows,
  getDashboard,
  getMyDashboardRowFilters,
  defaultFilterState,
  latestDashboardVersionAt,
  parseFilters,
  parseLayout,
  parsePages,
  parseWidgets,
  makeEmptyPage,
  pushDown,
  maskWidgets,
  mergeWidgetResults,
  saveDashboardVersion,
  syncWidgetResults,
  snapshotRows,
  touchDashboardView,
  updateDashboard,
  DashboardConflictError,
  type BiCrossFilter,
  type BiRowFilter,
  type BiDashboardRow,
  type BiFilterConfig,
  type BiFilterState,
  type BiLayoutItem,
  type BiPage,
  type BiDashTheme,
  type BiWidget,
  type BiWidgetSource,
  type BiWidgetTheme,
} from "@/lib/biDashboards";
import { isAggregatableChart } from "@/lib/biAggregate";
import { exportDashboardPdf } from "@/lib/biPdf";
import { downloadCsv, downloadXlsx } from "@/lib/exportData";
import { listPrepFlows } from "@/lib/dataPrep";
import { fetchWarehouseSchema, runWarehouseQuery, runBiDirectQuery } from "@/lib/warehouseClient";
import type { DirectFilter } from "@/lib/biDirectQuery";
import { hydrateFromSupabase, runQuery, type DatasetMeta, type QueryResult } from "@/lib/sqlEngine";
import { listWarehouseConnections } from "@/utils/warehouse.functions";
import type { WarehouseConnectionSummary, WarehouseTable } from "@/utils/warehouse/types";

export const Route = createFileRoute("/_authenticated/bi_/$dashboardId")({
  head: () => ({
    meta: [{ title: "BI Project — AgentSwarms" }],
  }),
  component: BiProjectPage,
});

/** Convert active dashboard filters into pushdown-able DirectFilter[] for a
 *  direct-query widget (the server applies them safely as a WHERE clause). */
function toDirectFilters(configs: BiFilterConfig[], state: BiFilterState): DirectFilter[] {
  const out: DirectFilter[] = [];
  for (const c of configs) {
    const s = state[c.id];
    if (!s) continue;
    if (c.kind === "select" && s.values && s.values.length) {
      out.push({ column: c.column, kind: "select", values: s.values });
    } else if (c.kind === "daterange" && (s.from || s.to)) {
      out.push({ column: c.column, kind: "daterange", from: s.from, to: s.to });
    } else if (c.kind === "numrange" && (s.min != null || s.max != null)) {
      out.push({ column: c.column, kind: "numrange", min: s.min, max: s.max });
    }
  }
  return out;
}

// Page tabs strip shown above the dashboard grid. Owners can switch, add,
// rename (double-click), and delete pages; viewers just switch.
function BiPageTabs({
  pages,
  activePageId,
  readOnly,
  onSwitch,
  onAdd,
  onRename,
  onDelete,
}: {
  pages: BiPage[];
  activePageId: string;
  readOnly: boolean;
  onSwitch: (id: string) => void;
  onAdd: () => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  // Viewers of a single-page dashboard see no tab chrome.
  if (readOnly && pages.length <= 1) return null;
  return (
    <div className="mb-3 flex items-center gap-1 overflow-x-auto pb-1">
      {pages.map((p) => {
        const active = p.id === activePageId;
        if (!readOnly && editingId === p.id) {
          return (
            <input
              key={p.id}
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => {
                onRename(p.id, draft);
                setEditingId(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  onRename(p.id, draft);
                  setEditingId(null);
                } else if (e.key === "Escape") {
                  setEditingId(null);
                }
              }}
              className="h-8 w-36 shrink-0 rounded-md border border-primary bg-background px-2 text-xs outline-none"
            />
          );
        }
        return (
          <div
            key={p.id}
            role="button"
            tabIndex={0}
            onClick={() => onSwitch(p.id)}
            onDoubleClick={() => {
              if (!readOnly) {
                setDraft(p.name);
                setEditingId(p.id);
              }
            }}
            title={readOnly ? p.name : "Click to open · double-click to rename"}
            className={cn(
              "group flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-3 text-xs",
              active
                ? "border border-border bg-background font-medium shadow-sm"
                : "text-muted-foreground hover:bg-background/60",
            )}
          >
            <span className="max-w-[10rem] truncate">{p.name}</span>
            {!readOnly && pages.length > 1 && (
              <button
                type="button"
                className="text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                title="Delete page"
                onClick={(e) => {
                  e.stopPropagation();
                  if (window.confirm(`Delete "${p.name}" and its widgets? This can't be undone.`)) {
                    onDelete(p.id);
                  }
                }}
              >
                <Trash2 className="h-3 w-3" />
              </button>
            )}
          </div>
        );
      })}
      {!readOnly && (
        <Button
          variant="ghost"
          size="sm"
          className="h-8 shrink-0 gap-1 text-xs text-muted-foreground"
          onClick={onAdd}
        >
          <Plus className="h-3.5 w-3.5" /> Add page
        </Button>
      )}
    </div>
  );
}

function BiProjectPage() {
  const { dashboardId } = Route.useParams();
  const { user, session } = useAuth();
  const token = session?.access_token ?? null;

  const [row, setRow] = useState<BiDashboardRow | "missing" | null>(null);
  // Multi-page: `widgets`/`layout` are the live editing copy of the ACTIVE page;
  // `pages` holds every page (its active entry is synced on save / page-switch).
  const [widgets, setWidgets] = useState<BiWidget[]>([]);
  const [layout, setLayout] = useState<BiLayoutItem[]>([]);
  const [pages, setPages] = useState<BiPage[]>([]);
  const [activePageId, setActivePageId] = useState<string>("");
  const pagesRef = useRef<BiPage[]>([]);
  pagesRef.current = pages;
  const activePageIdRef = useRef<string>("");
  activePageIdRef.current = activePageId;
  const [name, setName] = useState("");
  const [saveState, setSaveState] = useState<"saved" | "saving" | "error" | "conflict">("saved");
  // Optimistic-concurrency guard for content saves. `versionRef` holds the
  // last version we successfully loaded/wrote; `conflictRef` latches once a
  // concurrent save is detected so we stop clobbering until the user reloads.
  const versionRef = useRef(0);
  const conflictRef = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Connected data (owner only — viewers render snapshots).
  const [datasets, setDatasets] = useState<DatasetMeta[]>([]);
  const [semantics, setSemantics] = useState<Map<string, SemanticEntry>>(new Map());
  const [metrics, setMetrics] = useState<SavedMetric[]>([]);
  const [warehouses, setWarehouses] = useState<WarehouseConnectionSummary[]>([]);
  const [whTables, setWhTables] = useState<Record<string, WarehouseTable[] | "loading" | "error">>(
    {},
  );
  const [preparedTables, setPreparedTables] = useState<Set<string>>(new Set());
  const listWarehousesFn = useServerFn(listWarehouseConnections);

  // Builder pane + dialogs
  const [pane, setPane] = useState<BuilderTab | null>(null);
  const [builderInitial, setBuilderInitial] = useState<BiWidget | null>(null);
  const [textOpen, setTextOpen] = useState(false);
  const [textInitial, setTextInitial] = useState<BiWidget | null>(null);
  const [imageOpen, setImageOpen] = useState(false);
  const [imageInitial, setImageInitial] = useState<BiWidget | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [generateOpen, setGenerateOpen] = useState(false);
  const [themeOpen, setThemeOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [insightBusyId, setInsightBusyId] = useState<string | null>(null);
  const [biModel, setBiModel] = useBiModelPref();
  const gridWrapRef = useRef<HTMLDivElement>(null);

  // Dashboard filters: definitions persist, selections are runtime-only.
  const [filterConfigs, setFilterConfigs] = useState<BiFilterConfig[]>([]);
  const [filterState, setFilterState] = useState<BiFilterState>({});
  // Live results for Direct-query widgets, keyed by widget id.
  const [directRows, setDirectRows] = useState<
    Map<
      string,
      | { columns: string[]; rows: Record<string, unknown>[]; truncated: boolean }
      | "loading"
      | "error"
    >
  >(new Map());
  // Drill-through target — non-null opens the explore dialog.
  const [exploreWidget, setExploreWidget] = useState<BiWidget | null>(null);
  const [crossFilter, setCrossFilter] = useState<BiCrossFilter>(null);

  const dashTheme = useMemo(
    () => parseDashTheme(row !== null && row !== "missing" ? row.theme : undefined),
    [row],
  );

  // One content save through the optimistic-concurrency guard. Bumps the
  // tracked version on success so back-to-back saves stay in step.
  const commitPatch = useCallback(
    async (patch: Parameters<typeof updateDashboard>[1]) => {
      const next = await updateDashboard(dashboardId, patch, {
        expectedVersion: versionRef.current,
      });
      if (typeof next === "number") versionRef.current = next;
    },
    [dashboardId],
  );

  // Shared save-error handler. A concurrent-write conflict latches (we stop
  // autosaving so we never clobber the other session) and prompts a reload;
  // anything else is a transient error.
  const onSaveError = useCallback((e: unknown) => {
    if (e instanceof DashboardConflictError) {
      conflictRef.current = true;
      setSaveState("conflict");
      toast.error("This dashboard was changed in another session.", {
        description: "Reload to get the latest version before editing further.",
        action: { label: "Reload", onClick: () => window.location.reload() },
        duration: Infinity,
      });
      return;
    }
    setSaveState("error");
    toast.error(`Save failed: ${(e as Error).message}`);
  }, []);

  async function saveTheme(t: BiDashTheme) {
    if (row === null || row === "missing") return;
    try {
      await commitPatch({ theme: t as Json });
      setRow({ ...row, theme: t as Json });
    } catch (e) {
      onSaveError(e);
    }
  }

  function setWidgetTheme(id: string, patch: Partial<BiWidgetTheme>) {
    const next = widgets.map((w) =>
      w.id === id ? { ...w, theme: { ...(w.theme ?? {}), ...patch } } : w,
    );
    persist(next, layout);
  }

  const isOwner = row !== null && row !== "missing" && row.user_id === user?.id;
  const readOnly = !isOwner;

  // The dashboard as currently edited (persisted row + local edits) — what a
  // manual version save should snapshot. Mirrored into a ref so debounced
  // save callbacks always see the latest state.
  const liveRow: BiDashboardRow | null =
    row !== null && row !== "missing"
      ? {
          ...row,
          name,
          widgets: widgets as unknown as Json,
          layout: layout as unknown as Json,
          pages: pages.map((p) =>
            p.id === activePageId ? { ...p, widgets, layout } : p,
          ) as unknown as Json,
          filters: filterConfigs as unknown as Json,
        }
      : null;
  const liveRowRef = useRef<BiDashboardRow | null>(null);
  liveRowRef.current = liveRow;

  // ── Version history: throttled auto-snapshots ───────────────────────
  // On each autosave we snapshot the state as of the start of the current
  // 10-minute window (originalRef), so History can rewind past a session.
  const originalRef = useRef<BiDashboardRow | null>(null);
  const lastSnapshotAt = useRef(Number.MAX_SAFE_INTEGER); // blocked until seeded

  const maybeAutoSnapshot = useCallback(() => {
    const base = originalRef.current;
    if (!base || Date.now() - lastSnapshotAt.current < AUTO_SNAPSHOT_MS) return;
    lastSnapshotAt.current = Date.now();
    originalRef.current = liveRowRef.current;
    void saveDashboardVersion(base, null).catch(() => {});
  }, []);

  // ── Load dashboard (also re-run after a version restore) ────────────
  const loadDashboard = useCallback(() => {
    getDashboard(dashboardId)
      .then(async (r) => {
        if (!r) return setRow("missing");
        // Grantee path: a viewer whose grant carries a row filter or column
        // mask cannot read bi_widget_results directly (RLS admits only
        // unrestricted grants), so their data comes through the server
        // function that filters and masks it first. maskWidgets also runs over
        // the document itself, so legacy rows still embedded there can never
        // show a masked column.
        const { data: sessionData } = await supabase.auth.getSession();
        const me = sessionData.session?.user.id;
        const accessToken = sessionData.session?.access_token;
        if (me && accessToken && r.user_id !== me) {
          try {
            const shared = await biGetSharedWidgetResults({
              data: { access_token: accessToken, dashboard_id: dashboardId },
            });
            if (shared.ok) {
              const mask = shared.masked_columns;
              r.widgets = maskWidgets(mergeWidgetResults(r.widgets, shared.results), mask) as Json;
              r.pages = (
                Array.isArray(r.pages)
                  ? (r.pages as Record<string, unknown>[]).map((p) => ({
                      ...p,
                      widgets: maskWidgets(mergeWidgetResults(p.widgets, shared.results), mask),
                    }))
                  : r.pages
              ) as Json;
            }
          } catch {
            /* fall back to whatever RLS surfaced */
          }
        }
        setRow(r);
        versionRef.current = r.version ?? 0;
        conflictRef.current = false;
        setName(r.name);
        const w = parseWidgets(r.widgets);
        const pgs = parsePages(r.pages, w, parseLayout(r.layout, w));
        setPages(pgs);
        pagesRef.current = pgs;
        setActivePageId(pgs[0].id);
        activePageIdRef.current = pgs[0].id;
        setWidgets(pgs[0].widgets);
        setLayout(pgs[0].layout);
        const cfgs = parseFilters(r.filters);
        setFilterConfigs(cfgs);
        setFilterState(defaultFilterState(cfgs));
        originalRef.current = r;
      })
      .catch((e) => {
        toast.error((e as Error).message);
        setRow("missing");
      });
  }, [dashboardId]);

  useEffect(() => loadDashboard(), [loadDashboard]);

  // Seed the snapshot throttle from the newest stored version so frequent
  // short sessions don't each mint a version.
  useEffect(() => {
    if (!isOwner) return;
    latestDashboardVersionAt(dashboardId)
      .then((t) => (lastSnapshotAt.current = t))
      .catch(() => (lastSnapshotAt.current = 0));
  }, [isOwner, dashboardId]);

  // Usage analytics: count each dashboard open once (owners and grantees
  // alike). Keyed by id — the route component is reused across param changes.
  const viewTouched = useRef<string | null>(null);
  useEffect(() => {
    if (viewTouched.current === dashboardId || row === null || row === "missing" || !user?.id)
      return;
    viewTouched.current = dashboardId;
    touchDashboardView(dashboardId);
  }, [row, user?.id, dashboardId]);

  // Row-level security: viewers get the row filters attached to their IAM
  // grants (null = unrestricted). Applied to every widget snapshot before
  // rendering and to the filter options.
  const [rowFilters, setRowFilters] = useState<BiRowFilter[] | null>(null);
  // Viewers wait for their grant filters before any data renders, so
  // restricted rows never flash unfiltered while the query is in flight.
  const [filtersReady, setFiltersReady] = useState(false);
  useEffect(() => {
    setRowFilters(null); // never carry filters across dashboards
    setFiltersReady(false);
    if (row === null || row === "missing" || !user?.id) return;
    if (row.user_id === user.id) return setFiltersReady(true);
    getMyDashboardRowFilters(dashboardId)
      .then((f) => {
        setRowFilters(f);
        setFiltersReady(true);
      })
      .catch(() => setFiltersReady(true));
  }, [row, user?.id, dashboardId]);

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
      listPrepFlows()
        .then((fs) =>
          setPreparedTables(
            new Set(fs.map((f) => f.output_table_name).filter((n): n is string => Boolean(n))),
          ),
        )
        .catch(() => {});
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
      preparedTables,
      model: biModel,
      onModelChange: setBiModel,
      semantics,
      metrics,
      warehouses,
      whTables,
      ensureSchema,
      runSql,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      user?.id,
      datasets,
      preparedTables,
      biModel,
      semantics,
      metrics,
      warehouses,
      whTables,
      ensureSchema,
      runSql,
    ],
  );

  // ── Persistence (debounced autosave) ────────────────────────────────
  // Write the whole `pages` array; also mirror page 1 into the legacy
  // widgets/layout columns so older readers keep working.
  const savePages = useCallback(
    (nextPages: BiPage[]) => {
      if (readOnly || conflictRef.current) return;
      setSaveState("saving");
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        // Data first, then the definition: updateDashboard strips rows from
        // the document, so the results store is where a reload will find them.
        // Sync failures don't block the save — the fallback is stale data, and
        // the next refresh repairs it.
        void syncWidgetResults(
          dashboardId,
          nextPages.flatMap((p) => p.widgets),
        ).catch(() => {});
        commitPatch({
          pages: nextPages as unknown as Json,
          widgets: (nextPages[0]?.widgets ?? []) as unknown as Json,
          layout: (nextPages[0]?.layout ?? []) as unknown as Json,
        })
          .then(() => {
            setSaveState("saved");
            maybeAutoSnapshot();
          })
          .catch(onSaveError);
      }, 700);
    },
    [readOnly, commitPatch, onSaveError, maybeAutoSnapshot, dashboardId],
  );

  const persist = useCallback(
    (nextWidgets: BiWidget[], nextLayout: BiLayoutItem[]) => {
      setWidgets(nextWidgets);
      setLayout(nextLayout);
      const nextPages = pagesRef.current.map((p) =>
        p.id === activePageIdRef.current ? { ...p, widgets: nextWidgets, layout: nextLayout } : p,
      );
      setPages(nextPages);
      pagesRef.current = nextPages;
      savePages(nextPages);
    },
    [savePages],
  );

  // Capture the active page's live edits back into the pages array.
  const captureActivePage = useCallback(
    (): BiPage[] =>
      pagesRef.current.map((p) =>
        p.id === activePageIdRef.current ? { ...p, widgets, layout } : p,
      ),
    [widgets, layout],
  );

  const switchPage = useCallback(
    (targetId: string) => {
      if (targetId === activePageIdRef.current) return;
      const captured = captureActivePage();
      const target = captured.find((p) => p.id === targetId);
      if (!target) return;
      setPages(captured);
      pagesRef.current = captured;
      setActivePageId(targetId);
      activePageIdRef.current = targetId;
      setWidgets(target.widgets);
      setLayout(target.layout);
      setCrossFilter(null);
      setPane(null);
    },
    [captureActivePage],
  );

  const addPage = useCallback(() => {
    if (readOnly) return;
    const np = makeEmptyPage(`Page ${pagesRef.current.length + 1}`);
    const nextPages = [...captureActivePage(), np];
    setPages(nextPages);
    pagesRef.current = nextPages;
    setActivePageId(np.id);
    activePageIdRef.current = np.id;
    setWidgets([]);
    setLayout([]);
    setCrossFilter(null);
    setPane(null);
    savePages(nextPages);
  }, [readOnly, captureActivePage, savePages]);

  const renamePage = useCallback(
    (id: string, nextName: string) => {
      const nm = nextName.trim();
      if (readOnly || !nm) return;
      const nextPages = captureActivePage().map((p) => (p.id === id ? { ...p, name: nm } : p));
      setPages(nextPages);
      pagesRef.current = nextPages;
      savePages(nextPages);
    },
    [readOnly, captureActivePage, savePages],
  );

  const deletePage = useCallback(
    (id: string) => {
      if (readOnly || pagesRef.current.length <= 1) return;
      const captured = captureActivePage();
      const idx = captured.findIndex((p) => p.id === id);
      const nextPages = captured.filter((p) => p.id !== id);
      setPages(nextPages);
      pagesRef.current = nextPages;
      if (id === activePageIdRef.current) {
        const fallback = nextPages[Math.max(0, idx - 1)];
        setActivePageId(fallback.id);
        activePageIdRef.current = fallback.id;
        setWidgets(fallback.widgets);
        setLayout(fallback.layout);
        setCrossFilter(null);
        setPane(null);
      }
      savePages(nextPages);
    },
    [readOnly, captureActivePage, savePages],
  );

  function persistFilterConfigs(next: BiFilterConfig[]) {
    setFilterConfigs(next);
    if (readOnly || conflictRef.current) return;
    setSaveState("saving");
    commitPatch({ filters: next as unknown as Json })
      .then(() => setSaveState("saved"))
      .catch(onSaveError);
  }

  async function saveName() {
    if (row === null || row === "missing" || readOnly) return;
    const trimmed = name.trim();
    if (!trimmed || trimmed === row.name) return setName(row.name);
    try {
      await commitPatch({ name: trimmed });
      setRow({ ...row, name: trimmed });
    } catch (e) {
      if (e instanceof DashboardConflictError) return onSaveError(e);
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

  // Toggle a warehouse widget between Import (snapshot) and Direct query (live).
  // Use the ORIGINAL stored widget (widgetById may have swapped in live rows),
  // so switching mode never overwrites the saved snapshot.
  // Move a widget's aggregation between SQL and the browser.
  //
  // Turning it ON clears `truncated` and the stale snapshot rows: the old rows
  // are a capped raw extract whose client-side totals are exactly the partial
  // sums we are fixing, so leaving them on screen until the next refresh would
  // keep showing the wrong number under a badge that now says it is fine.
  function toggleAggPushdown(w: BiWidget) {
    const orig = widgets.find((x) => x.id === w.id) ?? w;
    const on = !orig.agg_pushdown;
    replaceWidget({
      ...orig,
      agg_pushdown: on,
      ...(on ? { rows: [], truncated: false } : {}),
    });
    toast.success(
      on
        ? "Aggregating in SQL — refresh the widget to load complete totals."
        : "Aggregating in the browser — refresh to reload the row snapshot.",
    );
  }

  function setWidgetQueryMode(w: BiWidget, mode: "import" | "direct") {
    const orig = widgets.find((x) => x.id === w.id) ?? w;
    replaceWidget({ ...orig, query_mode: mode });
    setDirectRows((prev) => {
      const next = new Map(prev);
      next.delete(w.id);
      return next;
    });
    toast.success(
      mode === "direct"
        ? "Direct query on — live data from the warehouse"
        : "Using the in-memory engine (cached snapshot)",
    );
  }

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
    if (w.source?.kind === "semantic") {
      toast.info("This widget is backed by a governed metric — edit it in the Semantic Layer.");
      return;
    }
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
        model: biModel ?? undefined,
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

  function downloadWidgetCsv(w: BiWidget) {
    // Uses the shared writer in lib/exportData rather than a local one. The
    // copy that used to live here had drifted three ways: it did not escape
    // the HEADER row at all, its escape test was /[",\n]/ and so missed a bare
    // carriage return, and it had no guard against spreadsheet formula
    // injection. A second implementation of an escaper is a second set of
    // holes, and this one had them.
    downloadCsv(
      w.columns ?? [],
      w.rows ?? [],
      `${w.title.replace(/[^\w-]+/g, "_") || "widget"}.csv`,
    );
  }

  async function downloadWidgetPng(w: BiWidget) {
    const el = gridWrapRef.current?.querySelector(
      `[data-widget-id="${w.id}"]`,
    ) as HTMLElement | null;
    if (!el) return toast.error("Widget not found on the grid");
    const { default: html2canvas } = await import("html2canvas-pro");
    const canvas = await html2canvas(el, { backgroundColor: null, scale: 2, logging: false });
    const a = document.createElement("a");
    a.href = canvas.toDataURL("image/png");
    a.download = `${w.title.replace(/[^\w-]+/g, "_") || "widget"}.png`;
    a.click();
  }

  async function handleExport() {
    if (row === null || row === "missing" || !gridWrapRef.current) return;
    setExporting(true);
    // Snapshot every page (with the active page's live edits) so the export
    // loop can render each in turn without capturing/mutating state.
    const restore = { id: activePageId, widgets, layout };
    const exportPages: BiPage[] = pages.map((p) =>
      p.id === activePageId ? { ...p, widgets, layout } : p,
    );
    try {
      await exportDashboardPdf({
        title: row.name,
        description: row.description,
        pageCount: exportPages.length,
        preparePage: async (i) => {
          const pg = exportPages[i];
          // Make this page the live grid, then let it (and its charts) render.
          setActivePageId(pg.id);
          activePageIdRef.current = pg.id;
          setWidgets(pg.widgets);
          setLayout(pg.layout);
          await new Promise((r) => setTimeout(r, 550));
          if (!gridWrapRef.current) throw new Error("Dashboard grid isn't ready");
          return {
            container: gridWrapRef.current,
            name: exportPages.length > 1 ? pg.name : undefined,
          };
        },
      });
      toast.success("PDF downloaded");
    } catch (e) {
      toast.error(`Export failed: ${(e as Error).message}`);
    } finally {
      // Restore the page the user was on (with its live edits).
      setActivePageId(restore.id);
      activePageIdRef.current = restore.id;
      setWidgets(restore.widgets);
      setLayout(restore.layout);
      setExporting(false);
    }
  }

  // Live "Direct query" widgets: re-run against the warehouse (server-side, as
  // the dashboard owner) whenever the direct widgets or the filters change.
  // Import widgets keep their snapshot. This route only ever renders for an
  // authenticated owner/grantee — public share/embed routes render snapshots.
  // NOTE: this hook must stay above the early returns below so it runs on every
  // render (Rules of Hooks).
  const directWidgetIds = widgets
    .filter((w) => w.query_mode === "direct" && w.source?.kind === "warehouse" && w.sql)
    .map((w) => w.id);
  const activeDirectFilters = toDirectFilters(filterConfigs, filterState);
  const directSig = JSON.stringify([directWidgetIds, activeDirectFilters, crossFilter]);
  useEffect(() => {
    if (!token || directWidgetIds.length === 0) return;
    let cancelled = false;
    setDirectRows((prev) => {
      const next = new Map(prev);
      for (const id of directWidgetIds) if (!next.has(id)) next.set(id, "loading");
      return next;
    });
    void Promise.all(
      directWidgetIds.map(async (id) => {
        const perWidget: DirectFilter[] =
          crossFilter && crossFilter.widgetId !== id
            ? [
                ...activeDirectFilters,
                { column: crossFilter.column, kind: "select", values: [crossFilter.value] },
              ]
            : activeDirectFilters;
        try {
          const res = await runBiDirectQuery(token, {
            dashboardId,
            widgetId: id,
            filters: perWidget,
          });
          if (!cancelled) {
            setDirectRows((prev) =>
              new Map(prev).set(id, {
                columns: res.columns,
                rows: res.rows,
                truncated: res.capped,
              }),
            );
          }
        } catch {
          if (!cancelled) setDirectRows((prev) => new Map(prev).set(id, "error"));
        }
      }),
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [directSig, token, dashboardId]);

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

  // Grant row filters must be resolved before a viewer sees any data.
  if (readOnly && !filtersReady) {
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

  // Mandatory grant row filters first (viewers can't clear them), then
  // dashboard filters + the cross-filter. securedWidgets also feeds the
  // filter bar, so restricted rows never reach the viewer's UI.
  const securedWidgets = rowFilters
    ? widgets.map((w) =>
        w.kind === "chart" && (w.rows?.length ?? 0) > 0
          ? { ...w, rows: applyRowFilters(w.rows ?? [], rowFilters) }
          : w,
      )
    : widgets;
  const widgetById = new Map(
    securedWidgets.map((w) => {
      // Direct-query widget: prefer the live, server-filtered warehouse result;
      // fall back to the snapshot while it loads or if the live query errored.
      if (w.query_mode === "direct" && w.source?.kind === "warehouse" && w.sql) {
        const live = directRows.get(w.id);
        if (live && live !== "loading" && live !== "error") {
          // Carry truncation through so a live result that hit the row ceiling
          // gets the same "Partial" badge a capped snapshot does.
          return [
            w.id,
            { ...w, columns: live.columns, rows: live.rows, truncated: live.truncated },
          ] as const;
        }
        return [w.id, w] as const;
      }
      return [
        w.id,
        w.kind === "chart" && (w.rows?.length ?? 0) > 0
          ? { ...w, rows: filterWidgetRows(w, filterConfigs, filterState, crossFilter) }
          : w,
      ] as const;
    }),
  );

  const handleElementClick = (widgetId: string) => (column: string, value: string) =>
    setCrossFilter((prev) =>
      prev && prev.column === column && prev.value === value ? null : { widgetId, column, value },
    );

  return (
    // Bounded to the viewport (same pattern as /data-sql) so the canvas and
    // the builder pane scroll independently instead of the whole page.
    <div className="flex h-[calc(100vh-3.5rem)] flex-col overflow-hidden">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-border bg-background px-3 py-2">
        <Button
          asChild
          size="sm"
          variant="ghost"
          className="h-8 w-8 p-0 text-muted-foreground"
          title="Back to BI Workspace"
        >
          <Link to="/bi">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <div className="flex min-w-0 items-center gap-2">
          <Link
            to="/bi"
            className="hidden shrink-0 text-xs font-medium text-muted-foreground hover:text-foreground sm:block"
          >
            BI Workspace
          </Link>
          <span className="hidden text-xs text-muted-foreground/50 sm:block">/</span>
          {readOnly ? (
            <h1 className="min-w-0 truncate text-[15px] font-semibold">{row.name}</h1>
          ) : (
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => void saveName()}
              onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
              className="h-8 w-56 rounded-md border-transparent bg-transparent px-2 text-[15px] font-semibold shadow-none hover:bg-muted/60 focus:bg-background focus-visible:border-border"
            />
          )}
        </div>
        {row.published && (
          <Badge className="gap-1 border-0 bg-emerald-500/15 text-[10px] font-medium text-emerald-600 hover:bg-emerald-500/15 dark:text-emerald-400">
            <Globe className="h-2.5 w-2.5" /> Published
          </Badge>
        )}
        {readOnly && (
          <Badge variant="outline" className="text-[10px] font-medium">
            Read-only
          </Badge>
        )}
        {readOnly && rowFilters && (
          <Badge
            className="gap-1 border-0 bg-sky-500/15 text-[10px] font-medium text-sky-600 hover:bg-sky-500/15 dark:text-sky-400"
            title={`Your administrator limited this view to: ${rowFilters
              .map((f) => `${f.column} ∈ ${f.values.join(", ")}`)
              .join(" · ")}`}
          >
            <ShieldCheck className="h-2.5 w-2.5" /> Filtered view
          </Badge>
        )}

        <div className="ml-auto flex items-center gap-0.5">
          {!readOnly && (
            <span
              className="mr-2 flex items-center gap-1.5 text-[11px] text-muted-foreground"
              title="Changes save automatically"
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  saveState === "saving"
                    ? "animate-pulse bg-amber-500"
                    : saveState === "error" || saveState === "conflict"
                      ? "bg-destructive"
                      : "bg-emerald-500"
                }`}
              />
              {saveState === "saving"
                ? "Saving"
                : saveState === "conflict"
                  ? "Changed elsewhere — reload"
                  : saveState === "error"
                    ? "Save failed"
                    : "Saved"}
            </span>
          )}
          {!readOnly && (
            <>
              <Button
                size="sm"
                variant="ghost"
                className="h-8 gap-1.5 px-2.5 text-xs"
                onClick={() => {
                  setBuilderInitial(null);
                  setPane("build");
                }}
              >
                <Plus className="h-3.5 w-3.5" /> Chart
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-8 gap-1.5 px-2.5 text-xs"
                onClick={() => setPane("ai")}
              >
                <Sparkles className="h-3.5 w-3.5 text-primary" /> AI analyst
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-8 gap-1.5 px-2.5 text-xs"
                onClick={() => {
                  setTextInitial(null);
                  setTextOpen(true);
                }}
              >
                <Type className="h-3.5 w-3.5" /> Text
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-8 gap-1.5 px-2.5 text-xs"
                onClick={() => {
                  setImageInitial(null);
                  setImageOpen(true);
                }}
              >
                <ImageIcon className="h-3.5 w-3.5" /> Image
              </Button>
              <div className="mx-1.5 h-5 w-px bg-border" />
              <Button
                size="sm"
                variant="ghost"
                className="h-8 gap-1.5 px-2.5 text-xs"
                onClick={() => void refreshAll()}
                disabled={refreshing}
              >
                {refreshing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )}
                Refresh
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-8 gap-1.5 px-2.5 text-xs"
                onClick={() => setScheduleOpen(true)}
                title="Scheduled refresh & data alerts"
              >
                <CalendarClock className="h-3.5 w-3.5" /> Schedule
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-8 gap-1.5 px-2.5 text-xs"
                onClick={() => setGenerateOpen(true)}
                title="Generate a whole dashboard from a goal with AI"
              >
                <Wand2 className="h-3.5 w-3.5 text-primary" /> Generate
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-8 gap-1.5 px-2.5 text-xs"
                onClick={() => setThemeOpen(true)}
                title="Background image & font"
              >
                <Palette className="h-3.5 w-3.5" /> Theme
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-8 gap-1.5 px-2.5 text-xs"
                onClick={() => setHistoryOpen(true)}
                title="Version history — snapshots & restore"
              >
                <History className="h-3.5 w-3.5" /> History
              </Button>
            </>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="h-8 gap-1.5 px-2.5 text-xs"
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
            <>
              <div className="mx-1.5 h-5 w-px bg-border" />
              <Button
                size="sm"
                className="h-8 gap-1.5 px-3 text-xs"
                onClick={() => setPublishOpen(true)}
              >
                <Share2 className="h-3.5 w-3.5" /> Publish &amp; share
              </Button>
            </>
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <div
          className="min-w-0 flex-1 overflow-y-auto bg-muted/30 p-5"
          style={{
            backgroundImage: "radial-gradient(circle, var(--border) 1px, transparent 1px)",
            backgroundSize: "22px 22px",
          }}
        >
          <BiPageTabs
            pages={pages}
            activePageId={activePageId}
            readOnly={readOnly}
            onSwitch={switchPage}
            onAdd={addPage}
            onRename={renamePage}
            onDelete={deletePage}
          />
          <BiFilterBar
            configs={filterConfigs}
            widgets={securedWidgets}
            state={filterState}
            onStateChange={setFilterState}
            cross={crossFilter}
            onClearCross={() => setCrossFilter(null)}
            editable={!readOnly}
            onConfigsChange={persistFilterConfigs}
          />
          <div ref={gridWrapRef} className="rounded-xl" style={dashSurfaceStyle(dashTheme)}>
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
                    onElementClick={handleElementClick(id)}
                    selectedValue={
                      crossFilter && crossFilter.widgetId === id ? crossFilter.value : null
                    }
                    actions={
                      readOnly ? undefined : (
                        <div className="flex items-center gap-1">
                          {w.source?.kind === "semantic" && (
                            <Badge
                              variant="secondary"
                              className="h-5 px-1.5 text-[10px]"
                              title="Backed by a governed semantic metric — edit it in the Semantic Layer"
                            >
                              Metric
                            </Badge>
                          )}
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button size="sm" variant="ghost" className="h-6 w-6 shrink-0 p-0">
                                <MoreVertical className="h-3.5 w-3.5" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              {w.source?.kind === "semantic" ? (
                                <DropdownMenuItem disabled>
                                  <Pencil className="mr-2 h-3.5 w-3.5" /> Edit in Semantic Layer
                                </DropdownMenuItem>
                              ) : (
                                <DropdownMenuItem onClick={() => editWidget(w)}>
                                  <Pencil className="mr-2 h-3.5 w-3.5" /> Edit
                                </DropdownMenuItem>
                              )}
                              {w.source?.kind === "warehouse" && (
                                <DropdownMenuItem
                                  onClick={() =>
                                    setWidgetQueryMode(
                                      w,
                                      w.query_mode === "direct" ? "import" : "direct",
                                    )
                                  }
                                >
                                  <SearchCode className="mr-2 h-3.5 w-3.5" />
                                  {w.query_mode === "direct"
                                    ? "Use in-memory engine (snapshot)"
                                    : "Use direct query (live)"}
                                </DropdownMenuItem>
                              )}
                              {isAggregatableChart(w.chart) && (
                                <DropdownMenuItem onClick={() => toggleAggPushdown(w)}>
                                  <Sigma className="mr-2 h-3.5 w-3.5" />
                                  {w.agg_pushdown
                                    ? "Aggregate in the browser (snapshot)"
                                    : "Aggregate in SQL (complete totals)"}
                                </DropdownMenuItem>
                              )}
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
                              {w.kind === "chart" && extractBaseTable(w.sql) && (
                                <DropdownMenuItem onClick={() => setExploreWidget(w)}>
                                  <SearchCode className="mr-2 h-3.5 w-3.5" /> Explore data
                                </DropdownMenuItem>
                              )}
                              {w.kind === "chart" && (w.rows?.length ?? 0) > 0 && (
                                <DropdownMenuSub>
                                  <DropdownMenuSubTrigger>
                                    <FileDown className="mr-2 h-3.5 w-3.5" /> Export data
                                  </DropdownMenuSubTrigger>
                                  <DropdownMenuPortal>
                                    <DropdownMenuSubContent>
                                      <DropdownMenuItem
                                        onClick={() =>
                                          downloadCsv(
                                            w.columns ?? [],
                                            w.rows ?? [],
                                            w.title || "widget",
                                          )
                                        }
                                      >
                                        CSV (.csv)
                                      </DropdownMenuItem>
                                      <DropdownMenuItem
                                        onClick={() =>
                                          void downloadXlsx(
                                            w.columns ?? [],
                                            w.rows ?? [],
                                            w.title || "widget",
                                            {
                                              sheet: w.title || "Data",
                                              columnFormats: w.chart?.columnFormats,
                                            },
                                          )
                                        }
                                      >
                                        Excel (.xlsx)
                                      </DropdownMenuItem>
                                    </DropdownMenuSubContent>
                                  </DropdownMenuPortal>
                                </DropdownMenuSub>
                              )}
                              <DropdownMenuItem onClick={() => duplicateWidget(w.id)}>
                                <Copy className="mr-2 h-3.5 w-3.5" /> Duplicate
                              </DropdownMenuItem>
                              <DropdownMenuSub>
                                <DropdownMenuSubTrigger>
                                  <Palette className="mr-2 h-3.5 w-3.5" /> Appearance
                                </DropdownMenuSubTrigger>
                                <DropdownMenuPortal>
                                  <DropdownMenuSubContent className="w-48">
                                    <p className="px-2 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                                      Accent
                                    </p>
                                    <div className="grid grid-cols-4 gap-1 px-2 pb-1.5">
                                      {Object.entries(WIDGET_ACCENTS).map(([id, a]) => (
                                        <button
                                          key={id}
                                          type="button"
                                          title={a.label}
                                          onClick={() =>
                                            setWidgetTheme(w.id, {
                                              accent: id === "default" ? undefined : id,
                                            })
                                          }
                                          className={`h-6 rounded-md border ${
                                            (w.theme?.accent ?? "default") === id
                                              ? "border-foreground"
                                              : "border-border/60"
                                          }`}
                                          style={{ background: a.color || "var(--primary)" }}
                                        />
                                      ))}
                                    </div>
                                    <p className="px-2 pb-1 pt-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                                      Card style
                                    </p>
                                    {(["default", "tint", "glass"] as const).map((c) => (
                                      <DropdownMenuItem
                                        key={c}
                                        onClick={() =>
                                          setWidgetTheme(w.id, {
                                            card: c === "default" ? undefined : c,
                                          })
                                        }
                                        className={
                                          (w.theme?.card ?? "default") === c
                                            ? "font-semibold"
                                            : undefined
                                        }
                                      >
                                        {c === "default"
                                          ? "Default"
                                          : c === "tint"
                                            ? "Accent tint"
                                            : "Glass (over image)"}
                                      </DropdownMenuItem>
                                    ))}
                                  </DropdownMenuSubContent>
                                </DropdownMenuPortal>
                              </DropdownMenuSub>
                              {w.kind === "chart" && (w.rows?.length ?? 0) > 0 && (
                                <DropdownMenuItem onClick={() => downloadWidgetCsv(w)}>
                                  <FileDown className="mr-2 h-3.5 w-3.5" /> Download CSV
                                </DropdownMenuItem>
                              )}
                              <DropdownMenuItem onClick={() => void downloadWidgetPng(w)}>
                                <FileDown className="mr-2 h-3.5 w-3.5" /> Download PNG
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                className="text-destructive focus:text-destructive"
                                onClick={() => removeWidget(w.id)}
                              >
                                <Trash2 className="mr-2 h-3.5 w-3.5" /> Remove
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
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
          <ImageWidgetDialog
            open={imageOpen}
            onOpenChange={setImageOpen}
            initial={imageInitial}
            onSubmit={(w) => (imageInitial ? replaceWidget(w) : addWidget(w))}
          />
          <PublishDialog
            open={publishOpen}
            onOpenChange={setPublishOpen}
            dashboard={row}
            accessToken={token}
            onUpdated={(patch) => setRow({ ...row, ...patch })}
          />
          {user?.id && (
            <ScheduleDialog
              open={scheduleOpen}
              onOpenChange={setScheduleOpen}
              dashboardId={row.id}
              userId={user.id}
              widgets={widgets}
            />
          )}
          <GenerateDashboardDialog
            open={generateOpen}
            onOpenChange={setGenerateOpen}
            ctx={ctx}
            onDone={(newWidgets) => {
              // Executive summary first (full width), then KPIs, charts,
              // tables at the bottom.
              const rank = (w: BiWidget) => {
                if (w.kind === "text") return -1;
                const t = w.chart?.type;
                return t === "kpi" || t === "gauge" ? 0 : t === "table" ? 2 : 1;
              };
              const sorted = [...newWidgets].sort((a, b) => rank(a) - rank(b));
              let lay = layout;
              for (const w of sorted) {
                lay = addWidgetToLayout(lay, w, w.kind === "text" ? { w: 12, h: 3 } : undefined);
              }
              persist([...widgets, ...sorted], lay);
            }}
          />
          <BiThemeDialog
            open={themeOpen}
            onOpenChange={setThemeOpen}
            theme={dashTheme}
            onSave={saveTheme}
          />
          {liveRow && (
            <BiHistoryDialog
              open={historyOpen}
              onOpenChange={setHistoryOpen}
              row={liveRow}
              onRestored={loadDashboard}
            />
          )}
        </>
      )}

      {!readOnly && (
        <BiExploreDialog
          widget={exploreWidget}
          context={crossFilter}
          onClose={() => setExploreWidget(null)}
        />
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

const IMAGE_UPLOAD_MAX_BYTES = 3 * 1024 * 1024; // 3 MB — kept inline in the dashboard JSON

function ImageWidgetDialog({
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
  const [mode, setMode] = useState<"upload" | "url">("url");
  const [src, setSrc] = useState(""); // data-URI (upload) or external URL
  const [fit, setFit] = useState<"contain" | "cover">("contain");
  const [href, setHref] = useState("");
  const [alt, setAlt] = useState("");

  useEffect(() => {
    if (!open) return;
    setTitle(initial?.title ?? "");
    const img = initial?.image;
    setSrc(img?.src ?? "");
    setMode(img?.src?.startsWith("data:") ? "upload" : "url");
    setFit(img?.fit ?? "contain");
    setHref(img?.href ?? "");
    setAlt(img?.alt ?? "");
  }, [open, initial]);

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) return toast.error("Please choose an image file");
    if (file.size > IMAGE_UPLOAD_MAX_BYTES) {
      return toast.error("Image is larger than 3 MB — use a smaller file or paste a URL instead");
    }
    const reader = new FileReader();
    reader.onload = () => setSrc(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => toast.error("Could not read that file");
    reader.readAsDataURL(file);
  }

  function submit() {
    if (!title.trim()) return toast.error("Give the image a title");
    if (!src.trim())
      return toast.error(mode === "upload" ? "Choose an image file" : "Enter an image URL");
    if (mode === "url" && !/^https?:\/\//i.test(src.trim())) {
      return toast.error("Image URL must start with http:// or https://");
    }
    onSubmit({
      id: initial?.id ?? crypto.randomUUID(),
      kind: "image",
      title: title.trim(),
      image: { src: src.trim(), fit, href: href.trim() || undefined, alt: alt.trim() || undefined },
    });
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{initial ? "Edit image" : "Add image"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Title</Label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Company logo"
            />
          </div>
          <div className="flex gap-1.5">
            <Button
              type="button"
              size="sm"
              variant={mode === "url" ? "default" : "outline"}
              onClick={() => setMode("url")}
            >
              From URL
            </Button>
            <Button
              type="button"
              size="sm"
              variant={mode === "upload" ? "default" : "outline"}
              onClick={() => setMode("upload")}
            >
              Upload
            </Button>
          </div>
          {mode === "url" ? (
            <div className="space-y-1.5">
              <Label>Image URL</Label>
              <Input
                value={src.startsWith("data:") ? "" : src}
                onChange={(e) => setSrc(e.target.value)}
                placeholder="https://my-bucket.s3.amazonaws.com/logo.png"
              />
              <p className="text-[11px] text-muted-foreground">
                Any public image URL (e.g. a public S3 object). Loaded by the viewer&apos;s browser.
              </p>
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label>Image file (max 3 MB)</Label>
              <Input type="file" accept="image/*" onChange={onFile} />
              {src.startsWith("data:") && (
                <p className="text-[11px] text-muted-foreground">
                  Image loaded — stored with the dashboard.
                </p>
              )}
            </div>
          )}
          {src && (
            <div className="flex h-28 items-center justify-center overflow-hidden rounded-md border border-border/60 bg-muted/30">
              <img src={src} alt="" className="h-full w-full" style={{ objectFit: fit }} />
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Fit</Label>
              <div className="flex gap-1.5">
                <Button
                  type="button"
                  size="sm"
                  variant={fit === "contain" ? "default" : "outline"}
                  onClick={() => setFit("contain")}
                >
                  Contain
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={fit === "cover" ? "default" : "outline"}
                  onClick={() => setFit("cover")}
                >
                  Cover
                </Button>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Link (optional)</Label>
              <Input
                value={href}
                onChange={(e) => setHref(e.target.value)}
                placeholder="https://…"
              />
            </div>
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
