// Data & BI -> Sheets -> a workbook: the spreadsheet editor.
import { useCallback, useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { ArrowLeft, Loader2, Pencil } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { promptAsk } from "@/components/ui/confirm-dialog";
import { WorkbookEditor } from "@/components/sheets/WorkbookEditor";
import { useWorkbook } from "@/components/sheets/useWorkbook";
import {
  sheetsGet,
  sheetsUpdateWorkbook,
  type SheetTabRow,
  type SheetsLimits,
} from "@/utils/sheets.functions";

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
      </div>
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
