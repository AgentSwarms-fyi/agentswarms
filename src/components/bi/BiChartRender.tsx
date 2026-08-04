// Shared recharts renderer for BI chart specs. Used by the Data & SQL BI
// chat (compact + enlarged) and by BI dashboard widgets (fill mode).
//
// Styling follows the conventions of professional BI tools: no axis lines,
// horizontal-only gridlines, soft tooltips, gradient area fills and a
// restrained categorical palette. Bar/line/area support multi-series via
// `seriesField` (long → wide pivot, palette-coloured, optional stacking),
// numeric output honours the spec's `format` (currency / percent), and
// every categorical mark (bars, slices, cells, countries, points, stages)
// is clickable for dashboard cross-filtering, and bar/hbar/pie/treemap
// support drill hierarchies.
import { useEffect, useId, useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Funnel,
  FunnelChart,
  LabelList,
  Layer,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart,
  Rectangle,
  ReferenceLine,
  ResponsiveContainer,
  Sankey,
  Scatter,
  ScatterChart,
  Tooltip,
  Treemap,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";
import {
  BarRace,
  BoxPlot,
  GaugeChart,
  HeatmapGrid,
  MatrixTable,
  NightingaleChart,
} from "@/components/bi/BiChartParts";
import { BiGeoMap } from "@/components/bi/BiGeoMap";
import { OntologyGraph } from "@/components/bi/OntologyGraph";
import { isOntologySpec } from "@/lib/biOntology";
import type { BiNumberFormat, BiRefLine, ChartSpec } from "@/lib/biAgent";
import {
  bucketRowsX,
  cumulative,
  drillRows,
  forecastRows,
  isMostlyDates,
  linearFit,
  priorPeriodOverlay,
  priorYearOverlay,
  type DateGrain,
  type DrillEntry,
} from "@/lib/biChartMath";
import { cn } from "@/lib/utils";

/** Longest label we will print before truncating with an ellipsis. */
const MAX_TICK_CHARS = 18;

/**
 * XAxis props for a CATEGORY axis, so labels are never silently dropped.
 *
 * Recharts defaults to `interval="preserveEnd"`, which hides ticks that would
 * overlap. On a chart of eight return reasons that rendered SIX labels and two
 * unlabelled bars — and nothing on screen said a label was missing, so the
 * reader cannot tell which bar is which and has no reason to suspect it.
 * Crowding is a visible problem; a dropped label is an invisible one.
 *
 * So `interval={0}` always, and when the labels cannot fit flat, angle them
 * and give the axis the height to hold them. Truncation is the last resort —
 * the full value is still in the tooltip.
 *
 * Exported for tests: the thresholds are the whole behaviour, and they are not
 * observable from a rendered chart without measuring pixels.
 */
export function categoryAxis(
  values: unknown[],
  tickSize: number,
): {
  interval: 0;
  angle?: number;
  textAnchor?: "end";
  height?: number;
  tickFormatter?: (v: unknown) => string;
  /**
   * Extra left margin the CHART needs, in px — not an XAxis prop.
   *
   * An angled label is anchored at its end and runs up and to the LEFT, so the
   * first one overhangs the plot area. With margin.left of 0 it was clipped:
   * measured 12px of "Wrong item shipped" cut off, which rendered as
   * "rong item shipped" — a label that is present, wrong, and looks
   * deliberate. Spread the axis props onto XAxis and pass this to the chart's
   * margin.
   */
  leftMargin: number;
} {
  const labels = values.map((v) => (v == null ? "" : String(v)));
  const longest = labels.reduce((m, l) => Math.max(m, l.length), 0);
  // Rough advance width for the tick font — enough to decide "does this fit",
  // which is all that is needed. Measuring text properly would mean a canvas
  // and a layout pass for a decision with two outcomes.
  const approxCharPx = tickSize * 0.62;
  // Recharts gives each category an equal slice; a label fits flat when it is
  // narrower than its slice. 640px is the typical widget width — deliberately
  // pessimistic, because guessing "it fits" is what produced the bug.
  const sliceWidth = 640 / Math.max(1, labels.length);
  const fitsFlat = longest * approxCharPx <= sliceWidth;

  const truncate =
    longest > MAX_TICK_CHARS
      ? (v: unknown) => {
          const s = v == null ? "" : String(v);
          return s.length > MAX_TICK_CHARS ? `${s.slice(0, MAX_TICK_CHARS - 1)}…` : s;
        }
      : undefined;

  if (fitsFlat)
    return { interval: 0, leftMargin: 0, ...(truncate ? { tickFormatter: truncate } : {}) };

  // Angled. Height has to cover the label's vertical extent at 35°, or the
  // axis clips them instead — which is the same invisible failure in a new
  // costume.
  const shown = Math.min(longest, MAX_TICK_CHARS);
  const labelPx = shown * approxCharPx;
  const height = Math.min(110, Math.round(labelPx * Math.sin(Math.PI / 5)) + 24);

  // How far the FIRST label reaches left of its tick, minus the room already
  // there: the Y axis (48px) plus half a category slice. Derived rather than
  // guessed — with eight categories this yields 12px, which is exactly what
  // was measured as clipped.
  const reach = labelPx * Math.cos(Math.PI / 5);
  const roomBeforeFirstTick = 48 + sliceWidth / 2;
  const leftMargin = Math.min(48, Math.max(0, Math.round(reach - roomBeforeFirstTick)));

  return {
    interval: 0,
    angle: -35,
    textAnchor: "end",
    height,
    leftMargin,
    ...(truncate ? { tickFormatter: truncate } : {}),
  };
}

/** Y position for a configured reference line (null = don't draw). For an
 *  "avg" line we average across every value key, so a multi-series (pivoted)
 *  chart — whose rows hold one column per series, not the raw yField — still
 *  yields a meaningful line instead of silently drawing nothing. */
function refLineY(
  ref: BiRefLine | undefined,
  data: Record<string, unknown>[],
  yKeys: string[],
): number | null {
  if (!ref) return null;
  if (ref.mode === "value") return Number.isFinite(ref.value) ? (ref.value as number) : null;
  const nums: number[] = [];
  for (const d of data) {
    for (const k of yKeys) {
      const n = Number(d[k]);
      if (Number.isFinite(n)) nums.push(n);
    }
  }
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
}

/** Fill opacity for a categorical mark under an active cross-filter: full for
 *  the clicked category, dimmed for the rest, all-full when nothing is picked.
 *  Lets bar/column charts show which bar the user clicked (like the map/tree). */
function selFillOpacity(rawValue: unknown, selected: string | null | undefined): number {
  if (selected == null) return 1;
  return String(rawValue) === selected ? 1 : 0.28;
}

const REF_COLOR = "#e15759";

/** Tableau-style categorical palette — calm, print-safe, colorblind-aware. */
export const PIE_COLORS = [
  "#4E79A7",
  "#F28E2B",
  "#59A14F",
  "#E15759",
  "#76B7B2",
  "#EDC948",
  "#B07AA1",
  "#9DA79E",
];

const MAX_SERIES = 12;

/** Coerce a value to a finite number — SQL results often carry numerics as
 * strings (warehouse drivers, CSV columns), which must still format/plot. */
export function toBiNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function fmtBiNumber(v: unknown): string {
  const n = toBiNumber(v);
  if (n === null) return String(v ?? "");
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  if (Number.isInteger(n)) return n.toString();
  return n.toFixed(2).replace(/\.?0+$/, "");
}

/** Options accepted by fmtBiValue — ChartSpec is structurally compatible,
 * so call sites can pass the chart itself. */
export type BiFormatOptions = {
  format?: BiNumberFormat | "number";
  /** ISO 4217 code for currency (default USD). */
  currency?: string;
  /** Fixed fraction digits (0-4); undefined = auto/compact. */
  decimals?: number;
};

function intlNumber(n: number, opts: Intl.NumberFormatOptions): string {
  try {
    // Viewer's browser locale drives separators and currency symbols.
    return new Intl.NumberFormat(undefined, opts).format(n);
  } catch {
    // Bad currency codes etc. — fall back to the plain compact formatter.
    return fmtBiNumber(n);
  }
}

/**
 * fmtBiNumber plus the chart's value format:
 *   currency → locale-aware with the widget's currency code ("€1.2M", "¥5万"…)
 *   percent  → "12.3%" (the value is treated as already being in percent
 *              units — 12.3 formats as 12.3%, not 0.12%)
 * `decimals` pins the fraction digits; otherwise large values use compact
 * notation and small ones show up to two trimmed decimals.
 */
export function fmtBiValue(v: unknown, opts?: BiNumberFormat | BiFormatOptions): string {
  const o: BiFormatOptions = typeof opts === "string" ? { format: opts } : (opts ?? {});
  const n = toBiNumber(v);
  if (n === null) return fmtBiNumber(v);
  const decimals =
    typeof o.decimals === "number" && o.decimals >= 0
      ? Math.min(4, Math.round(o.decimals))
      : undefined;
  if (o.format === "currency") {
    const compact = decimals === undefined && Math.abs(n) >= 10_000;
    return intlNumber(n, {
      style: "currency",
      currency: (o.currency || "USD").toUpperCase(),
      notation: compact ? "compact" : "standard",
      maximumFractionDigits: decimals ?? (compact ? 2 : 2),
      minimumFractionDigits: decimals ?? 0,
    });
  }
  if (o.format === "percent") {
    const body =
      decimals === undefined
        ? fmtBiNumber(n)
        : intlNumber(n, { maximumFractionDigits: decimals, minimumFractionDigits: decimals });
    return `${body}%`;
  }
  if (decimals !== undefined) {
    return intlNumber(n, { maximumFractionDigits: decimals, minimumFractionDigits: decimals });
  }
  return fmtBiNumber(n);
}

/**
 * Group rows by a category field, SUMMING the given value fields — so a
 * result with repeated categories (e.g. two "EU" rows) renders one slice /
 * bar / stage per category instead of duplicates. Value fields are coerced
 * to numbers; first-seen category order is preserved.
 */
export function aggregateByField(
  rows: Record<string, unknown>[],
  keyField: string,
  valueFields: string[],
): Record<string, unknown>[] {
  const order: string[] = [];
  const byKey = new Map<string, Record<string, unknown>>();
  for (const r of rows) {
    const k = String(r[keyField]);
    const existing = byKey.get(k);
    if (!existing) {
      const copy: Record<string, unknown> = { ...r };
      for (const f of valueFields) {
        const n = toBiNumber(r[f]);
        if (n !== null) copy[f] = n;
      }
      byKey.set(k, copy);
      order.push(k);
      continue;
    }
    for (const f of valueFields) {
      const add = toBiNumber(r[f]);
      if (add === null) continue;
      existing[f] = (toBiNumber(existing[f]) ?? 0) + add;
    }
  }
  return order.map((k) => byKey.get(k)!);
}

/**
 * Pivot long-format rows (x, series, value) into recharts' wide format:
 * one object per x with a numeric key per series (values summed).
 */
export function pivotSeries(
  rows: Record<string, unknown>[],
  xField: string,
  yField: string,
  seriesField: string,
): { data: Record<string, unknown>[]; series: string[] } {
  const series: string[] = [];
  const byX = new Map<string, Record<string, unknown>>();
  const xOrder: string[] = [];
  for (const r of rows) {
    const s = String(r[seriesField] ?? "—");
    if (!series.includes(s)) {
      if (series.length >= MAX_SERIES) continue;
      series.push(s);
    }
    const xKey = String(r[xField]);
    if (!byX.has(xKey)) {
      byX.set(xKey, { [xField]: r[xField] });
      xOrder.push(xKey);
    }
    const entry = byX.get(xKey)!;
    const v = Number(r[yField]);
    entry[s] = (Number(entry[s]) || 0) + (Number.isFinite(v) ? v : 0);
  }
  return { data: xOrder.map((x) => byX.get(x)!), series };
}

const WORDCLOUD_STOPWORDS = new Set(
  (
    "a an and are as at be by for from has have in is it its of on or that the to was were will with " +
    "this these those i you he she they we not but if then so than too very can just"
  ).split(" "),
);

/**
 * Word cloud. With no valueField, tokenizes the text-column values into words
 * and sizes by frequency (good for free text). With a valueField, treats each
 * distinct text value as a term weighted by the summed measure. Dependency-free.
 */
function WordCloud({
  rows,
  textField,
  valueField,
  fill,
  onElementClick,
}: {
  rows: Record<string, unknown>[];
  textField: string;
  valueField?: string;
  fill?: boolean;
  onElementClick?: (column: string, value: string) => void;
}) {
  const words = useMemo(() => {
    const weights = new Map<string, number>();
    const label = new Map<string, string>(); // lowercase key → display term
    if (valueField) {
      for (const r of rows) {
        const term = String(r[textField] ?? "").trim();
        if (!term) continue;
        const v = Number(r[valueField]);
        if (!Number.isFinite(v) || v <= 0) continue;
        const key = term.toLowerCase();
        weights.set(key, (weights.get(key) ?? 0) + v);
        if (!label.has(key)) label.set(key, term);
      }
    } else {
      for (const r of rows) {
        const raw = String(r[textField] ?? "");
        for (const tok of raw.split(/[^\p{L}\p{N}]+/u)) {
          const key = tok.toLowerCase();
          if (key.length < 3 || WORDCLOUD_STOPWORDS.has(key)) continue;
          weights.set(key, (weights.get(key) ?? 0) + 1);
          if (!label.has(key)) label.set(key, tok);
        }
      }
    }
    const arr = [...weights.entries()]
      .map(([key, weight]) => ({ key, weight, term: label.get(key) ?? key }))
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 60);
    // Deterministic shuffle so the layout is stable across renders.
    const shuffled = arr
      .map((w, i) => ({ w, r: ((i * 2654435761) % 100) / 100 }))
      .sort((a, b) => a.r - b.r)
      .map((x) => x.w);
    return shuffled;
  }, [rows, textField, valueField]);

  if (words.length === 0) {
    return (
      <div className="flex h-full w-full items-center justify-center px-4 text-center text-xs text-muted-foreground">
        No words to show — pick a text column with values.
      </div>
    );
  }

  const max = Math.max(...words.map((w) => w.weight));
  const min = Math.min(...words.map((w) => w.weight));
  const sizeFor = (weight: number) => {
    // sqrt scale, mapped to 12–46px so a few common words don't dominate.
    const t =
      max === min ? 0.5 : (Math.sqrt(weight) - Math.sqrt(min)) / (Math.sqrt(max) - Math.sqrt(min));
    return Math.round(12 + t * 34);
  };

  return (
    <div
      className={`${fill ? "h-full" : "h-56"} flex w-full flex-wrap items-center justify-center gap-x-3 gap-y-1 overflow-auto p-2`}
    >
      {words.map((w, i) => (
        <span
          key={w.key}
          onClick={onElementClick ? () => onElementClick(textField, w.term) : undefined}
          title={`${w.term}: ${w.weight}`}
          className={`font-semibold leading-tight ${onElementClick ? "cursor-pointer hover:underline" : ""}`}
          style={{
            fontSize: sizeFor(w.weight),
            color: PIE_COLORS[i % PIE_COLORS.length],
            opacity: 0.75 + 0.25 * (w.weight / max),
          }}
        >
          {w.term}
        </span>
      ))}
    </div>
  );
}

function BiChartRenderInner({
  chart,
  rows,
  large = false,
  fill = false,
  onElementClick,
  selectedValue,
}: {
  chart: ChartSpec;
  rows: Record<string, unknown>[];
  /** Enlarged dialog mode (60vh, bigger type). */
  large?: boolean;
  /** Fill the parent's height (dashboard widgets). Parent needs a real height. */
  fill?: boolean;
  /** Cross-filtering: called when a bar / slice is clicked. */
  onElementClick?: (column: string, value: string) => void;
  /** Currently cross-filtered value — used by the map to outline the pick. */
  selectedValue?: string | null;
}) {
  const gradientId = useId();
  const heightClass = fill ? "h-full" : large ? "h-[60vh]" : "h-56";
  const tickSize = large ? 12 : 11;
  /** Category-axis props for this chart's own labels — see categoryAxis. */
  const catAxis = (rows: Record<string, unknown>[], key: string) => {
    // leftMargin is for the CHART, not the axis — spreading it onto XAxis would
    // put an unknown attribute on an SVG element.
    const { leftMargin, ...axis } = categoryAxis(
      rows.map((r) => r?.[key]),
      tickSize,
    );
    return { axis, leftMargin };
  };
  const labelSize = large ? 12 : 11;
  // NOTE: design tokens in this project are raw oklch() values, not HSL
  // channels — so wrap with var() directly, never hsl(var(--token)).
  const tooltipStyle = {
    fontSize: tickSize,
    background: "var(--popover)",
    color: "var(--popover-foreground)",
    border: "1px solid var(--border)",
    borderRadius: 8,
    boxShadow: "0 4px 16px rgb(0 0 0 / 0.10)",
    padding: "6px 10px",
  } as const;
  const labelStyle = { color: "var(--popover-foreground)" } as const;
  const gridStroke = "var(--border)";
  const axisStroke = "var(--muted-foreground)";
  const primaryStroke = "var(--primary)";
  const tick = { fontSize: tickSize, fill: axisStroke } as const;
  const fmt = (v: unknown) => fmtBiValue(v, chart);
  const tooltipFmt = (v: unknown) => fmt(v);
  const clickable = Boolean(onElementClick);

  if (chart.type === "ontology") {
    // Renders from the stored spec — rows are irrelevant for this visual.
    //
    // GUARDED because the only boundary above this is the ROUTER's, which is
    // per route rather than per widget (router.tsx sets defaultErrorComponent).
    // A throw inside computeLayout is caught — the browser does not blank — but
    // the entire dashboard is replaced by a full-screen error card, and this
    // same component renders the PUBLIC share and embed pages. A spec stored by
    // an older build, or half-written, would take the whole dashboard down for
    // everyone holding the link rather than degrading one tile.
    if (!isOntologySpec(chart.spec)) {
      return (
        <div className="flex h-full items-center justify-center p-4 text-center text-xs text-muted-foreground">
          This ontology cannot be displayed — rebuild it from the BI builder.
        </div>
      );
    }
    return <OntologyGraph spec={chart.spec} large={large} fill={fill} />;
  }

  if (chart.type === "kpi") {
    const v = rows[0]?.[chart.valueField];
    const target = chart.targetField ? Number(rows[0]?.[chart.targetField]) : undefined;
    const num = Number(v);
    const deltaPct =
      target !== undefined && Number.isFinite(target) && target !== 0 && Number.isFinite(num)
        ? (num / target - 1) * 100
        : undefined;
    const centered = large || fill;
    return (
      <div
        className={`flex flex-col ${
          centered ? "h-full w-full items-center justify-center py-4" : "items-start py-3"
        }`}
      >
        <span
          className={`font-medium uppercase tracking-widest text-muted-foreground ${
            large ? "text-sm" : "text-[10px]"
          }`}
        >
          {chart.label || chart.valueField}
        </span>
        <span
          className={`mt-1 font-semibold tracking-tight text-foreground tabular-nums ${
            large ? "text-7xl" : fill ? "text-5xl" : "text-3xl"
          }`}
        >
          {fmt(v)}
        </span>
        {deltaPct !== undefined && (
          <span
            className={`mt-1.5 flex items-center gap-1 text-xs font-medium tabular-nums ${
              deltaPct >= 0
                ? "text-emerald-600 dark:text-emerald-400"
                : "text-red-600 dark:text-red-400"
            }`}
          >
            {deltaPct >= 0 ? "▲" : "▼"} {Math.abs(deltaPct).toFixed(1)}% vs target ({fmt(target)})
          </span>
        )}
      </div>
    );
  }

  if (chart.type === "gauge") {
    const v = Number(rows[0]?.[chart.valueField]);
    const target = chart.targetField ? Number(rows[0]?.[chart.targetField]) : undefined;
    return (
      <GaugeChart
        value={Number.isFinite(v) ? v : 0}
        target={target !== undefined && Number.isFinite(target) ? target : undefined}
        max={chart.max}
        label={chart.label || chart.valueField}
        format={chart}
      />
    );
  }

  if (chart.type === "heatmap") {
    return (
      <HeatmapGrid
        rows={rows}
        xField={chart.xField}
        yField={chart.yField}
        valueField={chart.valueField}
        onElementClick={onElementClick}
      />
    );
  }

  if (chart.type === "boxplot") {
    return <BoxPlot rows={rows} xField={chart.xField} yField={chart.yField} />;
  }

  if (chart.type === "wordcloud") {
    return (
      <WordCloud
        rows={rows}
        textField={chart.textField}
        valueField={chart.valueField}
        fill={fill}
        onElementClick={onElementClick}
      />
    );
  }

  if (chart.type === "matrix") {
    return (
      <MatrixTable
        rows={rows}
        rowField={chart.rowField}
        colField={chart.colField}
        valueField={chart.valueField}
        rowSubField={chart.rowSubField}
        condFormat={chart.condFormat}
        format={chart}
      />
    );
  }

  if (chart.type === "map" || chart.type === "bubblemap") {
    return (
      <BiGeoMap
        rows={rows}
        locationField={chart.locationField}
        valueField={chart.valueField}
        mode={chart.type === "map" ? "fill" : "bubble"}
        onElementClick={
          onElementClick ? (value) => onElementClick(chart.locationField, value) : undefined
        }
        selectedValue={selectedValue}
      />
    );
  }

  if (chart.type === "bar" || chart.type === "scolumn") {
    const seriesField = "seriesField" in chart ? chart.seriesField : undefined;
    const stacked = chart.type === "scolumn" ? true : chart.stacked;
    const pivoted = seriesField ? pivotSeries(rows, chart.xField, chart.yField, seriesField) : null;
    const barData = pivoted ? pivoted.data : aggregateByField(rows, chart.xField, [chart.yField]);
    const barCat = catAxis(barData, chart.xField);
    const handleClick = onElementClick
      ? (data: { payload?: Record<string, unknown> } | Record<string, unknown>) => {
          const payload =
            (data as { payload?: Record<string, unknown> }).payload ??
            (data as Record<string, unknown>);
          const v = payload?.[chart.xField];
          if (v !== undefined) onElementClick(chart.xField, String(v));
        }
      : undefined;
    return (
      <div className={`${heightClass} w-full`}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={barData}
            margin={{ top: 12, right: 12, left: barCat.leftMargin, bottom: 4 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} vertical={false} />
            {/* Every bar is a discrete category, so every bar needs its label —
                see categoryAxis. A line or area axis is different and is left
                to thin its own ticks. */}
            <XAxis
              dataKey={chart.xField}
              tick={tick}
              axisLine={false}
              tickLine={false}
              {...barCat.axis}
            />
            <YAxis tick={tick} axisLine={false} tickLine={false} tickFormatter={fmt} width={48} />
            <Tooltip
              contentStyle={tooltipStyle}
              labelStyle={labelStyle}
              itemStyle={labelStyle}
              formatter={tooltipFmt}
              cursor={{ fill: "var(--accent)", opacity: 0.35 }}
            />
            {(() => {
              const refY = refLineY(
                chart.refLine,
                barData,
                pivoted ? pivoted.series : [chart.yField],
              );
              return refY !== null ? (
                <ReferenceLine
                  y={refY}
                  stroke={REF_COLOR}
                  strokeDasharray="4 3"
                  label={{
                    value: chart.refLine?.label || (chart.refLine?.mode === "avg" ? "avg" : ""),
                    fontSize: 10,
                    fill: REF_COLOR,
                    position: "insideTopRight",
                  }}
                />
              ) : null;
            })()}
            {/* NOTE: recharts only discovers chart elements among direct
                children (arrays ok) — a React fragment hides them entirely,
                so multi-series children must be emitted as a keyed array. */}
            {pivoted ? (
              [
                <Legend
                  key="__legend"
                  iconType="circle"
                  iconSize={8}
                  wrapperStyle={{ fontSize: labelSize }}
                />,
                ...pivoted.series.map((s, i) => {
                  const color = PIE_COLORS[i % PIE_COLORS.length];
                  return (
                    <Bar
                      key={s}
                      dataKey={s}
                      fill={color}
                      stackId={stacked ? "stack" : undefined}
                      radius={
                        stacked
                          ? i === pivoted.series.length - 1
                            ? [5, 5, 0, 0]
                            : [0, 0, 0, 0]
                          : [5, 5, 0, 0]
                      }
                      maxBarSize={44}
                      onClick={handleClick}
                      cursor={clickable ? "pointer" : undefined}
                    >
                      {selectedValue != null &&
                        barData.map((d, idx) => (
                          <Cell
                            key={idx}
                            fill={color}
                            fillOpacity={selFillOpacity(d[chart.xField], selectedValue)}
                          />
                        ))}
                    </Bar>
                  );
                }),
              ]
            ) : (
              <Bar
                dataKey={chart.yField}
                fill={primaryStroke}
                radius={[5, 5, 0, 0]}
                maxBarSize={44}
                onClick={handleClick}
                cursor={clickable ? "pointer" : undefined}
              >
                {selectedValue != null &&
                  barData.map((d, idx) => (
                    <Cell
                      key={idx}
                      fill={primaryStroke}
                      fillOpacity={selFillOpacity(d[chart.xField], selectedValue)}
                    />
                  ))}
              </Bar>
            )}
          </BarChart>
        </ResponsiveContainer>
      </div>
    );
  }

  if (chart.type === "hbar") {
    const hbarData = aggregateByField(rows, chart.xField, [chart.yField]);
    const handleClick = onElementClick
      ? (data: { payload?: Record<string, unknown> }) => {
          const v = data?.payload?.[chart.xField];
          if (v !== undefined) onElementClick(chart.xField, String(v));
        }
      : undefined;
    return (
      <div className={`${heightClass} w-full`}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={hbarData}
            layout="vertical"
            margin={{ top: 8, right: 16, left: 8, bottom: 4 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} horizontal={false} />
            <XAxis
              type="number"
              tick={tick}
              axisLine={false}
              tickLine={false}
              tickFormatter={fmt}
            />
            <YAxis
              type="category"
              dataKey={chart.xField}
              tick={tick}
              axisLine={false}
              tickLine={false}
              width={96}
            />
            <Tooltip
              contentStyle={tooltipStyle}
              labelStyle={labelStyle}
              itemStyle={labelStyle}
              formatter={tooltipFmt}
              cursor={{ fill: "var(--accent)", opacity: 0.35 }}
            />
            <Bar
              dataKey={chart.yField}
              fill={primaryStroke}
              radius={[0, 5, 5, 0]}
              maxBarSize={22}
              onClick={handleClick}
              cursor={clickable ? "pointer" : undefined}
            >
              {selectedValue != null &&
                hbarData.map((d, idx) => (
                  <Cell
                    key={idx}
                    fill={primaryStroke}
                    fillOpacity={selFillOpacity(d[chart.xField], selectedValue)}
                  />
                ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    );
  }

  if (chart.type === "line") {
    const pivoted = chart.seriesField
      ? pivotSeries(rows, chart.xField, chart.yField, chart.seriesField)
      : null;
    // Analytics overlays apply to single-series lines only.
    let data = pivoted ? pivoted.data : aggregateByField(rows, chart.xField, [chart.yField]);
    let hasForecast = false;
    if (!pivoted) {
      if (chart.running) data = cumulative(data, chart.yField);
      if (chart.compare === "prior_period") {
        data = priorPeriodOverlay(data, chart.yField, "__prior");
      } else if (chart.compare === "prior_year") {
        data = priorYearOverlay(data, chart.xField, chart.yField, "__prior");
      }
      if (chart.trend) {
        const fit = linearFit(data.map((d) => Number(d[chart.yField])));
        if (fit) data = data.map((d, i) => ({ ...d, __trend: fit.slope * i + fit.intercept }));
      }
      if (chart.forecast && chart.forecast > 0) {
        const fc = forecastRows(data, chart.xField, chart.yField, chart.forecast);
        if (fc) {
          data = [...data, ...fc.rows];
          hasForecast = true;
        }
      }
    }
    const refY = refLineY(chart.refLine, data, pivoted ? pivoted.series : [chart.yField]);
    // Category clicks on the x-axis position cross-filter by the x value.
    const lineClick = onElementClick
      ? (state: { activeLabel?: string | number } | null) => {
          if (state && state.activeLabel !== undefined && state.activeLabel !== null) {
            onElementClick(chart.xField, String(state.activeLabel));
          }
        }
      : undefined;
    return (
      <div
        className={`${heightClass} w-full`}
        style={onElementClick ? { cursor: "pointer" } : undefined}
      >
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={data}
            margin={{ top: 12, right: 12, left: 0, bottom: 4 }}
            onClick={lineClick}
          >
            <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} vertical={false} />
            <XAxis dataKey={chart.xField} tick={tick} axisLine={false} tickLine={false} />
            <YAxis tick={tick} axisLine={false} tickLine={false} tickFormatter={fmt} width={48} />
            <Tooltip
              contentStyle={tooltipStyle}
              labelStyle={labelStyle}
              itemStyle={labelStyle}
              formatter={tooltipFmt}
            />
            {refY !== null && (
              <ReferenceLine
                y={refY}
                stroke={REF_COLOR}
                strokeDasharray="4 3"
                label={{
                  value: chart.refLine?.label || (chart.refLine?.mode === "avg" ? "avg" : ""),
                  fontSize: 10,
                  fill: REF_COLOR,
                  position: "insideTopRight",
                }}
              />
            )}
            {/* Vertical marker at the clicked x so the cross-filter source is
                visible on the line itself. */}
            {selectedValue != null &&
              (() => {
                const match = data.find((d) => String(d[chart.xField]) === selectedValue);
                return match ? (
                  <ReferenceLine
                    x={match[chart.xField] as string | number}
                    stroke="var(--foreground)"
                    strokeOpacity={0.55}
                    strokeDasharray="3 3"
                  />
                ) : null;
              })()}
            {!pivoted && chart.compare && (
              <Line
                type="monotone"
                dataKey="__prior"
                name={chart.compare === "prior_year" ? "prior year" : "prior period"}
                stroke="var(--muted-foreground)"
                strokeDasharray="5 4"
                strokeWidth={1.5}
                dot={false}
              />
            )}
            {!pivoted && chart.trend && (
              <Line
                type="linear"
                dataKey="__trend"
                name="trend"
                stroke="#d97706"
                strokeDasharray="6 4"
                strokeWidth={1.5}
                dot={false}
              />
            )}
            {/* Arrays, not fragments: recharts ignores fragment children. */}
            {!pivoted &&
              hasForecast && [
                <Line
                  key="__forecast"
                  type="monotone"
                  dataKey="__forecast"
                  name="forecast"
                  stroke={primaryStroke}
                  strokeDasharray="4 4"
                  strokeWidth={2}
                  dot={false}
                />,
                <Line
                  key="__lo"
                  type="monotone"
                  dataKey="__lo"
                  stroke="var(--muted-foreground)"
                  strokeDasharray="2 4"
                  strokeWidth={1}
                  dot={false}
                  legendType="none"
                />,
                <Line
                  key="__hi"
                  type="monotone"
                  dataKey="__hi"
                  stroke="var(--muted-foreground)"
                  strokeDasharray="2 4"
                  strokeWidth={1}
                  dot={false}
                  legendType="none"
                />,
              ]}
            {pivoted ? (
              [
                <Legend
                  key="__legend"
                  iconType="circle"
                  iconSize={8}
                  wrapperStyle={{ fontSize: labelSize }}
                />,
                ...pivoted.series.map((s, i) => (
                  <Line
                    key={s}
                    type="monotone"
                    dataKey={s}
                    stroke={PIE_COLORS[i % PIE_COLORS.length]}
                    strokeWidth={2.25}
                    dot={false}
                    activeDot={{ r: 4, strokeWidth: 0 }}
                  />
                )),
              ]
            ) : (
              <Line
                type="monotone"
                dataKey={chart.yField}
                stroke={primaryStroke}
                strokeWidth={2.5}
                dot={false}
                activeDot={{ r: 4, strokeWidth: 0 }}
              />
            )}
          </LineChart>
        </ResponsiveContainer>
      </div>
    );
  }

  if (chart.type === "area") {
    const pivoted = chart.seriesField
      ? pivotSeries(rows, chart.xField, chart.yField, chart.seriesField)
      : null;
    // Analytics overlays apply to single-series areas only (mirrors the line
    // chart) — running total and the prior-period/-year comparison.
    let data = pivoted ? pivoted.data : aggregateByField(rows, chart.xField, [chart.yField]);
    if (!pivoted) {
      if (chart.running) data = cumulative(data, chart.yField);
      if (chart.compare === "prior_period") {
        data = priorPeriodOverlay(data, chart.yField, "__prior");
      } else if (chart.compare === "prior_year") {
        data = priorYearOverlay(data, chart.xField, chart.yField, "__prior");
      }
    }
    const refY = refLineY(chart.refLine, data, pivoted ? pivoted.series : [chart.yField]);
    const areaClick = onElementClick
      ? (state: { activeLabel?: string | number } | null) => {
          if (state && state.activeLabel !== undefined && state.activeLabel !== null) {
            onElementClick(chart.xField, String(state.activeLabel));
          }
        }
      : undefined;
    return (
      <div
        className={`${heightClass} w-full`}
        style={onElementClick ? { cursor: "pointer" } : undefined}
      >
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart
            data={data}
            margin={{ top: 12, right: 12, left: 0, bottom: 4 }}
            onClick={areaClick}
          >
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={primaryStroke} stopOpacity={0.28} />
                <stop offset="100%" stopColor={primaryStroke} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} vertical={false} />
            <XAxis dataKey={chart.xField} tick={tick} axisLine={false} tickLine={false} />
            <YAxis tick={tick} axisLine={false} tickLine={false} tickFormatter={fmt} width={48} />
            <Tooltip
              contentStyle={tooltipStyle}
              labelStyle={labelStyle}
              itemStyle={labelStyle}
              formatter={tooltipFmt}
            />
            {refY !== null && (
              <ReferenceLine
                y={refY}
                stroke={REF_COLOR}
                strokeDasharray="4 3"
                label={{
                  value: chart.refLine?.label || (chart.refLine?.mode === "avg" ? "avg" : ""),
                  fontSize: 10,
                  fill: REF_COLOR,
                  position: "insideTopRight",
                }}
              />
            )}
            {/* Vertical marker at the clicked x so the cross-filter source is
                visible on the area itself. */}
            {selectedValue != null &&
              (() => {
                const match = data.find((d) => String(d[chart.xField]) === selectedValue);
                return match ? (
                  <ReferenceLine
                    x={match[chart.xField] as string | number}
                    stroke="var(--foreground)"
                    strokeOpacity={0.55}
                    strokeDasharray="3 3"
                  />
                ) : null;
              })()}
            {/* Prior-period/-year overlay drawn as a dashed, unfilled area so it
                reads as a comparison line inside the AreaChart. */}
            {!pivoted && chart.compare && (
              <Area
                type="monotone"
                dataKey="__prior"
                name={chart.compare === "prior_year" ? "prior year" : "prior period"}
                stroke="var(--muted-foreground)"
                strokeDasharray="5 4"
                strokeWidth={1.5}
                fill="none"
                dot={false}
              />
            )}
            {/* Arrays, not fragments: recharts ignores fragment children. */}
            {pivoted ? (
              [
                <Legend
                  key="__legend"
                  iconType="circle"
                  iconSize={8}
                  wrapperStyle={{ fontSize: labelSize }}
                />,
                ...pivoted.series.map((s, i) => (
                  <Area
                    key={s}
                    type="monotone"
                    dataKey={s}
                    stackId="stack"
                    stroke={PIE_COLORS[i % PIE_COLORS.length]}
                    strokeWidth={1.75}
                    fill={PIE_COLORS[i % PIE_COLORS.length]}
                    fillOpacity={0.25}
                  />
                )),
              ]
            ) : (
              <Area
                type="monotone"
                dataKey={chart.yField}
                stroke={primaryStroke}
                strokeWidth={2.5}
                fill={`url(#${gradientId})`}
              />
            )}
          </AreaChart>
        </ResponsiveContainer>
      </div>
    );
  }

  if (chart.type === "pie") {
    const pieData = aggregateByField(rows, chart.nameField, [chart.valueField]);
    return (
      <div className={`${heightClass} w-full`}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={pieData}
              dataKey={chart.valueField}
              nameKey={chart.nameField}
              cx="50%"
              cy="50%"
              innerRadius={large || fill ? "42%" : "38%"}
              outerRadius={large || fill ? "72%" : "68%"}
              paddingAngle={2}
              stroke="var(--card)"
              strokeWidth={2}
              // recharts' pie enter-animation can wedge and leave the chart
              // permanently empty (no sector paths) — render statically.
              isAnimationActive={false}
            >
              {pieData.map((r, i) => (
                <Cell
                  key={i}
                  fill={PIE_COLORS[i % PIE_COLORS.length]}
                  cursor={clickable ? "pointer" : undefined}
                  onClick={
                    onElementClick
                      ? () => onElementClick(chart.nameField, String(r[chart.nameField]))
                      : undefined
                  }
                />
              ))}
            </Pie>
            <Tooltip
              contentStyle={tooltipStyle}
              labelStyle={labelStyle}
              itemStyle={labelStyle}
              formatter={tooltipFmt}
            />
            <Legend
              iconType="circle"
              iconSize={8}
              wrapperStyle={{ fontSize: labelSize, color: axisStroke }}
            />
          </PieChart>
        </ResponsiveContainer>
      </div>
    );
  }

  if (chart.type === "combo") {
    // Hoisted so the axis can size itself from the SAME rows the bars use —
    // computing it twice would let the labels and the bars disagree.
    const comboData = aggregateByField(rows, chart.xField, [chart.barField, chart.lineField]);
    const comboCat = catAxis(comboData, chart.xField);
    const comboClick = onElementClick
      ? (state: { activeLabel?: string | number } | null) => {
          if (state && state.activeLabel !== undefined && state.activeLabel !== null) {
            onElementClick(chart.xField, String(state.activeLabel));
          }
        }
      : undefined;
    return (
      <div
        className={`${heightClass} w-full`}
        style={onElementClick ? { cursor: "pointer" } : undefined}
      >
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={comboData}
            margin={{ top: 12, right: 8, left: comboCat.leftMargin, bottom: 4 }}
            onClick={comboClick}
          >
            <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} vertical={false} />
            <XAxis
              dataKey={chart.xField}
              tick={tick}
              axisLine={false}
              tickLine={false}
              {...comboCat.axis}
            />
            <YAxis
              yAxisId="left"
              tick={tick}
              axisLine={false}
              tickLine={false}
              tickFormatter={fmt}
              width={48}
            />
            <YAxis
              yAxisId="right"
              orientation="right"
              tick={tick}
              axisLine={false}
              tickLine={false}
              tickFormatter={fmtBiNumber}
              width={44}
            />
            <Tooltip
              contentStyle={tooltipStyle}
              labelStyle={labelStyle}
              itemStyle={labelStyle}
              formatter={(v: unknown, name: unknown) =>
                name === chart.barField ? fmt(v) : fmtBiNumber(v)
              }
            />
            <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: labelSize }} />
            <Bar
              yAxisId="left"
              dataKey={chart.barField}
              fill={primaryStroke}
              radius={[5, 5, 0, 0]}
              maxBarSize={36}
            />
            <Line
              yAxisId="right"
              type="monotone"
              dataKey={chart.lineField}
              stroke="#F28E2B"
              strokeWidth={2.5}
              dot={false}
              activeDot={{ r: 4, strokeWidth: 0 }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    );
  }

  if (chart.type === "scatter") {
    // Points need real numbers on both axes — coerce string numerics.
    const points = rows.map((r) => ({
      ...r,
      [chart.xField]: toBiNumber(r[chart.xField]) ?? r[chart.xField],
      [chart.yField]: toBiNumber(r[chart.yField]) ?? r[chart.yField],
      ...(chart.sizeField
        ? { [chart.sizeField]: toBiNumber(r[chart.sizeField]) ?? r[chart.sizeField] }
        : {}),
    }));
    return (
      <div className={`${heightClass} w-full`}>
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart margin={{ top: 12, right: 12, left: 0, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} />
            <XAxis
              type="number"
              dataKey={chart.xField}
              name={chart.xField}
              tick={tick}
              axisLine={false}
              tickLine={false}
              tickFormatter={fmtBiNumber}
            />
            <YAxis
              type="number"
              dataKey={chart.yField}
              name={chart.yField}
              tick={tick}
              axisLine={false}
              tickLine={false}
              tickFormatter={fmt}
              width={48}
            />
            {chart.sizeField && (
              <ZAxis dataKey={chart.sizeField} name={chart.sizeField} range={[36, 420]} />
            )}
            <Tooltip
              contentStyle={tooltipStyle}
              labelStyle={labelStyle}
              itemStyle={labelStyle}
              cursor={{ strokeDasharray: "3 3", stroke: axisStroke }}
              formatter={(v: unknown, name: unknown) =>
                name === chart.yField ? fmt(v) : fmtBiNumber(v)
              }
            />
            <Scatter
              data={points}
              fill={primaryStroke}
              fillOpacity={0.65}
              cursor={onElementClick ? "pointer" : undefined}
              onClick={
                onElementClick
                  ? (pt: unknown) => {
                      // Cross-filter by the point's label column — the first
                      // string field that isn't one of the plotted axes.
                      const p = ((pt as { payload?: Record<string, unknown> })?.payload ??
                        pt) as Record<string, unknown>;
                      const entry = Object.entries(p).find(
                        ([k, v]) =>
                          typeof v === "string" &&
                          k !== chart.xField &&
                          k !== chart.yField &&
                          k !== chart.sizeField,
                      );
                      if (entry) onElementClick(entry[0], entry[1] as string);
                    }
                  : undefined
              }
            />
          </ScatterChart>
        </ResponsiveContainer>
      </div>
    );
  }

  if (chart.type === "funnel") {
    const funnelData = aggregateByField(rows, chart.nameField, [chart.valueField]);
    return (
      <div className={`${heightClass} w-full`}>
        <ResponsiveContainer width="100%" height="100%">
          <FunnelChart margin={{ top: 8, right: 96, left: 8, bottom: 8 }}>
            <Tooltip
              contentStyle={tooltipStyle}
              labelStyle={labelStyle}
              itemStyle={labelStyle}
              formatter={tooltipFmt}
            />
            <Funnel
              dataKey={chart.valueField}
              nameKey={chart.nameField}
              data={funnelData}
              isAnimationActive={false}
            >
              {funnelData.map((d, i) => (
                <Cell
                  key={i}
                  fill={PIE_COLORS[i % PIE_COLORS.length]}
                  cursor={onElementClick ? "pointer" : undefined}
                  onClick={
                    onElementClick
                      ? () => onElementClick(chart.nameField, String(d[chart.nameField]))
                      : undefined
                  }
                />
              ))}
              <LabelList
                dataKey={chart.nameField}
                position="right"
                fill={axisStroke}
                fontSize={labelSize}
                stroke="none"
              />
            </Funnel>
          </FunnelChart>
        </ResponsiveContainer>
      </div>
    );
  }

  if (chart.type === "waterfall") {
    let cum = 0;
    const wf = aggregateByField(rows, chart.xField, [chart.yField]).map((r) => {
      const v = Number(r[chart.yField]) || 0;
      const base = v >= 0 ? cum : cum + v;
      cum += v;
      return { name: String(r[chart.xField]), base, delta: Math.abs(v), value: v, cum };
    });
    return (
      <div className={`${heightClass} w-full`}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={wf} margin={{ top: 12, right: 12, left: 0, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} vertical={false} />
            <XAxis dataKey="name" tick={tick} axisLine={false} tickLine={false} />
            <YAxis tick={tick} axisLine={false} tickLine={false} tickFormatter={fmt} width={48} />
            <Tooltip
              contentStyle={tooltipStyle}
              labelStyle={labelStyle}
              itemStyle={labelStyle}
              formatter={(_v, _n, entry) => {
                const p = entry?.payload as { value: number; cum: number } | undefined;
                if (!p) return ["", ""];
                return [
                  `${p.value >= 0 ? "+" : ""}${fmt(p.value)} (running ${fmt(p.cum)})`,
                  "change",
                ];
              }}
            />
            <Bar dataKey="base" stackId="wf" fill="transparent" isAnimationActive={false} />
            {/* isAnimationActive must match the base bar — mixing an animated
                and a non-animated Bar in one stack can leave the animated one
                stuck at its initial (empty) frame. */}
            <Bar
              dataKey="delta"
              stackId="wf"
              radius={[3, 3, 0, 0]}
              maxBarSize={40}
              isAnimationActive={false}
            >
              {wf.map((d, i) => (
                <Cell
                  key={i}
                  fill={d.value >= 0 ? "#59A14F" : "#E15759"}
                  cursor={onElementClick ? "pointer" : undefined}
                  onClick={onElementClick ? () => onElementClick(chart.xField, d.name) : undefined}
                />
              ))}
            </Bar>
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    );
  }

  if (chart.type === "treemap") {
    const data = aggregateByField(rows, chart.nameField, [chart.valueField])
      .map((r) => ({
        name: String(r[chart.nameField] ?? "—"),
        size: Number(r[chart.valueField]) || 0,
      }))
      .filter((d) => d.size > 0);
    return (
      <div className={`${heightClass} w-full`}>
        <ResponsiveContainer width="100%" height="100%">
          <Treemap
            data={data}
            dataKey="size"
            nameKey="name"
            stroke="var(--card)"
            isAnimationActive={false}
            content={
              <TreemapCell
                selectedName={selectedValue}
                onCellClick={
                  onElementClick ? (name) => onElementClick(chart.nameField, name) : undefined
                }
              />
            }
          >
            <Tooltip
              contentStyle={tooltipStyle}
              labelStyle={labelStyle}
              itemStyle={labelStyle}
              formatter={(v: number) => [fmt(v), ""]}
            />
          </Treemap>
        </ResponsiveContainer>
      </div>
    );
  }

  if (chart.type === "shbar") {
    const pivoted = pivotSeries(rows, chart.xField, chart.yField, chart.seriesField);
    const handleClick = onElementClick
      ? (data: { payload?: Record<string, unknown> }) => {
          const v = data?.payload?.[chart.xField];
          if (v !== undefined) onElementClick(chart.xField, String(v));
        }
      : undefined;
    return (
      <div className={`${heightClass} w-full`}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={pivoted.data}
            layout="vertical"
            margin={{ top: 8, right: 16, left: 8, bottom: 4 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} horizontal={false} />
            <XAxis
              type="number"
              tick={tick}
              axisLine={false}
              tickLine={false}
              tickFormatter={fmt}
            />
            <YAxis
              type="category"
              dataKey={chart.xField}
              tick={tick}
              axisLine={false}
              tickLine={false}
              width={96}
            />
            <Tooltip
              contentStyle={tooltipStyle}
              labelStyle={labelStyle}
              itemStyle={labelStyle}
              formatter={tooltipFmt}
              cursor={{ fill: "var(--accent)", opacity: 0.35 }}
            />
            {[
              <Legend
                key="__legend"
                iconType="circle"
                iconSize={8}
                wrapperStyle={{ fontSize: labelSize }}
              />,
              ...pivoted.series.map((s, i) => {
                const color = PIE_COLORS[i % PIE_COLORS.length];
                return (
                  <Bar
                    key={s}
                    dataKey={s}
                    stackId="stack"
                    fill={color}
                    maxBarSize={26}
                    radius={i === pivoted.series.length - 1 ? [0, 5, 5, 0] : [0, 0, 0, 0]}
                    onClick={handleClick}
                    cursor={clickable ? "pointer" : undefined}
                  >
                    {selectedValue != null &&
                      pivoted.data.map((d, idx) => (
                        <Cell
                          key={idx}
                          fill={color}
                          fillOpacity={selFillOpacity(d[chart.xField], selectedValue)}
                        />
                      ))}
                  </Bar>
                );
              }),
            ]}
          </BarChart>
        </ResponsiveContainer>
      </div>
    );
  }

  if (chart.type === "radar") {
    const pivoted = chart.seriesField
      ? pivotSeries(rows, chart.xField, chart.yField, chart.seriesField)
      : null;
    const data = (
      pivoted ? pivoted.data : aggregateByField(rows, chart.xField, [chart.yField])
    ).slice(0, 12);
    return (
      <div className={`${heightClass} w-full`}>
        <ResponsiveContainer width="100%" height="100%">
          <RadarChart
            data={data}
            outerRadius="70%"
            margin={{ top: 8, right: 8, left: 8, bottom: 8 }}
          >
            <PolarGrid stroke={gridStroke} />
            <PolarAngleAxis
              dataKey={chart.xField}
              tick={{ fontSize: tickSize, fill: axisStroke }}
            />
            <PolarRadiusAxis
              tick={{ fontSize: 9, fill: axisStroke }}
              tickFormatter={fmtBiNumber}
              angle={90}
            />
            <Tooltip
              contentStyle={tooltipStyle}
              labelStyle={labelStyle}
              itemStyle={labelStyle}
              formatter={tooltipFmt}
            />
            {pivoted ? (
              [
                <Legend
                  key="__legend"
                  iconType="circle"
                  iconSize={8}
                  wrapperStyle={{ fontSize: labelSize }}
                />,
                ...pivoted.series.map((s, i) => (
                  <Radar
                    key={s}
                    name={s}
                    dataKey={s}
                    stroke={PIE_COLORS[i % PIE_COLORS.length]}
                    fill={PIE_COLORS[i % PIE_COLORS.length]}
                    fillOpacity={0.18}
                    strokeWidth={1.75}
                  />
                )),
              ]
            ) : (
              <Radar
                dataKey={chart.yField}
                stroke={primaryStroke}
                fill={primaryStroke}
                fillOpacity={0.3}
                strokeWidth={2}
              />
            )}
          </RadarChart>
        </ResponsiveContainer>
      </div>
    );
  }

  if (chart.type === "sankey") {
    const sankeyData = buildSankey(rows, chart.xField, chart.yField, chart.valueField);
    if (!sankeyData) {
      return (
        <p className="flex h-full items-center justify-center text-xs text-muted-foreground">
          No flows to plot.
        </p>
      );
    }
    return (
      <div className={`${heightClass} w-full`}>
        <ResponsiveContainer width="100%" height="100%">
          <Sankey
            data={{ nodes: sankeyData.nodes, links: sankeyData.links }}
            nodePadding={16}
            nodeWidth={10}
            margin={{ top: 10, right: 96, bottom: 10, left: 76 }}
            link={{ stroke: axisStroke, strokeOpacity: 0.15 }}
            node={
              <SankeyNode
                onElementClick={onElementClick}
                sourceField={chart.xField}
                targetField={chart.yField}
                boundary={sankeyData.srcCount}
              />
            }
          >
            <Tooltip
              contentStyle={tooltipStyle}
              labelStyle={labelStyle}
              itemStyle={labelStyle}
              formatter={(v: unknown) => fmt(v)}
            />
          </Sankey>
        </ResponsiveContainer>
      </div>
    );
  }

  if (chart.type === "barrace") {
    return (
      <BarRace
        rows={rows}
        xField={chart.xField}
        yField={chart.yField}
        timeField={chart.timeField}
        format={chart}
        onElementClick={onElementClick}
      />
    );
  }

  if (chart.type === "nightingale") {
    return (
      <NightingaleChart
        rows={rows}
        nameField={chart.nameField}
        valueField={chart.valueField}
        format={chart}
        onElementClick={onElementClick}
      />
    );
  }

  return null;
}

// ── Sankey helpers ─────────────────────────────────────────────────────────

/**
 * Turn (source, target, value) rows into recharts' {nodes, links} shape.
 * Source values become the left column, target values the right column — even
 * when a label appears in both — so the graph is always a bipartite DAG (no
 * cycles, which recharts' Sankey layout cannot resolve). Self-loops are dropped.
 */
function buildSankey(
  rows: Record<string, unknown>[],
  sourceField: string,
  targetField: string,
  valueField: string,
): {
  nodes: { name: string }[];
  links: { source: number; target: number; value: number }[];
  srcCount: number;
} | null {
  const linkAgg = new Map<string, number>();
  for (const r of rows) {
    const v = toBiNumber(r[valueField]);
    if (v === null || v <= 0) continue;
    const s = String(r[sourceField] ?? "—");
    const t = String(r[targetField] ?? "—");
    if (s === t) continue;
    const k = `${s}\u0001${t}`;
    linkAgg.set(k, (linkAgg.get(k) ?? 0) + v);
  }
  if (linkAgg.size === 0) return null;
  const srcVals: string[] = [];
  const tgtVals: string[] = [];
  const srcIdx = new Map<string, number>();
  const tgtIdx = new Map<string, number>();
  for (const key of linkAgg.keys()) {
    const [s, t] = key.split("\u0001");
    if (!srcIdx.has(s)) {
      srcIdx.set(s, srcVals.length);
      srcVals.push(s);
    }
    if (!tgtIdx.has(t)) {
      tgtIdx.set(t, tgtVals.length);
      tgtVals.push(t);
    }
  }
  const nodes = [...srcVals, ...tgtVals].map((name) => ({ name }));
  const links = [...linkAgg.entries()].map(([key, value]) => {
    const [s, t] = key.split("\u0001");
    return { source: srcIdx.get(s)!, target: srcVals.length + tgtIdx.get(t)!, value };
  });
  return { nodes, links, srcCount: srcVals.length };
}

/** Custom Sankey node: palette rect + outward label; clickable for cross-filter. */
function SankeyNode(props: {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  index?: number;
  payload?: { name?: string };
  onElementClick?: (column: string, value: string) => void;
  sourceField?: string;
  targetField?: string;
  boundary?: number;
}) {
  const {
    x = 0,
    y = 0,
    width = 0,
    height = 0,
    index = 0,
    payload,
    onElementClick,
    sourceField,
    targetField,
    boundary = 0,
  } = props;
  const isSource = index < boundary;
  const name = payload?.name ?? "";
  const label = name.length > 16 ? `${name.slice(0, 15)}…` : name;
  return (
    <Layer>
      <Rectangle
        x={x}
        y={y}
        width={width}
        height={Math.max(height, 1)}
        fill={PIE_COLORS[index % PIE_COLORS.length]}
        fillOpacity={0.9}
        radius={2}
        cursor={onElementClick ? "pointer" : undefined}
        onClick={
          onElementClick
            ? () => onElementClick(isSource ? (sourceField ?? "") : (targetField ?? ""), name)
            : undefined
        }
      />
      <text
        x={isSource ? x - 6 : x + width + 6}
        y={y + height / 2}
        textAnchor={isSource ? "end" : "start"}
        dominantBaseline="middle"
        fontSize={10}
        fill="var(--foreground)"
        style={{ pointerEvents: "none" }}
      >
        {label}
      </text>
    </Layer>
  );
}

/** Custom treemap cell: palette fill + readable label. White text carries a
 *  dark halo (paint-order stroke) so it stays legible over any palette colour,
 *  and the value is shown too when the box is tall enough. */
function TreemapCell(props: {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  index?: number;
  name?: string;
  /** recharts passes the node's sizing value through as `value`. */
  value?: number;
  size?: number;
  /** Currently cross-filtered cell name — outlined so the pick is obvious. */
  selectedName?: string | null;
  onCellClick?: (name: string) => void;
}) {
  const { x = 0, y = 0, width = 0, height = 0, index = 0, name = "", onCellClick } = props;
  if (width <= 0 || height <= 0) return null;
  const val = props.size ?? props.value;
  const selected = !!props.selectedName && props.selectedName === name;
  const dimmed = !!props.selectedName && !selected;
  const showLabel = width > 40 && height > 18;
  const showValue = val !== undefined && width > 56 && height > 34;
  // ~6.5px per char at 11px; leave an 12px gutter.
  const maxChars = Math.max(3, Math.floor((width - 12) / 6.5));
  const label = name.length > maxChars ? `${name.slice(0, Math.max(1, maxChars - 1))}…` : name;
  // Dark outline behind the glyphs — readable on light and dark fills alike.
  const halo = {
    paintOrder: "stroke" as const,
    stroke: "rgb(15 23 42 / 0.6)",
    strokeWidth: 3,
    strokeLinejoin: "round" as const,
  };
  return (
    <g
      onClick={onCellClick ? () => onCellClick(name) : undefined}
      cursor={onCellClick ? "pointer" : undefined}
    >
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        rx={3}
        fill={PIE_COLORS[index % PIE_COLORS.length]}
        fillOpacity={selected ? 1 : dimmed ? 0.4 : 0.92}
        stroke={selected ? "var(--foreground)" : "var(--card)"}
        strokeWidth={selected ? 2.5 : 2}
      />
      {showLabel && (
        <text
          x={x + 7}
          y={y + 16}
          fontSize={11}
          fontWeight={600}
          fill="#fff"
          style={{ pointerEvents: "none", ...halo }}
        >
          {label}
        </text>
      )}
      {showValue && (
        <text
          x={x + 7}
          y={y + 31}
          fontSize={10}
          fontWeight={500}
          fill="rgb(255 255 255 / 0.92)"
          style={{ pointerEvents: "none", ...halo }}
        >
          {fmtBiNumber(val)}
        </text>
      )}
    </g>
  );
}

// ── Public renderer: analytics wrapper (drill-down + date grain) ─────────
//
// Wraps the raw renderer with runtime interactions that work on snapshots
// everywhere (editor, shared view, public page): category drill-down with
// breadcrumbs for bar/hbar/pie/treemap, and a date-grain toggle for line/area.
export function BiChartRender({
  chart,
  rows,
  large = false,
  fill = false,
  onElementClick,
  selectedValue,
}: {
  chart: ChartSpec;
  rows: Record<string, unknown>[];
  large?: boolean;
  fill?: boolean;
  onElementClick?: (column: string, value: string) => void;
  /** Currently cross-filtered value — used by the map to outline the pick. */
  selectedValue?: string | null;
}) {
  const [drillPath, setDrillPath] = useState<DrillEntry[]>([]);
  const [grainOverride, setGrainOverride] = useState<"auto" | DateGrain | null>(null);

  const drillFields = (chart.drillFields ?? []).filter(Boolean);
  const drillable =
    (chart.type === "bar" ||
      chart.type === "hbar" ||
      chart.type === "pie" ||
      chart.type === "treemap") &&
    drillFields.length > 1;
  const isTime = chart.type === "line" || chart.type === "area";
  const xKey = "xField" in chart ? chart.xField : "nameField" in chart ? chart.nameField : null;
  const grain = grainOverride ?? chart.dateGrain ?? "auto";

  // Reset the drill when the widget's hierarchy changes.
  const drillKey = drillFields.join("|");
  useEffect(() => setDrillPath([]), [drillKey]);

  const showGrainToggle = useMemo(
    () => Boolean(isTime && xKey && isMostlyDates(rows, xKey)),
    [isTime, xKey, rows],
  );

  const { effChart, effRows } = useMemo(() => {
    let r = rows;
    let c: ChartSpec = chart;
    if (drillable && drillPath.length > 0) {
      r = drillRows(r, drillPath);
      const level = Math.min(drillPath.length, drillFields.length - 1);
      const f = drillFields[level];
      c =
        chart.type === "pie" || chart.type === "treemap"
          ? ({ ...chart, nameField: f } as ChartSpec)
          : ({ ...chart, xField: f } as ChartSpec);
    }
    if (isTime && xKey && showGrainToggle && grain !== "auto") {
      r = bucketRowsX(r, xKey, grain as DateGrain);
    }
    return { effChart: c, effRows: r };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chart, rows, drillable, drillPath, drillKey, isTime, xKey, showGrainToggle, grain]);

  const drillClick = drillable
    ? (column: string, value: string) => {
        if (drillPath.length < drillFields.length - 1) {
          setDrillPath((p) => [...p, { field: drillFields[p.length], value }]);
        } else {
          onElementClick?.(column, value);
        }
      }
    : onElementClick;

  const hasControls = drillable || showGrainToggle;
  const inner = (
    <BiChartRenderInner
      chart={effChart}
      rows={effRows}
      large={large}
      fill={fill}
      onElementClick={drillable || onElementClick ? drillClick : undefined}
      selectedValue={selectedValue}
    />
  );
  if (!hasControls) return inner;

  return (
    <div className={cn("flex w-full flex-col", fill && "h-full")}>
      <div className="flex h-5 shrink-0 items-center justify-between gap-2 overflow-hidden px-1 text-[10px]">
        {drillable ? (
          <div className="flex min-w-0 items-center gap-1 overflow-hidden whitespace-nowrap text-muted-foreground">
            <button
              type="button"
              className={cn(
                "hover:text-foreground",
                drillPath.length === 0 && "font-semibold text-foreground",
              )}
              onClick={() => setDrillPath([])}
            >
              All
            </button>
            {drillPath.map((p, i) => (
              <span key={i} className="flex items-center gap-1">
                <span className="text-muted-foreground/50">›</span>
                <button
                  type="button"
                  className={cn(
                    "max-w-28 truncate hover:text-foreground",
                    i === drillPath.length - 1 && "font-semibold text-foreground",
                  )}
                  onClick={() => setDrillPath(drillPath.slice(0, i + 1))}
                >
                  {p.value}
                </button>
              </span>
            ))}
            {drillPath.length < drillFields.length - 1 && (
              <span className="truncate text-muted-foreground/60">
                · click to drill into {drillFields[drillPath.length + 1]}
              </span>
            )}
          </div>
        ) : (
          <span />
        )}
        {showGrainToggle && (
          <div className="flex shrink-0 gap-0.5" title="Date grain">
            {(["auto", "day", "week", "month", "quarter", "year"] as const).map((g) => (
              <button
                key={g}
                type="button"
                onClick={() => setGrainOverride(g)}
                className={cn(
                  "rounded px-1 py-0.5 uppercase",
                  grain === g
                    ? "bg-primary/15 font-semibold text-primary"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {g === "auto" ? "auto" : g[0]}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="min-h-0 w-full flex-1">{inner}</div>
    </div>
  );
}
