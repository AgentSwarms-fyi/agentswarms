// Narrative widget body (R498): the sentence lib/biInsights computes from the
// widget's rows, drawn with its numbers emphasised and its good or bad news
// coloured. Recomputed on every render, so it follows filters like a chart.
import { useMemo } from "react";
import { Lightbulb } from "lucide-react";
import type { ChartSpec } from "@/lib/biAgent";
import { computeInsight, type InsightPart } from "@/lib/biInsights";
import { fmtBiValue } from "@/components/bi/biChartData";
import { hexColor } from "@/lib/biDashboards";
import { cn } from "@/lib/utils";

type InsightChart = Extract<ChartSpec, { type: "insight" }>;

function Part({ p, color }: { p: InsightPart; color?: string }) {
  if (!p.tone) return <>{p.text}</>;
  return (
    <span
      className={cn(
        "font-semibold tabular-nums",
        p.tone === "good"
          ? "text-emerald-600 dark:text-emerald-400"
          : p.tone === "bad"
            ? "text-red-600 dark:text-red-400"
            : "text-foreground",
      )}
      // The author's colour for plain figures (R501); good and bad news keep
      // their green and red, which carry meaning a chosen colour would hide.
      style={color && p.tone === "strong" ? { color } : undefined}
    >
      {p.text}
    </span>
  );
}

export function BiInsightBody({
  chart,
  rows,
  large = false,
  fill = false,
}: {
  chart: InsightChart;
  rows: Record<string, unknown>[];
  large?: boolean;
  fill?: boolean;
}) {
  const result = useMemo(
    () =>
      computeInsight(
        {
          kind: chart.kind,
          valueField: chart.valueField,
          categoryField: chart.categoryField,
          dateField: chart.dateField,
          topN: chart.topN,
          periods: chart.periods,
          label: chart.label,
          template: chart.template,
          lowerIsBetter: chart.lowerIsBetter,
          dateGrain: chart.dateGrain,
          measureIs: chart.measureIs,
        },
        rows,
        {
          value: (n) => fmtBiValue(n, chart),
          percentMeasure: chart.format === "percent",
        },
      ),
    [chart, rows],
  );

  if (!result.ok) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-xs text-muted-foreground">
        {result.reason}
      </div>
    );
  }

  const color = hexColor(chart.valueColor);
  return (
    <div
      className={cn(
        "flex w-full gap-2.5 overflow-y-auto px-2 leading-relaxed text-muted-foreground",
        fill ? "h-full items-start py-1" : "py-2",
        large ? "text-base" : "text-[13px]",
      )}
    >
      {!chart.hideIcon && (
        <Lightbulb
          className={cn("mt-0.5 shrink-0 text-primary", large ? "h-5 w-5" : "h-4 w-4")}
          aria-hidden
        />
      )}
      <div className="min-w-0 space-y-1">
        <p>
          {result.lead.map((p, i) => (
            <Part key={i} p={p} color={color} />
          ))}
        </p>
        {result.items && result.items.length > 0 && (
          <ol className="list-inside list-decimal space-y-0.5 marker:text-muted-foreground/70">
            {result.items.map((line, i) => (
              <li key={i}>
                {line.map((p, j) => (
                  <Part key={j} p={p} color={color} />
                ))}
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
