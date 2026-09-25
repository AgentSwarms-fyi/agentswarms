// Data & BI -> Sheets: the list of workbooks.
//
// A workbook is a spreadsheet: grid sheets for the familiar cells and
// formulas, and table sheets whose rows live in the lakehouse, so a sheet can
// hold far more than a browser could. This page lists, creates, renames and
// deletes them; the editor is sheets_.$workbookId.
import { useCallback, useEffect, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { FileSpreadsheet, Loader2, Pencil, Plus, RefreshCw, Table2, Trash2 } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { confirmAsk, promptAsk } from "@/components/ui/confirm-dialog";
import { relTime } from "@/components/ml/mlUi";
import { listClaim } from "@/lib/listClaim";
import {
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

function SheetsPage() {
  const { session } = useAuth();
  const token = session?.access_token;
  const navigate = useNavigate();
  const listFn = useServerFn(sheetsList);
  const createFn = useServerFn(sheetsCreate);
  const deleteFn = useServerFn(sheetsDelete);
  const updateFn = useServerFn(sheetsUpdateWorkbook);

  const [workbooks, setWorkbooks] = useState<WorkbookSummary[] | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!token) return;
    try {
      const r = await listFn({ data: { access_token: token } });
      if (!r.ok) {
        setLoadError(r.error);
      } else {
        setWorkbooks(r.workbooks);
        setLoadError(null);
      }
    } catch (e) {
      setLoadError((e as Error).message);
    } finally {
      setLoaded(true);
    }
  }, [token, listFn]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const claim = listClaim({ loaded, error: loadError, count: workbooks?.length ?? 0 });

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

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-primary">
            Data &amp; BI
          </p>
          <h1 className="font-display text-3xl font-semibold tracking-tight">Sheets</h1>
          <p className="mt-1 max-w-2xl text-muted-foreground">
            Spreadsheets with the Excel formulas you already know. Grid sheets hold cells; table
            sheets hold lakehouse data far beyond what a browser could, sorted, filtered and summed
            by the lakehouse itself.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void reload()}>
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Refresh
          </Button>
          <Button size="sm" onClick={() => setNewOpen(true)}>
            <Plus className="mr-1.5 h-4 w-4" /> New workbook
          </Button>
        </div>
      </div>

      {!loaded ? (
        <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading workbooks…
        </div>
      ) : claim.message === "error" ? (
        <Card className="border-destructive/40">
          <CardContent className="space-y-3 py-6 text-sm">
            <p className="font-medium text-destructive">Could not load your workbooks</p>
            <p className="text-muted-foreground">
              {loadError}. Nothing has been deleted; this page could not read the list.
            </p>
            <Button size="sm" variant="outline" onClick={() => void reload()}>
              Try again
            </Button>
          </CardContent>
        </Card>
      ) : claim.message === "empty" ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center gap-3 py-14 text-center">
            <FileSpreadsheet className="h-10 w-10 text-muted-foreground" />
            <div>
              <p className="font-medium">No workbooks yet</p>
              <p className="mt-1 max-w-md text-sm text-muted-foreground">
                Start with an empty grid, then bring in a lakehouse table, a catalog asset or a
                connected source as a table sheet.
              </p>
            </div>
            <Button size="sm" onClick={() => setNewOpen(true)}>
              <Plus className="mr-1.5 h-4 w-4" /> New workbook
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" data-testid="workbook-list">
          {(workbooks ?? []).map((wb) => (
            <Card key={wb.id} className="group transition-colors hover:border-primary/40">
              <CardContent className="flex h-full flex-col gap-3 p-4">
                <Link
                  to="/sheets/$workbookId"
                  params={{ workbookId: wb.id }}
                  className="flex items-start gap-3"
                >
                  <div className="rounded-md bg-emerald-500/10 p-2 text-emerald-600 dark:text-emerald-400">
                    <Table2 className="h-5 w-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium group-hover:text-primary">{wb.name}</p>
                    <p className="line-clamp-2 text-xs text-muted-foreground">
                      {wb.description || "No description"}
                    </p>
                  </div>
                </Link>
                <div className="mt-auto flex items-center justify-between text-xs text-muted-foreground">
                  <span>
                    {wb.sheet_count} sheet{wb.sheet_count === 1 ? "" : "s"} · edited{" "}
                    {relTime(wb.updated_at)}
                  </span>
                  <span className="flex items-center gap-1">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      title="Rename workbook"
                      disabled={busy === wb.id}
                      onClick={() => void rename(wb)}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 text-destructive hover:text-destructive"
                      title="Delete workbook"
                      disabled={busy === wb.id}
                      onClick={() => void remove(wb)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </span>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

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
