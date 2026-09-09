// Put a widget you already built onto a report page.
//
// The reason this is one dialog and not a rebuild: a report's chart block IS a
// dashboard widget. The query, the cached rows and the chart spec come across
// whole, so a number on a page cannot disagree with the same number on the
// tile it came from. The only choice the author makes here is which shape the
// page gets — the visual, or the rows behind it.
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { BarChart3, Loader2, Table2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  getDashboard,
  listDashboards,
  parseLayout,
  parsePages,
  parseWidgets,
  type BiDashboardRow,
  type BiWidget,
} from "@/lib/biDashboards";
import { newBlockId, type ReportBlock } from "@/lib/biReports";

type Candidate = { widget: BiWidget; page: string };

export function AddFromDashboardDialog({
  open,
  onOpenChange,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** The heading and the body block, in that order. */
  onAdd: (blocks: ReportBlock[]) => void;
}) {
  const [dashboards, setDashboards] = useState<BiDashboardRow[]>([]);
  const [pickedId, setPickedId] = useState("");
  const [loading, setLoading] = useState(false);
  const [candidates, setCandidates] = useState<Candidate[]>([]);

  useEffect(() => {
    if (!open) return;
    void (async () => {
      try {
        setDashboards(await listDashboards());
      } catch (e) {
        toast.error((e as Error).message);
      }
    })();
  }, [open]);

  useEffect(() => {
    if (!pickedId) return setCandidates([]);
    setLoading(true);
    void (async () => {
      try {
        const row = await getDashboard(pickedId);
        if (!row) return toast.error("That dashboard is gone");
        const pages = parsePages(
          row.pages,
          parseWidgets(row.widgets),
          parseLayout(row.layout, parseWidgets(row.widgets)),
        );
        const found: Candidate[] = [];
        for (const p of pages) {
          for (const w of p.widgets) {
            // Text and image tiles have nothing a page can flow; a chart
            // widget with no saved snapshot would print an empty box.
            if (w.kind !== "chart" || !(w.rows ?? []).length) continue;
            found.push({ widget: w, page: p.name });
          }
        }
        setCandidates(found);
      } catch (e) {
        toast.error((e as Error).message);
      } finally {
        setLoading(false);
      }
    })();
  }, [pickedId]);

  const add = (c: Candidate, as: "chart" | "table") => {
    const widget = { ...c.widget, title: "" };
    onAdd([
      { id: newBlockId(), kind: "heading", text: c.widget.title || "Untitled", level: 2 },
      as === "table"
        ? { id: newBlockId(), kind: "table", widget, zebra: true }
        : { id: newBlockId(), kind: "chart", widget, height: 200 },
    ]);
    onOpenChange(false);
    toast.success(`Added as a ${as}`);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Add from a dashboard</DialogTitle>
          <DialogDescription>
            The widget comes across whole — its query, its saved rows and its chart spec — so the
            page cannot disagree with the tile. Choose whether the page shows the visual or the rows
            behind it.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <Label className="text-xs">Dashboard</Label>
          <Select value={pickedId} onValueChange={setPickedId}>
            <SelectTrigger className="h-9">
              <SelectValue placeholder="Pick a dashboard…" />
            </SelectTrigger>
            <SelectContent>
              {dashboards.map((d) => (
                <SelectItem key={d.id} value={d.id}>
                  {d.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading widgets…
          </div>
        ) : null}

        {!loading && pickedId && candidates.length === 0 ? (
          <p className="py-4 text-xs text-muted-foreground">
            Nothing on this dashboard has saved rows yet. Refresh it first — a widget with no
            snapshot would print an empty box.
          </p>
        ) : null}

        <div className="space-y-1.5">
          {candidates.map((c) => (
            <div key={c.widget.id} className="flex items-center gap-2 rounded-md border p-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium">{c.widget.title || "Untitled"}</p>
                <p className="text-[11px] text-muted-foreground">
                  {c.page} · {(c.widget.rows ?? []).length.toLocaleString()} row(s)
                  {c.widget.chart?.type ? (
                    <>
                      {" · "}
                      <Badge variant="outline" className="text-[10px]">
                        {c.widget.chart.type}
                      </Badge>
                    </>
                  ) : null}
                </p>
              </div>
              <Button size="sm" variant="outline" className="h-7" onClick={() => add(c, "chart")}>
                <BarChart3 className="mr-1 h-3 w-3" /> Chart
              </Button>
              <Button size="sm" variant="outline" className="h-7" onClick={() => add(c, "table")}>
                <Table2 className="mr-1 h-3 w-3" /> Table
              </Button>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
