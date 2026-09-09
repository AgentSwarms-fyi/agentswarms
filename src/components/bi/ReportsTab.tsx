// BI → Reports: the list of paginated reports.
//
// A dashboard is a grid somebody scrolls; a report is pages somebody prints or
// sends. They share the widget underneath, so the list stays deliberately
// plain — the interesting part is the designer this opens.
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import { FileText, Loader2, Plus, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
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
import { Skeleton } from "@/components/ui/skeleton";
import { confirmAsk } from "@/components/ui/confirm-dialog";
import { useAuth } from "@/hooks/use-auth";
import { PAGE_SIZES } from "@/lib/biReports";
import {
  biReportCreate,
  biReportDelete,
  biReportsList,
  type BiReportRow,
} from "@/utils/biReports.functions";

export function ReportsTab() {
  const navigate = useNavigate();
  const { session } = useAuth();
  const token = session?.access_token ?? "";
  const listFn = useServerFn(biReportsList);
  const createFn = useServerFn(biReportCreate);
  const deleteFn = useServerFn(biReportDelete);

  const [reports, setReports] = useState<BiReportRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    if (!token) return;
    const res = await listFn({ data: { accessToken: token } });
    if (!res.ok) toast.error(res.error);
    else setReports(res.reports);
    setLoading(false);
  }, [listFn, token]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function create() {
    if (!name.trim()) return toast.error("Give the report a name");
    setBusy(true);
    try {
      const res = await createFn({ data: { accessToken: token, name: name.trim() } });
      if (!res.ok) return toast.error(res.error);
      setCreateOpen(false);
      setName("");
      await navigate({ to: "/bi/report/$reportId", params: { reportId: res.id } });
    } finally {
      setBusy(false);
    }
  }

  async function remove(r: BiReportRow) {
    const ok = await confirmAsk({
      title: `Delete "${r.name}"?`,
      body: "The report and its blocks go with it. Exported PDFs are unaffected.",
      actionLabel: "Delete report",
    });
    if (!ok) return;
    const res = await deleteFn({ data: { accessToken: token, id: r.id } });
    if (!res.ok) return toast.error(res.error);
    toast.success("Report deleted");
    void reload();
  }

  if (loading) return <Skeleton className="h-40 w-full" />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-2xl text-sm text-muted-foreground">
          A paginated report has a fixed page, a running header and footer, and tables that continue
          onto the next page with their header repeated — the shape a month-end pack or a regulatory
          return has to be. Generate one with AI, then export it to PDF.
        </p>
        <Button className="gap-1.5" onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4" /> New report
        </Button>
      </div>

      {reports.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
            <FileText className="h-8 w-8 text-muted-foreground" />
            <p className="text-sm font-medium">No reports yet</p>
            <p className="max-w-md text-xs text-muted-foreground">
              Start one and let the AI planner lay out the sections from a table you already have.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {reports.map((r) => {
            const blocks = Array.isArray(r.blocks) ? r.blocks.length : 0;
            return (
              <Card key={r.id} className="group transition-shadow hover:shadow-md">
                <CardContent className="space-y-2 p-4">
                  <button
                    type="button"
                    className="flex w-full items-start gap-2 text-left"
                    onClick={() =>
                      void navigate({ to: "/bi/report/$reportId", params: { reportId: r.id } })
                    }
                  >
                    <FileText className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{r.name}</span>
                      <span className="block text-xs text-muted-foreground">
                        {blocks} block{blocks === 1 ? "" : "s"} ·{" "}
                        {formatDistanceToNow(new Date(r.updated_at), { addSuffix: true })}
                      </span>
                    </span>
                  </button>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="text-[10px]">
                      {PAGE_SIZES[r.page.size]?.label ?? r.page.size} · {r.page.orientation}
                    </Badge>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="ml-auto h-7 w-7 text-muted-foreground hover:text-destructive"
                      title="Delete report"
                      onClick={() => void remove(r)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New report</DialogTitle>
            <DialogDescription>
              It opens on A4 portrait with a page-number footer. Change the page setup, or generate
              the whole thing from a table with AI.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label>Name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="September month-end pack"
              onKeyDown={(e) => e.key === "Enter" && void create()}
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => void create()} disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Create report"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
