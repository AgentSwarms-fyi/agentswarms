// The chart-type picker: 26 icons, one selected.
//
// Extracted from BiBuilderPane because it is the clearest case in that file —
// 40-odd lines of JSX and a lookup table that depend on exactly TWO things,
// the current type and a setter. Everything about which chart needs which
// fields lives in lib/biVizMeta, so this renders the catalogue rather than
// knowing anything about it.
import type React from "react";
import {
  AreaChart,
  BarChart2,
  BarChart3,
  BarChart4,
  BarChartHorizontal,
  CandlestickChart,
  Cloud,
  FastForward,
  Filter,
  Flame,
  Flower2,
  Gauge,
  Grid3x3,
  Hash,
  LayoutGrid,
  Layers,
  LineChart,
  Map as MapIcon,
  MapPin,
  Network,
  PieChart,
  Radar,
  Rows3,
  ScatterChart,
  Table2,
  Workflow,
} from "lucide-react";

import { Label } from "@/components/ui/label";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { VIZ_REQUIREMENTS } from "@/lib/biVizMeta";
import { cn } from "@/lib/utils";
import type { ChartSpec } from "@/lib/biAgent";

export type ChartType = ChartSpec["type"];

/** Every chart the builder offers, in the order they are shown. */
export const VIZ_TYPES: {
  value: ChartType;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}[] = [
  { value: "bar", label: "Column", icon: BarChart3 },
  { value: "hbar", label: "Bar", icon: BarChartHorizontal },
  { value: "scolumn", label: "Stacked column", icon: Layers },
  { value: "shbar", label: "Stacked bar", icon: Rows3 },
  { value: "barrace", label: "Bar race", icon: FastForward },
  { value: "line", label: "Line", icon: LineChart },
  { value: "area", label: "Area", icon: AreaChart },
  { value: "combo", label: "Combo", icon: BarChart2 },
  { value: "scatter", label: "Scatter", icon: ScatterChart },
  { value: "pie", label: "Pie", icon: PieChart },
  { value: "nightingale", label: "Nightingale", icon: Flower2 },
  { value: "radar", label: "Radar", icon: Radar },
  { value: "funnel", label: "Funnel", icon: Filter },
  { value: "sankey", label: "Sankey", icon: Workflow },
  { value: "treemap", label: "Treemap", icon: LayoutGrid },
  { value: "wordcloud", label: "Word cloud", icon: Cloud },
  { value: "heatmap", label: "Heatmap", icon: Flame },
  { value: "boxplot", label: "Box plot", icon: CandlestickChart },
  { value: "waterfall", label: "Waterfall", icon: BarChart4 },
  { value: "kpi", label: "KPI", icon: Hash },
  { value: "gauge", label: "Gauge", icon: Gauge },
  { value: "matrix", label: "Matrix", icon: Grid3x3 },
  { value: "map", label: "Map", icon: MapIcon },
  { value: "bubblemap", label: "Bubbles", icon: MapPin },
  { value: "table", label: "Table", icon: Table2 },
  { value: "ontology", label: "Ontology", icon: Network },
];

export function BiVizPicker({
  value,
  onChange,
}: {
  value: ChartType;
  onChange: (next: ChartType) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        Visualisation
      </Label>
      <TooltipProvider>
        <div className="grid grid-cols-3 gap-1.5">
          {VIZ_TYPES.map((v) => {
            const req = VIZ_REQUIREMENTS[v.value];
            const btn = (
              <button
                key={v.value}
                type="button"
                onClick={() => onChange(v.value)}
                className={cn(
                  "flex flex-col items-center gap-1 rounded-lg border px-2 py-2.5 text-[10px] font-medium transition",
                  value === v.value
                    ? "border-primary bg-primary/10 text-primary shadow-sm"
                    : "border-border/60 text-muted-foreground hover:border-primary/40 hover:bg-muted/50 hover:text-foreground",
                )}
              >
                <v.icon className="h-5 w-5" />
                {v.label}
              </button>
            );
            // A type with no stated requirement needs no explanation; wrapping
            // it in an empty tooltip would add a hover target that says nothing.
            if (!req) return btn;
            return (
              <Tooltip key={v.value} delayDuration={200}>
                <TooltipTrigger asChild>{btn}</TooltipTrigger>
                <TooltipContent
                  side="top"
                  className="max-w-[240px] border border-border bg-popover text-popover-foreground shadow-md"
                >
                  <p className="text-xs font-semibold text-foreground">{v.label}</p>
                  <p className="mt-0.5 text-xs text-foreground/90">{req.requires}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{req.how}</p>
                </TooltipContent>
              </Tooltip>
            );
          })}
        </div>
      </TooltipProvider>
    </div>
  );
}
