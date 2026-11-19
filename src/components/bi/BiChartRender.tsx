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
import { forecastPeriods } from "@/lib/mlForecast";
import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  Brush,
  CartesianGrid,
  Cell,
  ComposedChart,
  Customized,
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
  ReferenceArea,
  ReferenceLine,
  Sankey,
  Scatter,
  ScatterChart,
  Tooltip,
  Treemap,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";
import { ResponsiveContainer } from "@/components/bi/biChartBox";
import {
  BarRace,
  BoxPlot,
  GaugeChart,
  HeatmapGrid,
  MatrixTable,
  NightingaleChart,
} from "@/components/bi/BiChartParts";
import { BiGeoMap } from "@/components/bi/BiGeoMap";
import { BiInsightBody } from "@/components/bi/BiInsight";
import { BiKpiTile } from "@/components/bi/BiKpiTile";
import { BiCards } from "@/components/bi/BiCards";
import { BiEndLabels } from "@/components/bi/BiEndLabels";
import { BiJourney } from "@/components/bi/BiJourney";
import { BiControlsVisual } from "@/components/bi/BiParamControls";
import { BiPointMap } from "@/components/bi/BiPointMap";
import { BiChartNotes } from "@/components/bi/BiChartNotes";
import {
  comboColor,
  comboSeries,
  lastPoints,
  legendPlacement,
  measureTileColor,
  movingAverage,
  percentShares,
  placeNotes,
  wordCloudSize,
  wordCloudTerms,
  type PlacedNote,
} from "@/components/bi/biDrawHelpers";
import { humanizeField } from "@/lib/biInsights";
import {
  BiCalendar,
  BiPareto,
  BiPictogram,
  BiSmallMultiples,
} from "@/components/bi/BiBreadthCharts";
import { BiBumpChart, BiRadialBars, BiRangeBars } from "@/components/bi/BiRankCharts";
import { OntologyGraph } from "@/components/bi/OntologyGraph";
import { unshownRows } from "@/lib/biChartFields";
import { measureDisplayName } from "@/lib/biFieldQuery";
import { isOntologySpec } from "@/lib/biOntology";
import type { BiNumberFormat, BiRefLine, ChartSpec } from "@/lib/biAgent";
import {
  autoDateGrain,
  bucketRowsX,
  labelRowsX,
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
import {
  fmtBiNumber,
  PIE_COLORS,
  categoryAxis,
  fmtBiValue,
  measureSeries,
  measuresAsSpokes,
  pivotSeries,
  seriesColors,
  scaleSpokes,
  aggregateByField,
  toBiNumber,
} from "./biChartData";

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
  const words = useMemo(
    () => wordCloudTerms(rows, textField, valueField),
    [rows, textField, valueField],
  );

  if (words.length === 0) {
    return (
      <div className="flex h-full w-full items-center justify-center px-4 text-center text-xs text-muted-foreground">
        No words to show — pick a text column with values.
      </div>
    );
  }

  const max = Math.max(...words.map((w) => w.weight));
  const min = Math.min(...words.map((w) => w.weight));
  // A square-root scale from 12 to 46px, so a few common words do not dominate.
  const sizeFor = (weight: number) => wordCloudSize(weight, min, max);

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
  // The chart's measured width (R505), so category labels are judged against
  // the card they are in rather than a typical one.
  const [boxW, setBoxW] = useState(0);
  const onBoxResize = (w: number) => setBoxW(Math.round(w / 8) * 8);
  const heightClass = fill ? "h-full" : large ? "h-[60vh]" : "h-56";
  const tickSize = large ? 12 : 11;
  /** Category-axis props for this chart's own labels — see categoryAxis. */
  const catAxis = (rows: Record<string, unknown>[], key: string) => {
    // leftMargin is for the CHART, not the axis — spreading it onto XAxis would
    // put an unknown attribute on an SVG element.
    // The plot is the card less the value axis and margins, and less the
    // legend when it sits to the right.
    const plotWidth =
      boxW > 0
        ? boxW -
          60 -
          (legendPlacement(chart.legend)?.layout === "vertical" ? Math.min(boxW * 0.34, 110) : 0)
        : undefined;
    const { leftMargin, ...axis } = categoryAxis(
      rows.map((r) => r?.[key]),
      tickSize,
      plotWidth,
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
  // More measures as their own series (R499); only names, de-duplicated.
  const extra = (Array.isArray(chart.extraMeasures) ? chart.extraMeasures : []).filter(
    (m): m is string =>
      typeof m === "string" && m.length > 0 && m !== ("yField" in chart ? chart.yField : ""),
  );
  // Several measures drawn as series are named in words ("Average profit"),
  // not by column key; a series split by a column keeps that column's values.
  const bySeriesField = "seriesField" in chart && Boolean(chart.seriesField);
  const seriesName = (s: string) => (!bySeriesField && extra.length ? measureDisplayName(s) : s);
  // R505: where the legend sits, or none at all.
  const legendAt = legendPlacement(chart.legend);
  const legendEl = (style?: CSSProperties, entries = 0) =>
    legendAt ? (
      <Legend
        key="__legend"
        iconType="circle"
        iconSize={8}
        {...legendAt}
        wrapperStyle={{
          fontSize: labelSize,
          // Beside the chart, a long list scrolls rather than running off the
          // card. Only a long one: a short list scrolled by a pixel of rounding.
          ...(legendAt.layout === "vertical"
            ? {
                maxWidth: "34%",
                paddingLeft: 8,
                lineHeight: "16px",
                ...(entries > 8 ? { maxHeight: "100%", overflowY: "auto" as const } : {}),
              }
            : {}),
          // Above the chart it hugs the top edge, leaving the band under it to
          // the notes (FOUND IN R505's UI test: the two shared one line).
          ...(legendAt.verticalAlign === "top" ? { top: 0 } : {}),
          ...style,
        }}
      />
    ) : null;
  // R505: notes pinned to points, with room above the chart for two rows.
  const notesTop = (notes: PlacedNote[], base: number) =>
    notes.length ? Math.max(base, 36) : base;
  const notesLayer = (notes: PlacedNote[]) =>
    notes.length ? (
      <Customized
        key="__notes"
        component={
          <BiChartNotes notes={notes} floor={legendAt?.verticalAlign === "top" ? 30 : 10} />
        }
      />
    ) : null;
  // R505: a 100% stack's tooltip gives each part's share and its value.
  const shareFmt = (
    v: unknown,
    name: unknown,
    item: { payload?: Record<string, unknown>; dataKey?: unknown },
  ) => {
    const share = toBiNumber(v);
    const raw = item?.payload?.[`__raw:${String(item?.dataKey ?? name)}`];
    return share === null ? "—" : `${share.toFixed(share < 10 ? 1 : 0)}% (${fmt(raw)})`;
  };
  const pctTick = (v: unknown) => `${toBiNumber(v) ?? 0}%`;

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
    // Plain, or the latest period against the one before (R498).
    return <BiKpiTile chart={chart} rows={rows} large={large} fill={fill} />;
  }

  if (chart.type === "insight") {
    return <BiInsightBody chart={chart} rows={rows} large={large} fill={fill} />;
  }

  // R500: cards, start→finish ranges, radial bars, rank over time.
  if (chart.type === "cards") {
    return (
      <div className={`${heightClass} w-full`}>
        <BiCards chart={chart} rows={rows} large={large} />
      </div>
    );
  }
  if (chart.type === "range") {
    return (
      <div className={`${heightClass} w-full`}>
        <BiRangeBars chart={chart} rows={rows} />
      </div>
    );
  }
  if (chart.type === "radialbar") {
    return (
      <div className={`${heightClass} w-full`}>
        <BiRadialBars chart={chart} rows={rows} />
      </div>
    );
  }
  if (chart.type === "bump") {
    return (
      <div className={`${heightClass} w-full`}>
        <BiBumpChart chart={chart} rows={rows} />
      </div>
    );
  }
  // R502: Pareto, calendar, small multiples, pictogram.
  if (chart.type === "pareto") {
    return (
      <div className={`${heightClass} w-full`}>
        <BiPareto chart={chart} rows={rows} onElementClick={onElementClick} />
      </div>
    );
  }
  if (chart.type === "calendar") {
    return (
      <div className={`${heightClass} w-full`}>
        <BiCalendar chart={chart} rows={rows} />
      </div>
    );
  }
  if (chart.type === "smallmultiples") {
    return (
      <div className={`${heightClass} w-full`}>
        <BiSmallMultiples chart={chart} rows={rows} />
      </div>
    );
  }
  if (chart.type === "pictogram") {
    return (
      <div className={`${heightClass} w-full`}>
        <BiPictogram chart={chart} rows={rows} />
      </div>
    );
  }
  // R501: points on a map, pins along a road, the dashboard's parameters.
  if (chart.type === "pointmap") {
    return (
      <div className={`${heightClass} w-full`}>
        <BiPointMap chart={chart} rows={rows} onElementClick={onElementClick} />
      </div>
    );
  }
  if (chart.type === "journey") {
    return (
      <div className={`${heightClass} w-full`}>
        <BiJourney chart={chart} rows={rows} />
      </div>
    );
  }
  if (chart.type === "controls") {
    return (
      <div className={`${heightClass} w-full`}>
        <BiControlsVisual chart={chart} />
      </div>
    );
  }

  if (chart.type === "gauge") {
    const v = Number(rows[0]?.[chart.valueField]);
    const target = chart.targetField ? Number(rows[0]?.[chart.targetField]) : undefined;
    // Same reading as the KPI above: a gauge is a single-value chart too.
    const gaugeOf = unshownRows(rows, chart.valueField);
    return (
      <GaugeChart
        value={Number.isFinite(v) ? v : 0}
        target={target !== undefined && Number.isFinite(target) ? target : undefined}
        max={chart.max}
        label={chart.label || humanizeField(chart.valueField)}
        format={chart}
        caveat={gaugeOf !== null ? `1 of ${gaugeOf} rows` : undefined}
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
        scale={chart.scale}
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
        extraMeasures={chart.extraMeasures}
        condFormat={chart.condFormat}
        columnFormats={chart.columnFormats}
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
        region={chart.region === "us" || chart.region === "world" ? chart.region : undefined}
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
    const pivoted = seriesField
      ? pivotSeries(rows, chart.xField, chart.yField, seriesField)
      : extra.length
        ? measureSeries(rows, chart.xField, [chart.yField, ...extra])
        : null;
    const barAgg = pivoted ? pivoted.data : aggregateByField(rows, chart.xField, [chart.yField]);
    // R505: a 100% stack draws each part as its share of the column.
    const barPct = Boolean(chart.percentStack && stacked && pivoted);
    const barRaw = barPct && pivoted ? percentShares(barAgg, pivoted.series) : barAgg;
    // A log axis has no place for zero or less (R502): those bars are left out.
    const barData =
      chart.logScale && !barPct
        ? barRaw.map((d) => {
            const out = { ...d };
            for (const k of pivoted ? pivoted.series : [chart.yField]) {
              const v = toBiNumber(out[k]);
              if (v !== null && v <= 0) out[k] = null;
            }
            return out;
          })
        : barRaw;
    const barCat = catAxis(barData, chart.xField);
    const barNotes = placeNotes(
      barData,
      chart.xField,
      pivoted ? pivoted.series : [chart.yField],
      chart.annotations,
      Boolean(stacked && pivoted),
    );
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
        <ResponsiveContainer width="100%" height="100%" onResize={onBoxResize}>
          <BarChart
            data={barData}
            margin={{
              top: notesTop(barNotes, 12),
              right: 12,
              left: barCat.leftMargin,
              bottom: 4,
            }}
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
            {barPct ? (
              <YAxis
                tick={tick}
                axisLine={false}
                tickLine={false}
                tickFormatter={pctTick}
                width={48}
                domain={[0, 100]}
                ticks={[0, 25, 50, 75, 100]}
              />
            ) : (
              <YAxis
                tick={tick}
                axisLine={false}
                tickLine={false}
                tickFormatter={fmt}
                width={48}
                // R502: a log axis for values spanning orders of magnitude; a bar
                // cannot start at zero on one, so it starts at the axis' floor.
                scale={chart.logScale ? "log" : "auto"}
                domain={chart.logScale ? ["auto", "auto"] : undefined}
                allowDataOverflow={chart.logScale || undefined}
              />
            )}
            {chart.zoomBar && (
              <Brush
                dataKey={chart.xField}
                height={18}
                stroke="var(--primary)"
                travellerWidth={8}
                tickFormatter={() => ""}
                // Its handles are sliders; without this they are read out as
                // "Min value: undefined", since the rows have no `name`.
                ariaLabel={`Shown range of ${chart.xField}`}
              />
            )}
            <Tooltip
              contentStyle={tooltipStyle}
              labelStyle={labelStyle}
              itemStyle={labelStyle}
              formatter={barPct ? shareFmt : tooltipFmt}
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
                legendEl(undefined, pivoted.series.length),
                ...pivoted.series.map((s, i) => {
                  const color = PIE_COLORS[i % PIE_COLORS.length];
                  return (
                    <Bar
                      key={s}
                      dataKey={s}
                      name={seriesName(s)}
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
            {/* After the bars, so the notes sit on top of them. */}
            {notesLayer(barNotes)}
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
    // Coloured from the rows (R500), each line is told apart by its own
    // colour, so a race's twenty drivers can all be drawn.
    const pivoted = chart.seriesField
      ? pivotSeries(
          rows,
          chart.xField,
          chart.yField,
          chart.seriesField,
          chart.colorField ? 40 : undefined,
        )
      : extra.length
        ? measureSeries(rows, chart.xField, [chart.yField, ...extra])
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
      // R502: the average of the last N points, beside the line it smooths.
      if (chart.movingAverage && chart.movingAverage > 1) {
        const ma = movingAverage(
          data.map((d) => toBiNumber(d[chart.yField])),
          chart.movingAverage,
        );
        data = data.map((d, i) => ({ ...d, __ma: ma[i] }));
      }
      if (forecastPeriods(chart.forecast) > 0) {
        const fc = forecastRows(data, chart.xField, chart.yField, chart.forecast ?? 0);
        if (fc) {
          data = [...data, ...fc.rows];
          hasForecast = true;
        }
      }
    }
    // A log axis cannot place zero or less (R502): those points are left out
    // rather than drawn at a made-up height.
    if (chart.logScale) {
      const keys = pivoted ? pivoted.series : [chart.yField, "__ma", "__trend"];
      data = data.map((d) => {
        const out = { ...d };
        for (const k of keys) {
          const v = toBiNumber(out[k]);
          if (v !== null && v <= 0) out[k] = null;
        }
        return out;
      });
    }
    const refY = refLineY(chart.refLine, data, pivoted ? pivoted.series : [chart.yField]);
    const lineNotes = placeNotes(
      data,
      chart.xField,
      pivoted ? pivoted.series : [chart.yField],
      chart.annotations,
      false,
    );
    const lineColors =
      chart.seriesField && chart.colorField
        ? seriesColors(rows, chart.seriesField, chart.colorField)
        : new Map<string, string>();
    // Room on the right for the names at the lines' ends, which were cut off
    // at the card's edge (FOUND IN R500's UI test): ~5.4px a 9px character.
    const lineRight =
      chart.endLabels && pivoted
        ? Math.min(
            150,
            16 + 5.4 * (Math.max(0, ...pivoted.series.map((s) => seriesName(s).length)) + 5),
          )
        : 12;
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
          <ComposedChart
            data={data}
            margin={{ top: notesTop(lineNotes, 12), right: lineRight, left: 0, bottom: 4 }}
            onClick={lineClick}
          >
            <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} vertical={false} />
            {/* A gap between ticks: 365 daily dates printed over each other. */}
            <XAxis
              dataKey={chart.xField}
              tick={tick}
              axisLine={false}
              tickLine={false}
              minTickGap={28}
            />
            <YAxis
              tick={tick}
              axisLine={false}
              tickLine={false}
              tickFormatter={fmt}
              width={48}
              scale={chart.logScale ? "log" : "auto"}
              domain={chart.logScale ? ["auto", "auto"] : undefined}
              allowDataOverflow={chart.logScale || undefined}
            />
            {chart.zoomBar && (
              <Brush
                dataKey={chart.xField}
                height={18}
                stroke="var(--primary)"
                travellerWidth={8}
                tickFormatter={() => ""}
                // Its handles are sliders; without this they are read out as
                // "Min value: undefined", since the rows have no `name`.
                ariaLabel={`Shown range of ${chart.xField}`}
              />
            )}
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
            {(chart.xBands ?? []).map((b, i) => (
              <ReferenceArea
                key={`band${i}`}
                x1={b.from}
                x2={b.to}
                fill="var(--foreground)"
                fillOpacity={0.06}
                stroke="none"
                label={
                  b.label
                    ? {
                        value: b.label,
                        position: "insideTop",
                        fontSize: 9,
                        fill: "var(--muted-foreground)",
                      }
                    : undefined
                }
              />
            ))}
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
            {!pivoted && chart.movingAverage && chart.movingAverage > 1 && (
              <Line
                type="monotone"
                dataKey="__ma"
                name={`${chart.movingAverage}-point average`}
                // Its own colour: in the line's colour it vanished into a
                // jagged daily series (FOUND IN R502's UI test).
                stroke="#F28E2B"
                strokeWidth={2.5}
                dot={false}
                connectNulls
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
                <Area
                  key="__band"
                  type="monotone"
                  dataKey="__band"
                  stroke="none"
                  fill={primaryStroke}
                  fillOpacity={0.12}
                  legendType="none"
                  tooltipType="none"
                  isAnimationActive={false}
                />,
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
                legendEl(undefined, pivoted.series.length),
                ...pivoted.series.map((s, i) => (
                  <Line
                    key={s}
                    type="monotone"
                    dataKey={s}
                    name={seriesName(s)}
                    stroke={lineColors.get(s) ?? PIE_COLORS[i % PIE_COLORS.length]}
                    strokeWidth={2.25}
                    dot={false}
                    activeDot={{ r: 4, strokeWidth: 0 }}
                  />
                )),
                chart.endLabels ? (
                  <Customized
                    key="__end_labels"
                    component={
                      <BiEndLabels
                        labels={lastPoints(
                          data,
                          chart.xField,
                          pivoted.series,
                          seriesName,
                          lineColors,
                        )}
                      />
                    }
                  />
                ) : null,
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
            {notesLayer(lineNotes)}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    );
  }

  if (chart.type === "area") {
    const pivoted = chart.seriesField
      ? pivotSeries(rows, chart.xField, chart.yField, chart.seriesField)
      : extra.length
        ? measureSeries(rows, chart.xField, [chart.yField, ...extra])
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
    // R505: stacked areas as shares of 100%, each x's parts filling the height.
    const areaPct = Boolean(chart.percentStack && pivoted);
    if (areaPct && pivoted) data = percentShares(data, pivoted.series);
    const refY = refLineY(chart.refLine, data, pivoted ? pivoted.series : [chart.yField]);
    const areaNotes = placeNotes(
      data,
      chart.xField,
      pivoted ? pivoted.series : [chart.yField],
      chart.annotations,
      Boolean(pivoted),
    );
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
            margin={{ top: notesTop(areaNotes, 12), right: 12, left: 0, bottom: 4 }}
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
            {areaPct ? (
              <YAxis
                tick={tick}
                axisLine={false}
                tickLine={false}
                tickFormatter={pctTick}
                width={48}
                domain={[0, 100]}
                ticks={[0, 25, 50, 75, 100]}
              />
            ) : (
              <YAxis tick={tick} axisLine={false} tickLine={false} tickFormatter={fmt} width={48} />
            )}
            <Tooltip
              contentStyle={tooltipStyle}
              labelStyle={labelStyle}
              itemStyle={labelStyle}
              formatter={areaPct ? shareFmt : tooltipFmt}
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
                legendEl(undefined, pivoted.series.length),
                ...pivoted.series.map((s, i) => (
                  <Area
                    key={s}
                    type="monotone"
                    dataKey={s}
                    name={seriesName(s)}
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
            {notesLayer(areaNotes)}
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
            {legendEl({ color: axisStroke }, pieData.length)}
          </PieChart>
        </ResponsiveContainer>
      </div>
    );
  }

  if (chart.type === "combo") {
    // R506: several bars and several lines. Hoisted so the axis can size
    // itself from the SAME rows the bars use — computing it twice would let
    // the labels and the bars disagree.
    const { bars: comboBars, lines: comboLines } = comboSeries(chart, rows);
    const comboData = aggregateByField(rows, chart.xField, [...comboBars, ...comboLines]);
    const comboCat = catAxis(comboData, chart.xField);
    const linesLeft = chart.lineAxis === "left";
    const lineKeys = new Set(comboLines);
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
        <ResponsiveContainer width="100%" height="100%" onResize={onBoxResize}>
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
            {!linesLeft && (
              <YAxis
                yAxisId="right"
                orientation="right"
                tick={tick}
                axisLine={false}
                tickLine={false}
                tickFormatter={fmtBiNumber}
                width={44}
              />
            )}
            <Tooltip
              contentStyle={tooltipStyle}
              labelStyle={labelStyle}
              itemStyle={labelStyle}
              // Lines on their own axis are another unit (a count beside
              // revenue), so they are not given the bars' currency.
              formatter={(v: unknown, _n: unknown, item: { dataKey?: unknown }) =>
                !linesLeft && lineKeys.has(String(item?.dataKey)) ? fmtBiNumber(v) : fmt(v)
              }
            />
            {[
              legendEl(undefined, comboBars.length + comboLines.length),
              ...comboBars.map((m, i) => (
                <Bar
                  key={`bar:${m}`}
                  yAxisId="left"
                  dataKey={m}
                  name={measureDisplayName(m)}
                  fill={comboColor("bar", i, comboBars.length)}
                  stackId={chart.stackBars ? "bars" : undefined}
                  radius={chart.stackBars && i < comboBars.length - 1 ? [0, 0, 0, 0] : [5, 5, 0, 0]}
                  maxBarSize={chart.stackBars ? 36 : Math.max(14, 36 - 6 * (comboBars.length - 1))}
                />
              )),
              ...comboLines.map((m, i) => (
                <Line
                  key={`line:${m}`}
                  yAxisId={linesLeft ? "left" : "right"}
                  type="monotone"
                  dataKey={m}
                  name={measureDisplayName(m)}
                  stroke={comboColor("line", i, comboBars.length)}
                  strokeWidth={2.5}
                  dot={false}
                  activeDot={{ r: 4, strokeWidth: 0 }}
                />
              )),
            ]}
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
    // R505: a second measure colours each tile; a #rrggbb column, its own.
    const tileMeasure = chart.colorMeasure || "";
    const tileHex =
      chart.colorField && !tileMeasure
        ? seriesColors(rows, chart.nameField, chart.colorField)
        : new Map<string, string>();
    const sized = aggregateByField(
      rows,
      chart.nameField,
      tileMeasure ? [chart.valueField, tileMeasure] : [chart.valueField],
    )
      .map((r) => ({
        name: String(r[chart.nameField] ?? "—"),
        size: Number(r[chart.valueField]) || 0,
        colorValue: tileMeasure ? toBiNumber(r[tileMeasure]) : null,
      }))
      .filter((d) => d.size > 0);
    const shades = sized.map((d) => d.colorValue).filter((v): v is number => v !== null);
    const tileRange = { min: Math.min(...shades, 0), max: Math.max(...shades, 0) };
    if (chart.scale !== "diverging" && shades.length) {
      // Low to high runs across the values there are, not from zero.
      tileRange.min = Math.min(...shades);
      tileRange.max = Math.max(...shades);
    }
    // A colour measure the rows do not carry leaves the palette, not grey tiles.
    const data = sized.map((d) => ({
      ...d,
      tileColor:
        tileMeasure && shades.length
          ? measureTileColor(d.colorValue, tileRange, chart.scale, chart.lowerIsBetter === true)
          : tileHex.get(d.name),
    }));
    return (
      <div className={`${heightClass} flex w-full flex-col`}>
        <div className="min-h-0 flex-1">
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
                formatter={(
                  v: number,
                  _n: unknown,
                  item: { payload?: { colorValue?: unknown; name?: unknown } },
                ) => [
                  tileMeasure && item?.payload?.colorValue != null
                    ? `${fmt(v)} · ${measureDisplayName(tileMeasure)} ${fmtBiNumber(item.payload.colorValue)}`
                    : fmt(v),
                  // The tile's name: the tooltip said only ": 452.0k" (R505's UI test).
                  typeof item?.payload?.name === "string" ? item.payload.name : "",
                ]}
              />
            </Treemap>
          </ResponsiveContainer>
        </div>
        {tileMeasure && shades.length > 0 && (
          <TileScaleKey
            label={measureDisplayName(tileMeasure)}
            range={tileRange}
            scale={chart.scale}
            lowerIsBetter={chart.lowerIsBetter === true}
            fmt={fmtBiNumber}
          />
        )}
      </div>
    );
  }

  if (chart.type === "shbar") {
    const pivoted = pivotSeries(rows, chart.xField, chart.yField, chart.seriesField);
    // R505: each bar as 100%, split into its parts' shares.
    const shPct = chart.percentStack === true;
    const shData = shPct ? percentShares(pivoted.data, pivoted.series) : pivoted.data;
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
            data={shData}
            layout="vertical"
            margin={{ top: 8, right: 16, left: 8, bottom: 4 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} horizontal={false} />
            <XAxis
              type="number"
              tick={tick}
              axisLine={false}
              tickLine={false}
              tickFormatter={shPct ? pctTick : fmt}
              domain={shPct ? [0, 100] : undefined}
              ticks={shPct ? [0, 25, 50, 75, 100] : undefined}
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
              formatter={shPct ? shareFmt : tooltipFmt}
              cursor={{ fill: "var(--accent)", opacity: 0.35 }}
            />
            {[
              legendEl(undefined, pivoted.series.length),
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
                      shData.map((d, idx) => (
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
    // Several measures make the spokes, one polygon per category (R499).
    const spokes =
      !chart.seriesField && extra.length
        ? measuresAsSpokes(rows, chart.xField, [chart.yField, ...extra], measureDisplayName)
        : null;
    const pivoted = spokes
      ? spokes
      : chart.seriesField
        ? pivotSeries(rows, chart.xField, chart.yField, chart.seriesField)
        : null;
    const angleKey = spokes ? spokes.spokeKey : chart.xField;
    // Measures as spokes are different units, so each spoke is on its own
    // scale (the rim is that spoke's largest value) and the tooltip shows the
    // actual figure; the radius axis then has no single scale to label.
    const data = (
      spokes
        ? scaleSpokes(spokes.data, spokes.series)
        : pivoted
          ? pivoted.data
          : aggregateByField(rows, chart.xField, [chart.yField])
    ).slice(0, 12);
    const radarTooltip = spokes
      ? (v: unknown, name: unknown, item: { payload?: Record<string, unknown> }) =>
          fmt(item?.payload?.[`__raw:${String(name)}`] ?? v)
      : tooltipFmt;
    return (
      <div className={`${heightClass} w-full`}>
        <ResponsiveContainer width="100%" height="100%">
          <RadarChart
            data={data}
            outerRadius="70%"
            margin={{ top: 8, right: 8, left: 8, bottom: 8 }}
          >
            <PolarGrid stroke={gridStroke} />
            <PolarAngleAxis dataKey={angleKey} tick={{ fontSize: tickSize, fill: axisStroke }} />
            <PolarRadiusAxis
              tick={spokes ? false : { fontSize: 9, fill: axisStroke }}
              tickFormatter={fmtBiNumber}
              angle={90}
              domain={spokes ? [0, 100] : undefined}
              axisLine={!spokes}
            />
            <Tooltip
              contentStyle={tooltipStyle}
              labelStyle={labelStyle}
              itemStyle={labelStyle}
              formatter={radarTooltip}
            />
            {pivoted ? (
              [
                legendEl(undefined, pivoted.series.length),
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
        topN={chart.topN}
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
  /** The tile's own colour (R505): from a second measure or a colour column. */
  tileColor?: string;
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
        fill={props.tileColor || PIE_COLORS[index % PIE_COLORS.length]}
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

/** The scale under a treemap coloured by a measure (R505): what the colours mean. */
function TileScaleKey({
  label,
  range,
  scale,
  lowerIsBetter,
  fmt,
}: {
  label: string;
  range: { min: number; max: number };
  scale?: "sequential" | "diverging";
  lowerIsBetter: boolean;
  fmt: (v: unknown) => string;
}) {
  const stops =
    scale === "diverging"
      ? [range.min, range.min / 2, 0, range.max / 2, range.max]
      : [0, 0.25, 0.5, 0.75, 1].map((t) => range.min + t * (range.max - range.min));
  const colors = stops.map((v) => measureTileColor(v, range, scale, lowerIsBetter));
  return (
    <div className="flex shrink-0 items-center gap-2 pt-1.5 text-[10px] text-muted-foreground">
      <span className="truncate">Colour: {label}</span>
      <span className="tabular-nums">{fmt(range.min)}</span>
      <span
        aria-hidden
        className="h-2 w-24 shrink-0 rounded-full"
        style={{ background: `linear-gradient(to right, ${colors.join(", ")})` }}
      />
      <span className="tabular-nums">{fmt(range.max)}</span>
    </div>
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
  onDrillChange,
  selectedValue,
}: {
  chart: ChartSpec;
  rows: Record<string, unknown>[];
  large?: boolean;
  fill?: boolean;
  onElementClick?: (column: string, value: string) => void;
  /** Currently cross-filtered value — used by the map to outline the pick. */
  selectedValue?: string | null;
  /**
   * Reports the drill path outward on every change.
   *
   * The path is local state because the drill is a view concern, but
   * drill-through needs it: "explore the rows behind this" means the rows
   * behind what you are LOOKING at, two levels in — not behind the widget's
   * top level. Without this the explore dialog could only ever see the
   * dashboard's cross-filter.
   */
  onDrillChange?: (path: DrillEntry[]) => void;
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

  // Held in a ref so a parent that re-creates its callback each render cannot
  // turn "report the path" into a render loop.
  const drillCb = useRef(onDrillChange);
  useEffect(() => {
    drillCb.current = onDrillChange;
  }, [onDrillChange]);
  useEffect(() => {
    drillCb.current?.(drillPath);
  }, [drillPath]);

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
    const regroups = isTime && xKey && showGrainToggle && grain !== "auto";
    if (regroups) {
      r = bucketRowsX(r, xKey, grain as DateGrain);
    } else if (xKey && (grain === "auto" || !isTime)) {
      // Auto: make the axis readable without changing what it reports. This
      // runs for every chart type, not just the two that offer the toggle —
      // a column chart over a timestamp has no toggle to rescue it. A grain
      // stored on a chart that cannot regroup by one (a combo, small
      // multiples) is not a reason to leave its timestamps raw (R507).
      const auto = autoDateGrain(r, xKey);
      if (auto) r = labelRowsX(r, xKey, auto);
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
