// "Add to dashboard" for a governed semantic-metric query result. Builds a
// metric-backed widget (which refresh re-runs against the current metric
// definition) and inserts it into an existing BI project or a new one.
import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { LayoutDashboard, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  appendWidgetToDashboard,
  createDashboard,
  listDashboards,
  widgetFromSemantic,
  type BiDashboardRow,
  type SemanticChartType,
} from "@/lib/biDashboards";
import type { ComparePeriod, SemanticFilter, TimeGrain } from "@/lib/semanticLayer";

const NEW_PROJECT = "__new__";
const CHART_TYPES: SemanticChartType[] = ["bar", "line", "area", "pie", "kpi", "table"];

export type SemanticWidgetPayload = {
  model: string;
  metrics: string[];
  dimensions: string[];
  filters?: SemanticFilter[];
  grains?: Record<string, TimeGrain>;
  compare?: ComparePeriod;
  columns: string[];
  rows: Record<string, unknown>[];
  sql: string;
  defaultTitle: string;
};

export function AddMetricToDashboardDialog({
  open,
  onOpenChange,
  userId,
  payload,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  userId: string | null;
  payload: SemanticWidgetPayload | null;
}) {
  const navigate = useNavigate();
  const [dashboards, setDashboards] = useState<BiDashboardRow[] | null>(null);
  const [target, setTarget] = useState<string>(NEW_PROJECT);
  const [newName, setNewName] = useState("");
  const [title, setTitle] = useState("");
  const [chartType, setChartType] = useState<SemanticChartType>("bar");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTitle(payload?.defaultTitle ?? "");
    setChartType(payload && payload.dimensions.length === 0 ? "kpi" : "bar");
    setDashboards(null);
    listDashboards()
      .then((rows) => {
        const mine = rows.filter((r) => r.user_id === userId);
        setDashboards(mine);
        setTarget(mine[0]?.id ?? NEW_PROJECT);
      })
      .catch((e) => {
        toast.error((e as Error).message);
        setDashboards([]);
      });
    setNewName("");
  }, [open, userId, payload]);

  async function submit() {
    if (!payload || !userId) return;
    if (!title.trim()) return toast.error("Give the widget a title");
    if (target === NEW_PROJECT && !newName.trim()) return toast.error("Name the new BI project");
    setBusy(true);
    try {
      const widget = widgetFromSemantic({
        title: title.trim(),
        model: payload.model,
        metrics: payload.metrics,
        dimensions: payload.dimensions,
        filters: payload.filters,
        grains: payload.grains,
        compare: payload.compare,
        chartType,
        columns: payload.columns,
        rows: payload.rows,
        sql: payload.sql,
      });
      let dashboardId = target;
      let dashboardName = dashboards?.find((d) => d.id === target)?.name ?? "";
      if (target === NEW_PROJECT) {
        const row = await createDashboard({ userId, name: newName.trim() });
        dashboardId = row.id;
        dashboardName = row.name;
      }
      await appendWidgetToDashboard(dashboardId, widget);
      onOpenChange(false);
      toast.success(`Added to "${dashboardName}"`, {
        action: {
          label: "Open",
          onClick: () => void navigate({ to: "/bi/$dashboardId", params: { dashboardId } }),
        },
      });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <LayoutDashboard className="h-4 w-4 text-primary" /> Add metric to dashboard
          </DialogTitle>
          <DialogDescription>
            Insert a widget backed by this governed metric — it re-runs against the current
            definition on every refresh.
          </DialogDescription>
        </DialogHeader>

        {dashboards === null ? (
          <Skeleton className="h-9 w-full" />
        ) : (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>Title</Label>
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Revenue by region"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Chart</Label>
                <Select
                  value={chartType}
                  onValueChange={(v) => setChartType(v as SemanticChartType)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CHART_TYPES.map((t) => (
                      <SelectItem key={t} value={t}>
                        {t}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>BI project</Label>
                <Select value={target} onValueChange={setTarget}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {dashboards.map((d) => (
                      <SelectItem key={d.id} value={d.id}>
                        {d.name}
                      </SelectItem>
                    ))}
                    <SelectItem value={NEW_PROJECT}>＋ New BI project…</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            {target === NEW_PROJECT && (
              <div className="space-y-1.5">
                <Label>New project name</Label>
                <Input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="Sales overview"
                  onKeyDown={(e) => e.key === "Enter" && void submit()}
                />
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={busy || dashboards === null}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Insert widget"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
