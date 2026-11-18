// Every visual a model may choose, described once (R507).
//
// Four places ask a model for a chart: the chart step after a query runs
// (dashboard generation, reports, the AI Analyst and Visual BI in chat all
// go through it), the dashboard planner that names a visual before any SQL
// exists, the governed planner, and the public embed's chat. Each carried its
// own list. The chart step's stopped growing at the word cloud while the
// builder gained a pareto, a calendar, small multiples, pictograms, US state
// maps and pivots with several measures, so nothing generated could ever be
// one of them. The embed offered six types in all.
//
// So the list lives here, and the prompts are built from it. A test holds it
// against the visual picker: a visual the builder offers is either in this
// catalogue or named in NOT_GENERATED with the reason.
//
// The second half is the guard on what comes back. A model answers in
// vocabulary — "column", "donut", "choropleth", "small_multiples" — and with
// option values it made up. `normalizeChartSpec` maps the vocabulary onto the
// types the renderer draws, keeps the options whose values are real, and
// turns a type nobody draws into a chart that will draw rather than an empty
// frame. Which COLUMNS a chart names is checked afterwards, against the rows,
// by reconcileChartFields.
import type { BiInsightKind, BiPictogramIcon, ChartSpec } from "@/lib/biAgent";
import { numericColumns } from "@/lib/biChartFields";
import { dateLikeColumns } from "@/lib/biPeriods";

export type ChartTypeId = ChartSpec["type"];

export type CatalogEntry = {
  type: ChartTypeId;
  /** The fields, as the chart step's prompt shows them. */
  fields: string;
  /** When to choose it, written for the chart step. */
  when: string;
  /** The question shape it needs, written for the dashboard planner. */
  plan: string;
};

/**
 * Visuals the builder offers that a model is never asked for, and why. Kept
 * beside the catalogue so a new visual has to land in one or the other.
 */
export const NOT_GENERATED: Partial<Record<ChartTypeId, string>> = {
  controls: "Draws the dashboard's parameters; it has no query and no rows to choose it from.",
  ontology: "Drawn from the ontology's graph, not from a query result.",
};

export const CHART_CATALOG: CatalogEntry[] = [
  {
    type: "kpi",
    fields:
      "{ valueField, label? } — or, when the rows are the measure per period, " +
      '{ valueField, dateField, compareTo?: "previous"|"year", sparkline: true, lowerIsBetter? }',
    when:
      "one headline value; with a date column, the latest period against the one before " +
      '(compareTo "year" for the same period a year earlier) and a trend line. lowerIsBetter ' +
      "for costs, churn and defects",
    plan: "a headline number (2-4 of them)",
  },
  {
    type: "gauge",
    fields: "{ valueField, targetField?, max? }",
    when: "one value against a target or a ceiling: utilisation, attainment, a score out of 100",
    plan: "one value against a target or a maximum",
  },
  {
    type: "insight",
    fields:
      '{ kind: "top"|"bottom"|"change"|"forecast"|"anomaly"|"growth"|"movers", valueField, ' +
      "categoryField?, dateField? }",
    when:
      "one or two sentences computed from the rows. top/bottom rank categoryField; " +
      "change/forecast/anomaly/growth read dateField; movers needs both",
    plan: "a narrative sentence computed from the data",
  },
  {
    type: "bar",
    fields: "{ xField, yField, seriesField?, stacked?, extraMeasures? }",
    when:
      "compare categories. seriesField splits by a second category (stacked: true stacks " +
      "it); extraMeasures adds more measure columns as their own bars",
    plan: "a measure by a category",
  },
  {
    type: "hbar",
    fields: "{ xField, yField, extraMeasures? }",
    when: "rankings, and categories with long names",
    plan: "a ranking of a category by a measure",
  },
  {
    type: "scolumn",
    fields: "{ xField, yField, seriesField, percentStack? }",
    when:
      "stacked columns: the parts of a total per category. percentStack: true draws each " +
      "column as shares of 100%, to compare the mix across categories of different sizes",
    plan: "parts of a total across a category and a second dimension",
  },
  {
    type: "shbar",
    fields: "{ xField, yField, seriesField, percentStack? }",
    when: "the same as scolumn, as horizontal bars",
    plan: "parts of a total across a category and a second dimension, as bars",
  },
  {
    type: "line",
    fields:
      "{ xField, yField, seriesField?, extraMeasures?, endLabels?, movingAverage?, trend?, " +
      'forecast?, zoomBar?, logScale?, dateGrain?: "day"|"week"|"month"|"quarter"|"year" }',
    when:
      "a measure over time. seriesField draws a line per category (endLabels: true names " +
      "each at its end); extraMeasures draws more measures as their own lines; movingAverage: " +
      "N smooths a noisy single series (7 for daily data); trend: true adds a trend line; " +
      "forecast: N projects N periods ahead; zoomBar: true for a long series (over about 60 " +
      "points); logScale: true when values span orders of magnitude",
    plan: "a measure over a date",
  },
  {
    type: "area",
    fields:
      '{ xField, yField, seriesField?, percentStack?, dateGrain?: "day"|"week"|"month"|"quarter"|"year" }',
    when:
      "volume over time. With seriesField, percentStack: true shows the mix over time as " +
      "shares of 100%",
    plan: "a measure over a date, or its mix over time",
  },
  {
    type: "combo",
    fields:
      '{ xField, barField, lineField, extraMeasures?, extraLines?, stackBars?, lineAxis?: "left"|"right" }',
    when:
      "two or more measures over one dimension, on different scales (revenue as bars, margin " +
      "as a line). extraMeasures adds measures as bars; extraLines names those of them drawn " +
      'as lines; stackBars stacks the bars; lineAxis "left" when the lines share the bars\' ' +
      "units (a target beside actuals)",
    plan: "two or more measures over one dimension",
  },
  {
    type: "scatter",
    fields: "{ xField, yField, sizeField? }",
    when: "two measures per item, to show correlation; sizeField sizes each point by a third",
    plan: "two measures per item, for correlation",
  },
  {
    type: "pie",
    fields: "{ nameField, valueField }",
    when: "part of a whole, 8 rows or fewer",
    plan: "part of a whole across a few categories",
  },
  {
    type: "nightingale",
    fields: "{ nameField, valueField }",
    when: "a rose of 12 categories or fewer whose magnitudes vary a lot",
    plan: "a rose of 12 or fewer categories with widely varying magnitudes",
  },
  {
    type: "radialbar",
    fields: "{ nameField, valueField }",
    when: "a handful (8 or fewer) of named values as concentric arcs",
    plan: "a handful of named values",
  },
  {
    type: "treemap",
    fields: '{ nameField, valueField, colorMeasure?, scale?: "sequential"|"diverging" }',
    when:
      "part of a whole with many categories. colorMeasure colours each tile by a second " +
      'measure (sized by sales, coloured by margin); scale "diverging" when it can be negative',
    plan: "part of a whole across many categories",
  },
  {
    type: "pareto",
    fields: "{ categoryField, valueField }",
    when:
      "which few categories make most of the total (causes, defects, complaints, products): " +
      "bars largest first with the running share of the total",
    plan: "which few categories make up most of a total",
  },
  {
    type: "funnel",
    fields: "{ nameField, valueField }",
    when: "sequential stages with decreasing values",
    plan: "sequential stages of a pipeline",
  },
  {
    type: "waterfall",
    fields: "{ xField, yField }",
    when: "positive and negative contributions adding up to a total",
    plan: "additive contributions to a total",
  },
  {
    type: "heatmap",
    fields: '{ xField, yField, valueField, scale?: "sequential"|"diverging" }',
    when:
      'intensity across two categorical dimensions (weekday by hour); scale "diverging" for ' +
      "values either side of zero",
    plan: "a measure across two categorical dimensions",
  },
  {
    type: "matrix",
    fields: "{ rowField, colField, valueField, rowSubField?, extraMeasures? }",
    when:
      "a pivot table: a measure across row and column categories. rowSubField nests a second " +
      "row level; extraMeasures puts several measures under each column",
    plan: "a pivot of one or more measures across two dimensions",
  },
  {
    type: "calendar",
    fields: "{ dateField, valueField }",
    when:
      "a daily measure over weeks or months, one square per day (needs one row per DAY; " +
      "the calendar shows the latest 400 days)",
    plan: "a measure per day over the last year at most",
  },
  {
    type: "smallmultiples",
    fields: '{ xField, yField, splitField, kind?: "line"|"bar" }',
    when:
      "the same small chart once per value of splitField (3-12 values) on one shared scale, " +
      "e.g. sales by month for each region",
    plan: "the same trend or breakdown repeated per value of a category",
  },
  {
    type: "pictogram",
    fields: '{ categoryField, valueField, icon?: "person"|"bike"|"car"|"house"|"coin"|"box" }',
    when: "counts of people or things for a few (6 or fewer) categories, as rows of icons",
    plan: "counts of people or things for a few categories",
  },
  {
    type: "range",
    fields: "{ categoryField, startField, endField, higherIsBetter? }",
    when:
      "where each item started and where it ended (before and after, plan against actual); " +
      "higherIsBetter: true when a larger value is the better one",
    plan: "a before and an after value per item",
  },
  {
    type: "bump",
    fields: "{ xField, yField, seriesField }",
    when:
      "rank over time, one line per series. yField must be a RANK (1 = first) per xField " +
      "period: compute it with RANK() in the SQL",
    plan: "how a ranking changes over time",
  },
  {
    type: "barrace",
    fields: "{ xField, yField, timeField }",
    when: "an animated ranking of xField by yField across timeField frames",
    plan: "a ranking that changes over a date",
  },
  {
    type: "sankey",
    fields: "{ xField, yField, valueField }",
    when: "flows FROM xField (source) TO yField (target), sized by valueField",
    plan: "flows between two linked columns",
  },
  {
    type: "radar",
    fields: "{ xField, yField, seriesField?, extraMeasures? }",
    when: "compare 3-10 metrics (xField spokes) across one or a few series",
    plan: "a handful of metrics across a few entities",
  },
  {
    type: "wordcloud",
    fields: "{ textField, valueField? }",
    when: "words sized by frequency in a text column, or weighted by a measure",
    plan: "frequent terms in a free-text column",
  },
  {
    type: "boxplot",
    fields: "{ xField, yField }",
    when: "the distribution of a measure per group (needs individual rows, not totals)",
    plan: "the distribution of a measure across groups",
  },
  {
    type: "map",
    fields: "{ locationField, valueField }",
    when:
      "a measure per country or US state: names, ISO codes, or US postal or FIPS codes. The " +
      "map draws countries or states from the values",
    plan: "a measure per country or US state (only if such a column exists)",
  },
  {
    type: "bubblemap",
    fields: "{ locationField, valueField }",
    when: "the same as map, as circles sized by the value",
    plan: "a measure per country or US state, as circles",
  },
  {
    type: "pointmap",
    fields: "{ latField, lngField, sizeField?, colorField?, labelField? }",
    when: "points at a latitude and a longitude: stores, stations, sensors",
    plan: "places with latitude and longitude columns",
  },
  {
    type: "journey",
    fields: "{ categoryField, valueField }",
    when: "a short ordered sequence (10 rows or fewer, in order) as pins along a road",
    plan: "a short ordered sequence of stages or days",
  },
  {
    type: "cards",
    fields: '{ title, body?, imageField?, layout?: "tiles"|"rows", max? }',
    when:
      "a few (6 or fewer) named items as cards, such as a podium or the top three products. " +
      'title and body are templates with {{column}} tokens: title "{{product}}", body ' +
      '"Revenue {{revenue}}"',
    plan: "a few named items shown as cards",
  },
  {
    type: "table",
    fields: "{}",
    when: "the fallback: detail rows, or many columns",
    plan: "detail rows with several columns",
  },
];

const CATALOG_TYPES = new Set<string>(CHART_CATALOG.map((e) => e.type));

/** Whether a model may be offered this visual. */
export function isGeneratedChartType(type: string): type is ChartTypeId {
  return CATALOG_TYPES.has(type);
}

/** The chart step's list of types, one line each. */
export function chartStepTypeLines(): string {
  return CHART_CATALOG.map((e) => `- '${e.type}': ${e.fields} — ${e.when}`).join("\n");
}

/** Options any chart may carry, for the chart step. */
export const SHARED_OPTION_LINE =
  'Optional on any chart: legend: "bottom"|"top"|"right"|"none"; refLine: { "mode": "avg" } ' +
  "to mark the average.";

/** The planner's list of type names. */
export function plannerTypeList(): string {
  return CHART_CATALOG.map((e) => e.type).join(", ");
}

/** The planner's guidance, one clause per type. */
export function plannerTypeGuide(): string {
  return CHART_CATALOG.filter((e) => e.type !== "kpi" && e.type !== "insight")
    .map((e) => `'${e.type}' for ${e.plan}`)
    .join("; ");
}

// ── Reading what a model returned ────────────────────────────────────────

/**
 * Words models use for a visual, mapped to the type that draws it. Keys are
 * lowercased with everything but letters and digits removed, so "Stacked
 * Column", "stacked_column" and "stacked-column" are one key.
 */
const TYPE_ALIASES: Record<string, ChartTypeId> = {
  column: "bar",
  columns: "bar",
  columnchart: "bar",
  barchart: "bar",
  verticalbar: "bar",
  groupedbar: "bar",
  horizontalbar: "hbar",
  horizontalbars: "hbar",
  hbarchart: "hbar",
  stackedcolumn: "scolumn",
  stackedcolumns: "scolumn",
  stackedbar: "shbar",
  stackedbars: "shbar",
  stackedhorizontalbar: "shbar",
  linechart: "line",
  timeseries: "line",
  areachart: "area",
  stackedarea: "area",
  barline: "combo",
  linebar: "combo",
  combination: "combo",
  combochart: "combo",
  dualaxis: "combo",
  scatterplot: "scatter",
  bubble: "scatter",
  bubblechart: "scatter",
  donut: "pie",
  doughnut: "pie",
  piechart: "pie",
  rose: "nightingale",
  polararea: "nightingale",
  radial: "radialbar",
  radialbars: "radialbar",
  radialbarchart: "radialbar",
  paretochart: "pareto",
  funnelchart: "funnel",
  waterfallchart: "waterfall",
  bridge: "waterfall",
  heatmapchart: "heatmap",
  heat: "heatmap",
  pivot: "matrix",
  pivottable: "matrix",
  crosstab: "matrix",
  calendarheatmap: "calendar",
  smallmultiple: "smallmultiples",
  facet: "smallmultiples",
  facets: "smallmultiples",
  trellis: "smallmultiples",
  pictograph: "pictogram",
  isotype: "pictogram",
  iconarray: "pictogram",
  dumbbell: "range",
  startfinish: "range",
  rangechart: "range",
  bumpchart: "bump",
  rankovertime: "bump",
  race: "barrace",
  barchartrace: "barrace",
  flow: "sankey",
  spider: "radar",
  radarchart: "radar",
  tagcloud: "wordcloud",
  box: "boxplot",
  boxandwhisker: "boxplot",
  choropleth: "map",
  filledmap: "map",
  geomap: "map",
  worldmap: "map",
  statemap: "map",
  usmap: "map",
  bubblemaps: "bubblemap",
  symbolmap: "bubblemap",
  pointmaps: "pointmap",
  pins: "pointmap",
  dotmap: "pointmap",
  road: "journey",
  card: "kpi",
  metric: "kpi",
  number: "kpi",
  bignumber: "kpi",
  scorecard: "kpi",
  narrative: "insight",
  sentence: "insight",
  text: "insight",
  tiles: "cards",
  podium: "cards",
  grid: "table",
  list: "table",
};

/** The type a model's word for a visual means, or undefined. */
export function chartTypeFromWord(word: unknown): ChartTypeId | undefined {
  if (typeof word !== "string") return undefined;
  const raw = word.trim().toLowerCase();
  if (isGeneratedChartType(raw)) return raw;
  const key = raw.replace(/[^a-z0-9]/g, "");
  if (isGeneratedChartType(key)) return key;
  return TYPE_ALIASES[key];
}

const LEGENDS = new Set(["bottom", "top", "right", "none"]);
const GRAINS = new Set(["auto", "day", "week", "month", "quarter", "year"]);
const SCALES = new Set(["sequential", "diverging"]);
const PICTO_ICONS = new Set<BiPictogramIcon>(["person", "bike", "car", "house", "coin", "box"]);
const INSIGHT_KINDS = new Set<BiInsightKind>([
  "top",
  "bottom",
  "change",
  "forecast",
  "anomaly",
  "growth",
  "movers",
]);

const BOOLEAN_KEYS = [
  "stacked",
  "stackBars",
  "percentStack",
  "endLabels",
  "trend",
  "running",
  "zoomBar",
  "logScale",
  "sparkline",
  "lowerIsBetter",
  "higherIsBetter",
  "totals",
  "striped",
  "hideIcon",
] as const;

function asBool(v: unknown): boolean | undefined {
  if (v === true || v === false) return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return undefined;
}

function asInt(v: unknown, min: number, max: number): number | undefined {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) return undefined;
  const i = Math.round(n);
  return i >= min && i <= max ? i : undefined;
}

function asNames(v: unknown): string[] | undefined {
  const list = typeof v === "string" ? [v] : Array.isArray(v) ? v : undefined;
  if (!list) return undefined;
  const out = [
    ...new Set(list.filter((s): s is string => typeof s === "string" && s.trim() !== "")),
  ].map((s) => s.trim());
  return out.length ? out : undefined;
}

/**
 * The chart to draw for a type nobody draws: a line for a measure over a
 * date, bars for a measure by a label, else the rows.
 */
export function fallbackChart(columns: string[], rows: Record<string, unknown>[]): ChartSpec {
  const dates = dateLikeColumns(columns, rows);
  const numbers = [...numericColumns(columns, rows)].filter((c) => !dates.includes(c));
  const labels = columns.filter((c) => !dates.includes(c) && !numbers.includes(c));
  if (numbers.length && dates.length) {
    return { type: "line", xField: dates[0], yField: numbers[0] };
  }
  if (numbers.length && labels.length) {
    return { type: "bar", xField: labels[0], yField: numbers[0] };
  }
  return { type: "table" };
}

/**
 * A model's chart, made into one the renderer draws.
 *
 * The type is mapped from the model's word for it; options keep a value only
 * when it is one the renderer reads; a type that no renderer draws (or one a
 * model must not choose, such as the dashboard's controls) becomes the
 * fallback for the rows. Column names are NOT checked here: that is
 * reconcileChartFields, which can say what it repaired.
 */
export function normalizeChartSpec(
  raw: unknown,
  result: { columns: string[]; rows: Record<string, unknown>[] },
): ChartSpec {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return fallbackChart(result.columns, result.rows);
  }
  const src = raw as Record<string, unknown>;
  const type = chartTypeFromWord(src.type);
  if (!type) return fallbackChart(result.columns, result.rows);

  const out: Record<string, unknown> = { ...src, type };

  // Field names: a model sometimes writes `"xField": ["month"]`.
  for (const [k, v] of Object.entries(out)) {
    if (!k.endsWith("Field")) continue;
    if (Array.isArray(v) && typeof v[0] === "string") out[k] = v[0];
    else if (typeof v !== "string" || v.trim() === "") delete out[k];
    else out[k] = v.trim();
  }

  for (const k of BOOLEAN_KEYS) {
    if (!(k in out)) continue;
    const b = asBool(out[k]);
    if (b === undefined) delete out[k];
    else out[k] = b;
  }

  const setOrDrop = (key: string, value: unknown) => {
    if (value === undefined) delete out[key];
    else out[key] = value;
  };

  if ("legend" in out) {
    const v = typeof out.legend === "string" ? out.legend.trim().toLowerCase() : "";
    setOrDrop("legend", LEGENDS.has(v) ? v : undefined);
  }
  if ("dateGrain" in out) {
    // Only a line or an area regroups by a grain. On any other chart a grain
    // also switched off the axis's own labelling of raw timestamps, so a
    // generated combo read "2022-01-01 00:00:00" under every bar (R507).
    const v = typeof out.dateGrain === "string" ? out.dateGrain.trim().toLowerCase() : "";
    setOrDrop("dateGrain", GRAINS.has(v) && (type === "line" || type === "area") ? v : undefined);
  }
  if ("scale" in out) {
    const v = typeof out.scale === "string" ? out.scale.trim().toLowerCase() : "";
    setOrDrop("scale", SCALES.has(v) ? v : undefined);
  }
  if ("movingAverage" in out) setOrDrop("movingAverage", asInt(out.movingAverage, 2, 365));
  if ("topN" in out) setOrDrop("topN", asInt(out.topN, 1, 50));
  if ("periods" in out) setOrDrop("periods", asInt(out.periods, 1, 120));
  // A forecast from the model is a number of periods; the object form attaches
  // a registry model and is the builder's to set.
  if ("forecast" in out) setOrDrop("forecast", asInt(out.forecast, 1, 36));
  if ("max" in out) {
    const n = typeof out.max === "string" ? Number(out.max) : out.max;
    setOrDrop("max", typeof n === "number" && Number.isFinite(n) && n > 0 ? n : undefined);
  }
  if ("unit" in out) {
    const n = typeof out.unit === "string" ? Number(out.unit) : out.unit;
    setOrDrop("unit", typeof n === "number" && Number.isFinite(n) && n > 0 ? n : undefined);
  }
  if ("refLine" in out) {
    const r = out.refLine as { mode?: unknown; value?: unknown; label?: unknown } | null;
    const mode = typeof r?.mode === "string" ? r.mode.toLowerCase() : "";
    const value = typeof r?.value === "number" && Number.isFinite(r.value) ? r.value : undefined;
    setOrDrop(
      "refLine",
      mode === "avg" || mode === "average"
        ? { mode: "avg" }
        : mode === "value" && value !== undefined
          ? { mode: "value", value, ...(typeof r?.label === "string" ? { label: r.label } : {}) }
          : undefined,
    );
  }
  if ("annotations" in out) {
    const list = Array.isArray(out.annotations) ? out.annotations : [];
    const notes = list
      .filter(
        (a): a is { x: string | number; text: string } =>
          !!a &&
          typeof a === "object" &&
          (typeof (a as { x?: unknown }).x === "string" ||
            typeof (a as { x?: unknown }).x === "number") &&
          typeof (a as { text?: unknown }).text === "string" &&
          (a as { text: string }).text.trim() !== "",
      )
      .slice(0, 12);
    setOrDrop("annotations", notes.length ? notes : undefined);
  }
  if ("extraMeasures" in out) setOrDrop("extraMeasures", asNames(out.extraMeasures));
  if ("extraLines" in out) setOrDrop("extraLines", asNames(out.extraLines));
  if ("iconFields" in out) setOrDrop("iconFields", asNames(out.iconFields));
  // Compare the latest period with — accepted in the words models use.
  if ("compareTo" in out) {
    const v = typeof out.compareTo === "string" ? out.compareTo.trim().toLowerCase() : "";
    setOrDrop(
      "compareTo",
      v === "year" || v === "yoy" || v === "prior_year" || v === "year_ago"
        ? "year"
        : v === "previous" || v === "prior" || v === "prior_period" || v === "mom"
          ? "previous"
          : v === "none"
            ? "none"
            : undefined,
    );
  }
  // The line overlay's compare is a different setting with other words.
  if ("compare" in out) {
    const v = typeof out.compare === "string" ? out.compare.trim().toLowerCase() : "";
    setOrDrop("compare", v === "prior_period" || v === "prior_year" ? v : undefined);
  }

  switch (type) {
    case "map":
    case "bubblemap": {
      // Unset lets the map choose from the values, which is what it should do.
      const v = typeof out.region === "string" ? out.region.trim().toLowerCase() : "";
      setOrDrop("region", v === "us" || v === "world" ? v : undefined);
      break;
    }
    case "combo": {
      const v = typeof out.lineAxis === "string" ? out.lineAxis.trim().toLowerCase() : "";
      setOrDrop("lineAxis", v === "left" || v === "right" ? v : undefined);
      break;
    }
    case "smallmultiples": {
      const v = typeof out.kind === "string" ? out.kind.trim().toLowerCase() : "";
      setOrDrop("kind", v === "line" || v === "bar" ? v : undefined);
      break;
    }
    case "pictogram": {
      const v = typeof out.icon === "string" ? out.icon.trim().toLowerCase() : "";
      setOrDrop("icon", PICTO_ICONS.has(v as BiPictogramIcon) ? v : undefined);
      break;
    }
    case "cards": {
      const v = typeof out.layout === "string" ? out.layout.trim().toLowerCase() : "";
      setOrDrop("layout", v === "tiles" || v === "rows" ? v : undefined);
      if ("max" in out) setOrDrop("max", asInt(out.max, 1, 12));
      // A card needs a name line. Without one, the first label column names it.
      if (typeof out.title !== "string" || !out.title.trim()) {
        const label = result.columns.find(
          (c) => !numericColumns(result.columns, result.rows).has(c),
        );
        if (!label) return fallbackChart(result.columns, result.rows);
        out.title = `{{${label}}}`;
      }
      break;
    }
    case "insight": {
      const v = typeof out.kind === "string" ? out.kind.trim().toLowerCase() : "";
      if (INSIGHT_KINDS.has(v as BiInsightKind)) {
        out.kind = v;
      } else {
        // The sentence the columns can carry: a change over a date, else who leads.
        const dates = dateLikeColumns(result.columns, result.rows);
        const labels = result.columns.filter(
          (c) => !dates.includes(c) && !numericColumns(result.columns, result.rows).has(c),
        );
        if (dates.length && result.rows.length >= 2) {
          out.kind = "change";
          out.dateField ??= dates[0];
        } else if (labels.length) {
          out.kind = "top";
          out.categoryField ??= labels[0];
        } else {
          return fallbackChart(result.columns, result.rows);
        }
      }
      break;
    }
    default:
      break;
  }
  return out as ChartSpec;
}
