// Data & BI -> Sheets -> a workbook: the spreadsheet editor.
import { useCallback, useEffect, useRef, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  ArrowLeft,
  ChevronDown,
  FileDown,
  FileSpreadsheet,
  FileUp,
  Eye,
  History,
  Loader2,
  Pencil,
  Share2,
} from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { downloadCsv, downloadXlsx } from "@/components/sheets/download";
import { ImportFileDialog } from "@/components/sheets/ImportFileDialog";
import { ShareDialog } from "@/components/sheets/ShareDialog";
import { VersionHistoryDialog } from "@/components/sheets/VersionHistoryDialog";
import { promptAsk } from "@/components/ui/confirm-dialog";
import { WorkbookEditor } from "@/components/sheets/WorkbookEditor";
import { useWorkbook } from "@/components/sheets/useWorkbook";
import { useWorkbookPreview } from "@/components/sheets/useWorkbookPreview";
import type { WorkbookPreview } from "@/lib/sheets/preview";
import type { DefinedName } from "@/lib/sheets/definedNames";
import {
  sheetsGet,
  sheetsUpdateWorkbook,
  type SheetTabRow,
  type SheetsLimits,
  type WorkbookAccessInfo,
} from "@/utils/sheets.functions";
import { ROLE_LABEL } from "@/lib/sheets/share";
import { sheetsTableExport } from "@/utils/sheetsTables.functions";
import type { TableConfig } from "@/lib/sheets/sql/tableQuery";

export const Route = createFileRoute("/_authenticated/sheets_/$workbookId")({
  head: () => ({ meta: [{ title: "Workbook — Sheets — AgentSwarms" }] }),
  // ?as=<share>: the owner looking at the workbook as that share sees it.
  validateSearch: (search: Record<string, unknown>): { as?: string } =>
    typeof search.as === "string" && /^[0-9a-f-]{36}$/i.test(search.as) ? { as: search.as } : {},
  component: WorkbookPage,
});

function WorkbookPage() {
  const { workbookId } = Route.useParams();
  const { as: asShare } = Route.useSearch();
  const { session } = useAuth();
  const token = session?.access_token;
  const getFn = useServerFn(sheetsGet);
  const updateFn = useServerFn(sheetsUpdateWorkbook);
  const exportFn = useServerFn(sheetsTableExport);
  const [importOpen, setImportOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [access, setAccess] = useState<WorkbookAccessInfo | null>(null);
  const navigate = useNavigate();
  const [busy, setBusy] = useState<"xlsx" | "csv" | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [tabs, setTabs] = useState<SheetTabRow[] | null>(null);
  const [names, setNames] = useState<DefinedName[] | null>(null);
  const [limits, setLimits] = useState<SheetsLimits | null>(null);
  // The gallery thumbnail kept now; undefined until the workbook has loaded.
  const [storedPreview, setStoredPreview] = useState<WorkbookPreview | null | undefined>();
  const [error, setError] = useState<{ message: string; missing?: boolean } | null>(null);

  // The session's token is read when it is needed, not watched: it changes
  // every time the session refreshes (about hourly), and reloading the
  // workbook then rebuilt the editor from the saved copy, dropping any edit
  // not yet saved and saving that older state over it (R120).
  const tokenRef = useRef(token);
  tokenRef.current = token;
  const signedIn = !!token;
  const load = useCallback(async () => {
    const token = tokenRef.current;
    if (!token) return;
    setError(null);
    try {
      const r = await getFn({
        data: { access_token: token, id: workbookId, as_share: asShare ?? null },
      });
      if (!r.ok) {
        setError({ message: r.error, missing: "missing" in r ? r.missing : undefined });
        return;
      }
      setAccess(r.access);
      setName(r.workbook.name);
      setStoredPreview(r.workbook.preview);
      setLimits(r.limits);
      setNames(r.names);
      setTabs(r.tabs);
    } catch (e) {
      setError({ message: (e as Error).message });
    }
    // Once per workbook (and once signed in), not once per token.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn, workbookId, asShare, getFn]);

  useEffect(() => {
    void load();
  }, [load]);

  // Shared to view, or seen as a share sees it: nothing changes or saves.
  const readOnly = !access || access.role === "viewer" || !!access.viewing_as;
  const wb = useWorkbook({
    token,
    workbookId,
    tabs,
    limits,
    readOnly,
    role: access?.role,
    asShare: asShare ?? null,
    names,
    book: name,
  });
  // The thumbnail is drawn from what this page shows: only from everything.
  useWorkbookPreview({ wb, token, workbookId, stored: readOnly ? undefined : storedPreview });

  useEffect(() => {
    if (name) document.title = `${name} — Sheets — AgentSwarms`;
  }, [name]);

  const rename = async () => {
    if (!token || name === null) return;
    const next = await promptAsk({
      title: "Rename workbook",
      input: { defaultValue: name, required: true },
      actionLabel: "Rename",
    });
    if (next === null || !next.trim() || next.trim() === name) return;
    try {
      const r = await updateFn({
        data: { access_token: token, id: workbookId, name: next.trim() },
      });
      if (!r.ok) return toast.error(r.error);
      setName(next.trim());
    } catch (e) {
      toast.error(`Could not rename: ${(e as Error).message}`);
    }
  };

  const tableRows = (args: { tab_id: string; config: TableConfig }) =>
    exportFn({
      data: { access_token: token!, ...args, as_share: asShare ?? null, params: wb.queryParams },
    });

  const download = async (kind: "xlsx" | "csv") => {
    if (!wb.engine || !token) return;
    setBusy(kind);
    try {
      await wb.flush();
      const notes =
        kind === "xlsx"
          ? await downloadXlsx({
              name: name ?? "workbook",
              engine: wb.engine,
              tabs: wb.tabs,
              tableConfigs: wb.tableConfigs,
              tableRows,
            })
          : await (async () => {
              const tab = wb.tabs.find((t) => t.id === wb.activeTabId);
              if (!tab) throw new Error("No sheet is open");
              return downloadCsv({
                workbook: name ?? "workbook",
                tab,
                engine: wb.engine!,
                tableConfig: wb.tableConfigs[tab.id],
                tableRows,
              });
            })();
      if (notes.length) toast.warning(`Downloaded, with limits: ${notes.join("; ")}`);
      else toast.success(kind === "xlsx" ? "Downloaded the workbook" : "Downloaded the sheet");
    } catch (e) {
      toast.error(`Could not download: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  if (error) {
    return (
      <div className="p-6">
        <Link
          to="/sheets"
          className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" /> Sheets
        </Link>
        <div className="rounded-md border border-destructive/40 p-4 text-sm">
          <p className="font-medium text-destructive">
            {error.missing ? "Workbook not found" : "Could not open this workbook"}
          </p>
          <p className="mt-1 text-muted-foreground">
            {error.message}
            {error.missing ? "" : ". Nothing was saved over it; the page could not read it."}
          </p>
          {!error.missing && (
            <Button size="sm" variant="outline" className="mt-3" onClick={() => void load()}>
              Try again
            </Button>
          )}
        </div>
      </div>
    );
  }

  return (
    // h-canvas, not h-full: the shell is min-h-screen, so a percentage height resolves to nothing.
    <div className="flex h-canvas flex-col overflow-hidden">
      <div className="flex items-center gap-3 border-b border-border px-3 py-2">
        <Link
          to="/sheets"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          onClick={() => void wb.flush()}
        >
          <ArrowLeft className="h-4 w-4" /> Sheets
        </Link>
        <div className="h-5 w-px bg-border" />
        <h1 className="truncate font-display text-lg font-semibold" data-testid="workbook-name">
          {name ?? "…"}
        </h1>
        {name !== null && !readOnly && (
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            title="Rename workbook"
            onClick={() => void rename()}
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
        )}
        {access && access.role !== "owner" && !access.viewing_as && (
          <span
            className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground"
            data-testid="workbook-role"
          >
            {ROLE_LABEL[access.role]} · shared by {access.owner}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {access?.role === "owner" && !access.viewing_as && (
            <Button
              size="sm"
              variant="outline"
              className="h-8 gap-1"
              onClick={() => setShareOpen(true)}
              data-testid="workbook-share"
            >
              <Share2 className="h-4 w-4" /> Share
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="sm"
                variant="outline"
                className="h-8 gap-1"
                disabled={!wb.engine}
                data-testid="workbook-file-menu"
              >
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <FileSpreadsheet className="h-4 w-4" />
                )}
                File
                <ChevronDown className="h-3 w-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              {!readOnly && (
                <>
                  <DropdownMenuItem onSelect={() => setImportOpen(true)}>
                    <FileUp className="mr-2 h-4 w-4" /> Import sheets from Excel or CSV…
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                </>
              )}
              <DropdownMenuItem onSelect={() => void download("xlsx")} disabled={!!busy}>
                <FileDown className="mr-2 h-4 w-4" /> Download as Excel (.xlsx)
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void download("csv")} disabled={!!busy}>
                <FileDown className="mr-2 h-4 w-4" /> Download this sheet as CSV
              </DropdownMenuItem>
              {/* A version holds every sheet and row: not for a viewer. */}
              {!readOnly && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => setHistoryOpen(true)}>
                    <History className="mr-2 h-4 w-4" /> Version history…
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {access?.role === "viewer" && !access.viewing_as && (
        <div
          className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-muted/40 px-3 py-1.5 text-xs"
          data-testid="share-banner"
        >
          <Eye className="h-3.5 w-3.5 text-muted-foreground" />
          <span>Shared with you to view by {access.owner}. Nothing you do here changes it.</span>
          {access.filtered.length > 0 && (
            <span className="text-muted-foreground">
              Some rows only: {access.filtered.join(", ")}.
            </span>
          )}
          {access.hidden > 0 && (
            <span className="text-muted-foreground">
              {access.hidden} sheet{access.hidden === 1 ? " is" : "s are"} not shared with you.
            </span>
          )}
        </div>
      )}
      {access?.viewing_as && (
        <div
          className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-900 dark:text-amber-100"
          data-testid="view-as-banner"
        >
          <Eye className="h-3.5 w-3.5" />
          <span>
            You are seeing this workbook as {access.viewing_as_label} sees it
            {access.filtered.length ? `: only some rows of ${access.filtered.join(", ")}` : ""}
            {access.hidden
              ? `${access.filtered.length ? ";" : ":"} ${access.hidden} sheet${access.hidden === 1 ? "" : "s"} left out`
              : ""}
            . Table sheets read the lakehouse as you here; for them it is their own access.
          </span>
          <Button
            size="sm"
            variant="outline"
            className="ml-auto h-6 px-2 text-xs"
            onClick={() =>
              void navigate({ to: "/sheets/$workbookId", params: { workbookId }, search: {} })
            }
          >
            Back to editing
          </Button>
        </div>
      )}
      {shareOpen && token && (
        <ShareDialog
          open
          onOpenChange={setShareOpen}
          token={token}
          workbookId={workbookId}
          wb={wb}
          onViewAs={(id) => {
            setShareOpen(false);
            void wb.flush();
            void navigate({
              to: "/sheets/$workbookId",
              params: { workbookId },
              search: { as: id },
            });
          }}
        />
      )}
      {historyOpen && (
        <VersionHistoryDialog
          token={token}
          workbookId={workbookId}
          flush={() => wb.flush()}
          onRestored={() => {
            setHistoryOpen(false);
            void load();
          }}
          onOpened={(id) => {
            setHistoryOpen(false);
            void navigate({ to: "/sheets/$workbookId", params: { workbookId: id } });
          }}
          onClose={() => setHistoryOpen(false)}
        />
      )}
      {importOpen && token && (
        <ImportFileDialog
          open
          onOpenChange={setImportOpen}
          token={token}
          maxCells={limits?.maxCells ?? 200_000}
          workbookId={workbookId}
          takenNames={wb.tabs.map((t) => t.name)}
          onImported={(r) => {
            // The names first, so the new sheets' formulas compute with them.
            if (r.names.length) wb.addNamesLocal(r.names);
            for (const tab of r.tabs) wb.addTabLocal(tab);
            toast.success(
              `Added ${r.tabs.length} sheet${r.tabs.length > 1 ? "s" : ""} from the file${r.names.length ? ` and ${r.names.length} name${r.names.length > 1 ? "s" : ""}` : ""}`,
            );
            if (r.skippedNames.length)
              toast.warning(
                `This workbook already has ${r.skippedNames.join(", ")}; its own ${r.skippedNames.length > 1 ? "were" : "was"} kept, and the file's formulas use ${r.skippedNames.length > 1 ? "them" : "it"}.`,
              );
          }}
        />
      )}
      <div className="min-h-0 flex-1">
        {tabs === null || !token ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Opening workbook…
          </div>
        ) : (
          <WorkbookEditor
            wb={wb}
            token={token}
            workbookId={workbookId}
            workbookName={name ?? "Workbook"}
          />
        )}
      </div>
    </div>
  );
}
