// Suggested narratives for the visual being built (R499): the sentences
// lib/biInsights can honestly say about the preview's rows — the top members,
// the change since the last period, the next period's forecast, an anomaly —
// each with an Add button that puts it on the dashboard beside the chart.
//
// Only sentences that compute are offered: a forecast on five months, or a
// ranking with no category, never appears as a suggestion to be refused later.
import { useMemo } from "react";
import { Lightbulb, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fmtBiValue } from "@/components/bi/biChartData";
import { visualFields } from "@/components/bi/biDrawHelpers";
import type { ChartSpec } from "@/lib/biAgent";
import { resolvePercentOf } from "@/lib/biChartFields";
import { suggestNarratives } from "@/lib/biInsights";
import { snapshotRows, type BiWidget } from "@/lib/biDashboards";
import { toast } from "sonner";

export function BiSuggestedNarratives({
  columns,
  rows,
  chart,
  base,
  onAdd,
}: {
  columns: string[];
  rows: Record<string, unknown>[];
  /** The visual being built: its number format and its fields. */
  chart?: ChartSpec;
  /** What the narrative widget shares with the visual being built. */
  base: Pick<BiWidget, "source" | "sql" | "truncated" | "field_query">;
  /** Puts the narrative on the dashboard. */
  onAdd: (w: BiWidget) => void;
}) {
  const list = useMemo(() => {
    const stated: Pick<ChartSpec, "format" | "currency" | "decimals" | "percentOf"> = chart ?? {};
    // The sentence prints figures the way the preview above it does (R512):
    // a Percent visual over ratios drew 27% on its axis while this read
    // "APJ 0.27%". The added narrative keeps only the stated format and
    // reads the scale from its own values when it draws.
    const shown = chart ? resolvePercentOf(chart, rows) : {};
    return suggestNarratives(
      columns,
      rows,
      (n) => fmtBiValue(n, shown),
      stated,
      3,
      visualFields(chart),
    );
  }, [columns, rows, chart]);
  if (list.length === 0) return null;
  return (
    <div className="space-y-1.5 rounded-lg border border-border/60 p-2">
      <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        <Lightbulb className="h-3 w-3 text-primary" /> Suggested narratives
      </p>
      {list.map((s) => (
        <div key={s.spec.kind} className="flex items-start gap-2">
          <p className="min-w-0 flex-1 text-[11px] leading-snug text-muted-foreground">{s.text}</p>
          <Button
            size="sm"
            variant="outline"
            className="h-6 shrink-0 gap-1 px-2 text-[10px]"
            aria-label={`Add the narrative: ${s.title}`}
            onClick={() => {
              onAdd({
                ...base,
                id: crypto.randomUUID(),
                kind: "chart",
                title: s.title,
                chart: s.spec,
                columns,
                rows: snapshotRows(rows),
                refreshed_at: new Date().toISOString(),
              });
              toast.success(`Added “${s.title}”`);
            }}
          >
            <Plus className="h-3 w-3" /> Add
          </Button>
        </div>
      ))}
    </div>
  );
}
