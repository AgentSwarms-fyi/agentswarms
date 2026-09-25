// Charts over a range of cells, read as Excel reads one: a first row of text
// is the series names, a first column of text is the categories, and the
// series run down the columns when the range is at least as tall as it is
// wide (across the rows otherwise), unless the chart says which.

import { parseRangeA1, type RangeAddr } from "./a1";
import { isError, type Scalar } from "./formula/values";

export type ChartType =
  | "column"
  | "bar"
  | "line"
  | "area"
  | "pie"
  | "doughnut"
  | "scatter"
  | "combo"
  | "radar";

export type ChartDef = {
  id: string;
  type: ChartType;
  /** The data, on the sheet the chart sits on: "A1:D13". */
  range: string;
  title?: string;
  /** Series down the columns or across the rows; "auto" follows Excel's rule. */
  seriesIn?: "auto" | "cols" | "rows";
  stacked?: "none" | "normal" | "percent";
  legend?: "top" | "bottom" | "right" | "none";
  /** Values (or a pie's percentages) printed on the marks. */
  labels?: boolean;
  smooth?: boolean;
  xTitle?: string;
  yTitle?: string;
  /** Position and size in pixels at 100% zoom, from the sheet's top-left. */
  x: number;
  y: number;
  w: number;
  h: number;
};

export const CHART_TYPES: { type: ChartType; label: string; hint: string }[] = [
  { type: "column", label: "Column", hint: "Compare values across categories" },
  { type: "bar", label: "Bar", hint: "Columns on their side, for long category names" },
  { type: "line", label: "Line", hint: "A trend over time" },
  { type: "area", label: "Area", hint: "A trend, with the volume under it" },
  { type: "pie", label: "Pie", hint: "Parts of one whole (the first series)" },
  { type: "doughnut", label: "Doughnut", hint: "A pie with a hole" },
  { type: "scatter", label: "Scatter", hint: "Two measures against each other: x, then y" },
  {
    type: "combo",
    label: "Column and line",
    hint: "The first series as columns, the rest as lines",
  },
  { type: "radar", label: "Radar", hint: "Several measures around a circle" },
];

/** Excel's default series colors (Office theme accents, then their darker shades). */
export const SERIES_COLORS = [
  "#4472C4",
  "#ED7D31",
  "#A5A5A5",
  "#FFC000",
  "#5B9BD5",
  "#70AD47",
  "#264478",
  "#9E480E",
  "#636363",
  "#997300",
];

export type ChartSeries = { name: string; values: (number | null)[] };
export type ChartData = {
  categories: string[];
  series: ChartSeries[];
  /** For a scatter: the x of each point. */
  xs?: (number | null)[];
  /** Why there is nothing to draw, when there is not. */
  problem?: string;
};

/** How a range splits into names, categories and values. */
export type ChartLayout = { headerRow: boolean; labelCol: boolean; byCols: boolean };

const isText = (v: Scalar) =>
  typeof v === "string" && v.trim() !== "" && !Number.isFinite(Number(v));
const num = (v: Scalar): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string" || !v.trim()) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const label = (v: Scalar, fallback: string): string =>
  v === null || v === ""
    ? fallback
    : isError(v)
      ? v.err
      : typeof v === "boolean"
        ? v
          ? "TRUE"
          : "FALSE"
        : String(v);

/** Excel's reading of a range: which row holds names, which column holds categories. */
export function chartLayout(
  def: Pick<ChartDef, "seriesIn" | "type">,
  r: RangeAddr,
  value: (row: number, col: number) => Scalar,
): ChartLayout {
  const rows = r.r1 - r.r0 + 1;
  const cols = r.c1 - r.c0 + 1;
  const cell = (dr: number, dc: number) => value(r.r0 + dr, r.c0 + dc);
  // A header row: a first row whose cells over the data are text.
  let headerRow = false;
  if (rows > 1) for (let c = 0; c < cols; c++) if (isText(cell(0, c))) headerRow = true;
  // A label column: a first column holding text (or dates shown as text) under the header.
  let labelCol = false;
  if (cols > 1 && def.type !== "scatter")
    for (let i = headerRow ? 1 : 0; i < rows; i++) if (isText(cell(i, 0))) labelCol = true;
  const byCols =
    def.type === "scatter" || def.seriesIn === "cols"
      ? true
      : def.seriesIn === "rows"
        ? false
        : rows >= cols;
  return { headerRow, labelCol, byCols };
}

/**
 * The numbers a chart draws, read from the sheet. `display` gives a cell's
 * shown text (a date as a date) for category labels.
 */
export function chartData(
  def: Pick<ChartDef, "range" | "seriesIn" | "type">,
  value: (row: number, col: number) => Scalar,
  display?: (row: number, col: number) => string,
  maxPoints = 5000,
): ChartData {
  const r = parseRangeA1(def.range.replace(/\$/g, ""));
  if (!r) return { categories: [], series: [], problem: `"${def.range}" is not a range` };
  const rows = r.r1 - r.r0 + 1;
  const cols = r.c1 - r.c0 + 1;
  if (rows * cols > 200_000)
    return {
      categories: [],
      series: [],
      problem: "The range is too large to chart (over 200,000 cells)",
    };
  const cell = (dr: number, dc: number) => value(r.r0 + dr, r.c0 + dc);
  const shown = (dr: number, dc: number) =>
    display?.(r.r0 + dr, r.c0 + dc) ?? label(cell(dr, dc), "");
  const { headerRow, labelCol, byCols } = chartLayout(def, r, value);
  const d0 = headerRow ? 1 : 0; // first data row
  const c0 = labelCol ? 1 : 0; // first data column

  if (def.type === "scatter") {
    // The first column is x; every other column is a series of y.
    if (cols < 2)
      return {
        categories: [],
        series: [],
        problem: "A scatter chart needs two columns: x, then y",
      };
    const xs: (number | null)[] = [];
    const ys: ChartSeries[] = [];
    for (let c = 1; c < cols; c++)
      ys.push({ name: headerRow ? label(cell(0, c), `Series ${c}`) : `Series ${c}`, values: [] });
    for (let i = d0; i < rows && xs.length < maxPoints; i++) {
      xs.push(num(cell(i, 0)));
      ys.forEach((s, k) => s.values.push(num(cell(i, 1 + k))));
    }
    if (!xs.some((x) => x !== null))
      return { categories: [], series: ys, xs, problem: "The first column has no numbers for x" };
    return { categories: xs.map((x) => (x === null ? "" : String(x))), series: ys, xs };
  }

  const categories: string[] = [];
  const series: ChartSeries[] = [];
  if (byCols) {
    for (let c = c0; c < cols; c++)
      series.push({
        name: headerRow ? label(cell(0, c), `Series ${c - c0 + 1}`) : `Series ${c - c0 + 1}`,
        values: [],
      });
    for (let i = d0; i < rows && categories.length < maxPoints; i++) {
      categories.push(labelCol ? shown(i, 0) : String(i - d0 + 1));
      series.forEach((s, k) => s.values.push(num(cell(i, c0 + k))));
    }
  } else {
    for (let i = d0; i < rows; i++)
      series.push({ name: labelCol ? shown(i, 0) : `Series ${i - d0 + 1}`, values: [] });
    for (let c = c0; c < cols && categories.length < maxPoints; c++) {
      categories.push(headerRow ? shown(0, c) : String(c - c0 + 1));
      series.forEach((s, k) => s.values.push(num(cell(d0 + k, c))));
    }
  }
  if (!series.some((s) => s.values.some((v) => v !== null)))
    return { categories, series, problem: "There are no numbers in the range to chart" };
  // A pie shows one series: the first, as Excel draws it.
  if ((def.type === "pie" || def.type === "doughnut") && series.length > 1)
    return { categories, series: series.slice(0, 1) };
  return { categories, series };
}
