// "Scan": run every obvious question against the dashboard's own snapshots.
//
// This is deliberately NOT a model call. The trend, the outliers and the
// concentration are computed from the rows already on screen — so the scan is
// free, instant, offline, and gives the same answer twice. That is worth
// saying out loud on the panel: a proactive feature is trusted more than an
// answer someone asked for, and "computed, not generated" is the reason it
// deserves to be.
//
// The empty state is the part that matters. Rendering "no insights" would be
// read as an all-clear, so describeSweep's full sentence is shown verbatim,
// and the widgets that could NOT be swept are listed underneath with their
// reasons — coverage silently short of 100% is how "we checked everything"
// becomes untrue without anyone editing a word.
import { useMemo } from "react";
import { AlertTriangle, BarChart3, Radar, TrendingUp, Zap } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { BiWidget } from "@/lib/biDashboards";
import { describeSweep, sweepDashboard, type FindingKind } from "@/lib/insightSweep";

const KIND_META: Record<FindingKind, { icon: typeof Radar; label: string }> = {
  trend: { icon: TrendingUp, label: "Trend" },
  anomaly: { icon: Zap, label: "Outlier" },
  concentration: { icon: BarChart3, label: "Concentration" },
};

export function InsightSweepDialog({
  open,
  onOpenChange,
  widgets,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  widgets: BiWidget[];
}) {
  const result = useMemo(() => sweepDashboard(widgets), [widgets]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Radar className="h-4 w-4 text-primary" /> Scan for insights
          </DialogTitle>
          <DialogDescription>
            Trends, outliers and concentration, computed from the snapshots already on this
            dashboard — no model call, no cost, same answer every time.
          </DialogDescription>
        </DialogHeader>

        <p className="rounded-lg border border-border/60 bg-muted/30 p-3 text-xs leading-relaxed text-muted-foreground">
          {describeSweep(result)}
        </p>

        {result.findings.length > 0 && (
          <ul className="space-y-2">
            {result.findings.map((f, i) => {
              const meta = KIND_META[f.kind];
              return (
                <li
                  key={`${f.widgetId}-${f.kind}-${i}`}
                  className="rounded-lg border border-border/60 p-3"
                >
                  <div className="mb-1 flex items-center gap-2">
                    <meta.icon className="h-3.5 w-3.5 shrink-0 text-primary" />
                    <Badge variant="outline" className="text-[9px] uppercase">
                      {meta.label}
                    </Badge>
                    <span className="truncate text-[11px] text-muted-foreground">
                      {f.widgetTitle}
                    </span>
                    <span
                      className="ml-auto shrink-0 text-[10px] tabular-nums text-muted-foreground"
                      title="How far past its own threshold this cleared. 1.0 sits exactly on the bar."
                    >
                      {f.materiality.toFixed(1)}×
                    </span>
                  </div>
                  <p className="text-xs leading-relaxed">{f.headline}</p>
                </li>
              );
            })}
          </ul>
        )}

        {result.skipped.length > 0 && (
          <div>
            <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold">
              <AlertTriangle className="h-3 w-3 text-amber-600 dark:text-amber-400" /> Not swept
            </p>
            <ul className="space-y-1">
              {result.skipped.map((s) => (
                <li key={s.widgetId} className="text-[11px] text-muted-foreground">
                  <span className="font-medium text-foreground">{s.widgetTitle}</span> — {s.reason}
                </li>
              ))}
            </ul>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
