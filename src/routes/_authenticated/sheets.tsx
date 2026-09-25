// Data & BI -> Sheets: the gallery of workbooks.
//
// A workbook is a spreadsheet: grid sheets for the familiar cells and
// formulas, and table sheets whose rows live in the lakehouse, so a sheet can
// hold far more than a browser could. This page finds (search, sort, grid or
// list), creates, renames and deletes them; the editor is
// sheets_.$workbookId. Each card shows the corner of the workbook's first
// grid sheet as it reads, from a preview the editor keeps (or, for a workbook
// not opened since previews began, one this page asks the server to build).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  ArrowUpRight,
  Database,
  FileSpreadsheet,
  FileUp,
  Grid3x3,
  LayoutGrid,
  List,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  SearchX,
  Trash2,
  X,
} from "lucide-react";
import { ImportFileDialog } from "@/components/sheets/ImportFileDialog";
import { WorkbookThumb } from "@/components/sheets/WorkbookThumb";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { confirmAsk, promptAsk } from "@/components/ui/confirm-dialog";
import { relTime } from "@/components/ml/mlUi";
import { listClaim } from "@/lib/listClaim";
import { matchSpans, searchWorkbooks, type GallerySort } from "@/lib/sheets/preview";
import { cn } from "@/lib/utils";
import {
  sheetsBackfillPreviews,
  sheetsCreate,
  sheetsDelete,
  sheetsList,
  sheetsUpdateWorkbook,
  type WorkbookSummary,
} from "@/utils/sheets.functions";

export const Route = createFileRoute("/_authenticated/sheets")({
  head: () => ({
    meta: [
      { title: "Sheets — AgentSwarms" },
      {
        name: "description",
        content:
          "Spreadsheets with Excel formulas over the lakehouse: grid sheets for cells, table sheets for data far beyond a browser's reach, and an AI assistant that writes formulas.",
      },
    ],
  }),
  component: SheetsPage,
});

type View = "grid" | "list";
const SORTS: { value: GallerySort; label: string }[] = [
  { value: "edited", label: "Last edited" },
  { value: "name", label: "Name" },
  { value: "created", label: "Date created" },
];

// Per viewer, per browser: the view and the order last chosen. Storage can be
// missing or refuse (private windows), so every read and write is guarded.
function remembered<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = window.localStorage.getItem(key);
    return v && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}
function remember(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* not kept; the choice still holds for this visit */
  }
}

function SheetsPage() {
  const { session } = useAuth();
  const token = session?.access_token;
  const navigate = useNavigate();
  const listFn = useServerFn(sheetsList);
  const createFn = useServerFn(sheetsCreate);
  const deleteFn = useServerFn(sheetsDelete);
  const updateFn = useServerFn(sheetsUpdateWorkbook);
  const backfillFn = useServerFn(sheetsBackfillPreviews);

  const [workbooks, setWorkbooks] = useState<WorkbookSummary[] | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [maxCells, setMaxCells] = useState(200_000);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<GallerySort>("edited");
  const [view, setView] = useState<View>("grid");
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setSort(remembered("sheets.gallery.sort", ["edited", "name", "created"] as const, "edited"));
    setView(remembered("sheets.gallery.view", ["grid", "list"] as const, "grid"));
  }, []);

  const reload = useCallback(async () => {
    if (!token) return;
    setRefreshing(true);
    try {
      const r = await listFn({ data: { access_token: token } });
      if (!r.ok) {
        setLoadError(r.error);
      } else {
        setWorkbooks(r.workbooks);
        setMaxCells(r.limits.maxCells);
        setLoadError(null);
      }
    } catch (e) {
      setLoadError((e as Error).message);
    } finally {
      setLoaded(true);
      setRefreshing(false);
    }
  }, [token, listFn]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Workbooks with grid sheets but no preview yet (made before previews, or
  // never opened since): a few at a time, so the page is drawn first.
  const asked = useRef(new Set<string>());
  useEffect(() => {
    if (!token || !workbooks) return;
    const missing = workbooks
      .filter((w) => !w.preview && w.sheets.some((s) => s.kind === "grid"))
      .map((w) => w.id)
      .filter((id) => !asked.current.has(id))
      .slice(0, 4);
    if (!missing.length) return;
    for (const id of missing) asked.current.add(id);
    let live = true;
    void backfillFn({ data: { access_token: token, ids: missing } })
      .then((r) => {
        if (!live || !r.ok || !Object.keys(r.previews).length) return;
        setWorkbooks((list) =>
          (list ?? []).map((w) => (r.previews[w.id] ? { ...w, preview: r.previews[w.id] } : w)),
        );
      })
      .catch(() => {
        /* a thumbnail is a nicety; the card still opens the workbook */
      });
    return () => {
      live = false;
    };
  }, [token, workbooks, backfillFn]);

  // "/" finds, as on most pages that list things; not while typing elsewhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (document.querySelector("[role=dialog]")) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const claim = listClaim({ loaded, error: loadError, count: workbooks?.length ?? 0 });
  const shown = useMemo(
    () => searchWorkbooks(workbooks ?? [], query, sort),
    [workbooks, query, sort],
  );
  const total = workbooks?.length ?? 0;

  async function create() {
    if (!token || !newName.trim()) return;
    setCreating(true);
    try {
      const r = await createFn({
        data: {
          access_token: token,
          name: newName.trim(),
          description: newDesc.trim() || undefined,
        },
      });
      if (!r.ok) return toast.error(r.error);
      setNewOpen(false);
      setNewName("");
      setNewDesc("");
      void navigate({ to: "/sheets/$workbookId", params: { workbookId: r.id } });
    } catch (e) {
      toast.error(`Could not create the workbook: ${(e as Error).message}`);
    } finally {
      setCreating(false);
    }
  }

  async function rename(wb: WorkbookSummary) {
    if (!token) return;
    const name = await promptAsk({
      title: "Rename workbook",
      input: { defaultValue: wb.name, required: true },
      actionLabel: "Rename",
    });
    if (name === null || !name.trim() || name.trim() === wb.name) return;
    setBusy(wb.id);
    try {
      const r = await updateFn({ data: { access_token: token, id: wb.id, name: name.trim() } });
      if (!r.ok) return toast.error(r.error);
      toast.success(`Renamed to "${name.trim()}"`);
      await reload();
    } catch (e) {
      toast.error(`Could not rename: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  async function remove(wb: WorkbookSummary) {
    if (!token) return;
    const ok = await confirmAsk({
      title: `Delete "${wb.name}"?`,
      body: `Its ${wb.sheet_count} sheet(s) go with it. Tables it saved to the lakehouse stay where they are.`,
      actionLabel: "Delete workbook",
    });
    if (!ok) return;
    setBusy(wb.id);
    try {
      const r = await deleteFn({ data: { access_token: token, id: wb.id } });
      if (!r.ok) return toast.error(`"${wb.name}" was not deleted: ${r.error}`);
      toast.success(`Deleted "${wb.name}"`);
      await reload();
    } catch (e) {
      toast.error(`"${wb.name}" was not deleted: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  const actions = (wb: WorkbookSummary) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          className="relative z-10 h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground data-[state=open]:bg-muted data-[state=open]:text-foreground"
          aria-label={`Actions for ${wb.name}`}
          disabled={busy === wb.id}
        >
          {busy === wb.id ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <MoreHorizontal className="h-4 w-4" />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuItem
          onSelect={() =>
            void navigate({ to: "/sheets/$workbookId", params: { workbookId: wb.id } })
          }
        >
          <ArrowUpRight className="mr-2 h-4 w-4" /> Open
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void rename(wb)}>
          <Pencil className="mr-2 h-4 w-4" /> Rename…
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="text-destructive focus:text-destructive"
          onSelect={() => void remove(wb)}
        >
          <Trash2 className="mr-2 h-4 w-4" /> Delete…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-8 p-4 sm:p-6 lg:p-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-primary">
            Data &amp; BI
          </p>
          <h1 className="font-display text-3xl font-semibold tracking-tight">Sheets</h1>
          <p className="mt-1.5 max-w-2xl text-balance text-muted-foreground">
            Excel formulas over grid cells, and table sheets whose rows stay in the lakehouse —
            sorted, filtered and summed where the data lives.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => setImportOpen(true)}>
            <FileUp className="mr-1.5 h-4 w-4" /> Import
          </Button>
          <Button onClick={() => setNewOpen(true)}>
            <Plus className="mr-1.5 h-4 w-4" /> New workbook
          </Button>
        </div>
      </header>

      <section aria-labelledby="start-heading" className="space-y-3">
        <h2
          id="start-heading"
          className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground"
        >
          Start
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <StartTile
            title="Blank workbook"
            detail="One empty grid sheet, ready for formulas"
            onClick={() => setNewOpen(true)}
            art={<BlankArt />}
          />
          <StartTile
            title="From an Excel or CSV file"
            detail="Formulas, formats, rules and charts come with it"
            onClick={() => setImportOpen(true)}
            art={<FileArt />}
          />
        </div>
      </section>

      {importOpen && token && (
        <ImportFileDialog
          open
          onOpenChange={setImportOpen}
          token={token}
          maxCells={maxCells}
          onImported={(r) =>
            void navigate({ to: "/sheets/$workbookId", params: { workbookId: r.workbookId } })
          }
        />
      )}

      <section aria-labelledby="wb-heading" className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <h2 id="wb-heading" className="sr-only">
            Your workbooks
          </h2>
          <div className="relative min-w-[240px] max-w-xl flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape" && query) {
                  e.preventDefault();
                  setQuery("");
                }
              }}
              placeholder="Search workbooks and their sheets"
              aria-label="Search workbooks"
              className="h-10 rounded-lg bg-card pl-9 pr-10"
              data-testid="workbook-search"
            />
            {query ? (
              <button
                type="button"
                onClick={() => {
                  setQuery("");
                  searchRef.current?.focus();
                }}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label="Clear search"
              >
                <X className="h-4 w-4" />
              </button>
            ) : (
              <kbd className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 rounded border border-border bg-muted px-1.5 font-mono text-[11px] text-muted-foreground">
                /
              </kbd>
            )}
          </div>
          <p className="text-sm tabular-nums text-muted-foreground" aria-live="polite">
            {!loaded
              ? ""
              : query.trim()
                ? `${shown.length} of ${total} workbook${total === 1 ? "" : "s"}`
                : `${total} workbook${total === 1 ? "" : "s"}`}
          </p>
          <div className="ml-auto flex items-center gap-2">
            <Select
              value={sort}
              onValueChange={(v) => {
                setSort(v as GallerySort);
                remember("sheets.gallery.sort", v);
              }}
            >
              <SelectTrigger className="h-10 w-[150px] bg-card" aria-label="Sort workbooks">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                {SORTS.map((s) => (
                  <SelectItem key={s.value} value={s.value}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <ToggleGroup
              type="single"
              value={view}
              onValueChange={(v) => {
                if (!v) return;
                setView(v as View);
                remember("sheets.gallery.view", v);
              }}
              className="rounded-lg border border-border bg-card p-0.5"
              aria-label="Layout"
            >
              <ToggleGroupItem value="grid" aria-label="Grid" className="h-8 w-8 p-0">
                <LayoutGrid className="h-4 w-4" />
              </ToggleGroupItem>
              <ToggleGroupItem value="list" aria-label="List" className="h-8 w-8 p-0">
                <List className="h-4 w-4" />
              </ToggleGroupItem>
            </ToggleGroup>
            <Button
              variant="ghost"
              size="icon"
              className="h-10 w-10"
              onClick={() => void reload()}
              aria-label="Refresh"
              title="Refresh"
            >
              <RefreshCw className={cn("h-4 w-4", refreshing && "animate-spin")} />
            </Button>
          </div>
        </div>

        {!loaded ? (
          <div
            className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4"
            aria-label="Loading workbooks"
          >
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="overflow-hidden rounded-xl border border-border bg-card">
                <Skeleton className="h-[136px] rounded-none" />
                <div className="space-y-2 p-4">
                  <Skeleton className="h-4 w-2/3" />
                  <Skeleton className="h-3 w-1/2" />
                </div>
              </div>
            ))}
          </div>
        ) : claim.message === "error" ? (
          <div className="space-y-3 rounded-xl border border-destructive/40 bg-card p-6 text-sm">
            <p className="font-medium text-destructive">Could not load your workbooks</p>
            <p className="text-muted-foreground">
              {loadError}. Nothing has been deleted; this page could not read the list.
            </p>
            <Button size="sm" variant="outline" onClick={() => void reload()}>
              Try again
            </Button>
          </div>
        ) : claim.message === "empty" ? (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border bg-card/50 py-14 text-center">
            <FileSpreadsheet className="h-10 w-10 text-muted-foreground" />
            <div>
              <p className="font-medium">No workbooks yet</p>
              <p className="mt-1 max-w-md text-sm text-muted-foreground">
                Start with an empty grid or an Excel or CSV file, then bring in a lakehouse table, a
                catalog asset or a connected source as a table sheet.
              </p>
            </div>
            <Button size="sm" onClick={() => setNewOpen(true)}>
              <Plus className="mr-1.5 h-4 w-4" /> New workbook
            </Button>
          </div>
        ) : shown.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border py-14 text-center">
            <SearchX className="h-9 w-9 text-muted-foreground" />
            <div>
              <p className="font-medium">No workbooks match “{query.trim()}”</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Names, descriptions and sheet names are searched; every word has to appear.
              </p>
            </div>
            <Button size="sm" variant="outline" onClick={() => setQuery("")}>
              Clear search
            </Button>
          </div>
        ) : view === "grid" ? (
          <ul
            className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4"
            data-testid="workbook-list"
          >
            {shown.map((wb) => (
              <li key={wb.id}>
                <article
                  className="group relative flex h-full flex-col overflow-hidden rounded-xl border border-border bg-card shadow-sm transition duration-200 focus-within:border-primary/50 hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-lg motion-reduce:transition-none motion-reduce:hover:translate-y-0"
                  data-testid="workbook-card"
                >
                  <WorkbookThumb
                    preview={wb.preview}
                    className="h-[136px] border-b border-border"
                  />
                  <div className="flex flex-1 flex-col gap-1.5 p-4 pt-3">
                    <div className="flex items-start gap-2">
                      <h3 className="min-w-0 flex-1 truncate font-medium leading-8">
                        {/* The whole card opens the workbook; the menu sits above the link. */}
                        <Link
                          to="/sheets/$workbookId"
                          params={{ workbookId: wb.id }}
                          className="outline-none after:absolute after:inset-0 after:content-[''] focus-visible:underline"
                        >
                          <Highlight text={wb.name} query={query} />
                        </Link>
                      </h3>
                      {actions(wb)}
                    </div>
                    {wb.description && (
                      <p className="-mt-1 line-clamp-2 text-sm text-muted-foreground">
                        <Highlight text={wb.description} query={query} />
                      </p>
                    )}
                    <div className="mt-auto flex items-end justify-between gap-3 pt-2">
                      <SheetChips sheets={wb.sheets} query={query} />
                      <time
                        dateTime={wb.updated_at}
                        title={`Edited ${new Date(wb.updated_at).toLocaleString()}`}
                        className="shrink-0 text-xs tabular-nums text-muted-foreground"
                      >
                        {relTime(wb.updated_at)}
                      </time>
                    </div>
                  </div>
                </article>
              </li>
            ))}
          </ul>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border bg-card">
            <table className="w-full min-w-[720px] text-sm" data-testid="workbook-table">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-2.5 font-medium">Name</th>
                  <th className="px-4 py-2.5 font-medium">Sheets</th>
                  <th className="px-4 py-2.5 font-medium">Edited</th>
                  <th className="px-4 py-2.5 font-medium">Created</th>
                  <th className="w-12 px-2 py-2.5">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map((wb) => (
                  <tr
                    key={wb.id}
                    className="relative border-b border-border last:border-0 hover:bg-muted/40"
                  >
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-3">
                        <WorkbookThumb
                          preview={wb.preview}
                          compact
                          className="h-9 w-14 shrink-0 rounded border border-border"
                        />
                        <div className="min-w-0">
                          <Link
                            to="/sheets/$workbookId"
                            params={{ workbookId: wb.id }}
                            className="block truncate font-medium outline-none after:absolute after:inset-0 after:content-[''] focus-visible:underline"
                          >
                            <Highlight text={wb.name} query={query} />
                          </Link>
                          {wb.description && (
                            <p className="truncate text-xs text-muted-foreground">
                              <Highlight text={wb.description} query={query} />
                            </p>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-2.5">
                      <SheetChips sheets={wb.sheets} query={query} />
                    </td>
                    <td
                      className="whitespace-nowrap px-4 py-2.5 tabular-nums text-muted-foreground"
                      title={new Date(wb.updated_at).toLocaleString()}
                    >
                      {relTime(wb.updated_at)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 tabular-nums text-muted-foreground">
                      {new Date(wb.created_at).toLocaleDateString()}
                    </td>
                    <td className="px-2 py-2.5 text-right">{actions(wb)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <Dialog open={newOpen} onOpenChange={setNewOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New workbook</DialogTitle>
            <DialogDescription>
              It starts with one empty grid sheet. Add table sheets from the lakehouse, the data
              catalog or a connected source once it is open.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="wb-name">Name</Label>
              <Input
                id="wb-name"
                value={newName}
                maxLength={200}
                placeholder="Q3 revenue model"
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void create();
                }}
                autoFocus
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="wb-desc">Description (optional)</Label>
              <Textarea
                id="wb-desc"
                value={newDesc}
                maxLength={4000}
                rows={3}
                onChange={(e) => setNewDesc(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewOpen(false)}>
              Cancel
            </Button>
            <Button disabled={creating || !newName.trim()} onClick={() => void create()}>
              {creating && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** The parts of `text` a search found, marked. */
function Highlight({ text, query }: { text: string; query: string }) {
  const spans = matchSpans(text, query);
  if (!spans.length) return <>{text}</>;
  const out: React.ReactNode[] = [];
  let at = 0;
  spans.forEach(([s, e], i) => {
    if (s > at) out.push(text.slice(at, s));
    out.push(
      <mark key={i} className="rounded-sm bg-primary/15 px-px text-foreground">
        {text.slice(s, e)}
      </mark>,
    );
    at = e;
  });
  if (at < text.length) out.push(text.slice(at));
  return <>{out}</>;
}

/** A workbook's sheets as chips: the ones a search found first, then in order. */
function SheetChips({ sheets, query }: { sheets: WorkbookSummary["sheets"]; query: string }) {
  const hit = (name: string) => matchSpans(name, query).length > 0;
  const ordered = query.trim()
    ? [...sheets.filter((s) => hit(s.name)), ...sheets.filter((s) => !hit(s.name))]
    : sheets;
  const first = ordered.slice(0, 3);
  const more = sheets.length - first.length;
  return (
    <ul className="flex min-w-0 flex-wrap items-center gap-1" aria-label="Sheets">
      {first.map((s) => {
        const Icon = s.kind === "table" ? Database : Grid3x3;
        return (
          <li
            key={s.name}
            className="inline-flex max-w-[140px] items-center gap-1 rounded-md border border-border bg-muted/50 px-1.5 py-0.5 text-[11px] text-muted-foreground"
            title={`${s.name} — ${s.kind === "table" ? "table sheet (lakehouse)" : "grid sheet"}`}
          >
            <Icon
              className={cn(
                "h-3 w-3 shrink-0",
                s.kind === "table"
                  ? "text-sky-600 dark:text-sky-400"
                  : "text-emerald-600 dark:text-emerald-400",
              )}
            />
            <span className="truncate">
              <Highlight text={s.name} query={query} />
            </span>
          </li>
        );
      })}
      {more > 0 && <li className="px-1 text-[11px] text-muted-foreground">+{more}</li>}
    </ul>
  );
}

function StartTile({
  title,
  detail,
  art,
  onClick,
}: {
  title: string;
  detail: string;
  art: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex items-center gap-4 rounded-xl border border-border bg-card p-3 text-left shadow-sm transition hover:border-primary/40 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
    >
      <span className="flex h-16 w-24 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-muted/40">
        {art}
      </span>
      <span className="min-w-0">
        <span className="block font-medium group-hover:text-primary">{title}</span>
        <span className="block text-sm text-muted-foreground">{detail}</span>
      </span>
    </button>
  );
}

/** A blank sheet with a plus: the grid lines of an empty workbook. */
function BlankArt() {
  return (
    <span className="relative block h-full w-full">
      <span
        className="absolute inset-0 opacity-70"
        style={{
          backgroundImage:
            "linear-gradient(to right, var(--border) 1px, transparent 1px), linear-gradient(to bottom, var(--border) 1px, transparent 1px)",
          backgroundSize: "18px 10px",
        }}
      />
      <span className="absolute inset-0 flex items-center justify-center">
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary text-primary-foreground shadow">
          <Plus className="h-4 w-4" />
        </span>
      </span>
    </span>
  );
}

/** A file on its way into a sheet. */
function FileArt() {
  return (
    <span className="flex items-center gap-1.5 text-muted-foreground">
      <span className="flex h-10 w-8 flex-col justify-end rounded-sm border border-border bg-card px-1 pb-1 shadow-sm">
        <span className="rounded-[2px] bg-emerald-600 px-0.5 text-center text-[7px] font-bold leading-3 text-white">
          XLSX
        </span>
      </span>
      <span className="text-primary">→</span>
      <Grid3x3 className="h-6 w-6 text-primary" />
    </span>
  );
}
