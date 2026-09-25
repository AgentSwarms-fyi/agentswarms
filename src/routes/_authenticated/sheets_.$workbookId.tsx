// Data & BI -> Sheets -> a workbook: the spreadsheet editor.
import { useCallback, useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  ArrowLeft,
  ChevronDown,
  FileDown,
  FileSpreadsheet,
  FileUp,
  Loader2,
  Pencil,
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
import { promptAsk } from "@/components/ui/confirm-dialog";
import { WorkbookEditor } from "@/components/sheets/WorkbookEditor";
import { useWorkbook } from "@/components/sheets/useWorkbook";
import {
  sheetsGet,
  sheetsUpdateWorkbook,
  type SheetTabRow,
  type SheetsLimits,
} from "@/utils/sheets.functions";
import { sheetsTableExport } from "@/utils/sheetsTables.functions";
import type { TableConfig } from "@/lib/sheets/sql/tableQuery";

export const Route = createFileRoute("/_authenticated/sheets_/$workbookId")({
  head: () => ({ meta: [{ title: "Workbook — Sheets — AgentSwarms" }] }),
  component: WorkbookPage,
});

function WorkbookPage() {
  const { workbookId } = Route.useParams();
  const { session } = useAuth();
  const token = session?.access_token;
  const getFn = useServerFn(sheetsGet);
  const updateFn = useServerFn(sheetsUpdateWorkbook);
  const exportFn = useServerFn(sheetsTableExport);
  const [importOpen, setImportOpen] = useState(false);
  const [busy, setBusy] = useState<"xlsx" | "csv" | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [tabs, setTabs] = useState<SheetTabRow[] | null>(null);
  const [limits, setLimits] = useState<SheetsLimits | null>(null);
  const [error, setError] = useState<{ message: string; missing?: boolean } | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    setError(null);
    try {
      const r = await getFn({ data: { access_token: token, id: workbookId } });
      if (!r.ok) {
        setError({ message: r.error, missing: "missing" in r ? r.missing : undefined });
        return;
      }
      setName(r.workbook.name);
      setLimits(r.limits);
      setTabs(r.tabs);
    } catch (e) {
      setError({ message: (e as Error).message });
    }
  }, [token, workbookId, getFn]);

  useEffect(() => {
    void load();
  }, [load]);

  const wb = useWorkbook({ token, workbookId, tabs, limits });

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
    exportFn({ data: { access_token: token!, ...args } });

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
        {name !== null && (
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
        <div className="ml-auto flex items-center gap-2">
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
              <DropdownMenuItem onSelect={() => setImportOpen(true)}>
                <FileUp className="mr-2 h-4 w-4" /> Import sheets from Excel or CSV…
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => void download("xlsx")} disabled={!!busy}>
                <FileDown className="mr-2 h-4 w-4" /> Download as Excel (.xlsx)
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void download("csv")} disabled={!!busy}>
                <FileDown className="mr-2 h-4 w-4" /> Download this sheet as CSV
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {importOpen && token && (
        <ImportFileDialog
          open
          onOpenChange={setImportOpen}
          token={token}
          maxCells={limits?.maxCells ?? 200_000}
          workbookId={workbookId}
          takenNames={wb.tabs.map((t) => t.name)}
          onImported={(r) => {
            for (const tab of r.tabs) wb.addTabLocal(tab);
            toast.success(
              `Added ${r.tabs.length} sheet${r.tabs.length > 1 ? "s" : ""} from the file`,
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
          <WorkbookEditor wb={wb} token={token} workbookId={workbookId} />
        )}
      </div>
    </div>
  );
}
