// Data Catalog browser: a sources rail, a searchable/filterable asset
import { Skeleton } from "@/components/ui/skeleton";
// inventory, and a detail sheet with column-level metadata, PII flags
// and user curation (description + tags, which survive re-crawls).
// Local CSV tables appear automatically as a built-in source; warehouse
// and object-storage sources are added through the wizard and crawled
// on demand.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import {
  BadgeCheck,
  BookMarked,
  CalendarClock,
  Cloud,
  Database,
  FileText,
  Folder,
  Gauge,
  GitBranch,
  HardDrive,
  Layers,
  LayoutDashboard,
  Loader2,
  MoreVertical,
  Play,
  Plug,
  Plus,
  RefreshCw,
  Search,
  Server,
  ShieldAlert,
  Sparkles,
  Table2,
  Tag,
  Trash2,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/hooks/use-auth";
import { useBiModelPref } from "@/components/bi/BiModelSelect";
import {
  assetLineageKeys,
  fmtBytes,
  fmtCount,
  generateAssetDocs,
  isPiiColumnName,
  listCatalogAssets,
  listCatalogSources,
  listGlossaryTerms,
  assetFreshness,
  freshnessPrefix,
  loadLineageIndex,
  loadCatalogLineage,
  lookupLineage,
  sourceLineageFor,
  updateCatalogAsset,
  type AssetLineage,
  type CatalogAsset,
  type CatalogAssetStatus,
  type CatalogLineageEdge,
  type CatalogSource,
  type GlossaryTerm,
  type LineageIndex,
} from "@/lib/dataCatalog";
import { supabase } from "@/integrations/supabase/client";
import {
  LOCAL_SOURCE_ID,
  datasetSourceIds,
  saasSourcesFrom,
  type SaasAttributionRow,
  type SaasSource,
} from "@/lib/catalogSources";
import { SCHEDULE_LABELS, scheduleSummary } from "@/lib/saasSchedule";
import { listSaasConnections, setSaasSchedule, syncSaasConnection } from "@/utils/saas.functions";
import { SAAS_LABELS } from "@/utils/saas/types";
import type { SaasConnectionSummary, SyncSchedule } from "@/utils/saas/types";
import { hydrateFromSupabase } from "@/lib/sqlEngine";
import { objectSqlName } from "@/lib/objectSqlName";
import {
  catalogCrawlSource,
  catalogDeleteSource,
  catalogSetSchedule,
} from "@/utils/catalog.functions";
import { AddSourceWizard } from "@/components/catalog/AddSourceWizard";
import { DatasetQualityPanel, QualityChip } from "@/components/catalog/DatasetQualityPanel";
import { GlossaryDialog } from "@/components/catalog/GlossaryDialog";
import { loadLatestQualityResults, listQualityTests, rollupByTable } from "@/lib/dataQuality";
import type { QualityRollup } from "@/lib/dataQualityCore";

/** Local tables presented in the same shape as crawled assets. */
type UnifiedAsset = CatalogAsset & { local?: boolean };

export function CatalogView({
  onQueryAsset,
  active = true,
}: {
  /** Open an asset in the Workbench tab with a seeded query (auto-executed). */
  onQueryAsset?: (seed: { sql: string; dataSource: string; autorun?: boolean }) => void;
  /**
   * Whether this pane is the one on screen. The parent keeps both panes mounted
   * and toggles `hidden`, so without this the catalog would show whatever it
   * read when the page first loaded, for as long as the tab stayed open.
   */
  active?: boolean;
}) {
  const { session } = useAuth();
  const token = session?.access_token ?? "";
  const crawlFn = useServerFn(catalogCrawlSource);
  const deleteFn = useServerFn(catalogDeleteSource);
  const catalogSetScheduleFn = useServerFn(catalogSetSchedule);
  const listConnectionsFn = useServerFn(listSaasConnections);
  const syncConnectionFn = useServerFn(syncSaasConnection);
  const saasScheduleFn = useServerFn(setSaasSchedule);
  // A catalog source shared via IAM is read-only for the grantee: they can
  // browse it but not re-crawl / reschedule / delete / curate.
  const myId = session?.user?.id ?? "";
  const ownsSource = (s: CatalogSource) => s.user_id === myId;

  const [sources, setSources] = useState<CatalogSource[]>([]);
  const [assets, setAssets] = useState<CatalogAsset[]>([]);
  const [localAssets, setLocalAssets] = useState<UnifiedAsset[]>([]);
  const [quality, setQuality] = useState<Map<string, QualityRollup>>(new Map());
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [piiOnly, setPiiOnly] = useState(false);
  const [certOnly, setCertOnly] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [crawlingIds, setCrawlingIds] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<UnifiedAsset | null>(null);

  const [lineage, setLineage] = useState<LineageIndex>(new Map());
  const [catalogLineage, setCatalogLineage] = useState<CatalogLineageEdge[]>([]);
  const [glossary, setGlossary] = useState<GlossaryTerm[]>([]);
  const [glossaryOpen, setGlossaryOpen] = useState(false);
  /** Connector-synced sources, so the rail and the SOURCE column can name them. */
  const [saasSources, setSaasSources] = useState<SaasSource[]>([]);
  /** The same rows, keyed by connection id, for the rail's sync/schedule menu. */
  const [saasConnections, setSaasConnections] = useState<SaasConnectionSummary[]>([]);
  const [syncingConnIds, setSyncingConnIds] = useState<Set<string>>(new Set());

  /**
   * Re-read the LOCAL datasets from Supabase.
   *
   * Lives outside the mount effect because local assets go stale within a
   * session: uploading in the Workbench tab, or restoring a version from this
   * very drawer, changes the row count while the Catalog keeps showing the
   * number it read at mount. Observed: a dataset replaced with 10 rows still
   * read "ROWS 364", and Refresh did not correct it because `reload` only
   * refetched CRAWLED assets.
   */
  const reloadLocal = useCallback(async (): Promise<UnifiedAsset[]> => {
    try {
      const tables = await hydrateFromSupabase();
      // WHERE A SYNCED DATASET CAME FROM.
      //
      // Connector-synced tables live in user_data_tables like any upload —
      // deliberately, so a synced dataset cannot behave differently to an
      // uploaded one. But that made the catalog file seven Salesforce tables
      // under "Local tables", which is true about their storage and useless
      // about their origin. saas_connection_id (migration 20260832000000) is
      // the fact; source_filename was only ever a label to read.
      const [{ data: attribution }, connections] = await Promise.all([
        // Cast through unknown: types.ts is generated from the DEPLOYED schema
        // and these columns ship in migration 20260832000000. Regenerating
        // types after applying it removes the need.
        supabase.from("user_data_tables").select("id, saas_connection_id") as unknown as Promise<{
          data: SaasAttributionRow[] | null;
        }>,
        // The SAME server function the Integration Hub calls, not a direct
        // table read. Two pages that answer "when did this last sync?" from
        // two different queries eventually disagree — and the direct read
        // cannot see sources reached through an IAM grant at all.
        token
          ? listConnectionsFn({ data: { access_token: token } }).catch(() => [])
          : Promise.resolve([]),
      ]);
      const conns = connections;
      setSaasConnections(conns);
      const saasList = saasSourcesFrom(conns);
      setSaasSources(saasList);
      const saasByTable = datasetSourceIds(attribution ?? [], conns);
      const providerBySource = new Map(saasList.map((s) => [s.id, s.provider]));
      const mapped: UnifiedAsset[] = tables.map((d) => {
        const columns = d.columns.map((c) => ({
          name: c.name,
          type: c.type,
          pii: isPiiColumnName(c.name) || undefined,
        }));
        const saasSource = saasByTable.get(d.id);
        return {
          id: `local:${d.id}`,
          user_id: myId,
          // A connector-synced table belongs to its connection, not to the
          // catch-all bucket that only describes where the bytes sit.
          source_id: saasSource ?? LOCAL_SOURCE_ID,
          asset_type: "table" as const,
          schema_name: null,
          name: d.name,
          fqn: d.name,
          columns,
          row_count: d.row_count,
          // The real size when the dataset has been synced to Parquet. This was
          // hardcoded null, so a table whose size is known still showed "—".
          size_bytes: d.parquet_bytes,
          // A synced table was never a CSV file, and saying so is the same
          // mistake as filing it under "Local tables" — describing the pipe it
          // came down rather than where it came from.
          format: saasSource
            ? (providerBySource.get(saasSource) ?? "synced")
            : d.is_sample
              ? "sample"
              : "csv",
          file_count: null,
          description: null,
          tags: d.is_sample ? ["sample"] : [],
          owner: null,
          status: "draft" as const,
          pii: columns.some((c) => c.pii),
          // WHEN THE DATA ARRIVED, not when this list was built.
          //
          // This was `new Date()`, so the drawer printed "Crawled less than a
          // minute ago" over every local table — including datasets loaded
          // weeks earlier. Measured: 26 tables with data_loaded_at spanning
          // 2026-07-20 to 2026-08-07, every one of them reported as fresh.
          // A freshness stamp that is always now is not a stamp.
          last_crawled_at: d.data_loaded_at,
          local: true,
        };
      });
      setLocalAssets(mapped);
      return mapped;
    } catch (e) {
      // Local tables disappearing from the catalog while the Workbench and
      // the agent can still query the same dataset is a hydration failure,
      // not an empty account. Bare, this catch reported the two as the same
      // thing: an empty "Local tables" filter and no way to tell which.
      console.warn("[Catalog] local table hydration failed", e);
      setLocalAssets([]);
      return [];
    }
  }, [myId, token, listConnectionsFn]);

  const reload = useCallback(async () => {
    // Local hydration runs ALONGSIDE the crawled reads, not inside the same
    // await: it spins up DuckDB-WASM, and a wedged worker (cold dev-server
    // optimize, slow disk) used to hold the ENTIRE catalog at skeletons even
    // though every crawled query had long since returned. It still refreshes
    // on every reload and sets its own state when it lands.
    void reloadLocal();
    try {
      const [src, ast, lin, terms, srcLin] = await Promise.all([
        listCatalogSources(),
        listCatalogAssets(),
        loadLineageIndex(),
        listGlossaryTerms(),
        loadCatalogLineage(),
      ]);
      setSources(src);
      setAssets(ast);
      setLineage(lin);
      setGlossary(terms);
      setCatalogLineage(srcLin);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }, [reloadLocal]);

  const termDefs = useMemo(
    () => new Map(glossary.map((t) => [t.term.toLowerCase(), t.definition])),
    [glossary],
  );

  useEffect(() => {
    (async () => {
      setLoading(true);
      // `reload` now hydrates local datasets as part of the same pass.
      await reload();
      setLoading(false);
    })();
  }, [reload]);

  // Re-read local datasets each time this pane comes back into view. Only the
  // local half: crawled assets change on a schedule, not because someone
  // switched tabs, and re-crawling on every toggle would be wasteful.
  const wasActive = useRef(active);
  useEffect(() => {
    if (active && !wasActive.current) void reloadLocal();
    wasActive.current = active;
  }, [active, reloadLocal]);

  // Latest quality verdict per local dataset, so the list can badge assets
  // without opening each one. Failures here are non-fatal: an unbadged asset
  // is a smaller problem than a catalog that won't load.
  useEffect(() => {
    (async () => {
      try {
        const [tests, results] = await Promise.all([
          listQualityTests(),
          loadLatestQualityResults(),
        ]);
        setQuality(rollupByTable(tests, results));
      } catch {
        setQuality(new Map());
      }
    })();
  }, []);

  const qualityFor = (a: UnifiedAsset): QualityRollup | undefined =>
    a.local ? quality.get(a.id.replace(/^local:/, "")) : undefined;

  const sourceById = useMemo(() => new Map(sources.map((s) => [s.id, s])), [sources]);

  const allAssets: UnifiedAsset[] = useMemo(
    () => [...localAssets, ...assets],
    [localAssets, assets],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return allAssets.filter((a) => {
      if (sourceFilter !== "all" && a.source_id !== sourceFilter) return false;
      if (typeFilter !== "all" && a.asset_type !== typeFilter) return false;
      if (piiOnly && !a.pii) return false;
      if (certOnly && a.status !== "certified") return false;
      if (!q) return true;
      const hay =
        `${a.fqn} ${a.name} ${a.schema_name ?? ""} ${a.tags.join(" ")} ${a.owner ?? ""} ${a.description ?? ""} ${a.columns.map((c) => c.name).join(" ")}`.toLowerCase();
      return q.split(/\s+/).every((part) => hay.includes(part));
    });
  }, [allAssets, search, sourceFilter, typeFilter, piiOnly, certOnly]);

  async function recrawl(source: CatalogSource) {
    if (!ownsSource(source))
      return toast.error("This source is shared read-only — only its owner can re-crawl it");
    setCrawlingIds((s) => new Set(s).add(source.id));
    try {
      const res = await crawlFn({ data: { access_token: token, source_id: source.id } });
      if (!res.ok) throw new Error(res.error);
      const c = res.stats.changes;
      const drift =
        c && c.added.length + c.removed.length + c.changed.length > 0
          ? ` · ${[
              c.added.length ? `${c.added.length} added` : null,
              c.removed.length ? `${c.removed.length} removed` : null,
              c.changed.length ? `${c.changed.length} schema-changed` : null,
            ]
              .filter(Boolean)
              .join(", ")}`
          : "";
      toast.success(
        `Crawled "${source.name}" — ${res.stats.assets} assets, ${res.stats.columns} columns${drift}`,
      );
      await reload();
    } catch (e) {
      toast.error((e as Error).message);
      await reload(); // pick up the error status
    } finally {
      setCrawlingIds((s) => {
        const next = new Set(s);
        next.delete(source.id);
        return next;
      });
    }
  }

  async function setSchedule(source: CatalogSource, schedule: CatalogSource["crawl_schedule"]) {
    if (!ownsSource(source))
      return toast.error("This source is shared read-only — only its owner can schedule crawls");
    const res = await catalogSetScheduleFn({
      data: { access_token: token, source_id: source.id, schedule },
    });
    if (!res.ok) return toast.error(res.error);
    toast.success(
      schedule === "manual"
        ? "Scheduled crawls disabled"
        : `Crawling ${schedule} — you'll be notified when the schema changes`,
    );
    await reload();
  }

  async function removeSource(source: CatalogSource) {
    if (!ownsSource(source))
      return toast.error("This source is shared read-only — only its owner can remove it");
    if (!window.confirm(`Remove "${source.name}" and its cataloged assets?`)) return;
    const res = await deleteFn({ data: { access_token: token, source_id: source.id } });
    if (!res.ok) return toast.error(res.error);
    toast.success("Source removed");
    if (sourceFilter === source.id) setSourceFilter("all");
    await reload();
  }

  /**
   * Re-sync a connector source from the catalog.
   *
   * Calls the SAME server function the Integration Hub's button calls, so the
   * two cannot drift: it writes last_sync_status / last_synced_at on the
   * connection row, which is what makes the Hub's "Last sync" column reflect a
   * run started from here.
   */
  async function resyncSaas(s: SaasSource) {
    const conn = saasConnections.find((c) => c.id === s.connectionId);
    setSyncingConnIds((prev) => new Set(prev).add(s.connectionId));
    try {
      const res = await syncConnectionFn({
        data: { access_token: token, id: s.connectionId },
      });
      const rows = res.synced.reduce((n, r) => n + r.rowCount, 0);
      if (res.failed.length > 0) {
        // A PARTIAL SYNC IS NOT SUCCESS — the same rule the Hub applies. One
        // stream of seven failing quietly is how a dashboard goes stale.
        toast.warning(
          `${conn?.name ?? s.name}: synced ${res.synced.length}, failed ${res.failed.length} — ` +
            `${res.failed[0].stream}: ${res.failed[0].error}`,
        );
      } else {
        toast.success(
          `${conn?.name ?? s.name}: ${res.synced.length} dataset${
            res.synced.length === 1 ? "" : "s"
          }, ${rows.toLocaleString()} rows`,
        );
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Sync failed");
    } finally {
      setSyncingConnIds((prev) => {
        const next = new Set(prev);
        next.delete(s.connectionId);
        return next;
      });
      // Either way: a failed run still changed the row's status, and the rail
      // has to show that rather than the state from before the attempt.
      await reload();
    }
  }

  async function setSaasScheduleFor(s: SaasSource, schedule: SyncSchedule) {
    const conn = saasConnections.find((c) => c.id === s.connectionId);
    if (conn?.shared)
      return toast.error("This source is shared read-only — only its owner can schedule syncs");
    try {
      await saasScheduleFn({
        data: { access_token: token, id: s.connectionId, sync_schedule: schedule },
      });
      toast.success(
        schedule === "manual"
          ? `“${s.name}” now syncs only when you ask`
          : `“${s.name}” syncs ${schedule} — first run starts shortly`,
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not change the schedule");
    } finally {
      await reload();
    }
  }

  const sourceIcon = (s: CatalogSource) =>
    s.kind === "warehouse" ? (
      <Server className="h-3.5 w-3.5" />
    ) : s.kind === "iceberg_rest" ? (
      <Database className="h-3.5 w-3.5" />
    ) : (
      <Cloud className="h-3.5 w-3.5" />
    );

  const statusDot = (s: CatalogSource) => (
    <span
      title={s.status === "error" ? (s.last_error ?? "error") : s.status}
      className={`h-1.5 w-1.5 shrink-0 rounded-full ${
        s.status === "ready"
          ? "bg-emerald-500"
          : s.status === "crawling"
            ? "animate-pulse bg-amber-500"
            : s.status === "error"
              ? "bg-destructive"
              : "bg-muted-foreground/40"
      }`}
    />
  );

  /**
   * One instant for the whole rail.
   *
   * Recomputed on each render rather than ticking: these labels are coarse
   * ("in 3 hours"), so a live countdown would be motion without information.
   */
  const railNow = new Date();

  const assetCountBySource = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of allAssets) m.set(a.source_id, (m.get(a.source_id) ?? 0) + 1);
    return m;
  }, [allAssets]);

  const typeIcon = (t: UnifiedAsset["asset_type"]) =>
    t === "table" || t === "view" ? (
      <Table2 className="h-3.5 w-3.5 text-teal-600 dark:text-teal-400" />
    ) : t === "dataset" ? (
      <Folder className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
    ) : (
      <FileText className="h-3.5 w-3.5 text-sky-600 dark:text-sky-400" />
    );

  const sourceName = (a: UnifiedAsset) => {
    if (a.source_id === LOCAL_SOURCE_ID) return "Local tables";
    // A synced dataset is named for the connection it came from. It is still
    // stored locally; that is simply not the interesting fact about it.
    const saas = saasSources.find((s) => s.id === a.source_id);
    if (saas) return saas.name;
    return sourceById.get(a.source_id)?.name ?? "—";
  };

  /**
   * Formats the object-store engine can open. A bucket can hold anything —
   * images, logs, ORC — and offering "Query in Workbench" on a PNG would be a
   * button that only ever produces an error.
   */
  // `.avro` is deliberately absent: the file is cataloged, but DuckDB has no
  // Avro build for this version, so the button would only ever error.
  const QUERYABLE_OBJECT = /\.(parquet|csv|tsv|json|ndjson|jsonl|orc)$/i;

  const queryable = (a: UnifiedAsset) => {
    if (a.local) return true;
    const kind = sourceById.get(a.source_id)?.kind;
    if (kind === "warehouse") return true;
    if (kind !== "object_storage" || !QUERYABLE_OBJECT.test(a.fqn)) return false;
    // A crawled folder of same-format files is ONE asset with a glob fqn
    // (`sales/*.parquet`). DuckDB expands that over s3 for Parquet, CSV and
    // JSON — verified — but ORC is read by downloading an object, and a glob
    // is not an object key. Offering the button on an ORC folder would open
    // the Workbench on a query that cannot succeed.
    if (a.asset_type === "dataset" && a.format === "orc") return false;
    return true;
  };

  const lineageFor = useCallback(
    (a: UnifiedAsset): AssetLineage =>
      lookupLineage(lineage, assetLineageKeys(a, sourceById.get(a.source_id), Boolean(a.local))),
    [lineage, sourceById],
  );

  function openInWorkbench(a: UnifiedAsset) {
    if (!onQueryAsset) return;
    if (a.local) {
      onQueryAsset({
        sql: `SELECT * FROM "${a.name}" LIMIT 10`,
        dataSource: "local",
        autorun: true,
      });
      return;
    }
    const src = sourceById.get(a.source_id);
    if (src?.kind === "warehouse" && src.connection_id) {
      onQueryAsset({
        sql: `SELECT * FROM ${a.fqn} LIMIT 10`,
        dataSource: src.connection_id,
        autorun: true,
      });
      return;
    }
    if (src?.kind === "object_storage") {
      // The SQL name is derived the same way the server derives it
      // (objectStoreQuery.sqlNameFor): the file's basename without its
      // extension. Seeding `SELECT * FROM data/orders.parquet` would be a
      // syntax error and would teach the wrong thing about how to write these.
      onQueryAsset({
        sql: `SELECT * FROM ${objectSqlName(a.fqn)} LIMIT 10`,
        dataSource: `storage:${src.id}`,
        autorun: true,
      });
    }
  }

  return (
    <div className="flex h-full min-h-0">
      {/* ── Sources rail ─────────────────────────────────────────── */}
      <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-3 py-2.5">
          <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider">
            <Layers className="h-4 w-4 text-primary" /> Sources
          </span>
          <Button
            size="sm"
            className="h-7 gap-1 px-2 text-[11px]"
            onClick={() => setWizardOpen(true)}
          >
            <Plus className="h-3 w-3" /> Add
          </Button>
        </div>
        <ScrollArea className="flex-1">
          <div className="space-y-0.5 p-2">
            <button
              type="button"
              onClick={() => setSourceFilter("all")}
              className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs ${
                sourceFilter === "all" ? "bg-primary/10 font-medium text-primary" : "hover:bg-muted"
              }`}
            >
              <Database className="h-3.5 w-3.5" /> All assets
              <span className="ml-auto text-[10px] text-muted-foreground">{allAssets.length}</span>
            </button>
            <button
              type="button"
              onClick={() => setSourceFilter(LOCAL_SOURCE_ID)}
              className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs ${
                sourceFilter === LOCAL_SOURCE_ID
                  ? "bg-primary/10 font-medium text-primary"
                  : "hover:bg-muted"
              }`}
            >
              <HardDrive className="h-3.5 w-3.5" /> Local tables
              <span className="ml-auto text-[10px] text-muted-foreground">
                {localAssets.filter((a) => a.source_id === LOCAL_SOURCE_ID).length}
              </span>
            </button>

            {/* Connector-synced datasets, listed under the connection they came
                from. They are stored locally like any upload — that is simply
                not the fact anyone is looking for when they ask where a table
                came from. */}
            {saasSources.map((s) => {
              const count = localAssets.filter((a) => a.source_id === s.id).length;
              if (count === 0) return null;
              const conn = saasConnections.find((c) => c.id === s.connectionId);
              const syncing = syncingConnIds.has(s.connectionId);
              const sched = conn ? scheduleSummary(conn, railNow) : null;
              return (
                <div
                  key={s.id}
                  className={`group flex items-center gap-1 rounded-md ${
                    sourceFilter === s.id ? "bg-primary/10" : "hover:bg-muted"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => setSourceFilter(s.id)}
                    className={`flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-xs ${
                      sourceFilter === s.id ? "font-medium text-primary" : ""
                    }`}
                    title={
                      conn
                        ? `${SAAS_LABELS[conn.provider] ?? s.provider} · ${
                            sched?.cadence ?? ""
                          }${sched?.next ? ` · ${sched.next}` : ""}${
                            conn.last_sync_error ? `\n${conn.last_sync_error}` : ""
                          }`
                        : `${s.provider} · synced, stored locally`
                    }
                  >
                    <Cloud className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">{s.name}</span>
                    {conn && conn.sync_schedule !== "manual" && (
                      <CalendarClock
                        className={`h-3 w-3 shrink-0 ${
                          sched?.broken ? "text-destructive" : "text-muted-foreground"
                        }`}
                        aria-label={`syncs ${conn.sync_schedule}`}
                      />
                    )}
                    {/* Same three states the crawled sources use, from the
                        sync's own record rather than a second opinion. A
                        partial sync is amber, not green: it is the case where
                        some datasets are current and some are silently not. */}
                    <span
                      title={
                        conn?.last_sync_status === "error" || conn?.last_sync_status === "partial"
                          ? (conn.last_sync_error ?? conn.last_sync_status)
                          : (conn?.last_sync_status ?? "never synced")
                      }
                      className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                        syncing
                          ? "animate-pulse bg-amber-500"
                          : conn?.last_sync_status === "ok"
                            ? "bg-emerald-500"
                            : conn?.last_sync_status === "partial"
                              ? "bg-amber-500"
                              : conn?.last_sync_status
                                ? "bg-destructive"
                                : "bg-muted-foreground/40"
                      }`}
                    />
                    <span className="ml-auto text-[10px] text-muted-foreground">{count}</span>
                  </button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
                        title="Re-sync, schedule"
                      >
                        {syncing ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <MoreVertical className="h-3 w-3" />
                        )}
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-52">
                      <DropdownMenuItem
                        className="gap-2 text-xs"
                        disabled={syncing}
                        onClick={() => void resyncSaas(s)}
                      >
                        <RefreshCw className="h-3.5 w-3.5" /> Re-sync now
                      </DropdownMenuItem>
                      <DropdownMenuSub>
                        <DropdownMenuSubTrigger className="gap-2 text-xs">
                          <CalendarClock className="h-3.5 w-3.5" /> Schedule
                          <span className="ml-auto text-[10px] text-muted-foreground">
                            {conn?.sync_schedule ?? "—"}
                          </span>
                        </DropdownMenuSubTrigger>
                        <DropdownMenuPortal>
                          <DropdownMenuSubContent className="w-44">
                            {(Object.keys(SCHEDULE_LABELS) as SyncSchedule[]).map((opt) => (
                              <DropdownMenuItem
                                key={opt}
                                className="gap-2 text-xs"
                                disabled={conn?.shared}
                                onClick={() => void setSaasScheduleFor(s, opt)}
                              >
                                {SCHEDULE_LABELS[opt]}
                                {conn?.sync_schedule === opt && (
                                  <BadgeCheck className="ml-auto h-3 w-3 text-primary" />
                                )}
                              </DropdownMenuItem>
                            ))}
                          </DropdownMenuSubContent>
                        </DropdownMenuPortal>
                      </DropdownMenuSub>
                      <DropdownMenuSeparator />
                      {/* Disconnecting deletes a credential and stops every
                          schedule on it. That belongs where the credential was
                          entered and where the warning can state what it costs
                          — not behind a rail menu whose other items are
                          reversible. */}
                      <DropdownMenuItem asChild className="gap-2 text-xs">
                        <Link to="/integrations">
                          <Plug className="h-3.5 w-3.5" /> Manage connection
                        </Link>
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              );
            })}

            {sources.map((s) => (
              <div
                key={s.id}
                className={`group flex items-center gap-1 rounded-md ${
                  sourceFilter === s.id ? "bg-primary/10" : "hover:bg-muted"
                }`}
              >
                <button
                  type="button"
                  onClick={() => setSourceFilter(s.id)}
                  className={`flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-xs ${
                    sourceFilter === s.id ? "font-medium text-primary" : ""
                  }`}
                  title={s.last_error ?? s.name}
                >
                  {sourceIcon(s)}
                  <span className="truncate">{s.name}</span>
                  {!ownsSource(s) && (
                    <span
                      className="shrink-0 rounded bg-muted px-1 py-0.5 text-[9px] font-medium text-muted-foreground"
                      title="Shared with you (read-only)"
                    >
                      Shared
                    </span>
                  )}
                  {s.crawl_schedule !== "manual" && (
                    <CalendarClock
                      className="h-3 w-3 shrink-0 text-muted-foreground"
                      aria-label={`crawls ${s.crawl_schedule}`}
                    />
                  )}
                  {statusDot(s)}
                  <span className="ml-auto text-[10px] text-muted-foreground">
                    {assetCountBySource.get(s.id) ?? 0}
                  </span>
                </button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
                      title="Re-crawl, schedule, remove"
                    >
                      {crawlingIds.has(s.id) ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <MoreVertical className="h-3 w-3" />
                      )}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-44">
                    <DropdownMenuItem
                      className="gap-2 text-xs"
                      disabled={crawlingIds.has(s.id)}
                      onClick={() => void recrawl(s)}
                    >
                      <RefreshCw className="h-3.5 w-3.5" /> Re-crawl
                    </DropdownMenuItem>
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger className="gap-2 text-xs">
                        <CalendarClock className="h-3.5 w-3.5" /> Schedule
                        <span className="ml-auto text-[10px] text-muted-foreground">
                          {s.crawl_schedule}
                        </span>
                      </DropdownMenuSubTrigger>
                      <DropdownMenuPortal>
                        <DropdownMenuSubContent className="w-36">
                          {(["manual", "daily", "weekly"] as const).map((opt) => (
                            <DropdownMenuItem
                              key={opt}
                              className="gap-2 text-xs capitalize"
                              onClick={() => void setSchedule(s, opt)}
                            >
                              {opt}
                              {s.crawl_schedule === opt && (
                                <BadgeCheck className="ml-auto h-3 w-3 text-primary" />
                              )}
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuSubContent>
                      </DropdownMenuPortal>
                    </DropdownMenuSub>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="gap-2 text-xs text-destructive focus:text-destructive"
                      onClick={() => void removeSource(s)}
                    >
                      <Trash2 className="h-3.5 w-3.5" /> Remove
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            ))}

            {sources.length === 0 && !loading && (
              <p className="px-2 py-3 text-[11px] leading-relaxed text-muted-foreground">
                Connect a warehouse or an object-storage bucket — the crawler catalogs every table,
                file and column it finds.
              </p>
            )}
          </div>
        </ScrollArea>
      </aside>

      {/* ── Asset inventory ──────────────────────────────────────── */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-background px-3 py-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search assets, columns, tags…"
              className="h-8 w-72 pl-8 text-xs"
            />
          </div>
          <Select value={typeFilter} onValueChange={setTypeFilter}>
            <SelectTrigger className="h-8 w-32 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all" className="text-xs">
                All types
              </SelectItem>
              <SelectItem value="table" className="text-xs">
                Tables
              </SelectItem>
              <SelectItem value="dataset" className="text-xs">
                Datasets
              </SelectItem>
              <SelectItem value="file" className="text-xs">
                Files
              </SelectItem>
            </SelectContent>
          </Select>
          <Button
            size="sm"
            variant={piiOnly ? "default" : "outline"}
            className="h-8 gap-1.5 px-2.5 text-xs"
            onClick={() => setPiiOnly((v) => !v)}
            title="Only assets with likely-PII columns"
          >
            <ShieldAlert className="h-3.5 w-3.5" /> PII
          </Button>
          <Button
            size="sm"
            variant={certOnly ? "default" : "outline"}
            className="h-8 gap-1.5 px-2.5 text-xs"
            onClick={() => setCertOnly((v) => !v)}
            title="Only certified assets"
          >
            <BadgeCheck className="h-3.5 w-3.5" /> Certified
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-8 gap-1.5 px-2.5 text-xs"
            onClick={() => setGlossaryOpen(true)}
            title="Business glossary — shared term definitions"
          >
            <BookMarked className="h-3.5 w-3.5" /> Glossary
          </Button>
          <span className="ml-auto text-[11px] text-muted-foreground">
            {filtered.length} of {allAssets.length} assets
          </span>
        </div>

        <ScrollArea className="min-h-0 flex-1">
          {loading ? (
            <div className="space-y-0 p-3" aria-label="Loading catalog">
              {Array.from({ length: 10 }).map((_, i) => (
                <div
                  key={i}
                  className="flex items-center gap-3 border-b border-border/30 px-2 py-3"
                >
                  <Skeleton className="h-4 w-4 rounded" />
                  <Skeleton className="h-3.5 flex-1 max-w-56" />
                  <Skeleton className="h-3 w-20" />
                  <Skeleton className="h-3 w-12" />
                  <Skeleton className="ml-auto h-6 w-24 rounded-md" />
                </div>
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center gap-3 p-16 text-center">
              <Database className="h-8 w-8 text-muted-foreground/50" />
              <p className="text-sm text-muted-foreground">
                {allAssets.length === 0
                  ? "Nothing cataloged yet — add a data source to get started."
                  : "No assets match the current filters."}
              </p>
              {allAssets.length === 0 && (
                <Button size="sm" className="gap-1.5" onClick={() => setWizardOpen(true)}>
                  <Plus className="h-3.5 w-3.5" /> Add data source
                </Button>
              )}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40 hover:bg-muted/40 [&_th]:h-9 [&_th]:text-[11px] [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-wider [&_th]:text-muted-foreground">
                  <TableHead>Asset</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead className="text-right">Columns</TableHead>
                  <TableHead className="text-right">Rows</TableHead>
                  <TableHead className="text-right">Size</TableHead>
                  <TableHead
                    className="text-right"
                    title="Dashboards, prep flows and metrics built on this asset"
                  >
                    Used by
                  </TableHead>
                  <TableHead>Tags</TableHead>
                  <TableHead className="w-24" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.slice(0, 500).map((a) => (
                  <TableRow
                    key={a.id}
                    className="group cursor-pointer border-b border-border/40 transition-colors hover:bg-primary/5"
                    onClick={() => setSelected(a)}
                  >
                    <TableCell className="max-w-72">
                      <div className="flex items-center gap-2">
                        {typeIcon(a.asset_type)}
                        <div className="min-w-0">
                          <p className="truncate font-mono text-xs">{a.name}</p>
                          {a.schema_name && (
                            <p className="truncate text-[10px] text-muted-foreground">
                              {a.schema_name}
                            </p>
                          )}
                        </div>
                        {a.status === "certified" && (
                          <Badge
                            variant="outline"
                            className="h-4 gap-0.5 border-emerald-500/50 px-1 text-[9px] text-emerald-600 dark:text-emerald-400"
                          >
                            <BadgeCheck className="h-2.5 w-2.5" /> Certified
                          </Badge>
                        )}
                        {a.status === "deprecated" && (
                          <Badge
                            variant="outline"
                            className="h-4 px-1 text-[9px] text-muted-foreground line-through"
                          >
                            deprecated
                          </Badge>
                        )}
                        {a.pii && (
                          <Badge
                            variant="outline"
                            className="h-4 gap-0.5 border-amber-500/50 px-1 text-[9px] text-amber-600 dark:text-amber-400"
                          >
                            <ShieldAlert className="h-2.5 w-2.5" /> PII
                          </Badge>
                        )}
                        {qualityFor(a) && <QualityChip rollup={qualityFor(a)!} />}
                      </div>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{sourceName(a)}</TableCell>
                    <TableCell>
                      <Badge variant="secondary" className="h-5 px-1.5 text-[10px] font-normal">
                        {a.asset_type}
                        {a.format ? ` · ${a.format}` : ""}
                        {a.file_count ? ` · ${a.file_count} files` : ""}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums">
                      {a.columns.length || "—"}
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums">
                      {fmtCount(a.row_count)}
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums">
                      {fmtBytes(a.size_bytes)}
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums">
                      {(() => {
                        const n = lineageFor(a).usedBy.length;
                        return n > 0 ? (
                          <span className="font-medium text-primary">{n}</span>
                        ) : (
                          <span className="text-muted-foreground/50">—</span>
                        );
                      })()}
                    </TableCell>
                    <TableCell className="max-w-40">
                      <div className="flex flex-wrap gap-1">
                        {a.tags.slice(0, 3).map((t) => {
                          const def = termDefs.get(t.toLowerCase());
                          return (
                            <Badge
                              key={t}
                              variant="outline"
                              title={def || undefined}
                              className={`h-4 px-1 text-[9px] ${def ? "border-primary/40 text-primary" : ""}`}
                            >
                              {t}
                            </Badge>
                          );
                        })}
                        {a.tags.length > 3 && (
                          <span className="text-[10px] text-muted-foreground">
                            +{a.tags.length - 3}
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      {/* `file` and `dataset` are here because those are what
                          the crawler calls an object and a folder-of-objects in
                          a bucket. Without them the button was hidden for every
                          Parquet and CSV in an object store — `queryable` said
                          yes and this said no. `dataset` covers a partitioned
                          folder, which is the common shape for real data. */}
                      {(a.asset_type === "table" ||
                        a.asset_type === "view" ||
                        a.asset_type === "file" ||
                        a.asset_type === "dataset") &&
                        queryable(a) &&
                        onQueryAsset && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-6 gap-1 px-2 text-[10px]"
                            title={`Run SELECT * FROM ${a.local ? a.name : a.fqn} LIMIT 10 in the Workbench`}
                            onClick={(e) => {
                              e.stopPropagation();
                              openInWorkbench(a);
                            }}
                          >
                            <Play className="h-2.5 w-2.5" /> Query data
                          </Button>
                        )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </ScrollArea>
      </div>

      <AssetSheet
        asset={selected}
        sourceName={selected ? sourceName(selected) : ""}
        lineage={selected ? lineageFor(selected) : { usedBy: [], derivedFrom: [] }}
        sourceLineage={
          selected
            ? sourceLineageFor(catalogLineage, selected.fqn)
            : { upstream: [], downstream: [] }
        }
        onJumpToAsset={(name) => {
          const target = allAssets.find((x) => x.name.toLowerCase() === name.toLowerCase());
          if (target) setSelected(target);
        }}
        queryable={selected ? queryable(selected) && Boolean(onQueryAsset) : false}
        onQuery={() => selected && openInWorkbench(selected)}
        onClose={() => setSelected(null)}
        onSaved={(patch) => {
          setAssets((prev) => prev.map((x) => (x.id === selected?.id ? { ...x, ...patch } : x)));
          setSelected((prev) => (prev ? { ...prev, ...patch } : prev));
        }}
        onDatasetChanged={async () => {
          // A restore replaces the dataset's rows. Re-read them AND re-point
          // the open sheet at the fresh asset, or the drawer keeps showing the
          // pre-restore row count while the toast says otherwise.
          const fresh = await reloadLocal();
          setSelected((prev) => (prev ? (fresh.find((a) => a.id === prev.id) ?? prev) : prev));
        }}
      />

      <AddSourceWizard
        open={wizardOpen}
        onOpenChange={setWizardOpen}
        onDone={() => void reload()}
      />

      <GlossaryDialog
        open={glossaryOpen}
        onOpenChange={setGlossaryOpen}
        terms={glossary}
        assetCountFor={(term) =>
          allAssets.filter((a) => a.tags.some((t) => t.toLowerCase() === term.toLowerCase())).length
        }
        onChanged={() => void listGlossaryTerms().then(setGlossary)}
        onFilterByTerm={(term) => {
          setSearch(term);
          setSourceFilter("all");
          setGlossaryOpen(false);
        }}
      />
    </div>
  );
}

// ── Asset detail sheet ────────────────────────────────────────────────────

function AssetSheet({
  asset,
  sourceName,
  lineage,
  sourceLineage,
  onJumpToAsset,
  queryable,
  onQuery,
  onClose,
  onSaved,
  onDatasetChanged,
}: {
  asset: UnifiedAsset | null;
  sourceName: string;
  lineage: AssetLineage;
  /** Real upstream/downstream edges read from the source system (Unity Catalog). */
  sourceLineage: { upstream: CatalogLineageEdge[]; downstream: CatalogLineageEdge[] };
  /** Navigate the sheet to another asset by table name (derived-from chips). */
  onJumpToAsset: (name: string) => void;
  queryable: boolean;
  onQuery: () => void;
  onClose: () => void;
  onSaved: (patch: Partial<CatalogAsset>) => void;
  /** A restore replaced the dataset's rows — re-read them and re-point the sheet. */
  onDatasetChanged: () => void | Promise<void>;
}) {
  const { session } = useAuth();
  const [biModel] = useBiModelPref();
  const [description, setDescription] = useState("");
  const [tagsInput, setTagsInput] = useState("");
  const [owner, setOwner] = useState("");
  const [status, setStatus] = useState<CatalogAssetStatus>("draft");
  const [saving, setSaving] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);

  useEffect(() => {
    setDescription(asset?.description ?? "");
    setTagsInput(asset?.tags.join(", ") ?? "");
    setOwner(asset?.owner ?? "");
    setStatus(asset?.status ?? "draft");
  }, [asset]);

  if (!asset) return null;
  const dirty =
    description !== (asset.description ?? "") ||
    tagsInput !== asset.tags.join(", ") ||
    owner !== (asset.owner ?? "") ||
    status !== asset.status;
  const hasStats = asset.columns.some((c) => c.null_pct !== undefined);

  async function save() {
    if (!asset || asset.local) return;
    setSaving(true);
    try {
      const tags = tagsInput
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
        .slice(0, 12);
      const patch = {
        description: description.trim() || null,
        tags,
        owner: owner.trim() || null,
        status,
      };
      await updateCatalogAsset(asset.id, patch);
      onSaved(patch);
      toast.success("Saved");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function aiDocs() {
    if (!asset || asset.local || !session?.access_token) return;
    if (asset.columns.length === 0) {
      return toast.error("No column metadata to document — crawl this asset first.");
    }
    setAiBusy(true);
    try {
      const res = await generateAssetDocs(session.access_token, asset, biModel);
      setDescription(res.description);
      onSaved({ description: res.description, columns: res.columns });
      toast.success("Documentation generated");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setAiBusy(false);
    }
  }

  return (
    <Sheet open onOpenChange={(v) => !v && onClose()}>
      <SheetContent className="flex w-full flex-col gap-0 overflow-hidden sm:max-w-lg">
        <SheetHeader className="pb-3">
          <SheetTitle className="flex items-center gap-2 font-mono text-base">
            {asset.name}
            {asset.status === "certified" && (
              <Badge
                variant="outline"
                className="h-5 gap-1 border-emerald-500/50 px-1.5 text-[10px] text-emerald-600 dark:text-emerald-400"
              >
                <BadgeCheck className="h-3 w-3" /> Certified
              </Badge>
            )}
            {asset.pii && (
              <Badge
                variant="outline"
                className="h-5 gap-1 border-amber-500/50 px-1.5 text-[10px] text-amber-600 dark:text-amber-400"
              >
                <ShieldAlert className="h-3 w-3" /> PII
              </Badge>
            )}
          </SheetTitle>
          <SheetDescription className="font-mono text-xs">{asset.fqn}</SheetDescription>
        </SheetHeader>

        <div className="grid grid-cols-4 gap-2 border-y border-border py-2.5 text-center">
          {[
            ["Source", sourceName],
            ["Type", `${asset.asset_type}${asset.format ? ` \u00b7 ${asset.format}` : ""}`],
            ["Rows", fmtCount(asset.row_count)],
            [
              asset.file_count ? "Files" : "Size",
              asset.file_count ? String(asset.file_count) : fmtBytes(asset.size_bytes),
            ],
          ].map(([label, value]) => (
            <div key={label}>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
              <p className="truncate text-xs font-medium" title={value}>
                {value}
              </p>
            </div>
          ))}
        </div>

        <ScrollArea className="min-h-0 flex-1 py-3">
          <div className="space-y-4 pr-3">
            {(lineage.usedBy.length > 0 || lineage.derivedFrom.length > 0) && (
              <div>
                <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Lineage & usage
                </p>
                {lineage.derivedFrom.length > 0 && (
                  <div className="mb-2 flex flex-wrap items-center gap-1 text-[11px]">
                    <span className="text-muted-foreground">Derived from:</span>
                    {lineage.derivedFrom.map((t) => (
                      <button
                        key={t}
                        type="button"
                        onClick={() => onJumpToAsset(t)}
                        className="rounded-full border border-border bg-muted/40 px-2 py-0.5 font-mono text-[10px] transition-colors hover:border-primary/50 hover:text-primary"
                        title={`Open ${t} in the catalog`}
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                )}
                {lineage.usedBy.length > 0 && (
                  <div className="space-y-1">
                    {lineage.usedBy.map((r) => (
                      <div
                        key={`${r.kind}:${r.id}`}
                        className="flex items-center gap-2 rounded-md border border-border/60 bg-muted/30 px-2 py-1.5 text-[11px]"
                      >
                        {r.kind === "dashboard" ? (
                          <LayoutDashboard className="h-3.5 w-3.5 shrink-0 text-primary" />
                        ) : r.kind === "prep_flow" ? (
                          <GitBranch className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
                        ) : (
                          <Gauge className="h-3.5 w-3.5 shrink-0 text-teal-600 dark:text-teal-400" />
                        )}
                        <span className="min-w-0 flex-1 truncate">
                          {r.kind === "dashboard" ? (
                            <Link
                              to="/bi/$dashboardId"
                              params={{ dashboardId: r.id }}
                              className="font-medium hover:text-primary hover:underline"
                            >
                              {r.name}
                            </Link>
                          ) : (
                            <span className="font-medium">{r.name}</span>
                          )}
                          {r.detail && <span className="text-muted-foreground"> — {r.detail}</span>}
                        </span>
                        <span className="shrink-0 text-[9px] uppercase tracking-wider text-muted-foreground">
                          {r.kind === "prep_flow" ? "prep flow" : r.kind}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {(sourceLineage.upstream.length > 0 || sourceLineage.downstream.length > 0) && (
              <div>
                <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Data lineage <span className="font-normal normal-case">· from source</span>
                </p>
                {sourceLineage.upstream.length > 0 && (
                  <div className="mb-2">
                    <span className="text-[11px] text-muted-foreground">
                      Upstream ({sourceLineage.upstream.length}):
                    </span>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {sourceLineage.upstream.slice(0, 40).map((e, i) => (
                        <span
                          key={i}
                          className="rounded-full border border-border bg-muted/40 px-2 py-0.5 font-mono text-[10px]"
                          title={e.upstream_fqn}
                        >
                          {e.upstream_fqn.split(".").slice(-2).join(".")}
                          {e.upstream_column ? `.${e.upstream_column}` : ""}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                {sourceLineage.downstream.length > 0 && (
                  <div>
                    <span className="text-[11px] text-muted-foreground">
                      Downstream ({sourceLineage.downstream.length}):
                    </span>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {sourceLineage.downstream.slice(0, 40).map((e, i) => (
                        <span
                          key={i}
                          className="rounded-full border border-border bg-muted/40 px-2 py-0.5 font-mono text-[10px]"
                          title={e.downstream_fqn}
                        >
                          {e.downstream_fqn.split(".").slice(-2).join(".")}
                          {e.downstream_column ? `.${e.downstream_column}` : ""}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Quality checks and version history apply to datasets stored in
                this app; a warehouse table is governed where it lives. */}
            {asset.local && (
              <DatasetQualityPanel
                tableId={asset.id.replace(/^local:/, "")}
                tableName={asset.name}
                columns={asset.columns}
                readOnly={asset.tags.includes("sample")}
                onDatasetChanged={onDatasetChanged}
              />
            )}

            <div>
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Columns ({asset.columns.length})
              </p>
              {asset.columns.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No column metadata \u2014{" "}
                  {asset.format === "parquet" || asset.format === "compressed"
                    ? "binary formats aren't sampled."
                    : "this asset wasn't sampled during the crawl."}
                </p>
              ) : (
                <>
                  <div className="overflow-hidden rounded-md border border-border">
                    <table className="w-full text-left">
                      <thead className="bg-muted/50">
                        <tr>
                          <th className="px-2 py-1 text-[10px] font-medium text-muted-foreground">
                            Name
                          </th>
                          <th className="px-2 py-1 text-[10px] font-medium text-muted-foreground">
                            Type
                          </th>
                          {hasStats && (
                            <>
                              <th className="px-2 py-1 text-right text-[10px] font-medium text-muted-foreground">
                                Nulls
                              </th>
                              <th className="px-2 py-1 text-right text-[10px] font-medium text-muted-foreground">
                                Distinct
                              </th>
                            </>
                          )}
                          <th className="px-2 py-1 text-[10px] font-medium text-muted-foreground">
                            Sample
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {asset.columns.map((c) => (
                          <tr key={c.name} className="border-t border-border/50 align-top">
                            <td className="max-w-44 px-2 py-1 font-mono text-[11px]">
                              <span className="flex items-center gap-1">
                                {c.name}
                                {c.pii && (
                                  <ShieldAlert
                                    className="h-3 w-3 shrink-0 text-amber-500"
                                    aria-label="likely PII"
                                  />
                                )}
                              </span>
                              {(c.description || c.comment) && (
                                <p
                                  className="truncate font-sans text-[10px] font-normal text-muted-foreground"
                                  title={c.description || c.comment}
                                >
                                  {c.description || c.comment}
                                </p>
                              )}
                            </td>
                            <td className="px-2 py-1 text-[11px] text-muted-foreground">
                              {c.type}
                              {c.min !== undefined && c.max !== undefined && (
                                <p className="text-[9px] text-muted-foreground/70">
                                  {fmtCount(c.min)}\u2013{fmtCount(c.max)}
                                </p>
                              )}
                            </td>
                            {hasStats && (
                              <>
                                <td className="px-2 py-1 text-right text-[11px] tabular-nums text-muted-foreground">
                                  {c.null_pct !== undefined ? `${c.null_pct}%` : "\u2014"}
                                </td>
                                <td className="px-2 py-1 text-right text-[11px] tabular-nums text-muted-foreground">
                                  {c.distinct_count !== undefined
                                    ? fmtCount(c.distinct_count)
                                    : "\u2014"}
                                </td>
                              </>
                            )}
                            <td
                              className="max-w-32 truncate px-2 py-1 text-[11px] text-muted-foreground"
                              title={c.sample}
                            >
                              {c.sample ?? ""}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {hasStats && (
                    <p className="mt-1 text-[10px] text-muted-foreground/70">
                      Profile stats come from a sample of up to 200 rows.
                    </p>
                  )}
                </>
              )}
            </div>

            {asset.local && (
              <p className="rounded-md border border-dashed border-border bg-muted/20 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
                Local tables are cataloged automatically and read-only here. Curation — status,
                owner, tags, description and AI-generated docs — lives on crawled sources: connect a
                warehouse or bucket with <span className="font-medium">Add</span> in the Sources
                rail, and manage crawls from the <span className="font-medium">⋯</span> menu on each
                source.
              </p>
            )}

            {!asset.local && (
              <>
                <div className="grid grid-cols-2 gap-2.5">
                  <div>
                    <Label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Status
                    </Label>
                    <Select
                      value={status}
                      onValueChange={(v) => setStatus(v as CatalogAssetStatus)}
                    >
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="draft" className="text-xs">
                          Draft
                        </SelectItem>
                        <SelectItem value="certified" className="text-xs">
                          Certified \u2014 trusted for analysis
                        </SelectItem>
                        <SelectItem value="deprecated" className="text-xs">
                          Deprecated \u2014 avoid using
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Owner
                    </Label>
                    <Input
                      value={owner}
                      onChange={(e) => setOwner(e.target.value)}
                      placeholder="team or person"
                      className="h-8 text-xs"
                    />
                  </div>
                </div>
                <div>
                  <div className="mb-1.5 flex items-center justify-between">
                    <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Description
                    </Label>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 gap-1 px-1.5 text-[10px] text-primary hover:text-primary"
                      disabled={aiBusy}
                      onClick={() => void aiDocs()}
                      title="Generate asset + column descriptions with your BI model"
                    >
                      {aiBusy ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Sparkles className="h-3 w-3" />
                      )}
                      AI docs
                    </Button>
                  </div>
                  <Textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    rows={3}
                    placeholder="What is this data? Who owns it? How fresh is it?"
                    className="text-xs"
                  />
                </div>
                <div>
                  <Label className="mb-1.5 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    <Tag className="h-3 w-3" /> Tags (comma-separated)
                  </Label>
                  <Input
                    value={tagsInput}
                    onChange={(e) => setTagsInput(e.target.value)}
                    placeholder="finance, gold, daily"
                    className="h-8 text-xs"
                  />
                </div>
              </>
            )}
          </div>
        </ScrollArea>

        <div className="flex items-center justify-between border-t border-border pt-3">
          {/* Null is a real state — a warehouse table is queried live and was
              never loaded here, so there is no local timestamp to report.
              Saying nothing beats printing a fabricated one. */}
          <p className="text-[10px] text-muted-foreground">
            {(() => {
              const f = assetFreshness({
                last_crawled_at: asset.last_crawled_at,
                local: asset.source_id === LOCAL_SOURCE_ID,
              });
              return f.kind === "live"
                ? freshnessPrefix(f)
                : `${freshnessPrefix(f)} ${formatDistanceToNow(new Date(f.at), { addSuffix: true })}`;
            })()}
          </p>
          <div className="flex gap-2">
            {queryable && (
              <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs" onClick={onQuery}>
                <Database className="h-3.5 w-3.5" /> Query in Workbench
              </Button>
            )}
            {!asset.local && (
              <Button
                size="sm"
                className="h-8 text-xs"
                disabled={!dirty || saving}
                onClick={() => void save()}
              >
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save"}
              </Button>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
