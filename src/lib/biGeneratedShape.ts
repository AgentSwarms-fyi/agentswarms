// Turning a generated widget's result into the R498 visuals the planner
// asked for: a KPI that compares the latest period with the one before, or a
// narrative computed from the rows.
//
// The planner names the visual before any SQL exists, and the chart step is a
// model that has never heard of either. So the shape is decided HERE, from the
// columns that came back, and deterministically: a date column and a number
// make a period KPI; a category and a number make a ranking; a planner wish
// the columns cannot carry leaves the chart the model picked untouched rather
// than drawing an empty frame.
import type { BiInsightKind, BiKpiCompare, ChartSpec } from "@/lib/biAgent";
import { numericColumns } from "@/lib/biChartFields";
import { dateLikeColumns } from "@/lib/biPeriods";
import { nameForCode } from "@/lib/countryMatch";
import { resolveUsState } from "@/lib/usStateMatch";

export const INSIGHT_KIND_IDS: BiInsightKind[] = [
  "top",
  "bottom",
  "change",
  "forecast",
  "anomaly",
  "growth",
  "movers",
];

export function parseInsightKind(v: unknown): BiInsightKind | undefined {
  const k = typeof v === "string" ? v.trim().toLowerCase() : "";
  return (INSIGHT_KIND_IDS as string[]).includes(k) ? (k as BiInsightKind) : undefined;
}

export function parseCompare(v: unknown): Exclude<BiKpiCompare, "none"> | undefined {
  const k = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (k === "previous" || k === "prior" || k === "prior_period" || k === "mom") return "previous";
  if (k === "year" || k === "yoy" || k === "prior_year" || k === "year_ago") return "year";
  return undefined;
}

type Wish = {
  chartType: string;
  title?: string;
  compare?: Exclude<BiKpiCompare, "none">;
  insightKind?: BiInsightKind;
};

/** Keep the value formatting the chart step chose; the shape is ours. */
function formatOf(chart: ChartSpec | undefined): Partial<ChartSpec> {
  if (!chart) return {};
  const out: Record<string, unknown> = {};
  for (const k of ["format", "currency", "decimals"] as const) {
    if (chart[k] !== undefined) out[k] = chart[k];
  }
  return out as Partial<ChartSpec>;
}

/**
 * The chart to draw for a generated widget, or `current` unchanged.
 *
 * `title` becomes the KPI's label, since a generated tile titled "Monthly
 * revenue" reads better than its column name `total_revenue`.
 */
export function shapeGeneratedChart(
  wish: Wish,
  columns: string[],
  rows: Record<string, unknown>[],
  current: ChartSpec | undefined,
): ChartSpec | undefined {
  if (!Array.isArray(rows) || rows.length === 0 || columns.length === 0) return current;
  const dates = dateLikeColumns(columns, rows);
  const numbers = [...numericColumns(columns, rows)].filter((c) => !dates.includes(c));
  const labels = columns.filter((c) => !dates.includes(c) && !numbers.includes(c));
  // The measure the model already picked, when it is a number; else the first.
  const picked =
    current && "valueField" in current && typeof current.valueField === "string"
      ? current.valueField
      : current && "yField" in current && typeof current.yField === "string"
        ? current.yField
        : undefined;
  const measure = picked && numbers.includes(picked) ? picked : numbers[0];
  if (!measure) return current;

  if (wish.chartType === "kpi") {
    // A period KPI needs a series. One row is a plain total and stays one.
    if (!wish.compare || dates.length === 0 || rows.length < 2) return current;
    return {
      type: "kpi",
      valueField: measure,
      label: wish.title?.trim() || undefined,
      dateField: dates[0],
      compareTo: wish.compare === "previous" ? undefined : wish.compare,
      sparkline: true,
      ...formatOf(current),
    } as ChartSpec;
  }

  if (wish.chartType === "insight") {
    const kind =
      wish.insightKind ??
      (dates.length > 0 && rows.length >= 2 ? "change" : labels.length > 0 ? "top" : undefined);
    if (!kind) return current;
    const needsDate = kind !== "top" && kind !== "bottom";
    const needsCategory = kind === "top" || kind === "bottom" || kind === "movers";
    if (needsDate && dates.length === 0) return current;
    if (needsCategory && labels.length === 0) return current;
    return {
      type: "insight",
      kind,
      valueField: measure,
      dateField: needsDate ? dates[0] : undefined,
      categoryField: needsCategory ? labels[0] : undefined,
      ...formatOf(current),
    } as ChartSpec;
  }

  // The visuals added since R500 (R507). The chart step is told what the
  // planner asked for and usually draws it; when it draws something else and
  // the columns carry the shape, the planner's visual is built here.
  if (current?.type === wish.chartType) return current;
  const shaped = shapeForWish(wish.chartType, {
    columns,
    rows,
    dates,
    numbers,
    labels,
    measure,
    current,
  });
  return shaped ? ({ ...shaped, ...formatOf(current) } as ChartSpec) : current;
}

type Shape = {
  columns: string[];
  rows: Record<string, unknown>[];
  dates: string[];
  numbers: string[];
  labels: string[];
  measure: string;
  current: ChartSpec | undefined;
};

/** The label column the chart step already drew, when it drew one. */
function pickedLabel(s: Shape, among: string[]): string | undefined {
  const c = s.current as Record<string, unknown> | undefined;
  for (const k of ["xField", "nameField", "categoryField", "locationField", "rowField"]) {
    const v = c?.[k];
    if (typeof v === "string" && among.includes(v)) return v;
  }
  return among[0];
}

const distinct = (rows: Record<string, unknown>[], col: string) =>
  new Set(rows.map((r) => r[col]).filter((v) => v !== null && v !== undefined && v !== "")).size;

/** Whether most values of a column are places a filled map can draw. */
function looksLikePlaces(rows: Record<string, unknown>[], col: string): boolean {
  if (/country|state|nation|province|iso/i.test(col)) return true;
  const values = [...new Set(rows.map((r) => r[col]))].filter((v) => typeof v === "string");
  if (values.length === 0) return false;
  const hits = values.filter((v) => resolveUsState(v) || nameForCode(String(v))).length;
  return hits / values.length >= 0.6;
}

/** A rank column: whole numbers from 1 up, none larger than the row count. */
function looksLikeRank(rows: Record<string, unknown>[], col: string): boolean {
  const vals = rows.map((r) => r[col]).filter((v): v is number => typeof v === "number");
  return vals.length > 0 && vals.every((v) => Number.isInteger(v) && v >= 1 && v <= rows.length);
}

function shapeForWish(type: string, s: Shape): ChartSpec | undefined {
  const { rows, dates, numbers, labels, measure } = s;
  const n = rows.length;
  switch (type) {
    case "pareto": {
      const cat = pickedLabel(s, labels);
      return cat && n >= 3
        ? { type: "pareto", categoryField: cat, valueField: measure }
        : undefined;
    }
    case "pictogram": {
      const cat = pickedLabel(s, labels);
      return cat && n <= 8
        ? { type: "pictogram", categoryField: cat, valueField: measure }
        : undefined;
    }
    case "radialbar": {
      const cat = pickedLabel(s, labels);
      return cat && n <= 10
        ? { type: "radialbar", nameField: cat, valueField: measure }
        : undefined;
    }
    case "journey": {
      const cat = pickedLabel(s, [...labels, ...dates]);
      return cat && n <= 12
        ? { type: "journey", categoryField: cat, valueField: measure }
        : undefined;
    }
    case "calendar":
      return dates.length && n >= 7
        ? { type: "calendar", dateField: dates[0], valueField: measure }
        : undefined;
    case "smallmultiples": {
      const x = dates[0] ?? pickedLabel(s, labels);
      const split = labels.find((c) => c !== x);
      if (!x || !split) return undefined;
      const panels = distinct(rows, split);
      if (panels < 2 || panels > 12) return undefined;
      return {
        type: "smallmultiples",
        xField: x,
        yField: measure,
        splitField: split,
        kind: dates.length ? "line" : "bar",
      };
    }
    case "combo": {
      const x = dates[0] ?? pickedLabel(s, labels);
      const rest = numbers.filter((c) => c !== measure);
      if (!x || rest.length === 0) return undefined;
      return {
        type: "combo",
        xField: x,
        barField: measure,
        lineField: rest[0],
        ...(rest.length > 1 ? { extraMeasures: rest.slice(1, 4) } : {}),
      };
    }
    case "matrix": {
      const dims = [...labels, ...dates];
      const row = pickedLabel(s, dims);
      const col = dims.find((c) => c !== row);
      if (!row || !col) return undefined;
      const rest = numbers.filter((c) => c !== measure).slice(0, 3);
      return {
        type: "matrix",
        rowField: row,
        colField: col,
        valueField: measure,
        ...(rest.length ? { extraMeasures: rest } : {}),
      };
    }
    case "map":
    case "bubblemap": {
      const loc = labels.find((c) => looksLikePlaces(rows, c));
      return loc ? { type, locationField: loc, valueField: measure } : undefined;
    }
    case "range": {
      const cat = pickedLabel(s, labels);
      const [start, end] = numbers;
      return cat && start && end
        ? { type: "range", categoryField: cat, startField: start, endField: end }
        : undefined;
    }
    case "bump": {
      const x = dates[0] ?? labels[0];
      const series = labels.find((c) => c !== x);
      const rank = numbers.find((c) => looksLikeRank(rows, c));
      return x && series && rank
        ? { type: "bump", xField: x, yField: rank, seriesField: series }
        : undefined;
    }
    case "pointmap": {
      const lat = s.columns.find((c) => /^(lat|latitude)$/i.test(c) && numbers.includes(c));
      const lng = s.columns.find(
        (c) => /^(lng|lon|long|longitude)$/i.test(c) && numbers.includes(c),
      );
      if (!lat || !lng) return undefined;
      const size = numbers.find((c) => c !== lat && c !== lng);
      return {
        type: "pointmap",
        latField: lat,
        lngField: lng,
        ...(size ? { sizeField: size } : {}),
        ...(labels[0] ? { labelField: labels[0] } : {}),
      };
    }
    default:
      return undefined;
  }
}
