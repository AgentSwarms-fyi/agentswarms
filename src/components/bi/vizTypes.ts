import type { ChartSpec } from "@/lib/biAgent";
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

export type ChartType = ChartSpec["type"];
