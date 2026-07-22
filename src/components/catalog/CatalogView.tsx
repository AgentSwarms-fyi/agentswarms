// Data Catalog browser: a sources rail, a searchable/filterable asset
// inventory, and a detail sheet with column-level metadata, PII flags
// and user curation (description + tags, which survive re-crawls).
// Local CSV tables appear automatically as a built-in source; warehouse
// and object-storage sources are added through the wizard and crawled
// on demand.
import { useCallback, useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import {
  Cloud,
  Database,
  FileText,
  Folder,
  HardDrive,
  Layers,
  Loader2,
  MoreVertical,
  Plus,
  RefreshCw,
  Search,
  Server,
  ShieldAlert,
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
import {
  fmtBytes,
  fmtCount,
  isPiiColumnName,
  listCatalogAssets,
  listCatalogSources,
  updateCatalogAsset,
  type CatalogAsset,
  type CatalogSource,
} from "@/lib/dataCatalog";
import { hydrateFromSupabase } from "@/lib/sqlEngine";
import { catalogCrawlSource, catalogDeleteSource } from "@/utils/catalog.functions";
import { AddSourceWizard } from "@/components/catalog/AddSourceWizard";

const LOCAL_SOURCE_ID = "local";

/** Local tables presented in the same shape as crawled assets. */
type UnifiedAsset = CatalogAsset & { local?: boolean };

export function CatalogView({
  onQueryAsset,
}: {
  /** Open an asset in the Workbench tab with a seeded query. */
  onQueryAsset?: (seed: { sql: string; dataSource: string }) => void;
}) {
  const { session } = useAuth();
  const token = session?.access_token ?? "";
  const crawlFn = useServerFn(catalogCrawlSource);
  const deleteFn = useServerFn(catalogDeleteSource);

  const [sources, setSources] = useState<CatalogSource[]>([]);
  const [assets, setAssets] = useState<CatalogAsset[]>([]);
  const [localAssets, setLocalAssets] = useState<UnifiedAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [piiOnly, setPiiOnly] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [crawlingIds, setCrawlingIds] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<UnifiedAsset | null>(null);

  const reload = useCallback(async () => {
    try {
      const [src, ast] = await Promise.all([listCatalogSources(), listCatalogAssets()]);
      setSources(src);
      setAssets(ast);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }, []);

  useEffect(() => {
    (async () => {
      setLoading(true);
      await reload();
      try {
        const tables = await hydrateFromSupabase();
        setLocalAssets(
          tables.map((d) => {
            const columns = d.columns.map((c) => ({
              name: c.name,
              type: c.type,
              pii: isPiiColumnName(c.name) || undefined,
            }));
            return {
              id: `local:${d.id}`,
              source_id: LOCAL_SOURCE_ID,
              asset_type: "table" as const,
              schema_name: null,
              name: d.name,
              fqn: d.name,
              columns,
              row_count: d.row_count,
              size_bytes: null,
              format: d.is_sample ? "sample" : "csv",
              file_count: null,
              description: null,
              tags: d.is_sample ? ["sample"] : [],
              pii: columns.some((c) => c.pii),
              last_crawled_at: new Date().toISOString(),
              local: true,
            };
          }),
        );
      } catch {
        setLocalAssets([]);
      }
      setLoading(false);
    })();
  }, [reload]);

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
      if (!q) return true;
      const hay = `${a.fqn} ${a.name} ${a.schema_name ?? ""} ${a.tags.join(" ")} ${a.description ?? ""} ${a.columns.map((c) => c.name).join(" ")}`.toLowerCase();
      return q.split(/\s+/).every((part) => hay.includes(part));
    });
  }, [allAssets, search, sourceFilter, typeFilter, piiOnly]);

  async function recrawl(source: CatalogSource) {
    setCrawlingIds((s) => new Set(s).add(source.id));
    try {
      const res = await crawlFn({ data: { access_token: token, source_id: source.id } });
      if (!res.ok) throw new Error(res.error);
      toast.success(
        `Crawled "${source.name}" — ${res.stats.assets} assets, ${res.stats.columns} columns`,
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

  async function removeSource(source: CatalogSource) {
    if (!window.confirm(`Remove "${source.name}" and its cataloged assets?`)) return;
    const res = await deleteFn({ data: { access_token: token, source_id: source.id } });
    if (!res.ok) return toast.error(res.error);
    toast.success("Source removed");
    if (sourceFilter === source.id) setSourceFilter("all");
    await reload();
  }

  const sourceIcon = (s: CatalogSource) =>
    s.kind === "warehouse" ? <Server className="h-3.5 w-3.5" /> : <Cloud className="h-3.5 w-3.5" />;

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

  const sourceName = (a: UnifiedAsset) =>
    a.source_id === LOCAL_SOURCE_ID ? "Local tables" : (sourceById.get(a.source_id)?.name ?? "—");

  const queryable = (a: UnifiedAsset) =>
    a.local || sourceById.get(a.source_id)?.kind === "warehouse";

  function openInWorkbench(a: UnifiedAsset) {
    if (!onQueryAsset) return;
    if (a.local) {
      onQueryAsset({ sql: `SELECT * FROM \`${a.name}\` LIMIT 100`, dataSource: "local" });
      return;
    }
    const src = sourceById.get(a.source_id);
    if (src?.kind === "warehouse" && src.connection_id) {
      onQueryAsset({ sql: `SELECT * FROM ${a.fqn} LIMIT 100`, dataSource: src.connection_id });
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
                {localAssets.length}
              </span>
            </button>

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
                      className="h-6 w-6 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100"
                    >
                      {crawlingIds.has(s.id) ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <MoreVertical className="h-3 w-3" />
                      )}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-40">
                    <DropdownMenuItem
                      className="gap-2 text-xs"
                      disabled={crawlingIds.has(s.id)}
                      onClick={() => void recrawl(s)}
                    >
                      <RefreshCw className="h-3.5 w-3.5" /> Re-crawl
                    </DropdownMenuItem>
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
          <span className="ml-auto text-[11px] text-muted-foreground">
            {filtered.length} of {allAssets.length} assets
          </span>
        </div>

        <ScrollArea className="min-h-0 flex-1">
          {loading ? (
            <div className="flex items-center gap-2 p-6 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading catalog…
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
                <TableRow>
                  <TableHead className="text-xs">Asset</TableHead>
                  <TableHead className="text-xs">Source</TableHead>
                  <TableHead className="text-xs">Type</TableHead>
                  <TableHead className="text-right text-xs">Columns</TableHead>
                  <TableHead className="text-right text-xs">Rows</TableHead>
                  <TableHead className="text-right text-xs">Size</TableHead>
                  <TableHead className="text-xs">Tags</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.slice(0, 500).map((a) => (
                  <TableRow
                    key={a.id}
                    className="cursor-pointer"
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
                        {a.pii && (
                          <Badge
                            variant="outline"
                            className="h-4 gap-0.5 border-amber-500/50 px-1 text-[9px] text-amber-600 dark:text-amber-400"
                          >
                            <ShieldAlert className="h-2.5 w-2.5" /> PII
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {sourceName(a)}
                    </TableCell>
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
                    <TableCell className="max-w-40">
                      <div className="flex flex-wrap gap-1">
                        {a.tags.slice(0, 3).map((t) => (
                          <Badge key={t} variant="outline" className="h-4 px-1 text-[9px]">
                            {t}
                          </Badge>
                        ))}
                        {a.tags.length > 3 && (
                          <span className="text-[10px] text-muted-foreground">
                            +{a.tags.length - 3}
                          </span>
                        )}
                      </div>
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
        queryable={selected ? queryable(selected) && Boolean(onQueryAsset) : false}
        onQuery={() => selected && openInWorkbench(selected)}
        onClose={() => setSelected(null)}
        onSaved={(patch) => {
          setAssets((prev) =>
            prev.map((x) => (x.id === selected?.id ? { ...x, ...patch } : x)),
          );
          setSelected((prev) => (prev ? { ...prev, ...patch } : prev));
        }}
      />

      <AddSourceWizard open={wizardOpen} onOpenChange={setWizardOpen} onDone={() => void reload()} />
    </div>
  );
}

// ── Asset detail sheet ────────────────────────────────────────────────────

function AssetSheet({
  asset,
  sourceName,
  queryable,
  onQuery,
  onClose,
  onSaved,
}: {
  asset: UnifiedAsset | null;
  sourceName: string;
  queryable: boolean;
  onQuery: () => void;
  onClose: () => void;
  onSaved: (patch: { description: string | null; tags: string[] }) => void;
}) {
  const [description, setDescription] = useState("");
  const [tagsInput, setTagsInput] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDescription(asset?.description ?? "");
    setTagsInput(asset?.tags.join(", ") ?? "");
  }, [asset]);

  if (!asset) return null;
  const dirty =
    description !== (asset.description ?? "") || tagsInput !== asset.tags.join(", ");

  async function save() {
    if (!asset || asset.local) return;
    setSaving(true);
    try {
      const tags = tagsInput
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
        .slice(0, 12);
      await updateCatalogAsset(asset.id, { description: description.trim() || null, tags });
      onSaved({ description: description.trim() || null, tags });
      toast.success("Saved");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet open onOpenChange={(v) => !v && onClose()}>
      <SheetContent className="flex w-full flex-col gap-0 overflow-hidden sm:max-w-lg">
        <SheetHeader className="pb-3">
          <SheetTitle className="flex items-center gap-2 font-mono text-base">
            {asset.name}
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
            ["Type", `${asset.asset_type}${asset.format ? ` · ${asset.format}` : ""}`],
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
            <div>
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Columns ({asset.columns.length})
              </p>
              {asset.columns.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No column metadata — {asset.format === "parquet" || asset.format === "compressed"
                    ? "binary formats aren't sampled."
                    : "this asset wasn't sampled during the crawl."}
                </p>
              ) : (
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
                        <th className="px-2 py-1 text-[10px] font-medium text-muted-foreground">
                          Sample
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {asset.columns.map((c) => (
                        <tr key={c.name} className="border-t border-border/50">
                          <td className="px-2 py-1 font-mono text-[11px]">
                            <span className="flex items-center gap-1">
                              {c.name}
                              {c.pii && (
                                <ShieldAlert
                                  className="h-3 w-3 text-amber-500"
                                  aria-label="likely PII"
                                />
                              )}
                            </span>
                          </td>
                          <td className="px-2 py-1 text-[11px] text-muted-foreground">{c.type}</td>
                          <td
                            className="max-w-40 truncate px-2 py-1 text-[11px] text-muted-foreground"
                            title={c.sample}
                          >
                            {c.sample ?? ""}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {!asset.local && (
              <>
                <div>
                  <Label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Description
                  </Label>
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
          <p className="text-[10px] text-muted-foreground">
            Crawled {formatDistanceToNow(new Date(asset.last_crawled_at), { addSuffix: true })}
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
