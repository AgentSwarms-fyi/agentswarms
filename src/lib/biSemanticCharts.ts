// The chart a governed widget draws, from the metrics and dimensions it asked
// the compiler for (R507).
//
// A governed widget never names a column: the compiler returns one column per
// dimension and one per metric, named as declared, so the chart can be built
// from the query alone. Until R507 that covered six shapes, so the governed
// half of "Generate Entire Dashboard" and the builder's governed metrics could
// draw no pareto, pivot, combo, map or calendar.
//
// Each shape needs a certain number of dimensions and metrics. The planner's
// suggestions are held to that (lib/biGenerateSemantic); the builder can hand
// anything over, so a shape the query cannot fill falls back to the nearest
// one that it can, rather than to an empty frame.
import type { ChartSpec } from "@/lib/biAgent";
import type { SemanticChartType } from "@/lib/biDashboards";
import { dateLikeColumns } from "@/lib/biPeriods";

export function semanticChartSpec(args: {
  chartType: SemanticChartType;
  metrics: string[];
  dimensions: string[];
  columns: string[];
  rows: Record<string, unknown>[];
  /** Dimensions rolled up by a grain are time axes. */
  grains?: Record<string, string>;
}): ChartSpec {
  const dims = args.dimensions;
  const mets = args.metrics;
  const dim0 = dims[0] ?? args.columns[0];
  const dim1 = dims[1];
  const met0 = mets[0] ?? args.columns[dims.length] ?? args.columns[0];
  const more = mets.slice(1);
  const isTime = (d: string | undefined) =>
    !!d && (!!args.grains?.[d] || dateLikeColumns(args.columns, args.rows).includes(d));
  // Nothing to group by: the one number is the chart.
  const single = (): ChartSpec => ({ type: "kpi", valueField: met0 });
  const bars = (): ChartSpec =>
    dims.length === 0 ? single() : { type: "bar", xField: dim0, yField: met0 };

  switch (args.chartType) {
    case "kpi":
      // One time dimension makes a period KPI: the latest period, its change
      // on the one before, and the line of periods behind it (R498).
      return dims.length === 1 && isTime(dim0)
        ? { type: "kpi", valueField: met0, dateField: dim0, sparkline: true }
        : single();
    case "gauge":
      return { type: "gauge", valueField: met0 };
    case "insight":
      if (dims.length === 0) return single();
      return isTime(dim0)
        ? { type: "insight", kind: "change", valueField: met0, dateField: dim0 }
        : { type: "insight", kind: "top", valueField: met0, categoryField: dim0 };
    case "pie":
    case "nightingale":
    case "funnel":
    case "radialbar":
      return dims.length === 0
        ? single()
        : { type: args.chartType, nameField: dim0, valueField: met0 };
    case "treemap":
      return dims.length === 0
        ? single()
        : {
            type: "treemap",
            nameField: dim0,
            valueField: met0,
            // A second metric colours the tiles: sized by sales, coloured by margin.
            ...(more[0] ? { colorMeasure: more[0] } : {}),
          };
    case "pareto":
    case "pictogram":
      return dims.length === 0
        ? single()
        : { type: args.chartType, categoryField: dim0, valueField: met0 };
    case "waterfall":
      return dims.length === 0 ? single() : { type: "waterfall", xField: dim0, yField: met0 };
    case "wordcloud":
      return dims.length === 0
        ? single()
        : { type: "wordcloud", textField: dim0, valueField: met0 };
    case "map":
    case "bubblemap":
      return dims.length === 0
        ? single()
        : { type: args.chartType, locationField: dim0, valueField: met0 };
    case "calendar":
      return isTime(dim0) ? { type: "calendar", dateField: dim0, valueField: met0 } : bars();
    case "bar":
    case "line":
    case "area":
    case "hbar": {
      if (dims.length === 0) return single();
      const type = args.chartType;
      if (dim1 && type !== "hbar") {
        return { type, xField: dim0, yField: met0, seriesField: dim1 };
      }
      return {
        type,
        xField: dim0,
        yField: met0,
        // More metrics are more series (R499) when nothing else splits the chart.
        ...(more.length ? { extraMeasures: more } : {}),
      } as ChartSpec;
    }
    case "scolumn":
    case "shbar":
      if (dims.length === 0) return single();
      return dim1
        ? { type: args.chartType, xField: dim0, yField: met0, seriesField: dim1 }
        : { type: args.chartType === "scolumn" ? "bar" : "hbar", xField: dim0, yField: met0 };
    case "combo":
      if (dims.length === 0) return single();
      return more.length
        ? {
            type: "combo",
            xField: dim0,
            barField: met0,
            lineField: more[0],
            ...(more.length > 1 ? { extraMeasures: more.slice(1) } : {}),
          }
        : bars();
    case "scatter":
      return more.length
        ? {
            type: "scatter",
            xField: met0,
            yField: more[0],
            ...(more[1] ? { sizeField: more[1] } : {}),
          }
        : bars();
    case "radar":
      if (dims.length === 0) return single();
      return {
        type: "radar",
        xField: dim0,
        yField: met0,
        ...(dim1 ? { seriesField: dim1 } : more.length ? { extraMeasures: more } : {}),
      } as ChartSpec;
    case "heatmap":
      return dim1 ? { type: "heatmap", xField: dim0, yField: dim1, valueField: met0 } : bars();
    case "sankey":
      return dim1 ? { type: "sankey", xField: dim0, yField: dim1, valueField: met0 } : bars();
    case "smallmultiples":
      return dim1
        ? {
            type: "smallmultiples",
            xField: dim0,
            yField: met0,
            splitField: dim1,
            kind: isTime(dim0) ? "line" : "bar",
          }
        : bars();
    case "matrix":
      if (!dim1) return { type: "table" };
      // The first dimension is the rows, the second the columns, and a third
      // nests under the rows.
      return {
        type: "matrix",
        rowField: dim0,
        colField: dim1,
        ...(dims[2] ? { rowSubField: dims[2] } : {}),
        valueField: met0,
        ...(more.length ? { extraMeasures: more } : {}),
      } as ChartSpec;
    default:
      return { type: "table" };
  }
}
